CREATE TABLE session_native_input_request (
  project_id uuid NOT NULL,
  input_request_id uuid NOT NULL,
  session_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  native_request_id jsonb NOT NULL CHECK(jsonb_typeof(native_request_id) IN ('string','number')),
  thread_id text NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 1024),
  turn_id text CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 1024),
  item_id text CHECK(item_id IS NULL OR length(item_id) BETWEEN 1 AND 1024),
  method text NOT NULL CHECK(method IN ('item/tool/requestUserInput','mcpServer/elicitation/request')),
  questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array' AND jsonb_array_length(questions) BETWEEN 0 AND 3 AND pg_column_size(questions)<=32768),
  is_blocking boolean NOT NULL,
  supported boolean NOT NULL,
  unavailable_reason text CHECK(unavailable_reason IS NULL OR length(unavailable_reason)<=4000),
  observed_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','response_saved','resolved','unavailable')),
  source jsonb,
  response jsonb CHECK(response IS NULL OR pg_column_size(response)<=20000),
  reason text CHECK(reason IS NULL OR length(reason)<=4000),
  version integer NOT NULL CHECK(version>0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,input_request_id),
  UNIQUE(project_id,connection_id,native_request_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK((state='response_saved')=(response IS NOT NULL) OR state IN ('resolved','unavailable')),
  CHECK(state<>'pending' OR supported),
  CHECK(NOT supported OR (turn_id IS NOT NULL AND item_id IS NOT NULL AND jsonb_array_length(questions)>=1))
);
CREATE INDEX session_native_input_session ON session_native_input_request(project_id,session_id,created_at DESC,input_request_id DESC);
CREATE INDEX session_native_input_pending ON session_native_input_request(project_id,created_at,input_request_id)
  WHERE state='response_saved';
CREATE FUNCTION protect_session_native_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native input cannot be deleted' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.project_id,NEW.input_request_id,NEW.session_id,NEW.connection_id,NEW.native_request_id,
    NEW.thread_id,NEW.turn_id,NEW.item_id,NEW.method,NEW.questions,NEW.is_blocking,NEW.supported,
    NEW.unavailable_reason,NEW.observed_at,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.project_id,OLD.input_request_id,OLD.session_id,OLD.connection_id,OLD.native_request_id,
    OLD.thread_id,OLD.turn_id,OLD.item_id,OLD.method,OLD.questions,OLD.is_blocking,OLD.supported,
    OLD.unavailable_reason,OLD.observed_at,OLD.created_at)
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
    OR (OLD.source IS NOT NULL AND NEW.source IS DISTINCT FROM OLD.source)
    OR (OLD.response IS NOT NULL AND (NEW.response IS NULL OR
      (NEW.response - 'attemptedAt' - 'submittedAt' - 'outcome') IS DISTINCT FROM
      (OLD.response - 'attemptedAt' - 'submittedAt' - 'outcome')))
    OR NOT ((OLD.state=NEW.state)
      OR (OLD.state='pending' AND NEW.state IN ('response_saved','resolved','unavailable'))
      OR (OLD.state='response_saved' AND NEW.state IN ('resolved','unavailable')))
  THEN RAISE EXCEPTION 'native input identity or transition is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_native_input_identity BEFORE UPDATE OR DELETE ON session_native_input_request
  FOR EACH ROW EXECUTE FUNCTION protect_session_native_input();
CREATE FUNCTION session_native_input_observe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM append_session_observation_row('session_native_input_request',to_jsonb(NEW)||jsonb_build_object('event_id',NEW.input_request_id),
    CASE WHEN TG_OP='UPDATE' THEN OLD.state ELSE NULL END);
  RETURN NEW;
END $$;
CREATE TRIGGER session_native_input_observation AFTER INSERT OR UPDATE ON session_native_input_request
  FOR EACH ROW EXECUTE FUNCTION session_native_input_observe();
