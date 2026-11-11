-- Only business facts that need a Leader's attention enter this durable inbox.
-- Each source is admitted in the source transaction; ordinary progress and
-- read/review/plan effects have no trigger here.
CREATE TABLE leader_result_notice (
  project_id uuid NOT NULL REFERENCES project(project_id),
  notice_id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('task_todo','delivery','observation','task_question','task_blocker',
    'run_without_submission','run_submission_blocked')),
  source_event_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL,
  source_session_id uuid,
  source_actor_id text,
  source_ref text NOT NULL CHECK (length(btrim(source_ref)) > 0),
  occurred_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','linked','blocked')),
  message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_session_id uuid,
  receiver_role_id text,
  receiver_actor_id text,
  sender_actor_id text,
  linked_session_id uuid,
  blocked_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,notice_id),
  UNIQUE (project_id,kind,source_event_id),
  UNIQUE (project_id,message_id),
  UNIQUE (project_id,operation_id),
  CHECK (message_id<>operation_id),
  FOREIGN KEY (project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY (project_id,source_session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY (project_id,recipient_session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY (project_id,linked_session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK ((recipient_session_id IS NULL AND receiver_role_id IS NULL AND receiver_actor_id IS NULL AND sender_actor_id IS NULL)
      OR (recipient_session_id IS NOT NULL AND length(btrim(receiver_role_id)) > 0
        AND length(btrim(receiver_actor_id)) > 0 AND length(btrim(sender_actor_id)) > 0)),
  CHECK (linked_session_id IS NULL OR linked_session_id=recipient_session_id),
  CHECK ((state='linked' AND linked_session_id IS NOT NULL AND blocked_reason IS NULL)
      OR (state='blocked' AND linked_session_id IS NULL AND blocked_reason IS NOT NULL AND length(btrim(blocked_reason)) > 0)
      OR (state='pending' AND linked_session_id IS NULL AND
        (blocked_reason IS NULL OR length(btrim(blocked_reason)) > 0)))
);
CREATE INDEX leader_result_notice_pending_idx ON leader_result_notice(project_id,occurred_at,notice_id)
  WHERE state='pending';
CREATE INDEX leader_result_notice_task_idx ON leader_result_notice(project_id,task_id,occurred_at,notice_id);

CREATE FUNCTION protect_leader_result_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Leader notice history cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF ROW(NEW.project_id,NEW.notice_id,NEW.kind,NEW.source_event_id,NEW.task_id,NEW.task_revision_id,
      NEW.source_session_id,NEW.source_actor_id,NEW.source_ref,NEW.occurred_at,NEW.message_id,NEW.operation_id)
    IS DISTINCT FROM ROW(OLD.project_id,OLD.notice_id,OLD.kind,OLD.source_event_id,OLD.task_id,OLD.task_revision_id,
      OLD.source_session_id,OLD.source_actor_id,OLD.source_ref,OLD.occurred_at,OLD.message_id,OLD.operation_id)
    OR (OLD.recipient_session_id IS NOT NULL AND ROW(NEW.recipient_session_id,NEW.receiver_role_id,
      NEW.receiver_actor_id,NEW.sender_actor_id) IS DISTINCT FROM ROW(OLD.recipient_session_id,
      OLD.receiver_role_id,OLD.receiver_actor_id,OLD.sender_actor_id))
    OR (OLD.linked_session_id IS NOT NULL AND NEW.linked_session_id IS DISTINCT FROM OLD.linked_session_id)
    OR NEW.updated_at<OLD.updated_at
    OR NOT ((OLD.state='pending' AND NEW.state IN ('pending','blocked','linked'))
      OR (OLD.state='blocked' AND NEW.state='pending')) THEN
    RAISE EXCEPTION 'Leader notice origin or transition is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_identity BEFORE UPDATE OR DELETE ON leader_result_notice
  FOR EACH ROW EXECUTE FUNCTION protect_leader_result_notice();

CREATE FUNCTION enqueue_leader_result_notice(p_project uuid,p_kind text,p_event uuid,p_task uuid,
  p_revision uuid,p_session uuid,p_actor text,p_ref text,p_when timestamptz) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO leader_result_notice(project_id,kind,source_event_id,task_id,task_revision_id,
    source_session_id,source_actor_id,source_ref,occurred_at)
  VALUES(p_project,p_kind,p_event,p_task,p_revision,p_session,p_actor,p_ref,p_when)
  ON CONFLICT (project_id,kind,source_event_id) DO NOTHING;
END $$;

CREATE FUNCTION leader_result_notice_from_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version=1 AND NEW.state='todo' THEN
    PERFORM enqueue_leader_result_notice(NEW.project_id,'task_todo',NEW.revision_id,NEW.task_id,
      NEW.revision_id,NULL,NEW.actor_id,'task:'||NEW.task_id||'@'||NEW.revision_id,NEW.created_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_task AFTER INSERT ON task_revision
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_task();

CREATE FUNCTION leader_result_notice_from_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_session uuid;
BEGIN
  IF NEW.run_id IS NOT NULL THEN
    SELECT session_id INTO source_session FROM runtime_run WHERE project_id=NEW.project_id AND run_id=NEW.run_id;
  END IF;
  PERFORM enqueue_leader_result_notice(NEW.project_id,'delivery',NEW.delivery_id,NEW.task_id,
    NEW.task_revision_id,source_session,COALESCE(NEW.submitted_by_actor_id,NEW.actor_id),
    'delivery:'||NEW.delivery_id,NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_delivery AFTER INSERT ON delivery
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_delivery();

CREATE FUNCTION leader_result_notice_from_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delivered delivery%ROWTYPE;
BEGIN
  SELECT * INTO delivered FROM delivery WHERE project_id=NEW.project_id AND delivery_id=NEW.delivery_id;
  -- A reviewer attesting for someone else and the submitting actor's own report
  -- are not independent personal-use results for the Leader.
  IF NEW.observer IS DISTINCT FROM NEW.actor_id OR
     NEW.actor_id=COALESCE(delivered.submitted_by_actor_id,delivered.actor_id) THEN RETURN NEW; END IF;
  -- The Delivery Run belongs to its author, not to the QA observer. No
  -- verified QA Session binding is stored on consumer_observation.
  PERFORM enqueue_leader_result_notice(NEW.project_id,'observation',NEW.observation_id,NEW.task_id,
    delivered.task_revision_id,NULL,NEW.actor_id,'observation:'||NEW.observation_id,NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_observation AFTER INSERT ON consumer_observation
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_observation();

CREATE FUNCTION leader_result_notice_from_task_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE channel discussion%ROWTYPE;
DECLARE message_kind text;
BEGIN
  IF NEW.kind<>'message' OR NEW.collaboration_payload->>'type'<>'message' THEN RETURN NEW; END IF;
  message_kind:=NEW.collaboration_payload->>'kind';
  IF message_kind NOT IN ('question','blocker') THEN RETURN NEW; END IF;
  SELECT * INTO channel FROM discussion WHERE project_id=NEW.project_id AND discussion_id=NEW.discussion_id;
  IF channel.kind<>'task_collaboration' OR NEW.actor_id IS DISTINCT FROM channel.collaboration_recipient_actor_id
    THEN RETURN NEW; END IF;
  PERFORM enqueue_leader_result_notice(NEW.project_id,'task_'||message_kind,NEW.event_id,channel.task_id,
    channel.task_revision_id,channel.collaboration_session_id,NEW.actor_id,
    'discussion:'||NEW.discussion_id||'@'||NEW.event_id,NEW.created_at);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_task_message AFTER INSERT ON discussion_event
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_task_message();

-- A submission can be blocked, retried, and blocked again. Its version names
-- each distinct transition while replay of the same transition stays unique.
CREATE FUNCTION leader_submission_notice_event(p_submission uuid,p_version integer)
  RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT md5(p_submission::text||':'||p_version::text)::uuid
$$;

-- NOTE: patched in place by migration 078 (a Run stopped on request produces no notice); see pg_get_functiondef for today's body.
CREATE FUNCTION leader_result_notice_from_terminal_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submission ordinary_run_submission%ROWTYPE;
BEGIN
  IF NEW.state NOT IN ('completed','failed','interrupted') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state=NEW.state THEN RETURN NEW; END IF;
  END IF;
  -- Managed worker decisions/submissions have their own settlement path. An
  -- ordinary signed intent may still be sealing after the Run becomes terminal.
  IF EXISTS(SELECT 1 FROM delivery d WHERE d.project_id=NEW.project_id AND d.run_id=NEW.run_id)
    OR EXISTS(SELECT 1 FROM orchestration_dispatch d WHERE d.project_id=NEW.project_id
      AND d.data->>'runtimeRunId'=NEW.run_id::text) THEN RETURN NEW; END IF;
  SELECT * INTO submission FROM ordinary_run_submission s WHERE s.project_id=NEW.project_id AND s.run_id=NEW.run_id;
  IF FOUND THEN
    IF submission.state IN ('blocked','rejected') THEN
      PERFORM enqueue_leader_result_notice(NEW.project_id,'run_submission_blocked',
        leader_submission_notice_event(submission.submission_id,submission.version),
        NEW.task_id,NEW.task_revision_id,NEW.session_id,submission.submitted_by,
        'submission:'||submission.submission_id||'@v'||submission.version,
        submission.updated_at_utc);
    END IF;
    RETURN NEW;
  END IF;
  PERFORM enqueue_leader_result_notice(NEW.project_id,'run_without_submission',NEW.run_id,NEW.task_id,
    NEW.task_revision_id,NEW.session_id,NULL,'run:'||NEW.run_id,NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_terminal_run AFTER INSERT OR UPDATE OF state ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_terminal_run();

-- NOTE: patched in place by migration 078 (no notice for a stopped Run's voided submission); see pg_get_functiondef for today's body.
CREATE FUNCTION leader_result_notice_from_submission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_run runtime_run%ROWTYPE;
BEGIN
  IF NEW.state NOT IN ('blocked','rejected') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state=NEW.state THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO source_run FROM runtime_run WHERE project_id=NEW.project_id AND run_id=NEW.run_id;
  IF source_run.state NOT IN ('completed','failed','interrupted') OR
    EXISTS(SELECT 1 FROM delivery WHERE project_id=NEW.project_id AND run_id=NEW.run_id) THEN RETURN NEW; END IF;
  PERFORM enqueue_leader_result_notice(NEW.project_id,'run_submission_blocked',
    leader_submission_notice_event(NEW.submission_id,NEW.version),
    NEW.task_id,NEW.task_revision_id,NEW.session_id,NEW.submitted_by,
    'submission:'||NEW.submission_id||'@v'||NEW.version,NEW.updated_at_utc);
  RETURN NEW;
END $$;
CREATE TRIGGER leader_result_notice_submission AFTER INSERT OR UPDATE OF state ON ordinary_run_submission
  FOR EACH ROW EXECUTE FUNCTION leader_result_notice_from_submission();
