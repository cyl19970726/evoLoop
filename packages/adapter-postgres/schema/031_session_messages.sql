CREATE TABLE session_message (
  project_id uuid NOT NULL REFERENCES project(project_id), message_id uuid NOT NULL,
  operation_id uuid NOT NULL, target_kind text NOT NULL CHECK(target_kind IN ('owned','external')),
  session_id uuid, link_id uuid, sender_actor_id text NOT NULL CHECK(length(btrim(sender_actor_id))>0),
  content text NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 16000),
  context_task_id uuid, context_task_revision_id uuid, reply_to_message_id uuid,
  state text NOT NULL CHECK(state IN ('queued','processing','replied','completed_without_reply','failed','unknown','cancelled','manual_pending')),
  version integer NOT NULL CHECK(version>0), blocked_reason text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,message_id), UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY(project_id,link_id) REFERENCES role_host_link(project_id,link_id),
  FOREIGN KEY(project_id,context_task_id,context_task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY(project_id,reply_to_message_id) REFERENCES session_message(project_id,message_id),
  CHECK((target_kind='owned' AND session_id IS NOT NULL AND link_id IS NULL AND state<>'manual_pending') OR
        (target_kind='external' AND link_id IS NOT NULL AND session_id IS NULL AND state IN ('manual_pending','cancelled'))),
  CHECK((context_task_id IS NULL)=(context_task_revision_id IS NULL))
);
CREATE INDEX session_message_owned_order ON session_message(project_id,session_id,created_at,message_id) WHERE target_kind='owned';
CREATE INDEX session_message_external_order ON session_message(project_id,link_id,created_at,message_id) WHERE target_kind='external';
CREATE INDEX session_message_pending ON session_message(project_id,created_at,message_id) WHERE state IN ('queued','processing','unknown');

CREATE TABLE session_message_processing (
  project_id uuid NOT NULL, processing_id uuid NOT NULL, message_id uuid NOT NULL,
  session_id uuid NOT NULL, operation_id uuid NOT NULL, receiver_actor_id text NOT NULL CHECK(length(btrim(receiver_actor_id))>0),
  state text NOT NULL CHECK(state IN ('dispatching','running','unknown','completed','failed')),
  native_turn_id text, response text CHECK(response IS NULL OR length(response)<=65536),
  failure text CHECK(failure IS NULL OR length(failure)<=4000),
  read_only_policy_fingerprint text NOT NULL CHECK(read_only_policy_fingerprint ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK(version>0),
  started_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,processing_id), UNIQUE(project_id,message_id), UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,message_id) REFERENCES session_message(project_id,message_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  CHECK(state NOT IN ('dispatching','unknown') OR response IS NULL)
);
CREATE UNIQUE INDEX session_message_occupied_session ON session_message_processing(project_id,session_id)
  WHERE state IN ('dispatching','running','unknown');
CREATE UNIQUE INDEX session_message_native_turn ON session_message_processing(project_id,native_turn_id)
  WHERE native_turn_id IS NOT NULL;
CREATE TABLE session_message_read_receipt (
  project_id uuid NOT NULL, message_id uuid NOT NULL, actor_id text NOT NULL,
  evidence text NOT NULL CHECK(length(btrim(evidence)) BETWEEN 1 AND 4000), recorded_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,message_id,actor_id),
  FOREIGN KEY(project_id,message_id) REFERENCES session_message(project_id,message_id)
);
CREATE TRIGGER session_message_receipt_immutable BEFORE UPDATE OR DELETE ON session_message_read_receipt
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE FUNCTION protect_session_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'message record cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='session_message' THEN
    IF ROW(NEW.project_id,NEW.message_id,NEW.operation_id,NEW.target_kind,NEW.session_id,NEW.link_id,
      NEW.sender_actor_id,NEW.content,NEW.context_task_id,NEW.context_task_revision_id,NEW.reply_to_message_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.project_id,OLD.message_id,OLD.operation_id,OLD.target_kind,OLD.session_id,OLD.link_id,
      OLD.sender_actor_id,OLD.content,OLD.context_task_id,OLD.context_task_revision_id,OLD.reply_to_message_id,OLD.created_at)
      OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR NOT (
        (NEW.state=OLD.state AND NEW.blocked_reason IS DISTINCT FROM OLD.blocked_reason AND OLD.state='queued') OR
        (OLD.state='queued' AND NEW.state IN ('processing','cancelled')) OR
        (OLD.state='manual_pending' AND NEW.state='cancelled') OR
        (OLD.state='processing' AND NEW.state IN ('unknown','replied','completed_without_reply','failed')) OR
        (OLD.state='unknown' AND NEW.state IN ('processing','replied','completed_without_reply','failed'))
      ) THEN RAISE EXCEPTION 'message identity or transition is immutable' USING ERRCODE='23514'; END IF;
  ELSE
    IF ROW(NEW.project_id,NEW.processing_id,NEW.message_id,NEW.session_id,NEW.operation_id,NEW.receiver_actor_id,NEW.started_at,NEW.read_only_policy_fingerprint)
      IS DISTINCT FROM ROW(OLD.project_id,OLD.processing_id,OLD.message_id,OLD.session_id,OLD.operation_id,OLD.receiver_actor_id,OLD.started_at,OLD.read_only_policy_fingerprint)
      OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at OR
      (OLD.native_turn_id IS NOT NULL AND NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id) OR NOT (
        (OLD.state='dispatching' AND NEW.state IN ('running','unknown','failed')) OR
        (OLD.state='unknown' AND NEW.state IN ('running','unknown','completed','failed')) OR
        (OLD.state='running' AND NEW.state IN ('unknown','completed','failed'))
      ) THEN RAISE EXCEPTION 'message processing identity or transition is immutable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_message_identity BEFORE UPDATE OR DELETE ON session_message FOR EACH ROW EXECUTE FUNCTION protect_session_message_identity();
CREATE TRIGGER session_message_processing_identity BEFORE UPDATE OR DELETE ON session_message_processing FOR EACH ROW EXECUTE FUNCTION protect_session_message_identity();
CREATE TABLE session_message_schedule (
  project_id uuid NOT NULL, session_id uuid NOT NULL, must_yield_business boolean NOT NULL,
  last_message_id uuid, last_business_run_id uuid, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,session_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY(project_id,last_message_id) REFERENCES session_message(project_id,message_id),
  FOREIGN KEY(project_id,last_business_run_id) REFERENCES runtime_run(project_id,run_id)
);
CREATE FUNCTION session_message_business_turn_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A reservation or dispatch attempt is not a business Turn. Clear fairness only after
  -- the original Run has bound a real native Turn and entered running.
  IF NEW.state<>'running' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.state='running' THEN RETURN NEW; END IF;
  END IF;
  UPDATE session_message_schedule SET must_yield_business=false,last_business_run_id=NEW.run_id,updated_at=now()
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER session_message_business_turn AFTER INSERT OR UPDATE OF state ON runtime_run FOR EACH ROW
  EXECUTE FUNCTION session_message_business_turn_record();

-- The project command journal serializes ordinary writes. This lock also protects direct SQL writers.
CREATE FUNCTION assert_session_turn_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='runtime_run' THEN
    IF NEW.state NOT IN ('requested','dispatching','running','unknown') THEN RETURN NEW; END IF;
  ELSE
    IF NEW.state NOT IN ('dispatching','running','unknown') THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.project_id::text || ':' || NEW.session_id::text, 871921));
  IF TG_TABLE_NAME='runtime_run' THEN
    IF EXISTS(SELECT 1 FROM session_message_processing p WHERE p.project_id=NEW.project_id
      AND p.session_id=NEW.session_id AND p.state IN ('dispatching','running','unknown')) THEN
      RAISE EXCEPTION 'Session occupied by ordinary message' USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id
      AND r.session_id=NEW.session_id AND r.state IN ('requested','dispatching','running','unknown')) THEN
      RAISE EXCEPTION 'Session occupied by Task Run' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_message_processing_slot BEFORE INSERT OR UPDATE OF state ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION assert_session_turn_slot();
CREATE TRIGGER runtime_run_message_slot BEFORE INSERT OR UPDATE OF state ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION assert_session_turn_slot();

CREATE TRIGGER session_message_observation AFTER INSERT OR UPDATE OR DELETE ON session_message
  FOR EACH ROW EXECUTE FUNCTION record_session_observation_change();
CREATE TRIGGER session_message_processing_observation AFTER INSERT OR UPDATE OR DELETE ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION record_session_observation_change();

-- A receipt is its own immutable fact. Refresh its exact recipient without
-- modifying the terminal message or attributing the read to the sender.
CREATE FUNCTION session_message_read_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE message_row record;
BEGIN
  SELECT session_id,link_id,target_kind INTO message_row FROM session_message
    WHERE project_id=NEW.project_id AND message_id=NEW.message_id;
  PERFORM append_session_observation_row('session_message_read_receipt',to_jsonb(NEW)||
    jsonb_build_object('session_id',message_row.session_id,'target_kind',message_row.target_kind,
      'target_id',COALESCE(message_row.session_id,message_row.link_id),'created_at',NEW.recorded_at,
      'state','read','detail','接收者已明确记录收阅'));
  RETURN NEW;
END $$;
CREATE TRIGGER session_message_read_observation AFTER INSERT ON session_message_read_receipt
  FOR EACH ROW EXECUTE FUNCTION session_message_read_observation();
