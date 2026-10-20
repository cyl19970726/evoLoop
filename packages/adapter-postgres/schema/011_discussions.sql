CREATE TABLE discussion (
  project_id uuid NOT NULL, discussion_id uuid NOT NULL, version integer NOT NULL CHECK(version > 0),
  kind text NOT NULL CHECK(kind IN ('allocation','direction')),
  status text NOT NULL CHECK(status IN ('prepared','handed_off','decided','linked')),
  document_id uuid NOT NULL, prepared_document_revision_id uuid NOT NULL,
  current_document_revision_id uuid NOT NULL, latest_decision_event_id uuid,
  goal_id uuid NOT NULL, goal_version integer NOT NULL,
  stage_id uuid, stage_version integer, task_id uuid, task_revision_id uuid,
  adopted_documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  question text NOT NULL, options jsonb NOT NULL, authorization_boundary text NOT NULL,
  target_session_label text NOT NULL, target_session_ref text,
  actor_id text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,discussion_id),
  FOREIGN KEY(project_id,document_id) REFERENCES process_document(project_id,document_id),
  FOREIGN KEY(project_id,document_id,prepared_document_revision_id) REFERENCES document_revision(project_id,document_id,revision_id),
  FOREIGN KEY(project_id,document_id,current_document_revision_id) REFERENCES document_revision(project_id,document_id,revision_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,goal_id,goal_version) REFERENCES goal_revision(project_id,goal_id,version),
  FOREIGN KEY(project_id,stage_id,stage_version) REFERENCES stage_revision(project_id,stage_id,version),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  CHECK ((stage_id IS NULL) = (stage_version IS NULL)),
  CHECK ((task_id IS NULL) = (task_revision_id IS NULL)),
  CHECK (jsonb_typeof(adopted_documents)='array' AND jsonb_typeof(options)='array')
);
CREATE TABLE discussion_event (
  project_id uuid NOT NULL, discussion_id uuid NOT NULL, event_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), kind text NOT NULL CHECK(kind IN ('prepared','handoff','decision','action')),
  document_id uuid NOT NULL, document_revision_id uuid, actor_id text NOT NULL, created_at timestamptz NOT NULL,
  evidence text, reason text, choice text, unresolved text, relook_condition text,
  supersedes_decision_event_id uuid, decision_event_id uuid,
  target_kind text CHECK(target_kind IN ('task','stage','role','document')),
  target_id uuid, target_version integer, target_revision_id uuid,
  PRIMARY KEY(project_id,event_id),
  UNIQUE(project_id,discussion_id,event_id), UNIQUE(project_id,discussion_id,version),
  FOREIGN KEY(project_id,discussion_id) REFERENCES discussion(project_id,discussion_id),
  FOREIGN KEY(project_id,document_id,document_revision_id) REFERENCES document_revision(project_id,document_id,revision_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,discussion_id,supersedes_decision_event_id) REFERENCES discussion_event(project_id,discussion_id,event_id),
  FOREIGN KEY(project_id,discussion_id,decision_event_id) REFERENCES discussion_event(project_id,discussion_id,event_id),
  CHECK ((kind='action') = (target_kind IS NOT NULL)),
  CHECK ((kind='decision') = (choice IS NOT NULL)),
  CHECK ((kind='action') = (decision_event_id IS NOT NULL)),
  CHECK (supersedes_decision_event_id IS NULL OR kind='decision'),
  CHECK ((target_kind IS NULL AND target_id IS NULL AND target_version IS NULL AND target_revision_id IS NULL)
    OR (target_kind='stage' AND target_id IS NOT NULL AND target_version IS NOT NULL AND target_revision_id IS NULL)
    OR (target_kind IN ('task','role','document') AND target_id IS NOT NULL AND target_version IS NULL AND target_revision_id IS NOT NULL))
);
ALTER TABLE discussion ADD CONSTRAINT discussion_latest_decision_fk
  FOREIGN KEY(project_id,discussion_id,latest_decision_event_id) REFERENCES discussion_event(project_id,discussion_id,event_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX discussion_project_list_idx ON discussion(project_id,discussion_id);
CREATE INDEX discussion_event_order_idx ON discussion_event(project_id,discussion_id,version);
CREATE TRIGGER discussion_event_immutable BEFORE UPDATE OR DELETE ON discussion_event FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE FUNCTION protect_discussion_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'discussion version must advance by one' USING ERRCODE='23514';
  END IF;
  IF (NEW.project_id,NEW.discussion_id,NEW.kind,NEW.document_id,NEW.prepared_document_revision_id,
      NEW.goal_id,NEW.goal_version,NEW.stage_id,NEW.stage_version,NEW.task_id,NEW.task_revision_id,
      NEW.adopted_documents,NEW.question,NEW.options,NEW.authorization_boundary,
      NEW.target_session_label,NEW.target_session_ref,NEW.actor_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.project_id,OLD.discussion_id,OLD.kind,OLD.document_id,OLD.prepared_document_revision_id,
      OLD.goal_id,OLD.goal_version,OLD.stage_id,OLD.stage_version,OLD.task_id,OLD.task_revision_id,
      OLD.adopted_documents,OLD.question,OLD.options,OLD.authorization_boundary,
      OLD.target_session_label,OLD.target_session_ref,OLD.actor_id,OLD.created_at) THEN
    RAISE EXCEPTION 'discussion fixed baseline is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discussion_head_protect BEFORE UPDATE ON discussion FOR EACH ROW EXECUTE FUNCTION protect_discussion_head();
