CREATE TABLE project (
  project_id uuid PRIMARY KEY,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE process_document (
  project_id uuid NOT NULL REFERENCES project(project_id),
  document_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  version integer NOT NULL CHECK (version > 0),
  current_revision_id uuid NOT NULL,
  adopted_revision_id uuid,
  PRIMARY KEY (project_id, document_id)
);
CREATE TABLE document_revision (
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) > 0),
  format text NOT NULL CHECK (format = 'markdown'),
  content_hash text NOT NULL,
  author text NOT NULL,
  created_at timestamptz NOT NULL,
  previous_revision_id uuid,
  reason text NOT NULL,
  PRIMARY KEY (project_id, document_id, revision_id),
  FOREIGN KEY (project_id, document_id) REFERENCES process_document(project_id, document_id),
  FOREIGN KEY (project_id, document_id, previous_revision_id)
    REFERENCES document_revision(project_id, document_id, revision_id)
);
ALTER TABLE process_document ADD CONSTRAINT document_current_revision_fk
  FOREIGN KEY (project_id, document_id, current_revision_id)
  REFERENCES document_revision(project_id, document_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE process_document ADD CONSTRAINT document_adopted_revision_fk
  FOREIGN KEY (project_id, document_id, adopted_revision_id)
  REFERENCES document_revision(project_id, document_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE document_decision (
  project_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, decision_id),
  FOREIGN KEY (project_id, document_id, revision_id)
    REFERENCES document_revision(project_id, document_id, revision_id)
);
CREATE INDEX document_decision_revision_idx ON document_decision(project_id, document_id, revision_id);

CREATE TABLE task (
  project_id uuid NOT NULL REFERENCES project(project_id),
  task_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  current_revision_id uuid NOT NULL,
  title text NOT NULL,
  goal text NOT NULL,
  acceptance text NOT NULL,
  owner text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','ready','active','review','done','blocked','deferred','cancelled')),
  PRIMARY KEY (project_id, task_id)
);
CREATE TABLE task_revision (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  goal text NOT NULL,
  acceptance text NOT NULL,
  owner text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','ready','active','review','done','blocked','deferred','cancelled')),
  basis_set_id uuid,
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, task_id, revision_id),
  UNIQUE (project_id, task_id, version),
  CHECK ((state = 'proposed' AND basis_set_id IS NULL) OR (state <> 'proposed' AND basis_set_id IS NOT NULL)),
  FOREIGN KEY (project_id, task_id) REFERENCES task(project_id, task_id)
);
ALTER TABLE task ADD CONSTRAINT task_current_revision_fk
  FOREIGN KEY (project_id, task_id, current_revision_id)
  REFERENCES task_revision(project_id, task_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE basis_set (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL,
  basis_set_id uuid NOT NULL,
  sealed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (project_id, task_id, task_revision_id, basis_set_id),
  UNIQUE (project_id, task_id, task_revision_id),
  FOREIGN KEY (project_id, task_id, task_revision_id)
    REFERENCES task_revision(project_id, task_id, revision_id)
);
ALTER TABLE task_revision ADD CONSTRAINT task_revision_basis_fk
  FOREIGN KEY (project_id, task_id, revision_id, basis_set_id)
  REFERENCES basis_set(project_id, task_id, task_revision_id, basis_set_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE basis_member (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL,
  basis_set_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_revision_id uuid NOT NULL,
  PRIMARY KEY (project_id, task_id, task_revision_id, basis_set_id, document_id, document_revision_id),
  UNIQUE (project_id, task_id, task_revision_id, basis_set_id, document_id),
  FOREIGN KEY (project_id, task_id, task_revision_id, basis_set_id)
    REFERENCES basis_set(project_id, task_id, task_revision_id, basis_set_id),
  FOREIGN KEY (project_id, document_id, document_revision_id)
    REFERENCES document_revision(project_id, document_id, revision_id)
);
CREATE INDEX basis_member_document_idx ON basis_member(project_id, document_id, document_revision_id);

CREATE TABLE task_document_link (
  project_id uuid NOT NULL,
  link_id uuid NOT NULL,
  task_id uuid NOT NULL,
  document_id uuid NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, link_id),
  UNIQUE (project_id, task_id, document_id),
  FOREIGN KEY (project_id, task_id) REFERENCES task(project_id, task_id),
  FOREIGN KEY (project_id, document_id) REFERENCES process_document(project_id, document_id)
);
CREATE INDEX task_document_link_task_idx ON task_document_link(project_id, task_id, link_id);

CREATE TABLE impact_review (
  project_id uuid NOT NULL,
  impact_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL,
  document_id uuid NOT NULL,
  from_revision_id uuid NOT NULL,
  to_revision_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','resolved','superseded')),
  decision_id uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, impact_id),
  UNIQUE (project_id, impact_id, task_id, task_revision_id),
  UNIQUE (project_id, task_id, task_revision_id, document_id, from_revision_id, to_revision_id),
  CHECK (from_revision_id <> to_revision_id),
  CHECK ((state = 'resolved' AND decision_id IS NOT NULL) OR (state <> 'resolved' AND decision_id IS NULL)),
  FOREIGN KEY (project_id, task_id, task_revision_id)
    REFERENCES task_revision(project_id, task_id, revision_id),
  FOREIGN KEY (project_id, document_id, from_revision_id)
    REFERENCES document_revision(project_id, document_id, revision_id),
  FOREIGN KEY (project_id, document_id, to_revision_id)
    REFERENCES document_revision(project_id, document_id, revision_id)
);
CREATE INDEX impact_review_task_idx ON impact_review(project_id, task_id, state, created_at, impact_id);
CREATE TABLE basis_decision (
  project_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  impact_id uuid NOT NULL,
  task_id uuid NOT NULL,
  previous_task_revision_id uuid NOT NULL,
  next_task_revision_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('adopt','retain')),
  reason text NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, decision_id),
  UNIQUE (project_id, impact_id),
  UNIQUE (project_id, impact_id, decision_id),
  FOREIGN KEY (project_id, impact_id, task_id, previous_task_revision_id)
    REFERENCES impact_review(project_id, impact_id, task_id, task_revision_id),
  FOREIGN KEY (project_id, task_id, previous_task_revision_id)
    REFERENCES task_revision(project_id, task_id, revision_id),
  FOREIGN KEY (project_id, task_id, next_task_revision_id)
    REFERENCES task_revision(project_id, task_id, revision_id)
);
ALTER TABLE impact_review ADD CONSTRAINT impact_decision_fk
  FOREIGN KEY (project_id, impact_id, decision_id)
  REFERENCES basis_decision(project_id, impact_id, decision_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE operation_journal (
  project_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL,
  command_hash text NOT NULL,
  command_type text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, operation_id),
  FOREIGN KEY (project_id) REFERENCES project(project_id)
);
CREATE TABLE outbox_event (
  project_id uuid NOT NULL,
  event_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  effect_key text NOT NULL,
  kind text NOT NULL,
  entity_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, event_id),
  UNIQUE (project_id, operation_id, effect_key, kind),
  FOREIGN KEY (project_id, operation_id) REFERENCES operation_journal(project_id, operation_id)
);

CREATE FUNCTION deny_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_document_revision BEFORE UPDATE OR DELETE ON document_revision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER immutable_document_decision BEFORE UPDATE OR DELETE ON document_decision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER immutable_task_revision BEFORE UPDATE OR DELETE ON task_revision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER immutable_basis_decision BEFORE UPDATE OR DELETE ON basis_decision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER immutable_operation_journal BEFORE UPDATE OR DELETE ON operation_journal FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER immutable_outbox_event BEFORE UPDATE OR DELETE ON outbox_event FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE FUNCTION advance_head_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.project_id <> OLD.project_id OR NEW.version <> OLD.version + 1) THEN
    RAISE EXCEPTION 'head version must advance exactly once in its project' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'task' THEN
    IF NEW.task_id <> OLD.task_id THEN
      RAISE EXCEPTION 'task identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'process_document' THEN
    IF NEW.document_id <> OLD.document_id THEN
      RAISE EXCEPTION 'document identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER advance_document_version BEFORE UPDATE ON process_document FOR EACH ROW EXECUTE FUNCTION advance_head_version();
CREATE TRIGGER advance_task_version BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION advance_head_version();

CREATE FUNCTION check_document_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_doc process_document%ROWTYPE;
BEGIN
  SELECT * INTO current_doc FROM process_document WHERE project_id = NEW.project_id AND document_id = NEW.document_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF current_doc.adopted_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_decision d WHERE d.project_id = current_doc.project_id
      AND d.document_id = current_doc.document_id AND d.revision_id = current_doc.adopted_revision_id
  ) THEN
    RAISE EXCEPTION 'adopted revision lacks approval decision' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER document_head_decision_check
  AFTER INSERT OR UPDATE ON process_document DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_document_head();

CREATE FUNCTION check_task_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_task task%ROWTYPE;
DECLARE current_revision task_revision%ROWTYPE;
BEGIN
  SELECT * INTO current_task FROM task WHERE project_id = NEW.project_id AND task_id = NEW.task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO current_revision FROM task_revision WHERE project_id = current_task.project_id
    AND task_id = current_task.task_id AND revision_id = current_task.current_revision_id;
  IF NOT FOUND OR current_revision.version <> current_task.version
    OR current_revision.title <> current_task.title OR current_revision.goal <> current_task.goal
    OR current_revision.acceptance <> current_task.acceptance OR current_revision.owner <> current_task.owner
    OR current_revision.state <> current_task.state THEN
    RAISE EXCEPTION 'task head does not match current revision' USING ERRCODE = '23514';
  END IF;
  IF current_task.state <> 'proposed' AND (current_revision.basis_set_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM basis_set b WHERE b.project_id = current_task.project_id AND b.task_id = current_task.task_id
      AND b.task_revision_id = current_revision.revision_id AND b.basis_set_id = current_revision.basis_set_id AND b.sealed
  )) THEN
    RAISE EXCEPTION 'active task requires sealed basis' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_head_basis_check
  AFTER INSERT OR UPDATE ON task DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_task_head();

CREATE FUNCTION check_task_revision_basis() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.basis_set_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM basis_set b WHERE b.project_id=NEW.project_id AND b.task_id=NEW.task_id
      AND b.task_revision_id=NEW.revision_id AND b.basis_set_id=NEW.basis_set_id AND b.sealed
  ) THEN
    RAISE EXCEPTION 'task revision requires sealed basis' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_revision_basis_check
  AFTER INSERT ON task_revision DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_task_revision_basis();

CREATE FUNCTION protect_basis_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'basis set cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF OLD.sealed OR NEW.project_id <> OLD.project_id OR NEW.task_id <> OLD.task_id
    OR NEW.task_revision_id <> OLD.task_revision_id OR NEW.basis_set_id <> OLD.basis_set_id
    OR NOT NEW.sealed THEN
    RAISE EXCEPTION 'basis set can only be sealed once' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM basis_member m WHERE m.project_id = OLD.project_id AND m.task_id = OLD.task_id
    AND m.task_revision_id = OLD.task_revision_id AND m.basis_set_id = OLD.basis_set_id) THEN
    RAISE EXCEPTION 'cannot seal empty basis set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_basis_set_change BEFORE UPDATE OR DELETE ON basis_set FOR EACH ROW EXECUTE FUNCTION protect_basis_set();
CREATE FUNCTION protect_basis_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked_sealed boolean;
DECLARE member basis_member%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN member := NEW; ELSE member := OLD; END IF;
  SELECT sealed INTO locked_sealed FROM basis_set b WHERE b.project_id = member.project_id
    AND b.task_id = member.task_id
    AND b.task_revision_id = member.task_revision_id
    AND b.basis_set_id = member.basis_set_id FOR UPDATE;
  IF locked_sealed THEN RAISE EXCEPTION 'sealed basis members are immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'basis member updates are forbidden' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_basis_member_change BEFORE INSERT OR UPDATE OR DELETE ON basis_member FOR EACH ROW EXECUTE FUNCTION protect_basis_member();

CREATE FUNCTION protect_link_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'relation deletion is forbidden' USING ERRCODE = '23514'; END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.link_id <> OLD.link_id OR NEW.task_id <> OLD.task_id
    OR NEW.document_id <> OLD.document_id OR NEW.actor_id <> OLD.actor_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'relation identity and provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_link_change BEFORE UPDATE OR DELETE ON task_document_link FOR EACH ROW EXECUTE FUNCTION protect_link_identity();
CREATE FUNCTION protect_impact_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'impact history cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF NEW.project_id <> OLD.project_id OR NEW.impact_id <> OLD.impact_id OR NEW.task_id <> OLD.task_id
    OR NEW.task_revision_id <> OLD.task_revision_id OR NEW.document_id <> OLD.document_id
    OR NEW.from_revision_id <> OLD.from_revision_id OR NEW.to_revision_id <> OLD.to_revision_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'impact origin is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'pending' OR NEW.state NOT IN ('resolved', 'superseded') THEN
    RAISE EXCEPTION 'impact may only leave pending once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_impact_change BEFORE UPDATE OR DELETE ON impact_review FOR EACH ROW EXECUTE FUNCTION protect_impact_origin();
