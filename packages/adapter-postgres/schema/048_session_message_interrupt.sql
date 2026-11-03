ALTER TABLE session_message_processing
  ADD COLUMN interrupt_operation_id uuid,
  ADD COLUMN interrupt_actor_id text,
  ADD COLUMN interrupt_reason text CHECK(interrupt_reason IS NULL OR length(btrim(interrupt_reason)) BETWEEN 1 AND 4000),
  ADD COLUMN interrupt_requested_at timestamptz,
  ADD COLUMN interrupt_attempted_at timestamptz,
  ADD CONSTRAINT session_message_interrupt_complete CHECK (
    (interrupt_operation_id IS NULL AND interrupt_actor_id IS NULL AND interrupt_reason IS NULL
      AND interrupt_requested_at IS NULL AND interrupt_attempted_at IS NULL)
    OR (interrupt_operation_id IS NOT NULL AND interrupt_actor_id IS NOT NULL AND length(btrim(interrupt_actor_id)) > 0
      AND interrupt_reason IS NOT NULL AND interrupt_requested_at IS NOT NULL
      AND (interrupt_attempted_at IS NULL OR interrupt_attempted_at >= interrupt_requested_at)));
CREATE UNIQUE INDEX session_message_interrupt_operation ON session_message_processing(project_id,interrupt_operation_id)
  WHERE interrupt_operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_session_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'message record cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='session_message' THEN
    IF ROW(NEW.project_id,NEW.message_id,NEW.operation_id,NEW.target_kind,NEW.session_id,NEW.link_id,
      NEW.sender_actor_id,NEW.content,NEW.context_task_id,NEW.context_task_revision_id,NEW.reply_to_message_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.project_id,OLD.message_id,OLD.operation_id,OLD.target_kind,OLD.session_id,OLD.link_id,
      OLD.sender_actor_id,OLD.content,OLD.context_task_id,OLD.context_task_revision_id,OLD.reply_to_message_id,OLD.created_at)
      OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR NOT (
        (NEW.state=OLD.state AND NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason AND OLD.state='queued') OR
        (OLD.state='queued' AND NEW.state IN ('processing','cancelled')) OR
        (OLD.state='manual_pending' AND NEW.state='cancelled') OR
        (OLD.state='processing' AND NEW.state IN ('unknown','replied','completed_without_reply','failed')) OR
        (OLD.state='unknown' AND NEW.state IN ('processing','replied','completed_without_reply','failed'))
      ) THEN RAISE EXCEPTION 'message identity or transition is immutable' USING ERRCODE='23514'; END IF;
  ELSE
    IF ROW(NEW.project_id,NEW.processing_id,NEW.message_id,NEW.session_id,NEW.operation_id,NEW.receiver_actor_id,NEW.started_at,NEW.read_only_policy_fingerprint)
      IS DISTINCT FROM ROW(OLD.project_id,OLD.processing_id,OLD.message_id,OLD.session_id,OLD.operation_id,OLD.receiver_actor_id,OLD.started_at,OLD.read_only_policy_fingerprint)
      OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR
      (OLD.native_turn_id IS NOT NULL AND NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id) OR
      (OLD.interrupt_operation_id IS NOT NULL AND ROW(NEW.interrupt_operation_id,NEW.interrupt_actor_id,
        NEW.interrupt_reason,NEW.interrupt_requested_at) IS DISTINCT FROM
        ROW(OLD.interrupt_operation_id,OLD.interrupt_actor_id,OLD.interrupt_reason,OLD.interrupt_requested_at)) OR
      (OLD.interrupt_attempted_at IS NOT NULL AND NEW.interrupt_attempted_at IS DISTINCT FROM OLD.interrupt_attempted_at) OR NOT (
        (OLD.interrupt_operation_id IS NULL AND NEW.interrupt_operation_id IS NOT NULL AND NEW.state=OLD.state
          AND OLD.state IN ('running','unknown') AND NEW.interrupt_attempted_at IS NULL)
        OR (OLD.interrupt_operation_id IS NOT NULL AND OLD.interrupt_attempted_at IS NULL
          AND NEW.interrupt_attempted_at IS NOT NULL AND NEW.state=OLD.state AND OLD.state IN ('running','unknown'))
        OR (NEW.interrupt_operation_id IS NOT DISTINCT FROM OLD.interrupt_operation_id
          AND NEW.interrupt_attempted_at IS NOT DISTINCT FROM OLD.interrupt_attempted_at)
      ) OR NOT (
        (OLD.state='dispatching' AND NEW.state IN ('running','unknown','failed')) OR
        (OLD.state='unknown' AND NEW.state IN ('running','unknown','completed','failed')) OR
        (OLD.state='running' AND NEW.state IN ('unknown','completed','failed')) OR
        (OLD.state IN ('running','unknown') AND NEW.state=OLD.state AND
          ((OLD.interrupt_operation_id IS NULL AND NEW.interrupt_operation_id IS NOT NULL AND NEW.interrupt_attempted_at IS NULL)
            OR (OLD.interrupt_operation_id IS NOT NULL AND OLD.interrupt_attempted_at IS NULL
              AND NEW.interrupt_operation_id=OLD.interrupt_operation_id AND NEW.interrupt_attempted_at IS NOT NULL)))
      ) THEN RAISE EXCEPTION 'message processing identity or transition is immutable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
