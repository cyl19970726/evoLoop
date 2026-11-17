-- A page that stopped rendering in the workbench (Task c3a8e5d1). The browser's page boundary posts what it caught so the cause survives a screenshot being
-- overwritten and does not depend on the console being open. Only what is needed to find the cause is kept (message, component names, route, build commit,
-- time); the service redacts token-like strings and bounds every field before it is stored. It is a bounded diagnostic list, not an error-reporting system:
-- each project keeps its newest 200 rows, and the same error from the same actor within a minute is stored once.
CREATE TABLE client_render_error (
  project_id uuid NOT NULL REFERENCES project(project_id),
  error_id uuid NOT NULL,
  actor_id text NOT NULL CHECK(length(btrim(actor_id))>0),
  fingerprint text NOT NULL CHECK(length(fingerprint)=64),
  route text NOT NULL CHECK(length(route)<=400),
  message text NOT NULL CHECK(length(message)<=600),
  component_stack text NOT NULL CHECK(length(component_stack)<=2400),
  commit text CHECK(commit IS NULL OR commit ~ '^[0-9a-f]{7,40}$'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,error_id)
);
CREATE INDEX client_render_error_recent ON client_render_error(project_id,recorded_at DESC);
CREATE INDEX client_render_error_dedupe ON client_render_error(project_id,actor_id,fingerprint,recorded_at DESC);
