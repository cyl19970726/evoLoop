-- An external send is attempted at most once for the original delivery and request ID.
-- A lost response remains attempted until the original wx result can be observed.
CREATE TABLE connector_delivery_decision (
  project_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  delivery_id bigint NOT NULL CHECK(delivery_id BETWEEN 1 AND 9007199254740991),
  route_version integer NOT NULL CHECK(route_version > 0),
  decision text NOT NULL CHECK(decision IN ('reply','draft','skip','defer')),
  request_id text,
  content text,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','attempted','observed','complete_unknown','completed')),
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
