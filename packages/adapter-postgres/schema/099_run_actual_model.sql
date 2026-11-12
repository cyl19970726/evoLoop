-- What the runtime reported about a Run's Turn (the model that answered, the effort in force, the subagents' models), kept beside the
-- configured executionProfile. A field that was not observed stays null inside the object; nothing is ever filled from the configuration.
-- Historical rows stay NULL ("not recorded").
ALTER TABLE runtime_run ADD COLUMN actual jsonb
  CHECK (actual IS NULL OR (jsonb_typeof(actual)='object' AND actual ? 'model' AND actual ? 'reasoningEffort' AND actual ? 'subagentModels'));
-- The most recent exact model any Turn of a Session reported (a Run's or a message's). A table of its own: runtime_session rows may only
-- change with a version bump, and a telemetry write must not conflict with the Session's commands. runtime_session.observed_model stays
-- the thread-creation receipt.
CREATE TABLE runtime_session_actual_model (
  project_id uuid NOT NULL, session_id uuid NOT NULL,
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, session_id),
  FOREIGN KEY (project_id, session_id) REFERENCES runtime_session(project_id, session_id)
);
