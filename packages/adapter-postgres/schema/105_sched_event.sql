-- Scheduling event stream (DEC-045 Q2): one small metadata row per scheduling-relevant state change, written by AFTER triggers in the
-- same transaction as the change itself (no application write path changes, no second write by the application). Four categories:
-- notice, task, message, acceptance. Metadata only: who -> whom, the subject's kind and ID, the state before and after. Titles and links are
-- resolved when read, from the subject's own table; message text never enters this table.
--
-- Order. `seq` is taken after the same per-project advisory lock leader_work_change uses (record_leader_work_change), so within a project a
-- later seq cannot commit before an earlier one and a reader that has seen seq N has seen everything below it. Reusing that exact lock key
-- means a transaction that writes a work change and a scheduling event takes one lock, never two in different orders.
--
-- Retention: events older than 30 days are deleted by the coordinator (purge_sched_event). A reader whose cursor is below the oldest
-- retained seq is told resetRequired and reads the snapshot again.
CREATE TABLE sched_event (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project(project_id),
  at timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL CHECK(category IN ('notice','task','message','acceptance')),
  kind text NOT NULL CHECK(length(kind) BETWEEN 3 AND 60),
  session_id uuid,                 -- the Session node the event is about, when there is one
  task_id uuid,
  from_ref text,                   -- an actor ID, or a platform part ('system')
  to_ref text,
  subject_kind text NOT NULL CHECK(subject_kind IN ('notice','packet','task','queue_entry','run','delivery','message','input','relay','observation','closure','review','mark')),
  subject_id uuid NOT NULL,
  prior_state text,
  new_state text
);
CREATE INDEX sched_event_project_seq ON sched_event(project_id,seq);
CREATE INDEX sched_event_project_at ON sched_event(project_id,at,seq);

CREATE FUNCTION sched_event_emit(p uuid, cat text, k text, sess uuid, tsk uuid, f text, t text, sk text, sid uuid, prior text, next text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('leader-work:'||p::text,0));
  INSERT INTO sched_event(project_id,category,kind,session_id,task_id,from_ref,to_ref,subject_kind,subject_id,prior_state,new_state)
    VALUES(p,cat,k,sess,tsk,f,t,sk,sid,prior,next);
END $$;

-- ---- notice ----
CREATE FUNCTION sched_event_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM sched_event_emit(NEW.project_id,'notice','notice.created',NEW.source_session_id,NEW.task_id,COALESCE(NEW.source_actor_id,'system'),'leader','notice',NEW.notice_id,NULL,NEW.state);
  ELSIF NOT NEW.via_packet AND NEW.state IN ('linked','blocked') THEN
    -- Without packets the notice is its own message: linking it is the delivery (a new Turn); a packet notice is linked by the packet.
    PERFORM sched_event_emit(NEW.project_id,'notice',CASE WHEN NEW.state='linked' THEN 'notice.sent' ELSE 'notice.blocked' END,
      COALESCE(NEW.linked_session_id,NEW.recipient_session_id),NEW.task_id,NEW.sender_actor_id,NEW.receiver_actor_id,'notice',NEW.notice_id,OLD.state,NEW.state);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_notice_ins AFTER INSERT ON leader_result_notice FOR EACH ROW EXECUTE FUNCTION sched_event_notice();
CREATE TRIGGER sched_event_notice_upd AFTER UPDATE OF state ON leader_result_notice FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION sched_event_notice();

CREATE FUNCTION sched_event_packet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM sched_event_emit(NEW.project_id,'notice','notice.packet_built',NEW.session_id,NULL,'system',NULL,'packet',NEW.packet_id,NULL,NEW.state);
  ELSIF NEW.state NOT IN ('building','sent') THEN
    -- 'sent' is recorded with its method by the attempt row below.
    PERFORM sched_event_emit(NEW.project_id,'notice','notice.'||NEW.state,NEW.session_id,NULL,'system',NULL,'packet',NEW.packet_id,OLD.state,NEW.state);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_packet_ins AFTER INSERT ON leader_notice_packet FOR EACH ROW EXECUTE FUNCTION sched_event_packet();
CREATE TRIGGER sched_event_packet_upd AFTER UPDATE OF state ON leader_notice_packet FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION sched_event_packet();

CREATE FUNCTION sched_event_packet_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- new_turn: the packet opens a Turn (a message); steer: it goes into the running Turn.
  PERFORM sched_event_emit(NEW.project_id,'notice','notice.sent',(SELECT session_id FROM leader_notice_packet k WHERE k.project_id=NEW.project_id AND k.packet_id=NEW.packet_id),
    NULL,'system',NULL,'packet',NEW.packet_id,NULL,NEW.method);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_packet_attempt AFTER INSERT ON leader_notice_packet_attempt FOR EACH ROW EXECUTE FUNCTION sched_event_packet_attempt();

CREATE FUNCTION sched_event_packet_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- A notice enters a packet: the packet's ID travels in to_ref, so the stream alone ties a notice to what happens to its packet (metrics).
    IF NEW.state='pending' THEN
      PERFORM sched_event_emit(NEW.project_id,'notice','notice.packed',NULL,(SELECT n.task_id FROM leader_result_notice n WHERE n.project_id=NEW.project_id AND n.notice_id=NEW.notice_id),
        'system',NEW.packet_id::text,'notice',NEW.notice_id,NULL,NEW.state);
    END IF;
    RETURN NULL;
  END IF;
  PERFORM sched_event_emit(NEW.project_id,'notice',
    CASE WHEN NEW.state='handled' AND NEW.disposition='deferred' THEN 'notice.deferred' WHEN NEW.state='handled' THEN 'notice.handled' ELSE 'notice.withdrawn' END,
    NULL,(SELECT n.task_id FROM leader_result_notice n WHERE n.project_id=NEW.project_id AND n.notice_id=NEW.notice_id),
    COALESCE(NEW.handled_by,'system'),NULL,'notice',NEW.notice_id,OLD.state,NEW.state);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_packet_item_ins AFTER INSERT ON leader_notice_packet_item FOR EACH ROW EXECUTE FUNCTION sched_event_packet_item();
CREATE TRIGGER sched_event_packet_item AFTER UPDATE OF state ON leader_notice_packet_item FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('handled','withdrawn')) EXECUTE FUNCTION sched_event_packet_item();

-- ---- task ----
CREATE FUNCTION sched_event_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM sched_event_emit(NEW.project_id,'task','task.created',NULL,NEW.task_id,NULL,NULL,'task',NEW.task_id,NULL,NEW.state);
  ELSE
    PERFORM sched_event_emit(NEW.project_id,'task',CASE NEW.state WHEN 'in_progress' THEN 'task.started' ELSE 'task.'||NEW.state END,NULL,NEW.task_id,NULL,NULL,'task',NEW.task_id,OLD.state,NEW.state);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_task_ins AFTER INSERT ON task FOR EACH ROW EXECUTE FUNCTION sched_event_task();
CREATE TRIGGER sched_event_task_upd AFTER UPDATE OF state ON task FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION sched_event_task();

CREATE FUNCTION sched_event_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The recipient's lightweight execution confirmation, or the Task handed back.
  PERFORM sched_event_emit(NEW.project_id,'task',CASE WHEN NEW.verdict='confirm' THEN 'task.confirmed' ELSE 'task.returned' END,
    NULL,NEW.task_id,NEW.actor_id,NULL,'task',NEW.task_id,NULL,NEW.verdict);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_confirmation AFTER INSERT ON task_assignment_confirmation FOR EACH ROW EXECUTE FUNCTION sched_event_confirmation();

CREATE FUNCTION sched_event_queue_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE who text;
BEGIN
  IF TG_OP='INSERT' THEN
    -- The source of an appended entry is the identity that adopted the queue it was added to.
    SELECT q.actor_id INTO who FROM resident_queue q WHERE q.project_id=NEW.project_id AND q.queue_id=NEW.queue_id;
    PERFORM sched_event_emit(NEW.project_id,'task','task.queued',NEW.session_id,NEW.task_id,COALESCE(who,'system'),NULL,'queue_entry',NEW.entry_id,NULL,NEW.state);
  ELSIF OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM sched_event_emit(NEW.project_id,'task',CASE NEW.state WHEN 'claimed' THEN 'task.turn' WHEN 'released' THEN 'task.released' ELSE 'task.'||NEW.state END,
      NEW.session_id,NEW.task_id,NULL,NULL,'queue_entry',NEW.entry_id,OLD.state,NEW.state);
  ELSE
    PERFORM sched_event_emit(NEW.project_id,'task','task.reordered',NEW.session_id,NEW.task_id,NULL,NULL,'queue_entry',NEW.entry_id,OLD.position::text,NEW.position::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_queue_ins AFTER INSERT ON resident_queue_entry FOR EACH ROW EXECUTE FUNCTION sched_event_queue_entry();
CREATE TRIGGER sched_event_queue_upd AFTER UPDATE OF state,position ON resident_queue_entry FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.position IS DISTINCT FROM NEW.position) EXECUTE FUNCTION sched_event_queue_entry();

CREATE FUNCTION sched_event_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM sched_event_emit(NEW.project_id,'task','task.run_requested',NEW.session_id,NEW.task_id,NEW.actor_id,NULL,'run',NEW.run_id,NULL,NEW.state);
  ELSE
    PERFORM sched_event_emit(NEW.project_id,'task',CASE WHEN NEW.state='running' THEN 'task.run_started' ELSE 'task.run_ended' END,
      NEW.session_id,NEW.task_id,NEW.actor_id,NULL,'run',NEW.run_id,OLD.state,NEW.state);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_run_ins AFTER INSERT ON runtime_run FOR EACH ROW EXECUTE FUNCTION sched_event_run();
CREATE TRIGGER sched_event_run_upd AFTER UPDATE OF state ON runtime_run FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('running','completed','failed','interrupted','unknown')) EXECUTE FUNCTION sched_event_run();

CREATE FUNCTION sched_event_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sched_event_emit(NEW.project_id,'task','task.delivered',(SELECT r.session_id FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.run_id=NEW.run_id),
    NEW.task_id,NEW.actor_id,NULL,'delivery',NEW.delivery_id,NULL,NEW.technical_result);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_delivery AFTER INSERT ON delivery FOR EACH ROW EXECUTE FUNCTION sched_event_delivery();

-- ---- message ----
CREATE FUNCTION sched_event_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM sched_event_emit(NEW.project_id,'message','message.queued',NEW.session_id,NEW.context_task_id,NEW.sender_actor_id,NULL,'message',NEW.message_id,NULL,NEW.state);
  ELSE
    PERFORM sched_event_emit(NEW.project_id,'message','message.'||NEW.state,NEW.session_id,NEW.context_task_id,NULL,NULL,'message',NEW.message_id,OLD.state,NEW.state);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_message_ins AFTER INSERT ON session_message FOR EACH ROW EXECUTE FUNCTION sched_event_message();
CREATE TRIGGER sched_event_message_upd AFTER UPDATE OF state ON session_message FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION sched_event_message();

CREATE FUNCTION sched_event_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Direct input: into the running Turn (steer = inserted) or as a new Turn when idle (start). A refused one saved as a queued message is a message.queued.
  PERFORM sched_event_emit(NEW.project_id,'message',CASE WHEN NEW.mode='steer' THEN 'message.inserted' ELSE 'message.started' END,
    NEW.session_id,NULL,NEW.actor_id,NULL,'input',NEW.input_id,NULL,NEW.state);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_input AFTER INSERT ON session_direct_input FOR EACH ROW EXECUTE FUNCTION sched_event_input();

CREATE FUNCTION sched_event_manual_stop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sched_event_emit(NEW.project_id,'message','message.stopped',NEW.session_id,NULL,NEW.actor_id,NULL,'message',NEW.message_id,NULL,NULL);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_manual_stop AFTER INSERT ON session_message_manual_stop_evidence FOR EACH ROW EXECUTE FUNCTION sched_event_manual_stop();

-- ---- acceptance ----
CREATE FUNCTION sched_event_relay() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM sched_event_emit(NEW.project_id,'acceptance','acceptance.arranged',NEW.session_id,NEW.task_id,NEW.arranged_by,NEW.recipient_actor_id,'relay',NEW.relay_id,NULL,NEW.state);
  ELSE
    -- linked: the arrangement's message was posted (delivered to the verifier's Session).
    PERFORM sched_event_emit(NEW.project_id,'acceptance','acceptance.'||CASE NEW.state WHEN 'linked' THEN 'delivered' ELSE NEW.state END,
      NEW.session_id,NEW.task_id,NEW.arranged_by,NEW.recipient_actor_id,'relay',NEW.relay_id,OLD.state,NEW.state);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_relay_ins AFTER INSERT ON task_acceptance_relay FOR EACH ROW EXECUTE FUNCTION sched_event_relay();
CREATE TRIGGER sched_event_relay_upd AFTER UPDATE OF state ON task_acceptance_relay FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION sched_event_relay();

CREATE FUNCTION sched_event_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sched_event_emit(NEW.project_id,'acceptance','acceptance.observed',NULL,NEW.task_id,NEW.observer,NULL,'observation',NEW.observation_id,NULL,NEW.result);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_observation AFTER INSERT ON consumer_observation FOR EACH ROW EXECUTE FUNCTION sched_event_observation();

CREATE FUNCTION sched_event_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sched_event_emit(NEW.project_id,'acceptance','acceptance.closed',NULL,NEW.task_id,NEW.actor_id,NULL,'closure',NEW.closure_id,NULL,NEW.acceptance_result);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_closure AFTER INSERT ON task_closure FOR EACH ROW EXECUTE FUNCTION sched_event_closure();

CREATE FUNCTION sched_event_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sched_event_emit(NEW.project_id,'acceptance','acceptance.reviewed',NULL,NEW.task_id,NEW.actor_id,NULL,'review',NEW.review_id,NULL,NEW.decision);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_review AFTER INSERT ON leader_work_review FOR EACH ROW EXECUTE FUNCTION sched_event_review();

CREATE FUNCTION sched_event_mark() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The publication / precondition the acceptance waited for was marked met.
  PERFORM sched_event_emit(NEW.project_id,'acceptance','acceptance.precondition_marked',NULL,NEW.task_id,NEW.actor_id,NULL,'mark',NEW.mark_id,NULL,NULL);
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_mark AFTER INSERT ON task_acceptance_precondition_mark FOR EACH ROW EXECUTE FUNCTION sched_event_mark();

-- ---- retention ----
-- sched_event_floor holds, per project, the highest seq ever purged: a cursor at or below it may have missed deleted events (resetRequired).
-- (seq is one sequence for all projects, so a gap between two seqs of a project is normal and proves nothing; the floor does.)
CREATE TABLE sched_event_floor (project_id uuid PRIMARY KEY REFERENCES project(project_id), floor_seq bigint NOT NULL);
-- Deletes at most `batch` rows older than `days` days; the coordinator calls it until it returns 0.
CREATE FUNCTION purge_sched_event(days integer, batch integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF days < 1 OR batch < 1 THEN RAISE EXCEPTION 'days and batch must be positive'; END IF;
  WITH doomed AS (SELECT seq FROM sched_event WHERE at < now() - make_interval(days => days) ORDER BY seq LIMIT batch),
  del AS (DELETE FROM sched_event e USING doomed d WHERE e.seq = d.seq RETURNING e.project_id, e.seq),
  floors AS (INSERT INTO sched_event_floor(project_id,floor_seq) SELECT project_id, max(seq) FROM del GROUP BY project_id
    ON CONFLICT(project_id) DO UPDATE SET floor_seq = greatest(sched_event_floor.floor_seq, EXCLUDED.floor_seq))
  SELECT count(*) INTO n FROM del;
  RETURN n;
END $$;
