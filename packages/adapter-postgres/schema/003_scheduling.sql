CREATE TABLE schedule_definition (
  project_id uuid NOT NULL REFERENCES project(project_id),
  schedule_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  current_revision_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active','paused','stopped')),
  watermark_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,schedule_id)
);
CREATE TABLE schedule_revision (
  project_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  timezone text NOT NULL,
  rule jsonb NOT NULL,
  misfire jsonb NOT NULL,
  overlap_policy text NOT NULL CHECK (overlap_policy IN ('skip','queue')),
  task_template jsonb NOT NULL,
  authorization_scope jsonb NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,schedule_id,revision_id),
  UNIQUE (project_id,schedule_id,version),
  FOREIGN KEY (project_id,schedule_id) REFERENCES schedule_definition(project_id,schedule_id)
);
ALTER TABLE schedule_definition ADD CONSTRAINT schedule_current_revision_fk
  FOREIGN KEY (project_id,schedule_id,current_revision_id)
  REFERENCES schedule_revision(project_id,schedule_id,revision_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE schedule_decision (
  project_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  schedule_revision_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create','revise','watermark')),
  actor_id text NOT NULL,
  reason text NOT NULL,
  observed_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,decision_id),
  FOREIGN KEY (project_id,schedule_id,schedule_revision_id)
    REFERENCES schedule_revision(project_id,schedule_id,revision_id)
);
CREATE TABLE schedule_occurrence (
  project_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  schedule_revision_id uuid NOT NULL,
  planned_at_utc timestamptz NOT NULL,
  observed_at_utc timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('created','queued','skipped')),
  task_id uuid,
  operation_id uuid NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (project_id,schedule_id,planned_at_utc),
  UNIQUE (project_id,operation_id),
  UNIQUE (project_id,task_id),
  FOREIGN KEY (project_id,schedule_id,schedule_revision_id)
    REFERENCES schedule_revision(project_id,schedule_id,revision_id),
  FOREIGN KEY (project_id,task_id) REFERENCES task(project_id,task_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((state='created' AND task_id IS NOT NULL) OR (state<>'created' AND task_id IS NULL))
);
CREATE INDEX schedule_active_idx ON schedule_definition(project_id,state,watermark_utc);
CREATE INDEX schedule_queued_idx ON schedule_occurrence(project_id,schedule_id,planned_at_utc) WHERE state='queued';
CREATE TRIGGER immutable_schedule_revision BEFORE UPDATE OR DELETE ON schedule_revision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER immutable_schedule_decision BEFORE UPDATE OR DELETE ON schedule_decision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
