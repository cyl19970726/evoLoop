-- A Session that cannot start work fails every Run sent to it before the model starts (no business identity, no native thread). Each failed Run
-- already raises its own run_without_submission notice; this adds the one signal that says it is the SAME cause again and again: when the third
-- consecutive terminal Run of a Session failed in the preflight with the same code (evoloop-preflight-v1 in the Run summary), one immediate
-- notice goes to the Leader. A completed Run or another cause in between starts the count again; a fourth, fifth ... failure of the same streak
-- adds nothing (only the third raises it), so it does not repeat. Threshold 3.
ALTER TABLE leader_result_notice DROP CONSTRAINT leader_result_notice_kind_check;
ALTER TABLE leader_result_notice ADD CONSTRAINT leader_result_notice_kind_check CHECK (kind IN
  ('task_todo','delivery','observation','observation_used','observation_failed','task_question','task_blocker',
   'run_without_submission','run_submission_blocked','task_attention','acceptance_blocked',
   'line_entry_suspended','line_confirmation_returned','direct_dispatch_blocked','direct_circuit_open','schedule_skips_escalated',
   'session_repeated_failure'));
DROP INDEX leader_result_notice_level_idx;
ALTER TABLE leader_result_notice DROP COLUMN level;
ALTER TABLE leader_result_notice ADD COLUMN level text GENERATED ALWAYS AS (CASE WHEN kind IN
  ('acceptance_blocked','run_submission_blocked','run_without_submission','task_question','task_blocker','observation_failed','line_entry_suspended',
   'direct_dispatch_blocked','direct_circuit_open','session_repeated_failure')
  THEN 'immediate' ELSE 'digest' END) STORED;
CREATE INDEX leader_result_notice_level_idx ON leader_result_notice(project_id,level,occurred_at);

CREATE FUNCTION run_preflight_code(p_summary text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_summary LIKE 'evoloop-preflight-v1:%' THEN substring(p_summary from '"code":"([A-Z_]+)"') END $$;

CREATE FUNCTION leader_result_notice_from_repeated_preflight() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE code text; newest text[]; streak integer;
BEGIN
  IF NEW.state<>'failed' OR NEW.session_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state=NEW.state THEN RETURN NEW; END IF;
  code:=run_preflight_code(NEW.result_summary);
  IF code IS NULL THEN RETURN NEW; END IF;
  -- The codes of this Session's newest terminal Runs, newest first (NULL for a Run that did not fail in the preflight).
  SELECT array_agg(CASE WHEN r.state='failed' THEN COALESCE(run_preflight_code(r.result_summary),'-') ELSE '-' END ORDER BY r.updated_at DESC,r.run_id DESC)
    INTO newest FROM (SELECT * FROM runtime_run r0 WHERE r0.project_id=NEW.project_id AND r0.session_id=NEW.session_id
      AND r0.state IN ('completed','failed','interrupted') ORDER BY r0.updated_at DESC,r0.run_id DESC LIMIT 4) r;
  -- The third in a row: the three newest are this cause, and the one before them is not (a longer streak raised its notice at the third).
  streak:=0;
  FOR i IN 1..LEAST(3,COALESCE(array_length(newest,1),0)) LOOP
    IF newest[i]=code THEN streak:=streak+1; ELSE EXIT; END IF;
  END LOOP;
  IF streak=3 AND COALESCE(newest[4],'-')<>code THEN
    PERFORM enqueue_leader_result_notice(NEW.project_id,'session_repeated_failure',NEW.run_id,NEW.task_id,NEW.task_revision_id,NEW.session_id,NULL,
      'session:'||NEW.session_id||' '||code||' x3',NEW.updated_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_repeated_preflight AFTER INSERT OR UPDATE OF state ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_repeated_preflight();
