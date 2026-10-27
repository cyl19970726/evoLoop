-- A reviewed queue.continue reserves exactly one new Run for the original
-- unreleased claim. Existing failure cause, retry decision, pin and attempts remain.
ALTER TABLE session_recovery_gate DROP CONSTRAINT session_recovery_gate_phase_check;
ALTER TABLE session_recovery_gate ADD CONSTRAINT session_recovery_gate_phase_check
  CHECK(phase IN ('open','blocked','retrying','reworking','message_pending','awaiting_acceptance'));

CREATE OR REPLACE FUNCTION session_recovery_start_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate record; permitted boolean; profile_state text;
BEGIN
  IF TG_TABLE_NAME='runtime_run' THEN
    IF NEW.state NOT IN ('requested','dispatching','running','unknown') THEN RETURN NEW; END IF;
  ELSE
    IF NEW.state NOT IN ('dispatching','running','unknown') THEN RETURN NEW; END IF;
  END IF;
  PERFORM session_recovery_slot_lock(NEW.project_id,NEW.session_id);
  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session recovery gate missing' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.native_turn_id IS NOT DISTINCT FROM NEW.native_turn_id AND
      (OLD.state=NEW.state OR NEW.state='unknown') THEN RETURN NEW; END IF;
  END IF;
  SELECT activation_state INTO profile_state FROM session_execution_profile
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
  IF profile_state IS DISTINCT FROM 'active' AND NOT (TG_TABLE_NAME='runtime_run' AND NEW.state='requested'
    AND profile_state='pending') THEN
    RAISE EXCEPTION 'Session execution profile has no confirmed activation' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='runtime_run' THEN
    permitted:=gate.phase='open' OR (gate.phase IN ('retrying','reworking') AND gate.retry_run_id=NEW.run_id);
    IF TG_OP='UPDATE' AND OLD.state='unknown' AND NEW.state='running' AND NEW.native_turn_id IS NOT NULL
      AND gate.phase='blocked' AND gate.cause_kind='run' AND gate.cause_id=NEW.run_id THEN
      permitted:=true;
    END IF;
  ELSE
    permitted:=gate.phase='open' OR (gate.phase='message_pending' AND gate.resume_message_id=NEW.message_id);
    IF TG_OP='UPDATE' AND OLD.state='unknown' AND NEW.state='running' AND NEW.native_turn_id IS NOT NULL
      AND gate.phase='blocked' AND gate.cause_kind='message' AND gate.cause_id=NEW.message_id THEN
      permitted:=true;
    END IF;
  END IF;
  IF NOT permitted THEN RAISE EXCEPTION 'Session recovery gate blocks native startup' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION session_recovery_run_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate record; claim record; original_message uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NEW; END IF;
  IF NEW.state NOT IN ('failed','interrupted','unknown','completed') THEN RETURN NEW; END IF;
  PERFORM session_recovery_slot_lock(NEW.project_id,NEW.session_id);
  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;
  IF NEW.state='completed' THEN
    IF gate.phase IN ('retrying','reworking') AND gate.retry_run_id=NEW.run_id THEN
      UPDATE session_recovery_gate SET phase=CASE WHEN gate.phase='reworking' THEN 'awaiting_acceptance'
          WHEN resume_message_id IS NOT NULL THEN 'message_pending'
          WHEN claim_id IS NOT NULL THEN 'awaiting_acceptance' ELSE 'open' END,
        cause_kind=CASE WHEN claim_id IS NULL AND resume_message_id IS NULL THEN NULL ELSE cause_kind END,
        cause_id=CASE WHEN claim_id IS NULL AND resume_message_id IS NULL THEN NULL ELSE cause_id END,
        retry_run_id=NULL,version=version+1,updated_at=now()
        WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.queue_id,c.claim_id INTO claim FROM resident_queue_claim c JOIN resident_queue_attempt a
    ON a.project_id=c.project_id AND a.claim_id=c.claim_id
    WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id AND c.released_at IS NULL AND a.run_id=NEW.run_id
    ORDER BY a.sequence DESC LIMIT 1;
  IF gate.phase='open' THEN
    SELECT m.message_id INTO original_message FROM session_message m
      WHERE m.project_id=NEW.project_id AND m.session_id=NEW.session_id AND m.state='queued'
      ORDER BY m.created_at,m.message_id LIMIT 1;
  ELSE original_message:=gate.resume_message_id; END IF;
  UPDATE session_recovery_gate SET phase='blocked',cause_kind='run',cause_id=NEW.run_id,cause_state=NEW.state,
    reason='Run terminal failure or unresolved native outcome',queue_id=COALESCE(claim.queue_id,gate.queue_id),
    claim_id=COALESCE(claim.claim_id,gate.claim_id),retry_run_id=NULL,resume_message_id=original_message,
    version=version+1,updated_at=now() WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
  RETURN NEW;
END $$;
