-- Preflight failures (requested -> failed, no native Turn, no queue claim, gate open) no longer block the Session.
-- Native rejections after dispatch, unknown/interrupted outcomes and real failures still set the recovery gate.
--
-- Patched into the function in place (as 078 did) instead of redefining it, so every clause earlier migrations added stays
-- (078: a Run stopped on request does not close an open gate) and the migration composes with parallel changes to the same function.
DO $$
DECLARE def text; patched text;
BEGIN
  def := pg_get_functiondef('session_recovery_run_outcome()'::regprocedure);
  -- A Run that failed before dispatch (requested -> failed, no native Turn) never reached the model: nothing is unresolved,
  -- so an open Session stays open and its queued messages keep flowing. Every other failure, a Run inside a queue claim,
  -- and a gate that is not open keep the protection that follows.
  patched := replace(def, E'  IF gate.phase=''open'' THEN\n    SELECT m.message_id INTO original_message',
    E'  IF TG_OP=''UPDATE'' AND OLD.state=''requested'' AND NEW.state=''failed'' AND NEW.native_turn_id IS NULL\n' ||
    E'     AND gate.phase=''open'' AND claim.claim_id IS NULL THEN RETURN NEW; END IF;\n' ||
    E'  IF gate.phase=''open'' THEN\n    SELECT m.message_id INTO original_message');
  IF patched = def THEN RAISE EXCEPTION 'session_recovery_run_outcome has no open-gate anchor to patch'; END IF;
  EXECUTE patched;
END $$;
