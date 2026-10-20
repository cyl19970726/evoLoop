CREATE TABLE runtime_session (
  project_id uuid NOT NULL REFERENCES project(project_id),
  session_id uuid NOT NULL, role_id text NOT NULL, cwd text NOT NULL,
  authorization_scope text NOT NULL, model text,
  sandbox text NOT NULL CHECK(sandbox IN ('read-only','workspace-write')),
  approval_policy text NOT NULL CHECK(approval_policy IN ('on-request','untrusted')),
  state text NOT NULL CHECK(state IN ('reserved','creating','ready','unknown','closed')),
  version integer NOT NULL CHECK(version > 0),
  native_thread_id text, native_session_id text,
  operation_id uuid NOT NULL, actor_id text NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,session_id),
  UNIQUE(project_id,operation_id),
  CHECK((native_thread_id IS NULL) = (native_session_id IS NULL)),
  CHECK(state <> 'ready' OR native_thread_id IS NOT NULL)
);
CREATE UNIQUE INDEX runtime_native_thread_unique ON runtime_session(native_thread_id) WHERE native_thread_id IS NOT NULL;

CREATE TABLE runtime_run (
  project_id uuid NOT NULL, run_id uuid NOT NULL, task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL, basis_set_id uuid NOT NULL,
  session_id uuid NOT NULL, operation_id uuid NOT NULL,
  input text NOT NULL, input_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('requested','dispatching','running','completed','failed','interrupted','unknown')),
  version integer NOT NULL CHECK(version > 0), native_turn_id text,
  interrupt_requested boolean NOT NULL DEFAULT false,
  result_summary text, actor_id text NOT NULL,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,run_id), UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,task_id,task_revision_id,basis_set_id)
    REFERENCES basis_set(project_id,task_id,task_revision_id,basis_set_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK(state NOT IN ('running','completed','interrupted') OR native_turn_id IS NOT NULL)
);
CREATE UNIQUE INDEX runtime_run_active_task ON runtime_run(project_id,task_id)
  WHERE state IN ('requested','dispatching','running','unknown');
CREATE UNIQUE INDEX runtime_run_active_session ON runtime_run(project_id,session_id)
  WHERE state IN ('requested','dispatching','running','unknown');
CREATE UNIQUE INDEX runtime_run_native_turn ON runtime_run(project_id,native_turn_id)
  WHERE native_turn_id IS NOT NULL;

CREATE TABLE runtime_record_event (
  sequence bigint GENERATED ALWAYS AS IDENTITY, project_id uuid NOT NULL, event_id uuid NOT NULL, run_id uuid, session_id uuid,
  kind text NOT NULL, detail text NOT NULL, native_turn_id text,
  cursor text, items_digest text,
  actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,event_id),
  CHECK(run_id IS NOT NULL OR session_id IS NOT NULL),
  FOREIGN KEY(project_id,run_id) REFERENCES runtime_run(project_id,run_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE INDEX runtime_event_run_idx ON runtime_record_event(project_id,run_id,sequence);

CREATE FUNCTION protect_runtime_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'runtime record cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='runtime_session' THEN
    IF NEW.project_id<>OLD.project_id OR NEW.session_id<>OLD.session_id OR NEW.role_id<>OLD.role_id
      OR NEW.cwd<>OLD.cwd OR NEW.authorization_scope<>OLD.authorization_scope
      OR NEW.model IS DISTINCT FROM OLD.model
      OR NEW.sandbox<>OLD.sandbox OR NEW.approval_policy<>OLD.approval_policy
      OR NEW.operation_id<>OLD.operation_id OR NEW.actor_id<>OLD.actor_id OR NEW.created_at<>OLD.created_at
      OR (OLD.native_thread_id IS NOT NULL AND (NEW.native_thread_id IS DISTINCT FROM OLD.native_thread_id OR NEW.native_session_id IS DISTINCT FROM OLD.native_session_id))
      OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'runtime session identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.project_id<>OLD.project_id OR NEW.run_id<>OLD.run_id OR NEW.task_id<>OLD.task_id
      OR NEW.task_revision_id<>OLD.task_revision_id OR NEW.basis_set_id<>OLD.basis_set_id
      OR NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
      OR NEW.input<>OLD.input OR NEW.input_hash<>OLD.input_hash OR NEW.actor_id<>OLD.actor_id
      OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
      OR (OLD.native_turn_id IS NOT NULL AND NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id) THEN
      RAISE EXCEPTION 'runtime run origin is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_identity BEFORE UPDATE OR DELETE ON runtime_session FOR EACH ROW EXECUTE FUNCTION protect_runtime_identity();
CREATE TRIGGER runtime_run_identity BEFORE UPDATE OR DELETE ON runtime_run FOR EACH ROW EXECUTE FUNCTION protect_runtime_identity();
CREATE TRIGGER runtime_event_immutable BEFORE UPDATE OR DELETE ON runtime_record_event FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
