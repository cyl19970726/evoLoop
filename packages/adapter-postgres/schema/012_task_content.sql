-- C5: Task prose is held only by a fixed, task-owned process Document revision.
ALTER TABLE process_document ADD COLUMN kind text CHECK (kind IN ('task','issue','spec','discussion','report'));
ALTER TABLE process_document ADD COLUMN status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','published','archived'));
-- Legacy adopted heads already carry approval. Backfill status without creating
-- a new Document version or changing its immutable revision identity.
ALTER TABLE process_document DISABLE TRIGGER advance_document_version;
UPDATE process_document SET status='published' WHERE adopted_revision_id IS NOT NULL;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE process_document ENABLE TRIGGER advance_document_version;

ALTER TABLE task ADD COLUMN kind text CHECK (kind IN ('implementation','research','validation'));
ALTER TABLE task ADD COLUMN content_document_id uuid;
ALTER TABLE task ADD COLUMN content_revision_id uuid;
ALTER TABLE task_revision ADD COLUMN kind text CHECK (kind IN ('implementation','research','validation'));
ALTER TABLE task_revision ADD COLUMN content_document_id uuid;
ALTER TABLE task_revision ADD COLUMN content_revision_id uuid;
ALTER TABLE task DROP CONSTRAINT task_state_check;
DROP TRIGGER task_head_basis_check ON task;

-- These two old triggers protect normal writes. Disable only for the one-time backfill;
-- immutable IDs, versions, history states, sealed basis and operation receipts stay intact.
ALTER TABLE task DISABLE TRIGGER advance_task_version;
ALTER TABLE task_revision DISABLE TRIGGER immutable_task_revision;
UPDATE task SET content_document_id=gen_random_uuid(),
  state=CASE WHEN state IN ('proposed','ready','blocked','deferred') THEN 'todo'
             WHEN state IN ('active','review') THEN 'in_progress' ELSE state END;
UPDATE task_revision r SET content_document_id=t.content_document_id,
  content_revision_id=gen_random_uuid()
  FROM task t WHERE r.project_id=t.project_id AND r.task_id=t.task_id;
UPDATE task t SET content_revision_id=r.content_revision_id
  FROM task_revision r WHERE t.project_id=r.project_id AND t.task_id=r.task_id
    AND t.current_revision_id=r.revision_id;
-- Drain legacy deferred FK events before the following ALTER TABLE statements.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE task ENABLE TRIGGER advance_task_version;
ALTER TABLE task_revision ENABLE TRIGGER immutable_task_revision;

-- One new primary Document per legacy Task, with one byte-exact Markdown revision
-- per immutable historical TaskRevision. A sealed current legacy basis is existing
-- approval evidence: mark that primary revision published without changing basis.
INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
  SELECT t.project_id,t.content_document_id,t.title,t.version,t.content_revision_id,
    CASE WHEN EXISTS(SELECT 1 FROM task_revision r JOIN basis_set b
      ON b.project_id=r.project_id AND b.task_id=r.task_id AND b.task_revision_id=r.revision_id
      AND b.basis_set_id=r.basis_set_id AND b.sealed
      WHERE r.project_id=t.project_id AND r.task_id=t.task_id AND r.revision_id=t.current_revision_id)
      THEN t.content_revision_id ELSE NULL END,
    'task',CASE WHEN EXISTS(SELECT 1 FROM task_revision r JOIN basis_set b
      ON b.project_id=r.project_id AND b.task_id=r.task_id AND b.task_revision_id=r.revision_id
      AND b.basis_set_id=r.basis_set_id AND b.sealed
      WHERE r.project_id=t.project_id AND r.task_id=t.task_id AND r.revision_id=t.current_revision_id)
      THEN 'published' ELSE 'draft' END
  FROM task t;
WITH history AS (
  SELECT r.*, lag(r.content_revision_id) OVER (PARTITION BY r.project_id,r.task_id ORDER BY r.version) AS previous_content_revision_id
  FROM task_revision r
)
INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
  author,created_at,previous_revision_id,reason,media_type,original_name,assets_manifest)
  SELECT project_id,content_document_id,content_revision_id,goal,'markdown',
    encode(sha256(convert_to(goal,'UTF8')),'hex'),actor_id,created_at,previous_content_revision_id,
    'Legacy Task content preservation','text/markdown',task_id::text || '.md','[]'::jsonb
  FROM history;
INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at)
  SELECT t.project_id,gen_random_uuid(),t.content_document_id,t.content_revision_id,
    r.actor_id,'Migration record derived from existing sealed Task basis',r.created_at
  FROM task t JOIN task_revision r ON r.project_id=t.project_id AND r.task_id=t.task_id
    AND r.revision_id=t.current_revision_id
  JOIN process_document d ON d.project_id=t.project_id AND d.document_id=t.content_document_id
  WHERE d.adopted_revision_id IS NOT NULL;

ALTER TABLE task ALTER COLUMN content_document_id SET NOT NULL;
ALTER TABLE task ALTER COLUMN content_revision_id SET NOT NULL;
ALTER TABLE task_revision ALTER COLUMN content_document_id SET NOT NULL;
ALTER TABLE task_revision ALTER COLUMN content_revision_id SET NOT NULL;
ALTER TABLE task DROP COLUMN goal;
ALTER TABLE task_revision DROP COLUMN goal;

ALTER TABLE task ADD CONSTRAINT task_state_check CHECK(state IN ('todo','in_progress','done','cancelled'));
-- Legacy states remain readable in immutable old revisions; new inserts are restricted below.
ALTER TABLE task_revision DROP CONSTRAINT task_revision_state_check;
ALTER TABLE task_revision ADD CONSTRAINT task_revision_state_check
  CHECK(state IN ('todo','in_progress','done','cancelled','proposed','ready','active','review','blocked','deferred'));
ALTER TABLE task_revision DROP CONSTRAINT task_revision_basis_state_check;
ALTER TABLE task_revision ADD CONSTRAINT task_revision_basis_state_check
  CHECK(state NOT IN ('in_progress','done','ready','active','review','blocked','deferred') OR basis_set_id IS NOT NULL);

ALTER TABLE task ADD CONSTRAINT task_content_document_fk
  FOREIGN KEY(project_id,content_document_id) REFERENCES process_document(project_id,document_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE task ADD CONSTRAINT task_content_revision_fk
  FOREIGN KEY(project_id,content_document_id,content_revision_id)
  REFERENCES document_revision(project_id,document_id,revision_id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX task_primary_document_unique ON task(project_id,content_document_id);
ALTER TABLE task_revision ADD CONSTRAINT task_revision_content_fk
  FOREIGN KEY(project_id,content_document_id,content_revision_id)
  REFERENCES document_revision(project_id,document_id,revision_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION c5_task_revision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state NOT IN ('todo','in_progress','done','cancelled') THEN
    RAISE EXCEPTION 'new Task revisions require four-state lifecycle' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c5_task_revision_state_guard BEFORE INSERT ON task_revision
  FOR EACH ROW EXECUTE FUNCTION c5_task_revision_insert();

CREATE FUNCTION c5_task_primary_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_document_id IS DISTINCT FROM OLD.content_document_id THEN
    RAISE EXCEPTION 'Task primary Document identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c5_task_primary_identity_guard BEFORE UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION c5_task_primary_identity();

CREATE FUNCTION c5_check_task_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_task task%ROWTYPE;
DECLARE source_doc process_document%ROWTYPE;
DECLARE source_revision document_revision%ROWTYPE;
BEGIN
  SELECT * INTO current_task FROM task WHERE project_id=NEW.project_id AND task_id=NEW.task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO source_doc FROM process_document WHERE project_id=current_task.project_id
    AND document_id=current_task.content_document_id;
  SELECT * INTO source_revision FROM document_revision WHERE project_id=current_task.project_id
    AND document_id=current_task.content_document_id AND revision_id=current_task.content_revision_id;
  IF source_doc.kind IS DISTINCT FROM 'task' OR source_doc.current_revision_id IS DISTINCT FROM current_task.content_revision_id
    OR source_revision.body IS NULL OR source_revision.format IS DISTINCT FROM 'markdown' THEN
    RAISE EXCEPTION 'Task primary content must pin its own current Markdown Document revision' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='task_revision' AND (NEW.content_document_id IS DISTINCT FROM current_task.content_document_id
      OR NOT EXISTS(SELECT 1 FROM document_revision dr WHERE dr.project_id=NEW.project_id
        AND dr.document_id=NEW.content_document_id AND dr.revision_id=NEW.content_revision_id
        AND dr.body IS NOT NULL AND dr.format='markdown')) THEN
    RAISE EXCEPTION 'Task revision primary content must belong to the Task Document' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER c5_task_content_head AFTER INSERT OR UPDATE ON task
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION c5_check_task_content();
CREATE CONSTRAINT TRIGGER c5_task_content_revision AFTER INSERT ON task_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION c5_check_task_content();

CREATE FUNCTION c5_check_owned_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_task task%ROWTYPE;
BEGIN
  SELECT * INTO owner_task FROM task WHERE project_id=NEW.project_id AND content_document_id=NEW.document_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NEW.kind IS DISTINCT FROM 'task' OR NEW.current_revision_id IS DISTINCT FROM owner_task.content_revision_id
    OR NEW.status='archived'
    OR (OLD.status<>'published' AND NEW.status='published' AND owner_task.state NOT IN ('in_progress','done')) THEN
    RAISE EXCEPTION 'Task primary Document must advance with its Task' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER c5_owned_document_head AFTER UPDATE ON process_document
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION c5_check_owned_document();

CREATE OR REPLACE FUNCTION check_task_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_task task%ROWTYPE;
DECLARE current_revision task_revision%ROWTYPE;
DECLARE mapped_state text;
BEGIN
  SELECT * INTO current_task FROM task WHERE project_id=NEW.project_id AND task_id=NEW.task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO current_revision FROM task_revision WHERE project_id=current_task.project_id
    AND task_id=current_task.task_id AND revision_id=current_task.current_revision_id;
  mapped_state := CASE WHEN current_revision.state IN ('proposed','ready','blocked','deferred') THEN 'todo'
                       WHEN current_revision.state IN ('active','review') THEN 'in_progress'
                       ELSE current_revision.state END;
  IF NOT FOUND OR current_revision.version <> current_task.version
    OR current_revision.title <> current_task.title
    OR current_revision.acceptance <> current_task.acceptance
    OR current_revision.owner <> current_task.owner
    OR current_revision.kind IS DISTINCT FROM current_task.kind
    OR current_revision.content_document_id <> current_task.content_document_id
    OR current_revision.content_revision_id <> current_task.content_revision_id
    OR mapped_state <> current_task.state THEN
    RAISE EXCEPTION 'Task head does not match current revision' USING ERRCODE='23514';
  END IF;
  IF current_task.state IN ('in_progress','done') AND (current_revision.basis_set_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM basis_set b WHERE b.project_id=current_task.project_id AND b.task_id=current_task.task_id
      AND b.task_revision_id=current_revision.revision_id AND b.basis_set_id=current_revision.basis_set_id AND b.sealed
  )) THEN RAISE EXCEPTION 'active Task requires sealed basis' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_head_basis_check AFTER INSERT OR UPDATE ON task
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_task_head();
