-- Session line (DEC-045 Q1): one ordered line of Tasks per resident business Session. It is a small, separate mechanism; the
-- batch resident queue (027) is untouched. An entry waits while the Session is busy and is released when the Session's Run ends.
CREATE TABLE session_line (
  project_id uuid NOT NULL, session_id uuid NOT NULL, controller_actor_id text NOT NULL CHECK(length(btrim(controller_actor_id))>0),
  version integer NOT NULL CHECK(version>0), created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,session_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE TABLE session_line_entry (
  project_id uuid NOT NULL, entry_id uuid NOT NULL, session_id uuid NOT NULL, task_id uuid NOT NULL,
  position bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','suspended','starting','started','withdrawn')),
  -- While starting: assign (record the assignment, ask the Session) -> confirm (waiting for its execution confirmation) -> start
  -- (confirmed; Task start, assignment on the started revision, Run reserve).
  step text CHECK(step IN ('assign','confirm','start')),
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
  -- A refused step that is only waiting retries under fresh operation ids (a refusal is journalled and would replay forever).
  step_try integer NOT NULL DEFAULT 0 CHECK(step_try>=0),
  assign_operation_id uuid, start_operation_id uuid, reassign_operation_id uuid, reserve_operation_id uuid, message_id uuid,
  suspend_reason text, withdrawn_reason text,
  source text NOT NULL CHECK(source IN ('leader','schedule')),
  source_actor_id text NOT NULL CHECK(length(btrim(source_actor_id))>0), schedule_id uuid,
  release_rule text NOT NULL DEFAULT 'run_end' CHECK(release_rule='run_end'),
  run_id uuid, run_ended_at timestamptz, version integer NOT NULL CHECK(version>0),
  appended_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,entry_id),
  FOREIGN KEY(project_id,session_id) REFERENCES session_line(project_id,session_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id),
  CHECK(state<>'starting' OR step IS NOT NULL), CHECK(state='starting' OR step IS NULL),
  CHECK(state<>'suspended' OR suspend_reason IS NOT NULL), CHECK(state<>'withdrawn' OR withdrawn_reason IS NOT NULL),
  CHECK(state<>'started' OR run_id IS NOT NULL), CHECK(run_ended_at IS NULL OR state='started'), CHECK(source<>'schedule' OR schedule_id IS NOT NULL)
);
-- The same Task cannot wait in two lines (or twice in one) while its entry is still in progress.
CREATE UNIQUE INDEX session_line_entry_task_live ON session_line_entry(project_id,task_id) WHERE state IN ('queued','suspended','starting');
CREATE INDEX session_line_entry_order ON session_line_entry(project_id,session_id,position,entry_id);
-- Every line event, in order, for the scheduling board (Q2) and for the indicator measurements.
CREATE TABLE session_line_event (
  project_id uuid NOT NULL, event_seq bigint GENERATED ALWAYS AS IDENTITY, session_id uuid NOT NULL, entry_id uuid, task_id uuid,
  kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, actor_id text NOT NULL, at timestamptz NOT NULL,
  PRIMARY KEY(project_id,event_seq)
);
CREATE INDEX session_line_event_session ON session_line_event(project_id,session_id,event_seq);
CREATE TRIGGER session_line_event_immutable BEFORE UPDATE OR DELETE ON session_line_event
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
-- The Session's execution confirmation, recorded on the assignment (extends task.assignment.acknowledge).
CREATE TABLE task_assignment_confirmation (
  project_id uuid NOT NULL, task_id uuid NOT NULL, assignment_version integer NOT NULL CHECK(assignment_version>0),
  verdict text NOT NULL CHECK(verdict IN ('confirm','return')), plan text, missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_revision_id uuid NOT NULL, actor_id text NOT NULL, at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id,assignment_version),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id),
  CHECK(verdict<>'confirm' OR (plan IS NOT NULL AND length(btrim(plan))>0)),
  CHECK(verdict<>'return' OR jsonb_array_length(missing)>0)
);
CREATE TRIGGER task_assignment_confirmation_immutable BEFORE UPDATE OR DELETE ON task_assignment_confirmation
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
