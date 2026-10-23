CREATE TABLE orchestration_loop (
  project_id uuid NOT NULL REFERENCES project(project_id), loop_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('active','paused','stopped')),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(project_id,loop_id)
);
CREATE TABLE orchestration_inbox (
  project_id uuid NOT NULL, inbox_id uuid NOT NULL, loop_id uuid NOT NULL,
  source_event_id uuid NOT NULL, recipient_role_id text NOT NULL, purpose text NOT NULL,
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN ('pending','acknowledged','disposed')),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(project_id,inbox_id), UNIQUE(project_id,loop_id,source_event_id,recipient_role_id,purpose),
  FOREIGN KEY(project_id,loop_id) REFERENCES orchestration_loop(project_id,loop_id)
);
CREATE TABLE orchestration_dispatch (
  project_id uuid NOT NULL, dispatch_id uuid NOT NULL, loop_id uuid NOT NULL, inbox_id uuid NOT NULL,
  task_id uuid NOT NULL, task_version integer NOT NULL CHECK(task_version>0),
  version integer NOT NULL CHECK(version>0), state text NOT NULL CHECK(state IN
    ('pending','claimed','dispatching','accepted','unknown','rejected','completed')),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(project_id,dispatch_id), UNIQUE(project_id,inbox_id),
  FOREIGN KEY(project_id,loop_id) REFERENCES orchestration_loop(project_id,loop_id),
  FOREIGN KEY(project_id,inbox_id) REFERENCES orchestration_inbox(project_id,inbox_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id)
);
CREATE TABLE orchestration_operation (
  project_id uuid NOT NULL REFERENCES project(project_id), operation_id uuid NOT NULL,
  actor_id text NOT NULL, command_hash text NOT NULL, result jsonb NOT NULL,
  created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,operation_id)
);
CREATE TABLE orchestration_submission (
  project_id uuid NOT NULL, submission_id uuid NOT NULL, dispatch_id uuid NOT NULL,
  loop_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  state text NOT NULL CHECK(state IN ('submitted','sealing','sealed','unknown','rejected')),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(project_id,submission_id), UNIQUE(project_id,dispatch_id),
  FOREIGN KEY(project_id,dispatch_id) REFERENCES orchestration_dispatch(project_id,dispatch_id),
  FOREIGN KEY(project_id,loop_id) REFERENCES orchestration_loop(project_id,loop_id)
);
CREATE TABLE orchestration_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, dispatch_id uuid NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(project_id,decision_id), UNIQUE(project_id,dispatch_id),
  FOREIGN KEY(project_id,dispatch_id) REFERENCES orchestration_dispatch(project_id,dispatch_id)
);
CREATE TABLE orchestration_event (
  project_id uuid NOT NULL, event_id uuid NOT NULL, loop_id uuid NOT NULL,
  entity_type text NOT NULL CHECK(entity_type IN ('loop','inbox','dispatch','submission','decision')),
  entity_id uuid NOT NULL, operation_id uuid NOT NULL, kind text NOT NULL,
  actor_id text NOT NULL, detail jsonb NOT NULL, created_at_utc timestamptz NOT NULL,
  PRIMARY KEY(project_id,event_id),
  FOREIGN KEY(project_id,loop_id) REFERENCES orchestration_loop(project_id,loop_id),
  FOREIGN KEY(project_id,operation_id) REFERENCES orchestration_operation(project_id,operation_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX orchestration_event_loop ON orchestration_event(project_id,loop_id,event_id);
CREATE TRIGGER orchestration_operation_immutable BEFORE UPDATE OR DELETE ON orchestration_operation
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER orchestration_event_immutable BEFORE UPDATE OR DELETE ON orchestration_event
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER orchestration_decision_immutable BEFORE UPDATE OR DELETE ON orchestration_decision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
