-- Scheduled direct dispatch (DEC-045 S1, design 5.5). A schedule hands its Task to the Leader by default; with a dispatch policy of "direct" the Task
-- is appended to the line of one Session from the Leader's direct list for the schedule's Role. The Task and the dispatch intent are written in the
-- occurrence's own transaction, and the Leader's triage notice is not made for a Task that goes straight to a line.

CREATE TABLE schedule_dispatch_policy (
  project_id uuid NOT NULL, schedule_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  mode text NOT NULL CHECK(mode IN ('leader','direct')),
  state text NOT NULL CHECK(state IN ('active','paused','revoked','circuit_open')),
  wait_limit_minutes integer NOT NULL DEFAULT 120 CHECK(wait_limit_minutes BETWEEN 1 AND 1440),
  daily_run_budget integer CHECK(daily_run_budget IS NULL OR daily_run_budget>0),
  -- The schedule revision whose Task template was approved for direct dispatch, and the Role's revision at that time (its binding and skills).
  set_revision_id uuid NOT NULL, role_revision_id uuid,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  consecutive_skips integer NOT NULL DEFAULT 0 CHECK(consecutive_skips>=0),
  revert_reason text, actor_id text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>0), updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,schedule_id), FOREIGN KEY(project_id,schedule_id) REFERENCES schedule_definition(project_id,schedule_id)
);
-- The Leader's direct list: the resident Sessions of one Role that scheduled Tasks may be sent to, in the order they are preferred.
CREATE TABLE direct_dispatch_list (
  project_id uuid NOT NULL, role_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  session_ids uuid[] NOT NULL CHECK(cardinality(session_ids) BETWEEN 0 AND 20),
  actor_id text NOT NULL, reason text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,role_id)
);
-- Every trigger of a direct schedule leaves one row: what was decided, with the template hash and execution configuration at that moment.
CREATE TABLE schedule_dispatch_log (
  project_id uuid NOT NULL, schedule_id uuid NOT NULL, planned_at_utc timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','dispatched','fell_back','skipped')), reason text NOT NULL DEFAULT '',
  task_id uuid, session_id uuid, entry_id uuid, template_hash text NOT NULL, role_revision_id uuid, execution_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz NOT NULL, dispatched_at timestamptz, escalated_at timestamptz,
  PRIMARY KEY(project_id,schedule_id,planned_at_utc), FOREIGN KEY(project_id,schedule_id) REFERENCES schedule_definition(project_id,schedule_id)
);
CREATE INDEX schedule_dispatch_log_open ON schedule_dispatch_log(project_id,state) WHERE state IN ('pending','dispatched');

-- The notice kinds this adds (levels as in contracts.md): a direct dispatch that could not happen (immediate), the breaker opening (immediate),
-- consecutive skips (digest). Recorded only: direct_dispatched and direct_dispatch_skipped, in the record view below.
ALTER TABLE leader_result_notice DROP CONSTRAINT leader_result_notice_kind_check;
ALTER TABLE leader_result_notice ADD CONSTRAINT leader_result_notice_kind_check CHECK (kind IN
  ('task_todo','delivery','observation','observation_used','observation_failed','task_question','task_blocker',
   'run_without_submission','run_submission_blocked','task_attention','acceptance_blocked',
   'line_entry_suspended','line_confirmation_returned','direct_dispatch_blocked','direct_circuit_open','schedule_skips_escalated'));
DROP INDEX leader_result_notice_level_idx;
ALTER TABLE leader_result_notice DROP COLUMN level;
ALTER TABLE leader_result_notice ADD COLUMN level text GENERATED ALWAYS AS (CASE WHEN kind IN
  ('acceptance_blocked','run_submission_blocked','run_without_submission','task_question','task_blocker','observation_failed','line_entry_suspended',
   'direct_dispatch_blocked','direct_circuit_open')
  THEN 'immediate' ELSE 'digest' END) STORED;
CREATE INDEX leader_result_notice_level_idx ON leader_result_notice(project_id,level,occurred_at);

-- A Task that is going straight to a line is not offered to the Leader for triage. The occurrence turns this on for the one insert.
DO $$
DECLARE def text; patched text;
BEGIN
  def := pg_get_functiondef('leader_result_notice_from_task()'::regprocedure);
  patched := replace(def, E'  IF NEW.version=1 AND NEW.state=''todo'' THEN',
    E'  IF NEW.version=1 AND NEW.state=''todo'' AND COALESCE(current_setting(''evoloop.direct_dispatch'',true),'''')<>''on'' THEN');
  IF patched = def THEN RAISE EXCEPTION 'leader_result_notice_from_task has no todo anchor to patch'; END IF;
  EXECUTE patched;
END $$;

CREATE FUNCTION schedule_dispatch_uuid(p_schedule uuid,p_planned timestamptz,p_tag text) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT md5(p_schedule::text||':'||p_planned::text||':'||p_tag)::uuid
$$;

-- Decide, in the occurrence's transaction and before its Task is inserted, how this trigger is handled: 'direct' (the Task goes to a line; the triage
-- notice is suppressed for the insert that follows), 'skip' (no Task) or 'leader' (the ordinary path). Every direct schedule leaves a log row.
CREATE FUNCTION schedule_direct_intent(p_project uuid,p_schedule uuid,p_planned timestamptz,p_now timestamptz) RETURNS text LANGUAGE plpgsql AS $$
DECLARE pol schedule_dispatch_policy%ROWTYPE; cur schedule_revision%ROWTYPE; base schedule_revision%ROWTYPE; role_rev uuid; tz text; used integer;
  thash text;
BEGIN
  SELECT * INTO pol FROM schedule_dispatch_policy WHERE project_id=p_project AND schedule_id=p_schedule FOR UPDATE;
  IF NOT FOUND OR pol.mode<>'direct' THEN RETURN 'leader'; END IF;
  SELECT r.* INTO cur FROM schedule_revision r JOIN schedule_definition d ON d.project_id=r.project_id AND d.schedule_id=r.schedule_id AND d.current_revision_id=r.revision_id
    WHERE r.project_id=p_project AND r.schedule_id=p_schedule;
  thash := md5(cur.task_template::text);
  SELECT * INTO base FROM schedule_revision WHERE project_id=p_project AND schedule_id=p_schedule AND revision_id=pol.set_revision_id;
  SELECT current_revision_id INTO role_rev FROM role_definition WHERE project_id=p_project AND role_id=NULLIF(cur.task_template->>'owner','')::uuid;
  IF pol.state<>'active' THEN
    INSERT INTO schedule_dispatch_log(project_id,schedule_id,planned_at_utc,state,reason,template_hash,role_revision_id,decided_at)
      VALUES(p_project,p_schedule,p_planned,'fell_back','POLICY_'||upper(pol.state),thash,role_rev,p_now) ON CONFLICT DO NOTHING;
    RETURN 'leader';
  END IF;
  IF base.task_template IS DISTINCT FROM cur.task_template OR pol.role_revision_id IS DISTINCT FROM role_rev THEN
    UPDATE schedule_dispatch_policy SET mode='leader',version=version+1,revert_reason=CASE WHEN base.task_template IS DISTINCT FROM cur.task_template
      THEN 'TEMPLATE_CHANGED' ELSE 'ROLE_BINDING_CHANGED' END,updated_at=p_now WHERE project_id=p_project AND schedule_id=p_schedule;
    INSERT INTO schedule_dispatch_log(project_id,schedule_id,planned_at_utc,state,reason,template_hash,role_revision_id,decided_at)
      VALUES(p_project,p_schedule,p_planned,'fell_back','RETURNED_TO_LEADER',thash,role_rev,p_now) ON CONFLICT DO NOTHING;
    RETURN 'leader';
  END IF;
  IF pol.daily_run_budget IS NOT NULL THEN
    tz := cur.timezone;
    SELECT count(*) INTO used FROM schedule_dispatch_log l WHERE l.project_id=p_project AND l.schedule_id=p_schedule AND l.state IN ('pending','dispatched')
      AND (l.planned_at_utc AT TIME ZONE tz)::date=(p_planned AT TIME ZONE tz)::date;
    IF used>=pol.daily_run_budget THEN
      INSERT INTO schedule_dispatch_log(project_id,schedule_id,planned_at_utc,state,reason,task_id,template_hash,role_revision_id,decided_at)
        VALUES(p_project,p_schedule,p_planned,'skipped','DAILY_BUDGET',
          (SELECT o.task_id FROM schedule_occurrence o WHERE o.project_id=p_project AND o.schedule_id=p_schedule AND o.state='created' ORDER BY o.planned_at_utc DESC LIMIT 1),
          thash,role_rev,p_now) ON CONFLICT DO NOTHING;
      RETURN 'skip';
    END IF;
  END IF;
  INSERT INTO schedule_dispatch_log(project_id,schedule_id,planned_at_utc,state,reason,template_hash,role_revision_id,execution_config,decided_at)
    VALUES(p_project,p_schedule,p_planned,'pending','',thash,role_rev,
      jsonb_build_object('roleRevisionId',role_rev,'templateRevisionId',cur.revision_id,'waitLimitMinutes',pol.wait_limit_minutes),p_now) ON CONFLICT DO NOTHING;
  PERFORM set_config('evoloop.direct_dispatch','on',true);
  UPDATE schedule_dispatch_policy SET consecutive_skips=0 WHERE project_id=p_project AND schedule_id=p_schedule AND consecutive_skips>0;
  RETURN 'direct';
END $$;

-- The occurrence skipped itself because the previous one is still open: counted, recorded, and escalated at the second in a row.
CREATE FUNCTION schedule_direct_note_skip(p_project uuid,p_schedule uuid,p_planned timestamptz,p_now timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pol schedule_dispatch_policy%ROWTYPE; cur schedule_revision%ROWTYPE; anchor_task uuid; anchor_rev uuid;
BEGIN
  SELECT * INTO pol FROM schedule_dispatch_policy WHERE project_id=p_project AND schedule_id=p_schedule FOR UPDATE;
  IF NOT FOUND OR pol.mode<>'direct' THEN RETURN; END IF;
  SELECT r.* INTO cur FROM schedule_revision r JOIN schedule_definition d ON d.project_id=r.project_id AND d.schedule_id=r.schedule_id AND d.current_revision_id=r.revision_id
    WHERE r.project_id=p_project AND r.schedule_id=p_schedule;
  SELECT o.task_id INTO anchor_task FROM schedule_occurrence o WHERE o.project_id=p_project AND o.schedule_id=p_schedule AND o.state='created' ORDER BY o.planned_at_utc DESC LIMIT 1;
  INSERT INTO schedule_dispatch_log(project_id,schedule_id,planned_at_utc,state,reason,task_id,template_hash,decided_at)
    VALUES(p_project,p_schedule,p_planned,'skipped','PREVIOUS_STILL_OPEN',anchor_task,md5(cur.task_template::text),p_now) ON CONFLICT DO NOTHING;
  UPDATE schedule_dispatch_policy SET consecutive_skips=consecutive_skips+1,updated_at=p_now WHERE project_id=p_project AND schedule_id=p_schedule RETURNING consecutive_skips INTO pol.consecutive_skips;
  IF pol.consecutive_skips>=2 THEN
    -- The Task that is still open is the one the Leader has to look at.
    SELECT current_revision_id INTO anchor_rev FROM task WHERE project_id=p_project AND task_id=anchor_task;
    IF anchor_rev IS NOT NULL THEN
      PERFORM enqueue_leader_result_notice(p_project,'schedule_skips_escalated',schedule_dispatch_uuid(p_schedule,p_planned,'skips'),anchor_task,anchor_rev,NULL,
        'dispatcher:schedule','schedule:'||p_schedule||':skips@'||p_planned,p_now);
    END IF;
  END IF;
END $$;

-- A Task that was meant for a line goes to the Leader instead: the triage notice it did not get is made now, and a blocked dispatch is told at once.
CREATE FUNCTION schedule_direct_fall_back(p_project uuid,p_schedule uuid,p_planned timestamptz,p_reason text,p_blocked boolean,p_now timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE log_row schedule_dispatch_log%ROWTYPE; rev uuid;
BEGIN
  SELECT * INTO log_row FROM schedule_dispatch_log WHERE project_id=p_project AND schedule_id=p_schedule AND planned_at_utc=p_planned FOR UPDATE;
  IF NOT FOUND OR log_row.state<>'pending' THEN RETURN; END IF;
  SELECT o.task_id INTO log_row.task_id FROM schedule_occurrence o WHERE o.project_id=p_project AND o.schedule_id=p_schedule AND o.planned_at_utc=p_planned;
  SELECT current_revision_id INTO rev FROM task WHERE project_id=p_project AND task_id=log_row.task_id;
  UPDATE schedule_dispatch_log SET state='fell_back',reason=p_reason,task_id=log_row.task_id,dispatched_at=NULL WHERE project_id=p_project AND schedule_id=p_schedule AND planned_at_utc=p_planned;
  IF rev IS NOT NULL THEN
    PERFORM enqueue_leader_result_notice(p_project,'task_todo',rev,log_row.task_id,rev,NULL,'dispatcher:schedule','task:'||log_row.task_id||'@'||rev,p_now);
    IF p_blocked THEN
      PERFORM enqueue_leader_result_notice(p_project,'direct_dispatch_blocked',schedule_dispatch_uuid(p_schedule,p_planned,'blocked'),log_row.task_id,rev,NULL,
        'dispatcher:schedule','schedule:'||p_schedule||':blocked:'||p_reason||'@'||p_planned,p_now);
    END IF;
  END IF;
END $$;

-- The breaker: two Runs in a row of a direct schedule's lines that ended in failure (a Run stopped on request does not count; a completed one resets).
CREATE FUNCTION schedule_direct_breaker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry session_line_entry%ROWTYPE; failed boolean; stopped boolean; pol schedule_dispatch_policy%ROWTYPE; rev uuid;
BEGIN
  IF NEW.kind<>'entry.runEnded' OR NEW.entry_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO entry FROM session_line_entry WHERE project_id=NEW.project_id AND entry_id=NEW.entry_id;
  IF NOT FOUND OR entry.source<>'schedule' OR entry.schedule_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO pol FROM schedule_dispatch_policy WHERE project_id=NEW.project_id AND schedule_id=entry.schedule_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  failed := (NEW.detail->>'runState') IN ('failed','interrupted');
  SELECT COALESCE(r.stop_requested_at IS NOT NULL,false) INTO stopped FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.run_id=NULLIF(NEW.detail->>'runId','')::uuid;
  IF stopped THEN RETURN NEW; END IF;
  IF NOT failed THEN
    UPDATE schedule_dispatch_policy SET consecutive_failures=0,updated_at=NEW.at WHERE project_id=NEW.project_id AND schedule_id=entry.schedule_id AND consecutive_failures>0;
    RETURN NEW;
  END IF;
  UPDATE schedule_dispatch_policy SET consecutive_failures=consecutive_failures+1,updated_at=NEW.at WHERE project_id=NEW.project_id AND schedule_id=entry.schedule_id
    RETURNING * INTO pol;
  IF pol.consecutive_failures>=2 AND pol.state<>'circuit_open' THEN
    UPDATE schedule_dispatch_policy SET state='circuit_open',mode='leader',version=version+1,revert_reason='CIRCUIT_OPEN',updated_at=NEW.at
      WHERE project_id=NEW.project_id AND schedule_id=entry.schedule_id;
    SELECT current_revision_id INTO rev FROM task WHERE project_id=NEW.project_id AND task_id=entry.task_id;
    IF rev IS NOT NULL THEN
      PERFORM enqueue_leader_result_notice(NEW.project_id,'direct_circuit_open',session_line_event_uuid(NEW.project_id,NEW.event_seq),entry.task_id,rev,NEW.session_id,
        'dispatcher:schedule','schedule:'||entry.schedule_id||':circuit@'||NEW.event_seq,NEW.at);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER schedule_direct_breaker AFTER INSERT ON session_line_event FOR EACH ROW EXECUTE FUNCTION schedule_direct_breaker();

-- A changed schedule template returns the schedule to the Leader at once (the next trigger would also notice, but the policy should read right away).
CREATE FUNCTION schedule_direct_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pol schedule_dispatch_policy%ROWTYPE; base schedule_revision%ROWTYPE;
BEGIN
  SELECT * INTO pol FROM schedule_dispatch_policy WHERE project_id=NEW.project_id AND schedule_id=NEW.schedule_id FOR UPDATE;
  IF NOT FOUND OR pol.mode<>'direct' THEN RETURN NEW; END IF;
  SELECT * INTO base FROM schedule_revision WHERE project_id=NEW.project_id AND schedule_id=NEW.schedule_id AND revision_id=pol.set_revision_id;
  IF base.task_template IS DISTINCT FROM NEW.task_template THEN
    UPDATE schedule_dispatch_policy SET mode='leader',version=version+1,revert_reason='TEMPLATE_CHANGED',updated_at=NEW.created_at_utc
      WHERE project_id=NEW.project_id AND schedule_id=NEW.schedule_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER schedule_direct_template_guard AFTER INSERT ON schedule_revision FOR EACH ROW EXECUTE FUNCTION schedule_direct_template_guard();

-- The record view gains the dispatch records (same columns).
CREATE OR REPLACE VIEW leader_event_record AS
  SELECT r.project_id, 'run_stopped'::text AS kind, r.run_id AS source_event_id, r.task_id, 'run:'||r.run_id AS source_ref, r.updated_at AS occurred_at
    FROM runtime_run r WHERE r.stop_requested_at IS NOT NULL AND r.state IN ('completed','failed','interrupted')
  UNION ALL
  SELECT i.project_id, 'attention_resolved', e.event_id, i.task_id, 'attention:'||i.item_id||'@v'||e.item_version, e.created_at
    FROM task_attention_item_event e JOIN task_attention_item i ON i.project_id=e.project_id AND i.item_id=e.item_id WHERE e.kind='resolved'
  UNION ALL
  SELECT n.project_id, 'notice_withdrawn', n.notice_id, n.task_id, 'notice:'||n.notice_id||':'||COALESCE(x.withdrawn_reason,'withdrawn'), x.updated_at
    FROM leader_notice_packet_item x JOIN leader_result_notice n ON n.project_id=x.project_id AND n.notice_id=x.notice_id WHERE x.state='withdrawn'
  UNION ALL
  SELECT l.project_id,
    CASE l.kind WHEN 'entry.appended' THEN 'line_entry_appended' WHEN 'entry.started' THEN 'line_entry_started' ELSE 'line_entry_ended' END,
    session_line_event_uuid(l.project_id,l.event_seq), l.task_id, 'line:'||l.event_seq||':'||l.kind, l.at
    FROM session_line_event l WHERE l.kind IN ('entry.appended','entry.started','entry.runEnded') AND l.task_id IS NOT NULL
  UNION ALL
  SELECT g.project_id, CASE g.state WHEN 'dispatched' THEN 'direct_dispatched' ELSE 'direct_dispatch_skipped' END,
    schedule_dispatch_uuid(g.schedule_id,g.planned_at_utc,'record'), g.task_id,
    'schedule:'||g.schedule_id||':'||g.state||':'||g.reason||'@'||g.planned_at_utc, COALESCE(g.dispatched_at,g.decided_at)
    FROM schedule_dispatch_log g WHERE g.state IN ('dispatched','skipped') AND g.task_id IS NOT NULL;
