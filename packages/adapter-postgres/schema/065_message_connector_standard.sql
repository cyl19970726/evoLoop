-- Migration 065. PR198's disabled routes become explicitly restricted. Only reviewed standard
-- routes may subsequently enter active or paused states.
ALTER TABLE connector_route ADD COLUMN mode text NOT NULL DEFAULT 'restricted'
  CHECK(mode IN ('standard','restricted'));
ALTER TABLE connector_route ADD COLUMN send_targets text[] NOT NULL DEFAULT '{}';
ALTER TABLE connector_route ADD COLUMN sender_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE connector_route ADD COLUMN internal_targets uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE connector_route DROP CONSTRAINT connector_route_activation_unproven;
ALTER TABLE connector_route ADD CONSTRAINT connector_route_standard_only
  CHECK(state='disabled' OR mode='standard');

CREATE FUNCTION check_connector_standard_route() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session_row runtime_session%ROWTYPE;
DECLARE profile_row session_execution_profile%ROWTYPE;
DECLARE revision_row session_execution_profile_revision%ROWTYPE;
BEGIN
  IF cardinality(NEW.send_targets)>100 OR cardinality(NEW.sender_ids) NOT BETWEEN 1 AND 100
    OR cardinality(NEW.internal_targets)>100
    OR EXISTS(SELECT 1 FROM unnest(NEW.send_targets) AS t(id)
      WHERE id IS NULL OR id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$')
    OR (SELECT count(*) FROM unnest(NEW.send_targets)) <>
       (SELECT count(DISTINCT id) FROM unnest(NEW.send_targets) AS t(id))
    OR EXISTS(SELECT 1 FROM unnest(NEW.sender_ids) AS t(id)
      WHERE id IS NULL OR id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$')
    OR (SELECT count(*) FROM unnest(NEW.sender_ids)) <>
       (SELECT count(DISTINCT id) FROM unnest(NEW.sender_ids) AS t(id))
    OR array_position(NEW.internal_targets,NULL) IS NOT NULL
    OR (SELECT count(*) FROM unnest(NEW.internal_targets)) <>
       (SELECT count(DISTINCT id) FROM unnest(NEW.internal_targets) AS t(id)) THEN
    RAISE EXCEPTION 'connector route target allowlists are invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.mode='standard' AND NOT NEW.conversation_id=ANY(NEW.send_targets) THEN
    RAISE EXCEPTION 'standard route must allow source conversation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.mode<>OLD.mode OR NEW.target_actor_id<>OLD.target_actor_id OR
      NEW.sender_actor_id<>OLD.sender_actor_id OR
      ((NEW.send_targets IS DISTINCT FROM OLD.send_targets OR
        NEW.sender_ids IS DISTINCT FROM OLD.sender_ids OR
        NEW.internal_targets IS DISTINCT FROM OLD.internal_targets) AND
        (OLD.state<>'disabled' OR NEW.state<>'disabled' OR NEW.policy_hash=OLD.policy_hash)) THEN
      RAISE EXCEPTION 'route mode, actors or reviewed targets cannot change' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.state='disabled' THEN RETURN NEW; END IF;
  IF NEW.mode<>'standard' THEN
    RAISE EXCEPTION 'restricted connector activation remains blocked' USING ERRCODE='23514';
  END IF;
  SELECT * INTO session_row FROM runtime_session
    WHERE project_id=NEW.project_id AND session_id=NEW.target_session_id FOR SHARE;
  SELECT * INTO profile_row FROM session_execution_profile
    WHERE project_id=NEW.project_id AND session_id=NEW.target_session_id FOR SHARE;
  IF profile_row.revision_id IS NOT NULL THEN
    SELECT * INTO revision_row FROM session_execution_profile_revision
      WHERE project_id=NEW.project_id AND session_id=NEW.target_session_id
        AND revision_id=profile_row.revision_id FOR SHARE;
  END IF;
  IF session_row.state IS DISTINCT FROM 'ready'
    OR session_row.native_thread_id IS NULL OR session_row.native_session_id IS NULL
    OR session_row.native_thread_id IS DISTINCT FROM NEW.target_thread_id
    OR session_row.sandbox IS DISTINCT FROM 'danger-full-access'
    OR session_row.approval_policy IS DISTINCT FROM 'never'
    OR session_row.authorization_scope IS NULL OR session_row.authorization_scope=''
    OR profile_row.activation_state IS DISTINCT FROM 'active'
    OR profile_row.revision_id IS DISTINCT FROM profile_row.active_revision_id
    OR revision_row.sandbox IS DISTINCT FROM session_row.sandbox
    OR revision_row.approval_policy IS DISTINCT FROM session_row.approval_policy
    OR revision_row.authorization_scope IS DISTINCT FROM session_row.authorization_scope THEN
    RAISE EXCEPTION 'standard connector requires exact active owned Session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_route_standard_guard BEFORE INSERT OR UPDATE ON connector_route
  FOR EACH ROW EXECUTE FUNCTION check_connector_standard_route();

-- Direct SQL insertion must satisfy the same identity and mode boundary as the
-- application path. The original message and route locks remain authoritative.
CREATE OR REPLACE FUNCTION check_connector_message_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE route_row connector_route%ROWTYPE;
DECLARE message_row session_message%ROWTYPE;
DECLARE session_row runtime_session%ROWTYPE;
DECLARE profile_row session_execution_profile%ROWTYPE;
DECLARE revision_row session_execution_profile_revision%ROWTYPE;
BEGIN
  SELECT * INTO route_row FROM connector_route
    WHERE project_id=NEW.project_id AND binding_id=NEW.binding_id FOR SHARE;
  IF NOT FOUND OR route_row.state<>'active' OR route_row.mode<>'standard'
    OR route_row.version<>NEW.route_version
    OR ROW(route_row.provider,route_row.connection_id,route_row.conversation_id,
      route_row.owner,route_row.epoch,route_row.session_ref,route_row.policy_hash)
      IS DISTINCT FROM ROW(NEW.provider,NEW.connection_id,NEW.conversation_id,
        NEW.route_owner,NEW.route_epoch,NEW.route_session_ref,NEW.route_policy_hash) THEN
    RAISE EXCEPTION 'connector route is not active standard at exact version/source' USING ERRCODE='23514';
  END IF;
  SELECT * INTO message_row FROM session_message
    WHERE project_id=NEW.project_id AND message_id=NEW.message_id FOR SHARE;
  IF NOT FOUND OR message_row.target_kind<>'owned'
    OR message_row.session_id<>route_row.target_session_id
    OR message_row.sender_actor_id<>route_row.sender_actor_id
    OR NEW.participant_id IS NULL OR NOT NEW.participant_id=ANY(route_row.sender_ids)
    OR message_row.operation_id<>NEW.message_operation_id THEN
    RAISE EXCEPTION 'connector platform message identity differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO session_row FROM runtime_session
    WHERE project_id=NEW.project_id AND session_id=route_row.target_session_id FOR SHARE;
  SELECT * INTO profile_row FROM session_execution_profile
    WHERE project_id=NEW.project_id AND session_id=route_row.target_session_id FOR SHARE;
  IF profile_row.revision_id IS NOT NULL THEN
    SELECT * INTO revision_row FROM session_execution_profile_revision
      WHERE project_id=NEW.project_id AND session_id=route_row.target_session_id
        AND revision_id=profile_row.revision_id FOR SHARE;
  END IF;
  IF session_row.state IS DISTINCT FROM 'ready'
    OR session_row.native_thread_id IS NULL OR session_row.native_session_id IS NULL
    OR session_row.native_thread_id IS DISTINCT FROM route_row.target_thread_id
    OR session_row.sandbox IS DISTINCT FROM 'danger-full-access'
    OR session_row.approval_policy IS DISTINCT FROM 'never'
    OR session_row.authorization_scope IS NULL OR session_row.authorization_scope=''
    OR profile_row.activation_state IS DISTINCT FROM 'active'
    OR profile_row.revision_id IS DISTINCT FROM profile_row.active_revision_id
    OR revision_row.sandbox IS DISTINCT FROM session_row.sandbox
    OR revision_row.approval_policy IS DISTINCT FROM session_row.approval_policy
    OR revision_row.authorization_scope IS DISTINCT FROM session_row.authorization_scope THEN
    RAISE EXCEPTION 'connector receiver is not an active standard Session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
