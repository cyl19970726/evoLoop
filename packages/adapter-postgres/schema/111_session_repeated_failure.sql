-- A Session that cannot start work fails every Run sent to it before the model starts (no business identity, no native thread), and since the
-- reservation now refuses such a Run no failed Run is left behind to count. This keeps ONE sequence of start outcomes per Session, in order:
--   a Run that failed in the preflight with a cause (evoloop-preflight-v1 in the Run summary),
--   a reservation the coordinator refused for a cause (recorded by the coordinator, no Run exists),
--   a Run that completed (resets the count).
-- The third consecutive event with the same cause raises ONE attention item (session_attention) for that Session; a longer streak adds nothing,
-- a completed Run or another cause starts the count again. The item becomes a Leader notice here (immediate); the coordinator also delivers it
-- to the requirements Session(s) (session_attention_delivery). Threshold 3.
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

CREATE TABLE session_start_event (
  project_id uuid NOT NULL REFERENCES project(project_id),
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  session_id uuid NOT NULL,
  -- BUSINESS_IDENTITY_UNBOUND (a failed start with RECIPIENT_UNBOUND counts as the same cause), the other preflight codes as they are, or OK.
  cause text NOT NULL CHECK (length(btrim(cause)) > 0),
  source text NOT NULL CHECK (source IN ('run','refusal')),
  run_id uuid,
  task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id,event_id),
  FOREIGN KEY (project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY (project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE UNIQUE INDEX session_start_event_run ON session_start_event(project_id,run_id,cause) WHERE run_id IS NOT NULL;
CREATE INDEX session_start_event_session ON session_start_event(project_id,session_id,seq DESC);
CREATE TRIGGER session_start_event_immutable BEFORE UPDATE OR DELETE ON session_start_event FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE TABLE session_attention (
  project_id uuid NOT NULL REFERENCES project(project_id),
  attention_id uuid NOT NULL DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  cause text NOT NULL,
  event_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,attention_id),
  UNIQUE (project_id,event_id),
  FOREIGN KEY (project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY (project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE TRIGGER session_attention_immutable BEFORE UPDATE OR DELETE ON session_attention FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

-- Delivery of an item to one requirements Session: one row per (item, Session); the coordinator posts the message and says how it went.
CREATE TABLE session_attention_delivery (
  project_id uuid NOT NULL REFERENCES project(project_id),
  attention_id uuid NOT NULL,
  recipient_session_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','posted','blocked')),
  message_id uuid,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,attention_id,recipient_session_id),
  FOREIGN KEY (project_id,attention_id) REFERENCES session_attention(project_id,attention_id),
  FOREIGN KEY (project_id,recipient_session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK ((state='posted' AND message_id IS NOT NULL) OR state<>'posted')
);

-- An item that found no requirements Session to tell is not dropped: this row says so and why (the Leader's notice is unaffected). It is replaced
-- by delivery rows once a requirements Session exists; the coordinator rewrites the reason each round while there is none.
CREATE TABLE session_attention_skip (
  project_id uuid NOT NULL REFERENCES project(project_id),
  attention_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  noted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,attention_id),
  FOREIGN KEY (project_id,attention_id) REFERENCES session_attention(project_id,attention_id)
);

-- One place counts: appends the event, and when it is the third in a row with its cause, the attention item.
CREATE FUNCTION session_start_event_attention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE newest text[]; streak integer := 0;
BEGIN
  IF NEW.cause='OK' THEN RETURN NEW; END IF;
  SELECT array_agg(cause ORDER BY seq DESC) INTO newest FROM (SELECT cause,seq FROM session_start_event
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id ORDER BY seq DESC LIMIT 4) x;
  FOR i IN 1..LEAST(3,COALESCE(array_length(newest,1),0)) LOOP
    IF newest[i]=NEW.cause THEN streak:=streak+1; ELSE EXIT; END IF;
  END LOOP;
  -- The third in a row: the three newest are this cause and the one before them is not (a longer streak raised its item at the third).
  IF streak=3 AND COALESCE(newest[4],'OK')<>NEW.cause THEN
    INSERT INTO session_attention(project_id,session_id,cause,event_id,task_id,task_revision_id)
    VALUES(NEW.project_id,NEW.session_id,NEW.cause,NEW.event_id,NEW.task_id,NEW.task_revision_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_start_event_attention AFTER INSERT ON session_start_event FOR EACH ROW EXECUTE FUNCTION session_start_event_attention();

CREATE FUNCTION leader_result_notice_from_session_attention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_leader_result_notice(NEW.project_id,'session_repeated_failure',NEW.attention_id,NEW.task_id,NEW.task_revision_id,NEW.session_id,NULL,
    'session:'||NEW.session_id||' '||NEW.cause||' x3',NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_session_attention AFTER INSERT ON session_attention FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_session_attention();

-- A Run that failed in the preflight, or completed, is an event too.
CREATE FUNCTION session_start_event_from_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE code text;
BEGIN
  IF NEW.session_id IS NULL OR NEW.state NOT IN ('failed','completed') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.state=NEW.state THEN RETURN NEW; END IF;
  IF NEW.state='completed' THEN code:='OK';
  ELSE
    code:=run_preflight_code(NEW.result_summary);
    IF code IS NULL THEN RETURN NEW; END IF;
    IF code='RECIPIENT_UNBOUND' THEN code:='BUSINESS_IDENTITY_UNBOUND'; END IF;
  END IF;
  INSERT INTO session_start_event(project_id,session_id,cause,source,run_id,task_id,task_revision_id)
  VALUES(NEW.project_id,NEW.session_id,code,'run',NEW.run_id,NEW.task_id,NEW.task_revision_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER session_start_event_run AFTER INSERT OR UPDATE OF state ON runtime_run FOR EACH ROW EXECUTE FUNCTION session_start_event_from_run();

-- A reservation the coordinator refused (no Run exists): one event for the Session, with the Task the reservation named.
CREATE FUNCTION record_session_start_refusal(p_project uuid,p_session uuid,p_task uuid,p_cause text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE revision uuid;
BEGIN
  SELECT current_revision_id INTO revision FROM task WHERE project_id=p_project AND task_id=p_task;
  IF revision IS NULL THEN RETURN; END IF;
  INSERT INTO session_start_event(project_id,session_id,cause,source,task_id,task_revision_id) VALUES(p_project,p_session,p_cause,'refusal',p_task,revision);
END $$;
