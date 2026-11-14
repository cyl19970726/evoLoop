-- Scheduling events for the Session line (Q1) and a message that started a Turn (defect 52eb5ecf of Q2, migration 105).
--  1. Migration 105 hung its queue triggers on resident_queue_entry, the old batch queue. The line Leaders and schedules actually use
--     (087_session_line.sql: session_line_entry; its own session_line_event table says it is for Q2) wrote no scheduling event at all.
--     Now every line entry change is an event: appended (task.queued, from the source actor), resumed, started its turn (task.turn),
--     suspended (task.held), withdrawn (task.removed), moved (task.reordered), and released when its Run ended (task.released).
--  2. A direct input on an idle Session starts a Turn: session_direct_input.start inserts its message already 'processing', and the
--     input trigger records message.started. The message insert trigger recorded it as message.queued as well, so the Session counted
--     as having work waiting (and not busy). Only a message that really waits is message.queued.
ALTER TABLE sched_event DROP CONSTRAINT sched_event_subject_kind_check;
ALTER TABLE sched_event ADD CONSTRAINT sched_event_subject_kind_check CHECK(subject_kind IN
  ('notice','packet','task','queue_entry','line_entry','run','delivery','message','input','relay','observation','closure','review','mark'));

CREATE FUNCTION sched_event_line_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM sched_event_emit(NEW.project_id,'task','task.queued',NEW.session_id,NEW.task_id,NEW.source_actor_id,NULL,'line_entry',NEW.entry_id,NULL,NEW.state);
    RETURN NULL;
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    k:=CASE WHEN NEW.state='queued' THEN 'task.resumed' WHEN NEW.state='starting' THEN 'task.turn' WHEN NEW.state='suspended' THEN 'task.held'
             WHEN NEW.state='withdrawn' THEN 'task.removed' ELSE NULL END;
    -- started: the Run's own events say so; only its release (the Run ended) is a line event.
    IF k IS NOT NULL THEN
      PERFORM sched_event_emit(NEW.project_id,'task',k,NEW.session_id,NEW.task_id,NULL,NULL,'line_entry',NEW.entry_id,OLD.state,NEW.state);
    END IF;
  ELSIF OLD.run_ended_at IS NULL AND NEW.run_ended_at IS NOT NULL THEN
    PERFORM sched_event_emit(NEW.project_id,'task','task.released',NEW.session_id,NEW.task_id,NULL,NULL,'line_entry',NEW.entry_id,NEW.state,NEW.state);
  ELSIF OLD.position IS DISTINCT FROM NEW.position THEN
    PERFORM sched_event_emit(NEW.project_id,'task','task.reordered',NEW.session_id,NEW.task_id,NULL,NULL,'line_entry',NEW.entry_id,OLD.position::text,NEW.position::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sched_event_line_entry_ins AFTER INSERT ON session_line_entry FOR EACH ROW EXECUTE FUNCTION sched_event_line_entry();
CREATE TRIGGER sched_event_line_entry_upd AFTER UPDATE OF state,position,run_ended_at ON session_line_entry FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.position IS DISTINCT FROM NEW.position OR (OLD.run_ended_at IS NULL AND NEW.run_ended_at IS NOT NULL))
  EXECUTE FUNCTION sched_event_line_entry();

CREATE OR REPLACE FUNCTION sched_event_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    -- A message saved already processing is a direct start: session_direct_input records it as message.started.
    IF NEW.state='queued' THEN
      PERFORM sched_event_emit(NEW.project_id,'message','message.queued',NEW.session_id,NEW.context_task_id,NEW.sender_actor_id,NULL,'message',NEW.message_id,NULL,NEW.state);
    END IF;
  ELSE
    PERFORM sched_event_emit(NEW.project_id,'message','message.'||NEW.state,NEW.session_id,NEW.context_task_id,NULL,NULL,'message',NEW.message_id,OLD.state,NEW.state);
  END IF;
  RETURN NULL;
END $$;
