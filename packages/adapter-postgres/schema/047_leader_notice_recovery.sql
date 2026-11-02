-- A rejected post is a historical fact. A human disposition creates a new
-- notification intent for the same source, with independently fixed IDs.
ALTER TABLE leader_result_notice
  ADD COLUMN recovery_parent_notice_id uuid,
  ADD COLUMN recovery_replacement_notice_id uuid,
  ADD COLUMN recovery_actor_id text,
  ADD COLUMN recovery_reason text,
  ADD CONSTRAINT leader_notice_recovery_parent_fk FOREIGN KEY(project_id,recovery_parent_notice_id)
    REFERENCES leader_result_notice(project_id,notice_id),
  ADD CONSTRAINT leader_notice_recovery_replacement_fk FOREIGN KEY(project_id,recovery_replacement_notice_id)
    REFERENCES leader_result_notice(project_id,notice_id),
  ADD CONSTRAINT leader_notice_recovery_not_self CHECK (
    recovery_parent_notice_id IS DISTINCT FROM notice_id AND
    recovery_replacement_notice_id IS DISTINCT FROM notice_id),
  ADD CONSTRAINT leader_notice_recovery_disposition CHECK (
    (recovery_replacement_notice_id IS NULL AND recovery_actor_id IS NULL AND recovery_reason IS NULL) OR
    (recovery_replacement_notice_id IS NOT NULL AND recovery_actor_id IS NOT NULL
      AND recovery_reason IS NOT NULL AND length(btrim(recovery_actor_id)) > 0
      AND length(btrim(recovery_reason)) BETWEEN 1 AND 4000));

ALTER TABLE leader_result_notice DROP CONSTRAINT leader_result_notice_project_id_kind_source_event_id_key;
CREATE UNIQUE INDEX leader_notice_original_source_key
  ON leader_result_notice(project_id,kind,source_event_id)
  WHERE recovery_parent_notice_id IS NULL;
CREATE UNIQUE INDEX leader_notice_single_replacement_key
  ON leader_result_notice(project_id,recovery_parent_notice_id)
  WHERE recovery_parent_notice_id IS NOT NULL;
CREATE UNIQUE INDEX leader_notice_replacement_identity_key
  ON leader_result_notice(project_id,recovery_replacement_notice_id)
  WHERE recovery_replacement_notice_id IS NOT NULL;

-- The source trigger must still deduplicate the original source after the
-- uniqueness rule becomes partial. Recovery inserts bypass this trigger.
CREATE OR REPLACE FUNCTION enqueue_leader_result_notice(p_project uuid,p_kind text,p_event uuid,p_task uuid,
  p_revision uuid,p_session uuid,p_actor text,p_ref text,p_when timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO leader_result_notice(project_id,kind,source_event_id,task_id,task_revision_id,
    source_session_id,source_actor_id,source_ref,occurred_at)
  VALUES(p_project,p_kind,p_event,p_task,p_revision,p_session,p_actor,p_ref,p_when)
  ON CONFLICT DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION protect_leader_result_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Leader notice history cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.project_id,NEW.notice_id,NEW.kind,NEW.source_event_id,NEW.task_id,NEW.task_revision_id,
      NEW.source_session_id,NEW.source_actor_id,NEW.source_ref,NEW.occurred_at,NEW.message_id,NEW.operation_id,
      NEW.recovery_parent_notice_id)
    IS DISTINCT FROM ROW(OLD.project_id,OLD.notice_id,OLD.kind,OLD.source_event_id,OLD.task_id,OLD.task_revision_id,
      OLD.source_session_id,OLD.source_actor_id,OLD.source_ref,OLD.occurred_at,OLD.message_id,OLD.operation_id,
      OLD.recovery_parent_notice_id)
    OR (OLD.recipient_session_id IS NOT NULL AND ROW(NEW.recipient_session_id,NEW.receiver_role_id,
      NEW.receiver_actor_id,NEW.sender_actor_id) IS DISTINCT FROM ROW(OLD.recipient_session_id,
      OLD.receiver_role_id,OLD.receiver_actor_id,OLD.sender_actor_id))
    OR (OLD.linked_session_id IS NOT NULL AND NEW.linked_session_id IS DISTINCT FROM OLD.linked_session_id)
    OR NEW.updated_at<OLD.updated_at
    OR (OLD.recovery_replacement_notice_id IS NOT NULL AND ROW(NEW.recovery_replacement_notice_id,
      NEW.recovery_actor_id,NEW.recovery_reason) IS DISTINCT FROM ROW(OLD.recovery_replacement_notice_id,
      OLD.recovery_actor_id,OLD.recovery_reason))
    OR (OLD.recovery_replacement_notice_id IS NULL AND NEW.recovery_replacement_notice_id IS NOT NULL AND
      (OLD.state<>'blocked' OR NEW.state<>'blocked' OR NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason))
    OR NOT ((OLD.state='pending' AND NEW.state IN ('pending','blocked','linked'))
      OR (OLD.state='blocked' AND NEW.state='pending' AND OLD.recovery_replacement_notice_id IS NULL
        AND OLD.blocked_reason NOT LIKE 'MESSAGE_POST_REJECTED:%')
      OR (OLD.state='blocked' AND NEW.state='blocked' AND OLD.recovery_replacement_notice_id IS NULL
        AND NEW.recovery_replacement_notice_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Leader notice origin or transition is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
