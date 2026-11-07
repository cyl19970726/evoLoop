ALTER TABLE task_proposal ADD COLUMN acceptance_target text
  CHECK (acceptance_target IN ('human','leader','business_session'));

ALTER TABLE session_message_processing ADD COLUMN role_context text
  CHECK (role_context IS NULL OR length(role_context)<=3500);
CREATE FUNCTION guard_processing_role_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role_context IS DISTINCT FROM OLD.role_context THEN
    RAISE EXCEPTION 'fixed Role context cannot change after dispatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER processing_role_context_immutable BEFORE UPDATE ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION guard_processing_role_context();

CREATE TABLE task_acceptance_relay (
  project_id uuid NOT NULL REFERENCES project(project_id), relay_id uuid NOT NULL,
  operation_id uuid NOT NULL, request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), supersedes_relay_id uuid,
  task_id uuid NOT NULL, task_revision_id uuid NOT NULL, delivery_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('candidate','formal')),
  scope_key text NOT NULL CHECK (length(btrim(scope_key)) BETWEEN 1 AND 120),
  scope_description text NOT NULL CHECK (length(btrim(scope_description)) BETWEEN 1 AND 4000),
  entrypoint text, publication_ref text, reason text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('human','leader','session')),
  recipient_actor_id text NOT NULL CHECK (length(btrim(recipient_actor_id)) > 0),
  session_id uuid, native_thread_id text, role_id text, sender_actor_id text,
  message_id uuid, message_operation_id uuid,
  state text NOT NULL CHECK (state IN ('pending','linked','blocked','superseded','released')),
  blocked_reason text, arranged_by text NOT NULL, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id,relay_id), UNIQUE (project_id,operation_id),
  UNIQUE (project_id,message_id), UNIQUE (project_id,message_operation_id),
  FOREIGN KEY (project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY (project_id,delivery_id) REFERENCES delivery(project_id,delivery_id),
  FOREIGN KEY (project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY (project_id,supersedes_relay_id) REFERENCES task_acceptance_relay(project_id,relay_id),
  CHECK ((mode='human' AND session_id IS NULL AND native_thread_id IS NULL AND role_id IS NULL AND sender_actor_id IS NULL
    AND message_id IS NULL AND message_operation_id IS NULL) OR
    (mode<>'human' AND session_id IS NOT NULL AND native_thread_id IS NOT NULL AND role_id IS NOT NULL AND sender_actor_id IS NOT NULL
    AND message_id IS NOT NULL AND message_operation_id IS NOT NULL))
);
CREATE UNIQUE INDEX task_acceptance_relay_current ON task_acceptance_relay(project_id,delivery_id,stage,scope_key)
  WHERE state NOT IN ('superseded','released');
CREATE INDEX task_acceptance_relay_pending ON task_acceptance_relay(project_id,created_at,relay_id)
  WHERE state='pending';
CREATE INDEX task_acceptance_relay_task ON task_acceptance_relay(project_id,task_id,created_at DESC);

-- Serialize a new Delivery with the acceptance message's queued -> processing transition.
-- The lock gives one observable ordering even when the original pump preflight races publication.
CREATE FUNCTION lock_delivery_task_for_relay() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM task WHERE project_id=NEW.project_id AND task_id=NEW.task_id FOR UPDATE;
  RETURN NEW;
END $$;
CREATE TRIGGER acceptance_delivery_lock BEFORE INSERT ON delivery
  FOR EACH ROW EXECUTE FUNCTION lock_delivery_task_for_relay();

CREATE FUNCTION guard_acceptance_processing_start() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a task_acceptance_relay%ROWTYPE;
BEGIN
  SELECT * INTO a FROM task_acceptance_relay
    WHERE project_id=NEW.project_id AND message_id=NEW.message_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  PERFORM 1 FROM task WHERE project_id=a.project_id AND task_id=a.task_id FOR UPDATE;
  SELECT * INTO a FROM task_acceptance_relay
    WHERE project_id=NEW.project_id AND message_id=NEW.message_id;
  IF a.state NOT IN ('pending','linked') OR NOT EXISTS (
    SELECT 1 FROM task t JOIN session_message m ON m.project_id=a.project_id AND m.message_id=a.message_id
    JOIN LATERAL (SELECT delivery_id FROM delivery d WHERE d.project_id=t.project_id AND d.task_id=t.task_id
      ORDER BY created_at DESC,delivery_id DESC LIMIT 1) latest ON true
    WHERE t.project_id=a.project_id AND t.task_id=a.task_id
      AND t.state NOT IN ('done','cancelled') AND t.current_revision_id=a.task_revision_id
      AND latest.delivery_id=a.delivery_id AND m.state='queued'
      AND m.operation_id=a.message_operation_id AND m.sender_actor_id=a.sender_actor_id
      AND m.session_id=a.session_id AND m.context_task_id=a.task_id
      AND m.context_task_revision_id=a.task_revision_id
  ) THEN
    RAISE EXCEPTION 'acceptance source changed before message start'
      USING ERRCODE='23514',CONSTRAINT='acceptance_source_current';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER acceptance_processing_start BEFORE INSERT ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION guard_acceptance_processing_start();

CREATE TABLE task_acceptance_human_read (
  project_id uuid NOT NULL, relay_id uuid NOT NULL, operation_id uuid NOT NULL,
  actor_id text NOT NULL, evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 4000),
  read_at timestamptz NOT NULL,
  PRIMARY KEY (project_id,relay_id), UNIQUE (project_id,operation_id),
  FOREIGN KEY (project_id,relay_id) REFERENCES task_acceptance_relay(project_id,relay_id)
);
CREATE TABLE task_acceptance_observation_link (
  project_id uuid NOT NULL, relay_id uuid NOT NULL, observation_id uuid NOT NULL,
  operation_id uuid NOT NULL, actor_id text NOT NULL,
  evidence_level text NOT NULL CHECK (evidence_level IN ('human_credential','actor_message_turn')),
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (project_id,relay_id), UNIQUE (project_id,observation_id), UNIQUE (project_id,operation_id),
  FOREIGN KEY (project_id,relay_id) REFERENCES task_acceptance_relay(project_id,relay_id),
  FOREIGN KEY (project_id,observation_id) REFERENCES consumer_observation(project_id,observation_id)
);

-- An active arrangement cannot be satisfied by an unrelated observation made by the same actor.
CREATE FUNCTION guard_acceptance_relay_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM task_acceptance_relay a
    WHERE a.project_id=NEW.project_id AND a.task_id=NEW.task_id
      AND a.delivery_id=NEW.delivery_id AND a.state NOT IN ('superseded','released')
      AND NOT EXISTS (
        SELECT 1 FROM task_acceptance_observation_link l
        JOIN consumer_observation o ON o.project_id=l.project_id AND o.observation_id=l.observation_id
        WHERE l.project_id=a.project_id AND l.relay_id=a.relay_id AND o.result='used'
          AND o.delivery_id=a.delivery_id AND o.observer=a.recipient_actor_id
      )
  ) THEN
    RAISE EXCEPTION 'current acceptance arrangement lacks linked consumer use' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_closure_acceptance_relay_guard BEFORE INSERT ON task_closure
  FOR EACH ROW EXECUTE FUNCTION guard_acceptance_relay_closure();

CREATE TABLE session_retirement_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, session_id uuid NOT NULL,
  close_operation_id uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  expected_session_version integer NOT NULL CHECK(expected_session_version>0),
  actor_id text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000),
  handoff_evidence text NOT NULL CHECK(length(btrim(handoff_evidence)) BETWEEN 1 AND 4000),
  role_id text NOT NULL, native_thread_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,decision_id), UNIQUE(project_id,close_operation_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE INDEX session_retirement_by_session ON session_retirement_decision(project_id,session_id,created_at DESC);
CREATE TRIGGER session_retirement_decision_immutable BEFORE UPDATE OR DELETE ON session_retirement_decision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE FUNCTION guard_temporary_session_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='closing' AND OLD.state IS DISTINCT FROM 'closing' AND EXISTS (
    SELECT 1 FROM session_profile p WHERE p.project_id=NEW.project_id AND p.target_kind='owned'
      AND p.target_id=NEW.session_id AND p.tenure='temporary'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM session_retirement_decision d WHERE d.project_id=NEW.project_id
        AND d.session_id=NEW.session_id AND d.close_operation_id=NEW.close_operation_id
        AND d.expected_session_version=OLD.version AND d.role_id=OLD.role_id
        AND d.native_thread_id=OLD.native_thread_id
    ) THEN RAISE EXCEPTION 'temporary session lacks matching retirement decision' USING ERRCODE='23514'; END IF;
    IF EXISTS (
      SELECT 1 FROM task_session_assignment a JOIN task t ON t.project_id=a.project_id AND t.task_id=a.task_id
      WHERE a.project_id=NEW.project_id AND a.target_kind='owned' AND a.target_id=NEW.session_id
        AND a.state<>'released' AND t.state NOT IN ('done','cancelled')
    ) OR EXISTS (
      SELECT 1 FROM task_acceptance_relay a WHERE a.project_id=NEW.project_id
        AND a.session_id=NEW.session_id AND a.state NOT IN ('superseded','released')
        AND NOT EXISTS (
          SELECT 1 FROM task_acceptance_observation_link l
          JOIN consumer_observation o ON o.project_id=l.project_id AND o.observation_id=l.observation_id
          WHERE l.project_id=a.project_id AND l.relay_id=a.relay_id AND o.result IN ('used','failed','notUsed')
        )
    ) THEN RAISE EXCEPTION 'temporary session has unfinished business responsibility' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER temporary_session_retirement_guard BEFORE UPDATE ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION guard_temporary_session_retirement();
