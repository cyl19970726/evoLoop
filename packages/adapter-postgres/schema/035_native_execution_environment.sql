-- One explicitly adopted, database-wide App Server environment. A missing row is
-- legacy/unverified; a migration must never promote a ready Session to verified.
CREATE TABLE native_execution_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  epoch bigint NOT NULL CHECK(epoch>0),
  mode text NOT NULL CHECK(mode IN ('business_verified','message_verified','transition','unknown')),
  previous_mode text CHECK(previous_mode IN ('business_verified','message_verified','transition','unknown')),
  target_purpose text CHECK(target_purpose IN ('business','message')),
  target_project_id uuid, target_session_id uuid, target_thread_id text,
  target_message_id uuid, operation_id uuid, previous_target jsonb,
  owner_nonce uuid, owner_pid integer CHECK(owner_pid IS NULL OR owner_pid>0),
  owner_start_identity text CHECK(owner_start_identity IS NULL OR length(owner_start_identity) BETWEEN 1 AND 240),
  expected_policy_hash text CHECK(expected_policy_hash IS NULL OR expected_policy_hash ~ '^[a-f0-9]{64}$'),
  observed_policy_hash text CHECK(observed_policy_hash IS NULL OR observed_policy_hash ~ '^[a-f0-9]{64}$'),
  old_owner_exit_evidence_ref text CHECK(old_owner_exit_evidence_ref IS NULL OR length(old_owner_exit_evidence_ref) BETWEEN 1 AND 4000),
  spawned_owner_recorded_at timestamptz,
  verification_evidence_ref text CHECK(verification_evidence_ref IS NULL OR length(verification_evidence_ref) BETWEEN 1 AND 4000),
  native_attempted_at timestamptz, verified_at timestamptz,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000),
  updated_at timestamptz NOT NULL,
  CHECK(mode<>'transition' OR (target_purpose IS NOT NULL AND target_project_id IS NOT NULL
    AND target_session_id IS NOT NULL AND target_thread_id IS NOT NULL AND operation_id IS NOT NULL
    AND expected_policy_hash IS NOT NULL AND (target_purpose='message')=(target_message_id IS NOT NULL))),
  CHECK(mode NOT IN ('business_verified','message_verified') OR (owner_nonce IS NOT NULL
    AND owner_pid IS NOT NULL AND owner_start_identity IS NOT NULL AND observed_policy_hash IS NOT NULL
    AND verified_at IS NOT NULL)),
  CHECK(mode<>'message_verified' OR (target_purpose='message' AND target_message_id IS NOT NULL)),
  CHECK(mode<>'business_verified' OR target_purpose='business')
);

-- Historical rows remain unclassified. The launch epoch belongs to the original
-- persisted operation, never to whichever child happens to own the global row now.
ALTER TABLE runtime_session ADD COLUMN native_environment_epoch bigint CHECK(native_environment_epoch>0);
ALTER TABLE runtime_run ADD COLUMN native_environment_epoch bigint CHECK(native_environment_epoch>0);
ALTER TABLE session_message_processing ADD COLUMN native_environment_epoch bigint CHECK(native_environment_epoch>0);

CREATE FUNCTION native_execution_epoch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.native_environment_epoch IS NOT NULL THEN
      RAISE EXCEPTION 'Native environment epoch must be assigned by startup fence' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.native_environment_epoch IS DISTINCT FROM OLD.native_environment_epoch THEN
    RAISE EXCEPTION 'Native environment epoch is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_runtime_run_epoch_guard BEFORE INSERT OR UPDATE ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION native_execution_epoch_guard();
CREATE TRIGGER native_message_processing_epoch_guard BEFORE INSERT OR UPDATE ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION native_execution_epoch_guard();
CREATE TRIGGER native_runtime_session_epoch_guard BEFORE INSERT OR UPDATE ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION native_execution_epoch_guard();

-- Trusted transaction-local proof. This function is deliberately AFTER the
-- existing Session slot/recovery trigger in trigger name order. Switch writers
-- lock only native_execution_environment, never Session/queue/gate rows.
CREATE FUNCTION native_execution_start_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control record; claim jsonb; raw_claim text; kind text; project uuid; session uuid; operation uuid; message uuid;
  uncertain_insert boolean:=false;
BEGIN
  IF TG_TABLE_NAME='runtime_run' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.state='unknown' THEN uncertain_insert:=true;
      ELSIF NEW.state NOT IN ('dispatching','running') THEN RETURN NEW; END IF;
    ELSIF NOT ((NEW.state='dispatching' AND OLD.state IS DISTINCT FROM NEW.state)
      OR (NEW.state='running' AND OLD.state NOT IN ('dispatching','running','unknown'))) THEN
      RETURN NEW;
    END IF;
    kind:='run';project:=NEW.project_id;session:=NEW.session_id;operation:=NEW.operation_id;message:=NULL;
  ELSIF TG_TABLE_NAME='session_message_processing' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.state='unknown' THEN uncertain_insert:=true;
      ELSIF NEW.state NOT IN ('dispatching','running') THEN RETURN NEW; END IF;
    ELSIF NOT ((NEW.state='dispatching' AND OLD.state IS DISTINCT FROM NEW.state)
      OR (NEW.state='running' AND OLD.state NOT IN ('dispatching','running','unknown'))) THEN
      RETURN NEW;
    END IF;
    kind:='message';project:=NEW.project_id;session:=NEW.session_id;operation:=NEW.operation_id;message:=NEW.message_id;
  ELSE
    IF TG_OP='INSERT' THEN
      IF NEW.state='unknown' THEN uncertain_insert:=true;
      ELSIF NEW.state NOT IN ('creating','ready') THEN RETURN NEW; END IF;
    ELSIF NOT (NEW.state IN ('creating','ready') AND OLD.state='reserved') THEN RETURN NEW; END IF;
    kind:='session-create';project:=NEW.project_id;session:=NEW.session_id;operation:=NEW.operation_id;message:=NULL;
  END IF;

  SELECT * INTO control FROM native_execution_environment WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF; -- legacy compatibility, never a verified claim
  IF uncertain_insert THEN
    RAISE EXCEPTION 'Uncertain native operation requires a persisted original startup' USING ERRCODE='23514';
  END IF;
  raw_claim:=current_setting('evoloop.native_execution_startup',true);
  IF raw_claim IS NULL OR raw_claim='' THEN
    RAISE EXCEPTION 'Native execution startup permit missing' USING ERRCODE='23514';
  END IF;
  claim:=raw_claim::jsonb;
  IF claim->>'kind' IS DISTINCT FROM kind OR claim->>'epoch' IS DISTINCT FROM control.epoch::text
    OR claim->>'projectId' IS DISTINCT FROM project::text OR claim->>'sessionId' IS DISTINCT FROM session::text
    OR claim->>'operationId' IS DISTINCT FROM operation::text
    OR (kind='message' AND claim->>'messageId' IS DISTINCT FROM message::text) THEN
    RAISE EXCEPTION 'Native execution startup permit does not match original operation' USING ERRCODE='23514';
  END IF;
  IF kind='message' THEN
    IF control.mode<>'message_verified' OR control.target_project_id IS DISTINCT FROM project
      OR control.target_session_id IS DISTINCT FROM session OR control.target_message_id IS DISTINCT FROM message
      OR control.observed_policy_hash IS DISTINCT FROM NEW.read_only_policy_fingerprint
      OR NOT EXISTS(SELECT 1 FROM runtime_session s WHERE s.project_id=project AND s.session_id=session
        AND s.native_thread_id=control.target_thread_id AND s.state='ready') THEN
      RAISE EXCEPTION 'Native message environment is not verified for this original message' USING ERRCODE='23514';
    END IF;
  ELSIF control.mode<>'business_verified' THEN
    RAISE EXCEPTION 'Native business environment is not verified' USING ERRCODE='23514';
  END IF;
  IF NEW.native_environment_epoch IS NOT NULL THEN
    RAISE EXCEPTION 'Native startup cannot replace a recorded environment epoch' USING ERRCODE='23514';
  END IF;
  NEW.native_environment_epoch:=control.epoch;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_runtime_run_native_execution_fence BEFORE INSERT OR UPDATE OF state ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION native_execution_start_fence();
CREATE TRIGGER zz_session_message_native_execution_fence BEFORE INSERT OR UPDATE OF state ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION native_execution_start_fence();
CREATE TRIGGER zz_runtime_session_native_execution_fence BEFORE INSERT OR UPDATE OF state ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION native_execution_start_fence();
