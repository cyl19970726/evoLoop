-- Preflight failures (requested -> failed, no native Turn, no queue claim, gate open) no longer block the Session.
-- Native rejections after dispatch, unknown/interrupted outcomes and real failures still set the recovery gate.
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
  -- A Run that failed before dispatch (requested -> failed, no native Turn) never reached the model: nothing is unresolved,
  -- so an open Session stays open and its queued messages keep flowing. Every other failure, a Run inside a queue claim,
  -- and a gate that is not open keep the protection below.
  IF TG_OP='UPDATE' AND OLD.state='requested' AND NEW.state='failed' AND NEW.native_turn_id IS NULL
     AND gate.phase='open' AND claim.claim_id IS NULL THEN RETURN NEW; END IF;
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
