-- Rework of 078 (request stop), after review of the merged change.
--
-- F4: "superseded" must hold. A message the stop marked is no longer only text in blocked_reason, which the pump rewrites and
-- beginDispatch clears: it carries its own mark, selection and admission read it, and only its sender can lift it (cancel, or confirm).
ALTER TABLE session_message ADD COLUMN superseded_at timestamptz;
ALTER TABLE session_message ADD COLUMN superseded_by_run uuid;
ALTER TABLE session_message ADD COLUMN superseded_confirmed_at timestamptz;
ALTER TABLE session_message ADD COLUMN superseded_confirmed_by text;
ALTER TABLE session_message ADD CONSTRAINT session_message_superseded_whole CHECK (
  (superseded_at IS NULL AND superseded_by_run IS NULL AND superseded_confirmed_at IS NULL AND superseded_confirmed_by IS NULL) OR
  (superseded_at IS NOT NULL AND superseded_by_run IS NOT NULL AND
    ((superseded_confirmed_at IS NULL) = (superseded_confirmed_by IS NULL))));

CREATE OR REPLACE FUNCTION runtime_run_stop_effects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ordinary_run_submission SET state='rejected',reason='RUN_STOPPED',version=version+1,updated_at_utc=NEW.stop_requested_at
    WHERE project_id=NEW.project_id AND run_id=NEW.run_id AND state IN ('submitted','blocked');
  UPDATE session_message SET superseded_at=NEW.stop_requested_at,superseded_by_run=NEW.run_id,
      blocked_reason='SUPERSEDED: its Task Run was stopped on request ('||left(NEW.stop_reason,300)||'); the sender cancels or confirms it',
      version=version+1,updated_at=NEW.stop_requested_at
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND context_task_id=NEW.task_id AND state='queued'
      AND superseded_at IS NULL;
  RETURN NEW;
END $$;

-- F3 and the queue-claim guard: patch the recovery-gate function in place (as 078 did), on top of whatever earlier or parallel
-- migrations put in it; a missing anchor fails the migration.
DO $$
DECLARE def text; patched text;
BEGIN
  def := pg_get_functiondef('session_recovery_run_outcome()'::regprocedure);
  -- A Run inside a queue claim keeps the protection: the queue needs the gate to decide its retry.
  patched := replace(def, 'AND gate.phase=''open'' THEN RETURN NEW; END IF;',
    'AND gate.phase=''open'' AND claim.claim_id IS NULL THEN RETURN NEW; END IF;');
  IF patched = def THEN RAISE EXCEPTION 'session_recovery_run_outcome has no stop exemption to extend (078 missing?)'; END IF;
  def := patched;
  -- A stopped Run first marked unknown, then verified as ended: the gate it closed opens again by itself (like 059 for a reconciled
  -- direct start), but only that exact gate, and never one held by a queue claim.
  patched := replace(def, E'  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;\n',
    E'  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;\n' ||
    E'  IF TG_OP=''UPDATE'' AND OLD.state=''unknown'' AND NEW.stop_requested_at IS NOT NULL AND NEW.state IN (''failed'',''interrupted'',''completed'')\n' ||
    E'     AND gate.phase=''blocked'' AND gate.cause_kind=''run'' AND gate.cause_id=NEW.run_id AND gate.claim_id IS NULL THEN\n' ||
    E'    UPDATE session_recovery_gate SET phase=CASE WHEN resume_message_id IS NOT NULL THEN ''message_pending'' ELSE ''open'' END,\n' ||
    E'      cause_kind=CASE WHEN resume_message_id IS NOT NULL THEN cause_kind END,cause_id=CASE WHEN resume_message_id IS NOT NULL THEN cause_id END,\n' ||
    E'      cause_state=CASE WHEN resume_message_id IS NOT NULL THEN cause_state END,\n' ||
    E'      reason=''Stopped Run reconciled'',decision_operation_id=NULL,retry_run_id=NULL,version=version+1,updated_at=now()\n' ||
    E'      WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND version=gate.version;\n' ||
    E'    RETURN NEW;\n' ||
    E'  END IF;\n');
  IF patched = def THEN RAISE EXCEPTION 'session_recovery_run_outcome has no gate-lock anchor to patch'; END IF;
  EXECUTE patched;
END $$;
