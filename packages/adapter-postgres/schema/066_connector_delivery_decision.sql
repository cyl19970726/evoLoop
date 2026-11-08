-- Migration 066. An external send is attempted at most once for the original delivery and request ID.
-- A lost response remains attempted until the original wx result can be observed.
CREATE TABLE connector_claim_attempt (
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  delivery_id bigint NOT NULL CHECK(delivery_id BETWEEN 1 AND 9007199254740991),
  route_version integer NOT NULL CHECK(route_version > 0),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz,
  owner text,
  epoch integer CHECK(epoch IS NULL OR epoch > 0),
  cursor_start bigint CHECK(cursor_start IS NULL OR cursor_start BETWEEN 0 AND 9007199254740991),
  cursor_end bigint CHECK(cursor_end IS NULL OR cursor_end BETWEEN cursor_start AND 9007199254740991),
  PRIMARY KEY(project_id,binding_id,delivery_id),
  FOREIGN KEY(project_id,binding_id) REFERENCES connector_route(project_id,binding_id),
  CHECK ((observed_at IS NULL) = (owner IS NULL)),
  CHECK ((owner IS NULL) = (epoch IS NULL)),
  CHECK ((owner IS NULL) = (cursor_start IS NULL)),
  CHECK ((owner IS NULL) = (cursor_end IS NULL))
);

CREATE TABLE connector_delivery_decision (
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  delivery_id bigint NOT NULL CHECK(delivery_id BETWEEN 1 AND 9007199254740991),
  route_version integer NOT NULL CHECK(route_version > 0),
  route_owner text NOT NULL,
  route_epoch integer NOT NULL CHECK(route_epoch > 0),
  route_session_ref text NOT NULL,
  conversation_id text NOT NULL,
  cursor_start bigint NOT NULL CHECK(cursor_start BETWEEN 0 AND 9007199254740991),
  cursor_end bigint NOT NULL CHECK(cursor_end BETWEEN cursor_start AND 9007199254740991),
  decision text NOT NULL CHECK(decision IN ('reply','draft','skip','defer')),
  request_id text,
  content text,
  state text NOT NULL DEFAULT 'prepared'
    CHECK(state IN ('prepared','attempted','observed','complete_attempted','complete_unknown','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,binding_id,delivery_id),
  FOREIGN KEY(project_id,binding_id) REFERENCES connector_route(project_id,binding_id),
  CHECK ((decision='reply') = (request_id IS NOT NULL AND content IS NOT NULL)),
  CHECK (request_id IS NULL OR request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
);
CREATE INDEX connector_delivery_decision_pending ON connector_delivery_decision(project_id,binding_id,state);

CREATE TABLE connector_transport_attempt (
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  delivery_id bigint NOT NULL CHECK(delivery_id BETWEEN 1 AND 9007199254740991),
  route_version integer NOT NULL CHECK(route_version > 0),
  reserve_attempted_at timestamptz NOT NULL DEFAULT now(),
  record_turn_id text,
  record_attempted_at timestamptz,
  finish_status text CHECK(finish_status IN ('completed','interrupted','failed')),
  finish_attempted_at timestamptz,
  PRIMARY KEY(project_id,binding_id,delivery_id),
  FOREIGN KEY(project_id,binding_id) REFERENCES connector_route(project_id,binding_id),
  CHECK ((record_turn_id IS NULL) = (record_attempted_at IS NULL)),
  CHECK ((finish_status IS NULL) = (finish_attempted_at IS NULL))
);

-- A new delivery needs the current active route. A delivery already reserved by
-- this exact route version may finish after pause, resume, or disable.
CREATE OR REPLACE FUNCTION check_connector_message_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE route_row connector_route%ROWTYPE;
DECLARE message_row session_message%ROWTYPE;
DECLARE session_row runtime_session%ROWTYPE;
DECLARE profile_row session_execution_profile%ROWTYPE;
DECLARE revision_row session_execution_profile_revision%ROWTYPE;
BEGIN
  SELECT * INTO route_row FROM connector_route
    WHERE project_id=NEW.project_id AND binding_id=NEW.binding_id FOR SHARE;
  IF NOT FOUND OR
    NOT ((route_row.state='active' AND route_row.version=NEW.route_version) OR
      (route_row.version>=NEW.route_version AND EXISTS(
        SELECT 1 FROM connector_transport_attempt t
        WHERE t.project_id=NEW.project_id AND t.binding_id=NEW.binding_id
          AND t.delivery_id=NEW.delivery_id AND t.route_version=NEW.route_version))) OR
    route_row.mode<>'standard'
    OR ROW(route_row.provider,route_row.connection_id,route_row.conversation_id,
      route_row.owner,route_row.epoch,route_row.session_ref,route_row.policy_hash)
      IS DISTINCT FROM ROW(NEW.provider,NEW.connection_id,NEW.conversation_id,
        NEW.route_owner,NEW.route_epoch,NEW.route_session_ref,NEW.route_policy_hash) THEN
    RAISE EXCEPTION 'connector route is not active or a frozen in-flight policy' USING ERRCODE='23514';
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
