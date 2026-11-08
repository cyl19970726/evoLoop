-- One durable maintenance intent per native request. A lost reply never permits replay.
CREATE TABLE session_compaction (
  project_id uuid NOT NULL, operation_id uuid NOT NULL, session_id uuid NOT NULL,
  thread_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  gate_version integer NOT NULL, session_version integer NOT NULL,
  actor_id text NOT NULL, evidence_ref text NOT NULL, reason text NOT NULL,
  state text NOT NULL CHECK(state IN ('unknown','accepted','completed','failed')),
  native_request_id integer, native_acknowledged_at timestamptz, native_connection_id text,
  CONSTRAINT compaction_ack_connection CHECK (
    (native_acknowledged_at IS NULL AND native_connection_id IS NULL) OR
    (native_acknowledged_at IS NOT NULL AND native_connection_id IS NOT NULL AND native_request_id IS NOT NULL)),
  baseline_turn_id text, native_turn_id text,
  compaction_item_id text, error_code text,
  before_input_tokens bigint, after_input_tokens bigint,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,operation_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE UNIQUE INDEX session_compaction_pending_session ON session_compaction(project_id,session_id)
  WHERE state IN ('unknown','accepted');
CREATE UNIQUE INDEX session_compaction_one_per_gate ON session_compaction(project_id,session_id,gate_version);
CREATE INDEX session_compaction_session_history ON session_compaction(project_id,session_id,created_at DESC);

-- Recovery decisions and dispatch admission share this gate lock. A maintenance
-- operation cannot accidentally open the gate while its native outcome is unsettled.
CREATE FUNCTION session_compaction_guard_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM session_compaction WHERE project_id=NEW.project_id
      AND session_id=NEW.session_id AND state IN ('unknown','accepted')) THEN
    RAISE EXCEPTION 'compaction maintenance has unresolved native outcome' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_compaction_gate_guard BEFORE UPDATE ON session_recovery_gate
  FOR EACH ROW EXECUTE FUNCTION session_compaction_guard_gate();
