-- One replaceable bounded current projection per owned Session. Native history never enters this table.
CREATE TABLE session_native_observation (
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  thread_id text NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 1024),
  connection_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  observed_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  freshness text NOT NULL CHECK(freshness IN ('live','stale')),
  stale_reason text CHECK(stale_reason IS NULL OR length(stale_reason)<=240),
  projection jsonb NOT NULL CHECK(jsonb_typeof(projection)='object' AND pg_column_size(projection)<=24576),
  PRIMARY KEY(project_id,session_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK((freshness='live')=(stale_reason IS NULL))
);
CREATE INDEX session_native_observation_connection ON session_native_observation(project_id,connection_id) WHERE freshness='live';
CREATE FUNCTION session_native_observation_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only identity, freshness and version enter the invalidation journal.
  PERFORM append_session_observation_row('session_native_observation',
    jsonb_build_object('project_id',NEW.project_id,'session_id',NEW.session_id,'event_id',NEW.session_id,
      'version',NEW.version,'state',NEW.freshness,'updated_at',NEW.observed_at),
    CASE WHEN TG_OP='UPDATE' THEN OLD.freshness ELSE NULL END);
  RETURN NEW;
END $$;
CREATE TRIGGER session_native_observation_change AFTER INSERT OR UPDATE ON session_native_observation
  FOR EACH ROW EXECUTE FUNCTION session_native_observation_changed();
