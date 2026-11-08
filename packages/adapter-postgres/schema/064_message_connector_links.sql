-- Migration 064. The connector links one admitted channel event to the existing platform queue.
-- No connector-owned dispatch queue or mutable copy of processing/Turn state.
-- Standard-v1 keeps the current full-only runtime Session fence unchanged.

-- Unsupported incoming events advance only after their bounded metadata is
-- persisted. They never create a SessionMessage or imply a reply decision.
CREATE TABLE connector_unhandled_event (
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  route_version integer NOT NULL CHECK(route_version > 0),
  route_owner text NOT NULL,
  route_epoch integer NOT NULL CHECK(route_epoch > 0),
  route_session_ref text NOT NULL,
  route_target_thread_id text NOT NULL,
  route_policy_hash text NOT NULL CHECK(route_policy_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL,
  connection_id text NOT NULL,
  conversation_id text NOT NULL,
  delivery_id bigint NOT NULL CHECK(delivery_id BETWEEN 1 AND 9007199254740991),
  cursor_start bigint NOT NULL CHECK(cursor_start BETWEEN 0 AND 9007199254740991),
  cursor_end bigint NOT NULL CHECK(cursor_end BETWEEN cursor_start AND 9007199254740991),
  event_cursor bigint NOT NULL CHECK(event_cursor BETWEEN cursor_start AND cursor_end),
  participant_id text CHECK(participant_id IS NULL OR
    participant_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  event_kind text NOT NULL CHECK(event_kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  direction text NOT NULL CHECK(direction ~ '^[a-z][a-z0-9_.-]{0,31}$'),
  reason text NOT NULL CHECK(reason IN ('unsupported_content','empty_text','text_too_large','sender_not_allowed')),
  content_length integer NOT NULL CHECK(content_length BETWEEN 0 AND 16000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,binding_id,delivery_id,event_cursor),
  UNIQUE(provider,connection_id,conversation_id,delivery_id,event_cursor),
  FOREIGN KEY(project_id,binding_id) REFERENCES connector_route(project_id,binding_id)
);
CREATE INDEX connector_unhandled_event_binding
  ON connector_unhandled_event(project_id,binding_id,delivery_id,event_cursor);
CREATE TRIGGER connector_unhandled_event_immutable BEFORE UPDATE OR DELETE ON connector_unhandled_event
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE TABLE connector_message_link (
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  route_version integer NOT NULL CHECK(route_version > 0),
  route_owner text NOT NULL,
  route_epoch integer NOT NULL CHECK(route_epoch > 0),
  route_session_ref text NOT NULL,
  route_policy_hash text NOT NULL CHECK(route_policy_hash ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL,
  connection_id text NOT NULL,
  conversation_id text NOT NULL,
  delivery_id bigint NOT NULL CHECK(delivery_id BETWEEN 1 AND 9007199254740991),
  cursor_start bigint NOT NULL CHECK(cursor_start BETWEEN 0 AND 9007199254740991),
  cursor_end bigint NOT NULL CHECK(cursor_end BETWEEN cursor_start AND 9007199254740991),
  event_cursor bigint NOT NULL CHECK(event_cursor BETWEEN cursor_start AND cursor_end),
  participant_id text,
  reply_to_event_cursor bigint CHECK(reply_to_event_cursor BETWEEN 1 AND 9007199254740991),
  message_id uuid NOT NULL,
  message_operation_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  decision text NOT NULL DEFAULT 'admitted' CHECK(decision = 'admitted'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,message_id),
  UNIQUE(provider,connection_id,conversation_id,delivery_id,event_cursor),
  UNIQUE(project_id,decision_id),
  FOREIGN KEY(project_id,binding_id) REFERENCES connector_route(project_id,binding_id),
  FOREIGN KEY(project_id,message_id) REFERENCES session_message(project_id,message_id),
  CHECK(participant_id IS NULL OR participant_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$')
);
CREATE INDEX connector_message_link_binding ON connector_message_link(project_id,binding_id,created_at);

-- Independent SQL guard for direct inserts, with the same row locks as admission.
CREATE FUNCTION check_connector_message_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE route_row connector_route%ROWTYPE;
DECLARE message_row session_message%ROWTYPE;
DECLARE session_row runtime_session%ROWTYPE;
DECLARE profile_row session_execution_profile%ROWTYPE;
DECLARE revision_row session_execution_profile_revision%ROWTYPE;
BEGIN
  SELECT * INTO route_row FROM connector_route
    WHERE project_id=NEW.project_id AND binding_id=NEW.binding_id FOR SHARE;
  IF NOT FOUND OR route_row.state<>'active' OR route_row.version<>NEW.route_version
    OR ROW(route_row.provider,route_row.connection_id,route_row.conversation_id,
      route_row.owner,route_row.epoch,route_row.session_ref,route_row.policy_hash)
      IS DISTINCT FROM ROW(NEW.provider,NEW.connection_id,NEW.conversation_id,
        NEW.route_owner,NEW.route_epoch,NEW.route_session_ref,NEW.route_policy_hash) THEN
    RAISE EXCEPTION 'connector route is not active at exact version/source' USING ERRCODE='23514';
  END IF;
  SELECT * INTO message_row FROM session_message
    WHERE project_id=NEW.project_id AND message_id=NEW.message_id FOR SHARE;
  IF NOT FOUND OR message_row.target_kind<>'owned'
    OR message_row.session_id<>route_row.target_session_id
    OR message_row.sender_actor_id<>route_row.sender_actor_id
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
  IF session_row.state<>'ready' OR session_row.native_thread_id IS NULL
    OR session_row.native_session_id IS NULL OR session_row.actor_id<>route_row.target_actor_id
    OR session_row.sandbox<>'read-only' OR session_row.approval_policy<>'never'
    OR session_row.authorization_scope<>('connector-receiver:'||NEW.binding_id::text)
    OR profile_row.activation_state<>'active'
    OR profile_row.revision_id IS DISTINCT FROM profile_row.active_revision_id
    OR revision_row.sandbox IS DISTINCT FROM session_row.sandbox
    OR revision_row.approval_policy IS DISTINCT FROM session_row.approval_policy
    OR revision_row.authorization_scope IS DISTINCT FROM session_row.authorization_scope THEN
    RAISE EXCEPTION 'connector receiver is not an active restricted Session' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_message_link_checked BEFORE INSERT ON connector_message_link
  FOR EACH ROW EXECUTE FUNCTION check_connector_message_link();
CREATE TRIGGER connector_message_link_immutable BEFORE UPDATE OR DELETE ON connector_message_link
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
