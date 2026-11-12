-- Session line events and Leader notices (DEC-045 W5 follow-up). The line (migration 087) already writes an immutable event for every step; this gives
-- the ones the design names a level, in the same way the other sources do:
--   immediate  line_entry_suspended        an entry that cannot start is suspended (entry.suspended)
--   digest     line_confirmation_returned  the Session returned its execution confirmation (entry.returned)
--   record     line_entry_appended / line_entry_started / line_entry_ended   (entry.appended, entry.started, entry.runEnded): read from the record view
-- "Consecutive skips" and direct-dispatch events belong to scheduled dispatch (S1) and are not here.
ALTER TABLE leader_result_notice DROP CONSTRAINT leader_result_notice_kind_check;
ALTER TABLE leader_result_notice ADD CONSTRAINT leader_result_notice_kind_check CHECK (kind IN
  ('task_todo','delivery','observation','observation_used','observation_failed','task_question','task_blocker',
   'run_without_submission','run_submission_blocked','task_attention','acceptance_blocked',
   'line_entry_suspended','line_confirmation_returned'));
-- The level is generated from the kind, so adding an immediate kind means regenerating the column.
DROP INDEX leader_result_notice_level_idx;
ALTER TABLE leader_result_notice DROP COLUMN level;
ALTER TABLE leader_result_notice ADD COLUMN level text GENERATED ALWAYS AS (CASE WHEN kind IN
  ('acceptance_blocked','run_submission_blocked','run_without_submission','task_question','task_blocker','observation_failed','line_entry_suspended')
  THEN 'immediate' ELSE 'digest' END) STORED;
CREATE INDEX leader_result_notice_level_idx ON leader_result_notice(project_id,level,occurred_at);

-- A line event has a sequence number, not an id; the notice's source id is a stable uuid made from the project and that sequence.
CREATE FUNCTION session_line_event_uuid(p_project uuid,p_seq bigint) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT md5(p_project::text||':line:'||p_seq::text)::uuid
$$;
CREATE FUNCTION leader_result_notice_from_session_line_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision uuid;
BEGIN
  IF NEW.kind NOT IN ('entry.suspended','entry.returned') OR NEW.task_id IS NULL THEN RETURN NEW; END IF;
  SELECT current_revision_id INTO revision FROM task WHERE project_id=NEW.project_id AND task_id=NEW.task_id;
  IF revision IS NULL THEN RETURN NEW; END IF;
  PERFORM enqueue_leader_result_notice(NEW.project_id,
    CASE NEW.kind WHEN 'entry.suspended' THEN 'line_entry_suspended' ELSE 'line_confirmation_returned' END,
    session_line_event_uuid(NEW.project_id,NEW.event_seq),NEW.task_id,revision,NEW.session_id,NEW.actor_id,
    'line:'||NEW.event_seq||':'||NEW.kind,NEW.at);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_session_line_event AFTER INSERT ON session_line_event
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_session_line_event();

-- The record-only line events join the record view (same columns).
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
    FROM session_line_event l WHERE l.kind IN ('entry.appended','entry.started','entry.runEnded') AND l.task_id IS NOT NULL;
