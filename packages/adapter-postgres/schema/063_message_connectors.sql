-- Migration 063. A route is configuration only. A later migration must add verified restricted
-- receiver evidence before opening active delivery.
CREATE TABLE connector_route (
  project_id uuid NOT NULL REFERENCES project(project_id),
  binding_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  connection_id text NOT NULL CHECK(connection_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  conversation_id text NOT NULL CHECK(conversation_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  conversation_label text NOT NULL CHECK(length(btrim(conversation_label)) BETWEEN 1 AND 200),
  conversation_kind text NOT NULL CHECK(conversation_kind IN ('group','private')),
  target_session_id uuid NOT NULL,
  target_thread_id text NOT NULL CHECK(target_thread_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  target_actor_id text NOT NULL CHECK(target_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  sender_actor_id text NOT NULL CHECK(sender_actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  owner text NOT NULL CHECK(owner ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  epoch integer NOT NULL CHECK(epoch>0),
  session_ref text NOT NULL CHECK(session_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  read_scope text NOT NULL DEFAULT 'project' CHECK(read_scope='project'),
  state text NOT NULL CHECK(state IN ('disabled','paused','active')),
  capabilities jsonb NOT NULL CHECK(
    jsonb_typeof(capabilities)='object'
    AND capabilities ?& ARRAY['history','search','subscribe','sendText','sendMedia','receipt']
    AND capabilities - ARRAY['history','search','subscribe','sendText','sendMedia','receipt']='{}'::jsonb
    AND jsonb_typeof(capabilities->'history')='boolean'
    AND jsonb_typeof(capabilities->'search')='boolean'
    AND jsonb_typeof(capabilities->'subscribe')='boolean'
    AND jsonb_typeof(capabilities->'sendText')='boolean'
    AND jsonb_typeof(capabilities->'sendMedia')='boolean'
    AND capabilities->>'receipt' IN ('local_observed','recipient_confirmed','none')
  ),
  policy_hash text NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,binding_id),
  FOREIGN KEY(project_id,target_session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK(target_actor_id<>sender_actor_id),
  -- Target actor and channel sessionRef have no authoritative native mapping here.
  -- Keep every route disabled until that provenance and restricted execution are proven.
  CONSTRAINT connector_route_activation_unproven CHECK(state='disabled')
);
CREATE UNIQUE INDEX connector_route_source_live ON connector_route(provider,connection_id,conversation_id)
  WHERE state IN ('active','paused');
CREATE UNIQUE INDEX connector_route_session_live ON connector_route(project_id,target_session_id)
  WHERE state IN ('active','paused');
CREATE INDEX connector_route_project_page ON connector_route(project_id,binding_id);

CREATE FUNCTION protect_connector_route_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'connector route cannot be deleted' USING ERRCODE='23514'; END IF;
  IF NEW.project_id<>OLD.project_id OR NEW.binding_id<>OLD.binding_id
    OR NEW.provider<>OLD.provider OR NEW.connection_id<>OLD.connection_id
    OR NEW.conversation_id<>OLD.conversation_id OR NEW.conversation_label<>OLD.conversation_label
    OR NEW.conversation_kind<>OLD.conversation_kind
    OR NEW.target_session_id<>OLD.target_session_id OR NEW.target_thread_id<>OLD.target_thread_id
    OR NEW.read_scope<>OLD.read_scope
    OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
    OR NEW.epoch<OLD.epoch OR (NEW.owner<>OLD.owner AND NEW.epoch=OLD.epoch) THEN
    RAISE EXCEPTION 'connector route identity or epoch changed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_route_identity BEFORE UPDATE OR DELETE ON connector_route
  FOR EACH ROW EXECUTE FUNCTION protect_connector_route_identity();

-- Committed in the same transaction as the route version it returns. Read this
-- row by operation ID after a lost response; never infer failure from a timeout.
CREATE TABLE connector_route_operation (
  project_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL CHECK(actor_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('create','update')),
  binding_id uuid NOT NULL,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,operation_id),
  FOREIGN KEY(project_id,binding_id) REFERENCES connector_route(project_id,binding_id)
);
CREATE INDEX connector_route_operation_binding ON connector_route_operation(project_id,binding_id,created_at DESC);
CREATE TRIGGER connector_route_operation_immutable BEFORE UPDATE OR DELETE ON connector_route_operation
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
