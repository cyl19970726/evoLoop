-- Captured while the old coordinator and its one native child are alive.
-- This is an append-only identity anchor, not authority to stop either process.
CREATE TABLE session_message_manual_stop_preflight (
  project_id uuid NOT NULL,
  message_id uuid NOT NULL,
  preflight_id uuid NOT NULL,
  processing_id uuid NOT NULL,
  session_id uuid NOT NULL,
  native_turn_id text NOT NULL,
  native_thread_id text NOT NULL CHECK (length(btrim(native_thread_id)) > 0),
  message_version integer NOT NULL CHECK (message_version > 0),
  processing_version integer NOT NULL CHECK (processing_version > 0),
  host text NOT NULL CHECK (length(btrim(host)) > 0),
  captured_by_actor_id text NOT NULL CHECK (length(btrim(captured_by_actor_id)) > 0),
  listen_port integer NOT NULL CHECK (listen_port BETWEEN 1 AND 65535),
  old_coordinator_pid integer NOT NULL CHECK (old_coordinator_pid > 0),
  old_coordinator_start_identity text NOT NULL CHECK (length(btrim(old_coordinator_start_identity)) BETWEEN 1 AND 240),
  old_native_pid integer NOT NULL CHECK (old_native_pid > 0 AND old_native_pid <> old_coordinator_pid),
  old_native_start_identity text NOT NULL CHECK (length(btrim(old_native_start_identity)) BETWEEN 1 AND 240),
  pre_stop_evidence_json text NOT NULL CHECK (length(pre_stop_evidence_json) BETWEEN 1 AND 16000),
  pre_stop_evidence_hash text NOT NULL CHECK (pre_stop_evidence_hash ~ '^[a-f0-9]{64}$'),
  capture_file_ref text NOT NULL CHECK (length(btrim(capture_file_ref)) BETWEEN 1 AND 4000),
  capture_file_hash text NOT NULL CHECK (capture_file_hash ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id,message_id),
  UNIQUE (project_id,preflight_id),
  UNIQUE (project_id,preflight_id,message_id),
  FOREIGN KEY (project_id,processing_id,message_id,session_id,native_turn_id)
    REFERENCES session_message_processing(project_id,processing_id,message_id,session_id,native_turn_id),
  FOREIGN KEY (project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE TRIGGER session_message_manual_stop_preflight_immutable BEFORE UPDATE OR DELETE
  ON session_message_manual_stop_preflight FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

-- A legacy 049 row stays readable. Every new stop must name its exact preflight.
ALTER TABLE session_message_manual_stop_evidence ADD COLUMN preflight_id uuid;
ALTER TABLE session_message_manual_stop_evidence ADD CONSTRAINT manual_stop_preflight_original
  FOREIGN KEY (project_id,preflight_id,message_id)
  REFERENCES session_message_manual_stop_preflight(project_id,preflight_id,message_id);
CREATE FUNCTION require_manual_stop_preflight() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.preflight_id IS NULL THEN
    RAISE EXCEPTION 'manual stop requires an immutable preflight' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manual_stop_preflight_required BEFORE INSERT ON session_message_manual_stop_evidence
  FOR EACH ROW EXECUTE FUNCTION require_manual_stop_preflight();
