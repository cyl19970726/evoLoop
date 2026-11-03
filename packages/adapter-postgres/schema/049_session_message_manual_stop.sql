-- Append-only evidence for an externally verified stop of the original ordinary message Turn.
-- This migration does not change any existing message or processing state.
CREATE TABLE coordinator_lease_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  nonce uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE session_message_processing ADD CONSTRAINT session_message_processing_manual_stop_identity
  UNIQUE (project_id,processing_id,message_id,session_id,native_turn_id);

CREATE TABLE session_message_manual_stop_evidence (
  project_id uuid NOT NULL,
  message_id uuid NOT NULL,
  processing_id uuid NOT NULL,
  session_id uuid NOT NULL,
  native_turn_id text NOT NULL CHECK (length(btrim(native_turn_id)) BETWEEN 1 AND 256),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
  prior_failure text CHECK (prior_failure IS NULL OR length(prior_failure) <= 4000),
  old_coordinator_pid integer NOT NULL CHECK (old_coordinator_pid > 0),
  old_native_pid integer NOT NULL CHECK (old_native_pid > 0),
  old_coordinator_start_identity text NOT NULL CHECK (length(btrim(old_coordinator_start_identity)) BETWEEN 1 AND 240),
  old_native_start_identity text NOT NULL CHECK (length(btrim(old_native_start_identity)) BETWEEN 1 AND 240),
  exit_evidence_ref text NOT NULL CHECK (length(btrim(exit_evidence_ref)) BETWEEN 1 AND 4000),
  exit_evidence_hash text NOT NULL CHECK (exit_evidence_hash ~ '^[a-f0-9]{64}$'),
  observed_native_status text NOT NULL CHECK (observed_native_status IN ('inProgress','interrupted','failed')),
  observed_thread_status text NOT NULL CHECK (observed_thread_status IN ('idle','notLoaded')),
  observed_item_count integer NOT NULL CHECK (observed_item_count >= 0),
  observed_item_ids_hash text NOT NULL CHECK (observed_item_ids_hash ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (project_id,message_id),
  UNIQUE (project_id,operation_id),
  FOREIGN KEY (project_id,processing_id,message_id,session_id,native_turn_id)
    REFERENCES session_message_processing(project_id,processing_id,message_id,session_id,native_turn_id)
);
CREATE TRIGGER session_message_manual_stop_immutable BEFORE UPDATE OR DELETE ON session_message_manual_stop_evidence
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
