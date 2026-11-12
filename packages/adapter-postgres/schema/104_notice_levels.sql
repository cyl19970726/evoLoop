-- Notice levels (DEC-045 W5). Every Leader notice has one of three levels: immediate (sent at the next moment the Leader can take it, no 60 second
-- wait), digest (travels in the next packet after the debounce) and record only (never a notice: it is read from its own record, see the view below).
-- Only immediate and digest notices exist as leader_result_notice rows, so the level is a generated column of the kind: it cannot drift and needs no backfill.
ALTER TABLE leader_result_notice DROP CONSTRAINT leader_result_notice_kind_check;
ALTER TABLE leader_result_notice ADD CONSTRAINT leader_result_notice_kind_check CHECK (kind IN
  ('task_todo','delivery','observation','observation_used','observation_failed','task_question','task_blocker',
   'run_without_submission','run_submission_blocked','task_attention','acceptance_blocked'));
ALTER TABLE leader_result_notice ADD COLUMN level text GENERATED ALWAYS AS (CASE WHEN kind IN
  ('acceptance_blocked','run_submission_blocked','run_without_submission','task_question','task_blocker','observation_failed')
  THEN 'immediate' ELSE 'digest' END) STORED;
CREATE INDEX leader_result_notice_level_idx ON leader_result_notice(project_id,level,occurred_at);

-- An observation is told apart by its result: use is a digest notice (observation_used); a failure or a non-use is something the Leader has to act
-- on (observation_failed, immediate). Notices created before this migration keep the kind "observation" (digest).
CREATE OR REPLACE FUNCTION leader_result_notice_from_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivered delivery%ROWTYPE;
BEGIN
  SELECT * INTO delivered FROM delivery WHERE project_id=NEW.project_id AND delivery_id=NEW.delivery_id;
  -- A reviewer attesting for someone else and the submitting actor's own report
  -- are not independent personal-use results for the Leader.
  IF NEW.observer IS DISTINCT FROM NEW.actor_id OR
     NEW.actor_id=COALESCE(delivered.submitted_by_actor_id,delivered.actor_id) THEN RETURN NEW; END IF;
  PERFORM enqueue_leader_result_notice(NEW.project_id,CASE WHEN NEW.result='used' THEN 'observation_used' ELSE 'observation_failed' END,
    NEW.observation_id,NEW.task_id,delivered.task_revision_id,NULL,NEW.actor_id,'observation:'||NEW.observation_id,NEW.created_at);
  RETURN NEW;
END $$;

-- Record-only events. They wake no one and are not notices; this view is the one place to read them (the Q2 board and the daily evaluation read
-- it). It adds no storage: each row is a fact another table already keeps and cannot change.
--   run_stopped      a Run that ended after a stop request (its own `runtime_run` change also appears in `work changes`)
--   attention_resolved  a Task attention item that was resolved
--   notice_withdrawn    a Leader notice withdrawn before it was read (stale)
CREATE VIEW leader_event_record AS
  SELECT r.project_id, 'run_stopped'::text AS kind, r.run_id AS source_event_id, r.task_id, 'run:'||r.run_id AS source_ref, r.updated_at AS occurred_at
    FROM runtime_run r WHERE r.stop_requested_at IS NOT NULL AND r.state IN ('completed','failed','interrupted')
  UNION ALL
  SELECT i.project_id, 'attention_resolved', e.event_id, i.task_id, 'attention:'||i.item_id||'@v'||e.item_version, e.created_at
    FROM task_attention_item_event e JOIN task_attention_item i ON i.project_id=e.project_id AND i.item_id=e.item_id WHERE e.kind='resolved'
  UNION ALL
  SELECT n.project_id, 'notice_withdrawn', n.notice_id, n.task_id, 'notice:'||n.notice_id||':'||COALESCE(x.withdrawn_reason,'withdrawn'), x.updated_at
    FROM leader_notice_packet_item x JOIN leader_result_notice n ON n.project_id=x.project_id AND n.notice_id=x.notice_id WHERE x.state='withdrawn';
