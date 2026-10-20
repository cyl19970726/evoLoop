-- External originals remain in Git/OpenViking. These tables carry fixed provenance and human decisions only.
CREATE TABLE formal_source_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, git_source_ref_id uuid NOT NULL,
  document_id uuid NOT NULL, document_revision_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN ('adopted','rejected','incorporated')),
  actor_id text NOT NULL, reason text NOT NULL CHECK(length(reason)>0), created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,decision_id),
  FOREIGN KEY(project_id,git_source_ref_id) REFERENCES git_source_ref(project_id,git_source_ref_id),
  FOREIGN KEY(project_id,document_id,document_revision_id)
    REFERENCES document_revision(project_id,document_id,revision_id)
);
CREATE TRIGGER immutable_formal_source_decision BEFORE UPDATE OR DELETE ON formal_source_decision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE TABLE task_external_ref_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, task_id uuid NOT NULL,
  origin_task_revision_id uuid NOT NULL, slot_id uuid NOT NULL, slot_version integer NOT NULL CHECK(slot_version>0),
  decision text NOT NULL CHECK(decision IN ('adopt','retain','replace')),
  source_kind text NOT NULL CHECK(source_kind IN ('git','wiki')),
  reference_id text NOT NULL, source_revision text NOT NULL, content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  observed_current_revision text NOT NULL, observed_current_hash text NOT NULL CHECK(observed_current_hash ~ '^[a-f0-9]{64}$'),
  observed_current_validity text NOT NULL CHECK(observed_current_validity='valid'),
  reason text NOT NULL CHECK(length(reason)>0), action_impact text NOT NULL CHECK(length(action_impact)>0),
  actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,decision_id),
  UNIQUE(project_id,task_id,slot_id,slot_version),
  UNIQUE(project_id,task_id,slot_id,slot_version,decision_id),
  FOREIGN KEY(project_id,task_id,origin_task_revision_id)
    REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE TRIGGER immutable_task_external_ref_decision BEFORE UPDATE OR DELETE ON task_external_ref_decision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE TABLE task_external_ref_head (
  project_id uuid NOT NULL, task_id uuid NOT NULL, slot_id uuid NOT NULL,
  slot_version integer NOT NULL CHECK(slot_version>0), decision_id uuid NOT NULL,
  PRIMARY KEY(project_id,task_id,slot_id),
  FOREIGN KEY(project_id,task_id,slot_id,slot_version,decision_id)
    REFERENCES task_external_ref_decision(project_id,task_id,slot_id,slot_version,decision_id)
);
CREATE TABLE task_external_ref_snapshot (
  project_id uuid NOT NULL, task_id uuid NOT NULL, task_revision_id uuid NOT NULL,
  slot_id uuid NOT NULL, slot_version integer NOT NULL, decision_id uuid NOT NULL,
  PRIMARY KEY(project_id,task_id,task_revision_id,slot_id),
  FOREIGN KEY(project_id,task_id,task_revision_id)
    REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY(project_id,task_id,slot_id,slot_version,decision_id)
    REFERENCES task_external_ref_decision(project_id,task_id,slot_id,slot_version,decision_id)
);
CREATE TRIGGER immutable_task_external_ref_snapshot BEFORE UPDATE OR DELETE ON task_external_ref_snapshot
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE FUNCTION snapshot_external_refs_on_task_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO task_external_ref_snapshot(project_id,task_id,task_revision_id,slot_id,slot_version,decision_id)
    SELECT project_id,task_id,NEW.revision_id,slot_id,slot_version,decision_id FROM task_external_ref_head
    WHERE project_id=NEW.project_id AND task_id=NEW.task_id;
  RETURN NEW;
END $$;
CREATE TRIGGER task_revision_external_ref_snapshot AFTER INSERT ON task_revision
  FOR EACH ROW EXECUTE FUNCTION snapshot_external_refs_on_task_revision();
