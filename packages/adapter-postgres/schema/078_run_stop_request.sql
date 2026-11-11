-- Request stop (DEC-043): a Run that is no longer wanted gets a stop marker, not a new state. Everything that must stop reads
-- the marker: the unsealed signed submission is voided, no new submission or Delivery may cite the Run, the recovery gate and the
-- Leader notices treat its end as expected.
ALTER TABLE runtime_run ADD COLUMN stop_requested_at timestamptz;
ALTER TABLE runtime_run ADD COLUMN stop_reason text;
ALTER TABLE runtime_run ADD COLUMN stop_requested_by text;
ALTER TABLE runtime_run ADD CONSTRAINT runtime_run_stop_marker_whole CHECK (
  (stop_requested_at IS NULL AND stop_reason IS NULL AND stop_requested_by IS NULL) OR
  (stop_requested_at IS NOT NULL AND length(btrim(stop_reason))>0 AND length(btrim(stop_requested_by))>0));

-- The stop marker is final: it can be set once and never cleared or changed.
CREATE FUNCTION runtime_run_stop_marker_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stop_requested_at IS NOT NULL AND (NEW.stop_requested_at IS DISTINCT FROM OLD.stop_requested_at
    OR NEW.stop_reason IS DISTINCT FROM OLD.stop_reason OR NEW.stop_requested_by IS DISTINCT FROM OLD.stop_requested_by) THEN
    RAISE EXCEPTION 'RUN_STOPPED: a stop request cannot be changed or withdrawn' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_run_stop_marker_final BEFORE UPDATE ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION runtime_run_stop_marker_final();

-- In the same transaction as the stop: void the signed intent that was never sealed (submitted or blocked), mark the Task's queued
-- messages of this Session as superseded. A sealing/unknown intent may already have a Delivery in flight: the Delivery trigger below
-- is what stops it.
CREATE FUNCTION runtime_run_stop_effects() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ordinary_run_submission SET state='rejected',reason='RUN_STOPPED',version=version+1,updated_at_utc=NEW.stop_requested_at
    WHERE project_id=NEW.project_id AND run_id=NEW.run_id AND state IN ('submitted','blocked');
  UPDATE session_message SET blocked_reason='SUPERSEDED: its Task Run was stopped on request ('||left(NEW.stop_reason,300)||'); resend it if it is still wanted',
      version=version+1,updated_at=NEW.stop_requested_at
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND context_task_id=NEW.task_id AND state='queued';
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_run_stop_effects AFTER UPDATE OF stop_requested_at ON runtime_run
  FOR EACH ROW WHEN (OLD.stop_requested_at IS NULL AND NEW.stop_requested_at IS NOT NULL)
  EXECUTE FUNCTION runtime_run_stop_effects();

-- No new signed intent may cite a stopped Run.
CREATE FUNCTION ordinary_run_submission_stopped_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.run_id=NEW.run_id AND r.stop_requested_at IS NOT NULL) THEN
    RAISE EXCEPTION 'RUN_STOPPED: the Run was stopped on request, so it cannot take a submission' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ordinary_run_submission_stopped_run BEFORE INSERT ON ordinary_run_submission
  FOR EACH ROW EXECUTE FUNCTION ordinary_run_submission_stopped_run();

-- No Delivery may cite a stopped Run, and none without a Run while a stopped Run of the Task has not ended.
CREATE FUNCTION delivery_stopped_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.run_id=NEW.run_id AND r.stop_requested_at IS NOT NULL) THEN
      RAISE EXCEPTION 'RUN_STOPPED: the Run was stopped on request, so it cannot produce a Delivery' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.task_id=NEW.task_id AND r.stop_requested_at IS NOT NULL
    AND r.state IN ('requested','dispatching','running','unknown')) THEN
    RAISE EXCEPTION 'RUN_STOPPED: a stopped Run of this Task has not ended; a Delivery without a Run waits until it has' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_stopped_run BEFORE INSERT ON delivery FOR EACH ROW EXECUTE FUNCTION delivery_stopped_run();

-- The three existing trigger functions below are patched in place rather than redefined, so they keep whatever earlier (or
-- parallel) migrations put in them; a missing anchor fails the migration instead of silently skipping the rule.
DO $$
DECLARE def text; patched text;
BEGIN
  -- Recovery gate: a stopped Run's end is expected, it does not close an open gate (the Session can take the next Run at once).
  def := pg_get_functiondef('session_recovery_run_outcome()'::regprocedure);
  patched := replace(def, E'  IF gate.phase=''open'' THEN\n    SELECT m.message_id INTO original_message',
    E'  IF NEW.stop_requested_at IS NOT NULL AND NEW.state IN (''failed'',''interrupted'') AND gate.phase=''open'' THEN RETURN NEW; END IF;\n  IF gate.phase=''open'' THEN\n    SELECT m.message_id INTO original_message');
  IF patched = def THEN RAISE EXCEPTION 'session_recovery_run_outcome has no open-gate anchor to patch'; END IF;
  EXECUTE patched;

  -- Leader notices: a stopped Run ends without a "no submission" or "submission blocked" notice; the Run's own event is the record.
  def := pg_get_functiondef('leader_result_notice_from_terminal_run()'::regprocedure);
  patched := replace(def, E'  IF NEW.state NOT IN (''completed'',''failed'',''interrupted'') THEN RETURN NEW; END IF;',
    E'  IF NEW.state NOT IN (''completed'',''failed'',''interrupted'') OR NEW.stop_requested_at IS NOT NULL THEN RETURN NEW; END IF;');
  IF patched = def THEN RAISE EXCEPTION 'leader_result_notice_from_terminal_run has no terminal-state anchor to patch'; END IF;
  EXECUTE patched;

  def := pg_get_functiondef('leader_result_notice_from_submission()'::regprocedure);
  patched := replace(def, E'  IF source_run.state NOT IN (''completed'',''failed'',''interrupted'') OR',
    E'  IF source_run.stop_requested_at IS NOT NULL OR source_run.state NOT IN (''completed'',''failed'',''interrupted'') OR');
  IF patched = def THEN RAISE EXCEPTION 'leader_result_notice_from_submission has no source-run anchor to patch'; END IF;
  EXECUTE patched;
END $$;
