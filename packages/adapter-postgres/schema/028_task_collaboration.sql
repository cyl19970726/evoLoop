-- Task collaboration retains the existing Discussion/DiscussionEvent journal and DocumentRevision body authority.
ALTER TABLE discussion ALTER COLUMN goal_id DROP NOT NULL, ALTER COLUMN goal_version DROP NOT NULL;
ALTER TABLE discussion DROP CONSTRAINT discussion_kind_check;
ALTER TABLE discussion ADD CONSTRAINT discussion_kind_check CHECK(kind IN ('allocation','direction','task_collaboration'));
ALTER TABLE discussion ADD COLUMN collaboration_run_id uuid,
  ADD COLUMN collaboration_session_id uuid,
  ADD COLUMN collaboration_issuer_actor_id text,
  ADD COLUMN collaboration_recipient_actor_id text;
ALTER TABLE discussion ADD CONSTRAINT discussion_collaboration_shape CHECK (
  (kind='task_collaboration' AND goal_id IS NULL AND goal_version IS NULL AND stage_id IS NULL
    AND task_id IS NOT NULL AND task_revision_id IS NOT NULL AND collaboration_run_id IS NOT NULL
    AND collaboration_session_id IS NOT NULL AND collaboration_issuer_actor_id IS NOT NULL
    AND collaboration_recipient_actor_id IS NOT NULL AND collaboration_issuer_actor_id<>collaboration_recipient_actor_id)
  OR (kind<>'task_collaboration' AND goal_id IS NOT NULL AND goal_version IS NOT NULL
    AND collaboration_run_id IS NULL AND collaboration_session_id IS NULL
    AND collaboration_issuer_actor_id IS NULL AND collaboration_recipient_actor_id IS NULL));
ALTER TABLE discussion ADD CONSTRAINT discussion_collaboration_run_fk
  FOREIGN KEY(project_id,collaboration_run_id) REFERENCES runtime_run(project_id,run_id);
ALTER TABLE discussion ADD CONSTRAINT discussion_collaboration_session_fk
  FOREIGN KEY(project_id,collaboration_session_id) REFERENCES runtime_session(project_id,session_id);
ALTER TABLE discussion_event DROP CONSTRAINT discussion_event_kind_check;
ALTER TABLE discussion_event ADD CONSTRAINT discussion_event_kind_check CHECK(kind IN
  ('prepared','handoff','decision','action','message','receipt','action_request','action_decision','action_execution'));
ALTER TABLE discussion_event ADD COLUMN collaboration_payload jsonb;
ALTER TABLE discussion_event ADD CONSTRAINT discussion_event_collaboration_payload_check CHECK (
  (kind IN ('message','receipt','action_request','action_decision','action_execution')) = (collaboration_payload IS NOT NULL)
  AND (collaboration_payload IS NULL OR jsonb_typeof(collaboration_payload)='object'));
CREATE INDEX discussion_task_collaboration_idx ON discussion(project_id,task_id,collaboration_run_id)
  WHERE kind='task_collaboration';
CREATE FUNCTION validate_task_collaboration_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='task_collaboration' AND NOT EXISTS (
    SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.run_id=NEW.collaboration_run_id
      AND r.task_id=NEW.task_id AND r.task_revision_id=NEW.task_revision_id
      AND r.session_id=NEW.collaboration_session_id) THEN
    RAISE EXCEPTION 'Task collaboration Run must match fixed Task revision and Session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discussion_collaboration_head_validate BEFORE INSERT ON discussion
  FOR EACH ROW EXECUTE FUNCTION validate_task_collaboration_head();
CREATE FUNCTION validate_task_collaboration_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE channel discussion%ROWTYPE;
DECLARE body_ref jsonb;
BEGIN
  IF NEW.kind NOT IN ('message','receipt','action_request','action_decision','action_execution') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO channel FROM discussion WHERE project_id=NEW.project_id AND discussion_id=NEW.discussion_id;
  IF channel.kind IS DISTINCT FROM 'task_collaboration' OR NEW.document_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'Task collaboration event requires its channel participant and payload reference' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='action_execution' THEN
    IF NOT EXISTS (SELECT 1 FROM discussion_event request WHERE request.project_id=NEW.project_id
      AND request.discussion_id=NEW.discussion_id AND request.event_id=(NEW.collaboration_payload->>'requestEventId')::uuid
      AND request.kind='action_request' AND request.collaboration_payload->>'executorActorId'=NEW.actor_id) THEN
      RAISE EXCEPTION 'Action execution requires the designated actual executor' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.actor_id NOT IN (channel.collaboration_issuer_actor_id,channel.collaboration_recipient_actor_id) THEN
    RAISE EXCEPTION 'Only channel participants may write discussion messages and decisions' USING ERRCODE='23514';
  END IF;
  body_ref := CASE NEW.kind WHEN 'message' THEN NEW.collaboration_payload->'body'
    WHEN 'action_request' THEN NEW.collaboration_payload->'detail'
    WHEN 'action_execution' THEN NEW.collaboration_payload->'artifact'
    ELSE NEW.collaboration_payload->'evidence' END;
  IF NOT EXISTS (SELECT 1 FROM document_revision r WHERE r.project_id=NEW.project_id
    AND r.document_id=(body_ref->>'documentId')::uuid AND r.revision_id=(body_ref->>'revisionId')::uuid
    AND r.body IS NOT NULL AND r.format='markdown') THEN
    RAISE EXCEPTION 'Task collaboration payload must cite an existing same-project Markdown DocumentRevision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discussion_collaboration_event_validate BEFORE INSERT ON discussion_event
  FOR EACH ROW EXECUTE FUNCTION validate_task_collaboration_event();
CREATE OR REPLACE FUNCTION protect_discussion_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'discussion version must advance by one' USING ERRCODE='23514';
  END IF;
  IF (NEW.project_id,NEW.discussion_id,NEW.kind,NEW.document_id,NEW.prepared_document_revision_id,
      NEW.goal_id,NEW.goal_version,NEW.stage_id,NEW.stage_version,NEW.task_id,NEW.task_revision_id,
      NEW.adopted_documents,NEW.question,NEW.options,NEW.authorization_boundary,
      NEW.target_session_label,NEW.target_session_ref,NEW.actor_id,NEW.created_at,
      NEW.collaboration_run_id,NEW.collaboration_session_id,NEW.collaboration_issuer_actor_id,
      NEW.collaboration_recipient_actor_id)
     IS DISTINCT FROM
     (OLD.project_id,OLD.discussion_id,OLD.kind,OLD.document_id,OLD.prepared_document_revision_id,
      OLD.goal_id,OLD.goal_version,OLD.stage_id,OLD.stage_version,OLD.task_id,OLD.task_revision_id,
      OLD.adopted_documents,OLD.question,OLD.options,OLD.authorization_boundary,
      OLD.target_session_label,OLD.target_session_ref,OLD.actor_id,OLD.created_at,
      OLD.collaboration_run_id,OLD.collaboration_session_id,OLD.collaboration_issuer_actor_id,
      OLD.collaboration_recipient_actor_id) THEN
    RAISE EXCEPTION 'discussion fixed baseline is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
