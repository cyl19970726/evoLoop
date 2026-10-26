-- The configured launch profile is versioned independently of native telemetry.
CREATE FUNCTION session_recovery_fixed_uuid(seed text) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT overlay(overlay(md5(seed) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;
CREATE TABLE session_execution_profile_revision (
  project_id uuid NOT NULL, session_id uuid NOT NULL, revision_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), previous_revision_id uuid,
  model text, sandbox text NOT NULL CHECK(sandbox IN ('read-only','workspace-write')),
  approval_policy text NOT NULL CHECK(approval_policy IN ('on-request','untrusted')),
  cwd text NOT NULL, authorization_scope text NOT NULL,
  provenance text NOT NULL CHECK(provenance IN ('reserved','legacy_session_identity','revised')),
  operation_id uuid NOT NULL, actor_id text NOT NULL, reason text NOT NULL, evidence_ref text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,session_id,revision_id), UNIQUE(project_id,session_id,version),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY(project_id,session_id,previous_revision_id)
    REFERENCES session_execution_profile_revision(project_id,session_id,revision_id)
);
CREATE TRIGGER session_execution_profile_revision_immutable BEFORE UPDATE OR DELETE ON session_execution_profile_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TABLE session_execution_profile (
  project_id uuid NOT NULL, session_id uuid NOT NULL, revision_id uuid NOT NULL,
  active_revision_id uuid,
  activation_state text NOT NULL CHECK(activation_state IN ('active','pending','attempting','unknown','rejected')),
  activation_operation_id uuid, attempted_at timestamptz, activation_evidence text,
  PRIMARY KEY(project_id,session_id), FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY(project_id,session_id,revision_id)
    REFERENCES session_execution_profile_revision(project_id,session_id,revision_id),
  FOREIGN KEY(project_id,session_id,active_revision_id)
    REFERENCES session_execution_profile_revision(project_id,session_id,revision_id)
);
-- A migration snapshot is a configured historical identity, never observed model telemetry.
INSERT INTO session_execution_profile_revision(project_id,session_id,revision_id,version,model,sandbox,approval_policy,cwd,
  authorization_scope,provenance,operation_id,actor_id,reason,created_at)
SELECT project_id,session_id,session_recovery_fixed_uuid(project_id::text||':'||session_id::text||':legacy-profile'),1,
  model,sandbox,approval_policy,cwd,authorization_scope,'legacy_session_identity',operation_id,actor_id,
  'Persisted Session launch identity at migration; native per-Turn model unobserved',created_at
FROM runtime_session;
INSERT INTO session_execution_profile(project_id,session_id,revision_id,active_revision_id,activation_state,activation_evidence)
SELECT project_id,session_id,session_recovery_fixed_uuid(project_id::text||':'||session_id::text||':legacy-profile'),
  CASE WHEN native_thread_id IS NOT NULL THEN session_recovery_fixed_uuid(project_id::text||':'||session_id::text||':legacy-profile') ELSE NULL END,
  CASE WHEN native_thread_id IS NOT NULL THEN 'active' ELSE 'pending' END,
  'Legacy persisted configured identity; no native model telemetry'
FROM runtime_session;
ALTER TABLE runtime_run ADD COLUMN execution_profile_snapshot jsonb;
-- Existing immutable rows receive one migration-time configured snapshot. No Run state,
-- identity, version, or native telemetry is rewritten; ordinary updates remain protected.
ALTER TABLE runtime_run DISABLE TRIGGER runtime_run_identity;
ALTER TABLE runtime_run DISABLE TRIGGER runtime_run_session_observation;
UPDATE runtime_run r SET execution_profile_snapshot=jsonb_build_object(
  'revisionId',p.revision_id,'version',p.version,'model',p.model,'sandbox',p.sandbox,
  'approvalPolicy',p.approval_policy,'cwd',p.cwd,'authorizationScope',p.authorization_scope,
  'provenance',p.provenance)
FROM session_execution_profile_revision p WHERE p.project_id=r.project_id AND p.session_id=r.session_id AND p.version=1;
ALTER TABLE runtime_run ENABLE TRIGGER runtime_run_identity;
ALTER TABLE runtime_run ENABLE TRIGGER runtime_run_session_observation;
ALTER TABLE runtime_run ALTER COLUMN execution_profile_snapshot SET NOT NULL;

CREATE TABLE session_recovery_gate (
  project_id uuid NOT NULL, session_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
  phase text NOT NULL CHECK(phase IN ('open','blocked','retrying','message_pending','awaiting_acceptance')),
  cause_kind text CHECK(cause_kind IN ('run','message','execution_profile')),
  cause_id uuid, cause_state text, reason text NOT NULL DEFAULT '',
  queue_id uuid, claim_id uuid, retry_run_id uuid, resume_message_id uuid,
  decision_operation_id uuid, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,session_id), FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY(project_id,resume_message_id) REFERENCES session_message(project_id,message_id),
  CHECK((cause_kind IS NULL)=(cause_id IS NULL))
);
CREATE TABLE session_recovery_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, session_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('retry_failed','resume')),
  expected_gate_version integer NOT NULL, cause_id uuid NOT NULL, source_run_id uuid,
  source_input_hash text, retry_run_id uuid, resume_message_id uuid,
  actor_id text NOT NULL, reason text NOT NULL, evidence_ref text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,decision_id), UNIQUE(project_id,session_id,expected_gate_version),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
CREATE UNIQUE INDEX session_recovery_retry_successor ON session_recovery_decision(project_id,source_run_id)
  WHERE kind='retry_failed';
CREATE TRIGGER session_recovery_decision_immutable BEFORE UPDATE OR DELETE ON session_recovery_decision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
INSERT INTO session_recovery_gate(project_id,session_id,version,phase,updated_at)
SELECT project_id,session_id,1,'open',updated_at FROM runtime_session;

-- A still-unreleased claim's latest unsuccessful attempt is the first recovery
-- authority. A released claim's old attempt is not an independent later failure.
-- Pin the oldest message already queued at this selection point.
WITH latest AS (
  SELECT c.project_id,c.session_id,c.queue_id,c.claim_id,a.run_id,r.state,
    row_number() OVER(PARTITION BY c.project_id,c.session_id ORDER BY a.sequence DESC,a.reserved_at DESC) AS n
  FROM resident_queue_claim c JOIN resident_queue_attempt a ON a.project_id=c.project_id AND a.claim_id=c.claim_id
  JOIN runtime_run r ON r.project_id=a.project_id AND r.run_id=a.run_id WHERE c.released_at IS NULL
), chosen AS (SELECT * FROM latest WHERE n=1 AND state IN ('failed','interrupted','unknown'))
UPDATE session_recovery_gate g SET phase='blocked',cause_kind='run',cause_id=c.run_id,cause_state=c.state,
  reason='Upgrade: latest unreleased queue attempt requires explicit recovery',queue_id=c.queue_id,claim_id=c.claim_id,
  resume_message_id=(SELECT m.message_id FROM session_message m WHERE m.project_id=g.project_id AND m.session_id=g.session_id
    AND m.state='queued' ORDER BY m.created_at,m.message_id LIMIT 1),version=g.version+1,updated_at=now()
FROM chosen c WHERE g.project_id=c.project_id AND g.session_id=c.session_id;
-- Any still-unknown original operation remains unsafe, even when another
-- object has a later completed outcome.
WITH unresolved AS (
  SELECT project_id,session_id,'run'::text AS cause_kind,run_id AS cause_id,state,updated_at
    FROM runtime_run WHERE state='unknown'
  UNION ALL
  SELECT project_id,session_id,'message',message_id,state,updated_at
    FROM session_message_processing WHERE state='unknown'
), chosen AS (
  SELECT DISTINCT ON(project_id,session_id) * FROM unresolved
    ORDER BY project_id,session_id,updated_at DESC,cause_kind,cause_id
)
UPDATE session_recovery_gate g SET phase='blocked',cause_kind=c.cause_kind,cause_id=c.cause_id,cause_state=c.state,
  reason='Upgrade: unresolved original native outcome',
  resume_message_id=(SELECT m.message_id FROM session_message m WHERE m.project_id=g.project_id AND m.session_id=g.session_id
    AND m.state='queued' ORDER BY m.created_at,m.message_id LIMIT 1),version=g.version+1,updated_at=now()
FROM chosen c WHERE g.project_id=c.project_id AND g.session_id=c.session_id AND g.phase='open';

-- Compare terminal outcomes across Runs and ordinary message processing. A
-- journal sequence proves order only when every candidate has a real state
-- transition; pure historical INSERT/backfill rows use their source timestamps.
WITH outcomes AS (
  SELECT r.project_id,r.session_id,'run'::text AS cause_kind,r.run_id AS cause_id,r.state,r.updated_at,
    (SELECT max(j.sequence) FROM session_observation_change j
      WHERE j.project_id=r.project_id AND j.source_table='runtime_run' AND j.entity_id=r.run_id
        AND j.detail->>'state'=r.state AND j.detail->>'previousState' IS NOT NULL
        AND j.detail->>'previousState'<>j.detail->>'state') AS transition_sequence
  FROM runtime_run r WHERE r.state IN ('failed','interrupted','completed')
    AND (r.state='completed' OR NOT EXISTS (SELECT 1 FROM resident_queue_attempt a JOIN resident_queue_claim c
      ON c.project_id=a.project_id AND c.claim_id=a.claim_id
      WHERE a.project_id=r.project_id AND a.run_id=r.run_id AND c.released_at IS NOT NULL))
  UNION ALL
  SELECT p.project_id,p.session_id,'message',p.message_id,p.state,p.updated_at,
    (SELECT max(j.sequence) FROM session_observation_change j
      WHERE j.project_id=p.project_id AND j.source_table='session_message_processing' AND j.entity_id=p.processing_id
        AND j.detail->>'state'=p.state AND j.detail->>'previousState' IS NOT NULL
        AND j.detail->>'previousState'<>j.detail->>'state')
  FROM session_message_processing p WHERE p.state IN ('failed','completed')
), scoped AS (
  SELECT o.*,bool_and(transition_sequence IS NOT NULL) OVER(PARTITION BY project_id,session_id) AS proven_order,
    count(*) OVER(PARTITION BY project_id,session_id,updated_at) AS same_time_count
  FROM outcomes o
), ranked AS (
  SELECT s.*,row_number() OVER(PARTITION BY project_id,session_id ORDER BY
    CASE WHEN proven_order THEN transition_sequence END DESC NULLS LAST,
    CASE WHEN NOT proven_order THEN updated_at END DESC NULLS LAST,
    CASE WHEN state IN ('failed','interrupted') THEN 0 ELSE 1 END,cause_kind,cause_id) AS n
  FROM scoped s
)
UPDATE session_recovery_gate g SET phase='blocked',cause_kind=c.cause_kind,cause_id=c.cause_id,cause_state=c.state,
  reason=CASE WHEN NOT c.proven_order AND c.same_time_count>1 THEN
      'Upgrade: terminal outcome order ambiguous at equal source timestamps; explicit recovery required'
    WHEN c.proven_order THEN 'Upgrade: latest committed terminal state transition requires recovery'
    ELSE 'Upgrade: latest independent terminal outcome by source timestamp requires recovery' END,
  resume_message_id=(SELECT m.message_id FROM session_message m WHERE m.project_id=g.project_id AND m.session_id=g.session_id
    AND m.state='queued' ORDER BY m.created_at,m.message_id LIMIT 1),version=g.version+1,updated_at=now()
FROM ranked c WHERE c.n=1 AND c.state IN ('failed','interrupted')
  AND g.project_id=c.project_id AND g.session_id=c.session_id AND g.phase='open';

CREATE FUNCTION session_recovery_slot_lock(p_project uuid,p_session uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_project::text||':'||p_session::text,871921));
END $$;
CREATE FUNCTION session_recovery_new_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_id uuid;
BEGIN
  profile_id:=session_recovery_fixed_uuid(NEW.project_id::text||':'||NEW.session_id::text||':reserved-profile');
  INSERT INTO session_execution_profile_revision(project_id,session_id,revision_id,version,model,sandbox,approval_policy,cwd,
    authorization_scope,provenance,operation_id,actor_id,reason,created_at)
  VALUES(NEW.project_id,NEW.session_id,profile_id,1,NEW.model,NEW.sandbox,NEW.approval_policy,NEW.cwd,
    NEW.authorization_scope,'reserved',NEW.operation_id,NEW.actor_id,'Original Session reservation',NEW.created_at);
  INSERT INTO session_execution_profile(project_id,session_id,revision_id,active_revision_id,activation_state)
    VALUES(NEW.project_id,NEW.session_id,profile_id,
      CASE WHEN NEW.native_thread_id IS NOT NULL AND NEW.state='ready' THEN profile_id ELSE NULL END,
      CASE WHEN NEW.native_thread_id IS NOT NULL AND NEW.state='ready' THEN 'active' ELSE 'pending' END);
  INSERT INTO session_recovery_gate(project_id,session_id,version,phase,updated_at)
    VALUES(NEW.project_id,NEW.session_id,1,'open',NEW.updated_at);
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_recovery_new AFTER INSERT ON runtime_session FOR EACH ROW EXECUTE FUNCTION session_recovery_new_session();
CREATE FUNCTION session_recovery_session_bound() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='ready' AND OLD.state<>'ready' AND OLD.native_thread_id IS NULL
    AND NEW.native_thread_id IS NOT NULL THEN
    UPDATE session_execution_profile SET activation_state='active',active_revision_id=revision_id,
      activation_evidence='Original native thread bound'
      WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND activation_state='pending'
        AND EXISTS(SELECT 1 FROM session_execution_profile_revision p WHERE p.project_id=NEW.project_id
          AND p.session_id=NEW.session_id AND p.revision_id=session_execution_profile.revision_id
          AND p.provenance='reserved');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_recovery_bound AFTER UPDATE OF state ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION session_recovery_session_bound();

-- Permit a model change only when the immediately previous immutable configured revision
-- matches OLD and an adopted, pending immutable revision matches NEW. Other identity fields
-- stay under the original protection.
CREATE OR REPLACE FUNCTION protect_runtime_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile record; prior record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'runtime record cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='runtime_session' THEN
    IF NEW.model IS DISTINCT FROM OLD.model THEN
      SELECT h.activation_state,p.* INTO profile FROM session_execution_profile h
        JOIN session_execution_profile_revision p ON p.project_id=h.project_id AND p.session_id=h.session_id
          AND p.revision_id=h.revision_id WHERE h.project_id=NEW.project_id AND h.session_id=NEW.session_id;
      SELECT * INTO prior FROM session_execution_profile_revision
        WHERE project_id=OLD.project_id AND session_id=OLD.session_id AND revision_id=profile.previous_revision_id;
      IF profile IS NULL OR prior IS NULL OR profile.activation_state<>'pending' OR profile.provenance<>'revised' OR profile.model IS DISTINCT FROM NEW.model
        OR prior.model IS DISTINCT FROM OLD.model OR profile.version<>prior.version+1 THEN
        RAISE EXCEPTION 'runtime session model requires an adopted immutable profile revision' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.project_id<>OLD.project_id OR NEW.session_id<>OLD.session_id OR NEW.role_id<>OLD.role_id
      OR NEW.cwd<>OLD.cwd OR NEW.authorization_scope<>OLD.authorization_scope
      OR NEW.sandbox<>OLD.sandbox OR NEW.approval_policy<>OLD.approval_policy
      OR NEW.operation_id<>OLD.operation_id OR NEW.actor_id<>OLD.actor_id OR NEW.created_at<>OLD.created_at
      OR (OLD.native_thread_id IS NOT NULL AND (NEW.native_thread_id IS DISTINCT FROM OLD.native_thread_id OR NEW.native_session_id IS DISTINCT FROM OLD.native_session_id))
      OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'runtime session identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.project_id<>OLD.project_id OR NEW.run_id<>OLD.run_id OR NEW.task_id<>OLD.task_id
      OR NEW.task_revision_id<>OLD.task_revision_id OR NEW.basis_set_id<>OLD.basis_set_id
      OR NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
      OR NEW.input<>OLD.input OR NEW.input_hash<>OLD.input_hash OR NEW.actor_id<>OLD.actor_id
      OR NEW.execution_profile_snapshot IS DISTINCT FROM OLD.execution_profile_snapshot
      OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
      OR (OLD.native_turn_id IS NOT NULL AND NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id) THEN
      RAISE EXCEPTION 'runtime run origin is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION session_recovery_run_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile record; expected jsonb;
BEGIN
  SELECT p.* INTO profile FROM session_execution_profile h JOIN session_execution_profile_revision p
    ON p.project_id=h.project_id AND p.session_id=h.session_id AND p.revision_id=h.revision_id
    WHERE h.project_id=NEW.project_id AND h.session_id=NEW.session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'run has no configured Session profile' USING ERRCODE='23514'; END IF;
  expected:=jsonb_build_object('revisionId',profile.revision_id,'version',profile.version,'model',profile.model,
    'sandbox',profile.sandbox,'approvalPolicy',profile.approval_policy,'cwd',profile.cwd,
    'authorizationScope',profile.authorization_scope,'provenance',profile.provenance);
  IF NEW.execution_profile_snapshot IS NOT NULL AND NEW.execution_profile_snapshot<>expected THEN
    RAISE EXCEPTION 'run configured profile differs from adopted Session revision' USING ERRCODE='23514';
  END IF;
  NEW.execution_profile_snapshot:=expected;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_run_profile_snapshot BEFORE INSERT ON runtime_run FOR EACH ROW EXECUTE FUNCTION session_recovery_run_profile();

-- Any direct SQL native-start intent uses the same slot lock and gate as the trusted store.
CREATE FUNCTION session_recovery_start_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate record; permitted boolean; profile_state text;
BEGIN
  IF TG_TABLE_NAME='runtime_run' THEN
    IF NEW.state NOT IN ('requested','dispatching','running','unknown') THEN RETURN NEW; END IF;
  ELSE
    IF NEW.state NOT IN ('dispatching','running','unknown') THEN RETURN NEW; END IF;
  END IF;
  PERFORM session_recovery_slot_lock(NEW.project_id,NEW.session_id);
  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Session recovery gate missing' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    -- Persisting metadata for this same native operation, or uncertainty about
    -- it, is not a new startup. The AFTER outcome trigger fences unknown atomically.
    IF OLD.native_turn_id IS NOT DISTINCT FROM NEW.native_turn_id AND
      (OLD.state=NEW.state OR NEW.state='unknown') THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT activation_state INTO profile_state FROM session_execution_profile
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
  IF profile_state IS DISTINCT FROM 'active' AND NOT (TG_TABLE_NAME='runtime_run' AND NEW.state='requested'
    AND profile_state='pending') THEN
    RAISE EXCEPTION 'Session execution profile has no confirmed activation' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='runtime_run' THEN
    permitted:=gate.phase='open' OR (gate.phase='retrying' AND gate.retry_run_id=NEW.run_id);
    IF TG_OP='UPDATE' AND OLD.state='unknown' AND NEW.state='running' AND NEW.native_turn_id IS NOT NULL
      AND gate.phase='blocked' AND gate.cause_kind='run' AND gate.cause_id=NEW.run_id THEN
      permitted:=true; -- readback of the same persisted Run, not a second startup
    END IF;
  ELSE
    permitted:=gate.phase='open' OR (gate.phase='message_pending' AND gate.resume_message_id=NEW.message_id);
    IF TG_OP='UPDATE' AND OLD.state='unknown' AND NEW.state='running' AND NEW.native_turn_id IS NOT NULL
      AND gate.phase='blocked' AND gate.cause_kind='message' AND gate.cause_id=NEW.message_id THEN
      permitted:=true; -- bind only the already persisted original message processing
    END IF;
  END IF;
  IF NOT permitted THEN RAISE EXCEPTION 'Session recovery gate blocks native startup' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_run_recovery_fence BEFORE INSERT OR UPDATE OF state ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION session_recovery_start_fence();
CREATE TRIGGER session_message_recovery_fence BEFORE INSERT OR UPDATE OF state ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION session_recovery_start_fence();
CREATE FUNCTION session_recovery_message_queue_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_kind='owned' AND NEW.state='queued' THEN PERFORM session_recovery_slot_lock(NEW.project_id,NEW.session_id); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_message_recovery_queue_lock BEFORE INSERT ON session_message
  FOR EACH ROW EXECUTE FUNCTION session_recovery_message_queue_lock();

CREATE FUNCTION session_recovery_run_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate record; claim record; original_message uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NEW; END IF;
  IF NEW.state NOT IN ('failed','interrupted','unknown','completed') THEN RETURN NEW; END IF;
  PERFORM session_recovery_slot_lock(NEW.project_id,NEW.session_id);
  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;
  IF NEW.state='completed' THEN
    IF gate.phase='retrying' AND gate.retry_run_id=NEW.run_id THEN
      UPDATE session_recovery_gate SET phase=CASE WHEN resume_message_id IS NOT NULL THEN 'message_pending'
          WHEN claim_id IS NOT NULL THEN 'awaiting_acceptance' ELSE 'open' END,
        cause_kind=CASE WHEN claim_id IS NULL AND resume_message_id IS NULL THEN NULL ELSE cause_kind END,
        cause_id=CASE WHEN claim_id IS NULL AND resume_message_id IS NULL THEN NULL ELSE cause_id END,
        retry_run_id=NULL,version=version+1,updated_at=now()
        WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.queue_id,c.claim_id INTO claim FROM resident_queue_claim c JOIN resident_queue_attempt a
    ON a.project_id=c.project_id AND a.claim_id=c.claim_id
    WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id AND c.released_at IS NULL AND a.run_id=NEW.run_id
    ORDER BY a.sequence DESC LIMIT 1;
  IF gate.phase='open' THEN
    SELECT m.message_id INTO original_message FROM session_message m
      WHERE m.project_id=NEW.project_id AND m.session_id=NEW.session_id AND m.state='queued'
      ORDER BY m.created_at,m.message_id LIMIT 1;
  ELSE original_message:=gate.resume_message_id; END IF;
  UPDATE session_recovery_gate SET phase='blocked',cause_kind='run',cause_id=NEW.run_id,cause_state=NEW.state,
    reason='Run terminal failure or unresolved native outcome',queue_id=COALESCE(claim.queue_id,gate.queue_id),
    claim_id=COALESCE(claim.claim_id,gate.claim_id),retry_run_id=NULL,resume_message_id=original_message,
    version=version+1,updated_at=now() WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_run_recovery_outcome AFTER INSERT OR UPDATE OF state ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION session_recovery_run_outcome();
CREATE FUNCTION session_recovery_message_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate record; original_message uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NEW; END IF;
  IF NEW.state NOT IN ('failed','unknown','completed') THEN RETURN NEW; END IF;
  PERFORM session_recovery_slot_lock(NEW.project_id,NEW.session_id);
  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;
  IF NEW.state='completed' THEN
    IF gate.phase='message_pending' AND gate.resume_message_id=NEW.message_id THEN
      UPDATE session_recovery_gate SET phase=CASE WHEN claim_id IS NULL THEN 'open' ELSE 'awaiting_acceptance' END,
        cause_kind=CASE WHEN claim_id IS NULL THEN NULL ELSE cause_kind END,
        cause_id=CASE WHEN claim_id IS NULL THEN NULL ELSE cause_id END,
        resume_message_id=CASE WHEN claim_id IS NULL THEN NULL ELSE resume_message_id END,
        version=version+1,updated_at=now()
        WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
    END IF;
    RETURN NEW;
  END IF;
  IF gate.phase='open' THEN
    SELECT m.message_id INTO original_message FROM session_message m
      WHERE m.project_id=NEW.project_id AND m.session_id=NEW.session_id AND m.state='queued'
      ORDER BY m.created_at,m.message_id LIMIT 1;
  ELSE original_message:=gate.resume_message_id; END IF;
  UPDATE session_recovery_gate SET phase='blocked',cause_kind='message',cause_id=NEW.message_id,cause_state=NEW.state,
    reason='Ordinary message failed or native outcome unresolved',retry_run_id=NULL,resume_message_id=original_message,
    version=version+1,updated_at=now() WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER session_message_recovery_outcome AFTER INSERT OR UPDATE OF state ON session_message_processing
  FOR EACH ROW EXECUTE FUNCTION session_recovery_message_outcome();
CREATE FUNCTION session_recovery_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate record;
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN RETURN NEW; END IF;
  PERFORM session_recovery_slot_lock(NEW.project_id,NEW.session_id);
  SELECT * INTO gate FROM session_recovery_gate WHERE project_id=NEW.project_id AND session_id=NEW.session_id FOR UPDATE;
  IF NEW.release_kind='bounded' THEN
    IF gate.phase='awaiting_acceptance' AND gate.claim_id=NEW.claim_id THEN
      UPDATE session_recovery_gate SET phase='blocked',
        reason='Bounded original claim release requires explicit recovery review',version=version+1,updated_at=now()
        WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.release_kind<>'accepted' THEN RETURN NEW; END IF;
  IF gate.phase='open' THEN RETURN NEW; END IF;
  IF gate.phase<>'awaiting_acceptance' OR gate.claim_id IS DISTINCT FROM NEW.claim_id THEN
    RAISE EXCEPTION 'Session recovery awaits original message and accepted release' USING ERRCODE='23514';
  END IF;
  UPDATE session_recovery_gate SET phase='open',cause_kind=NULL,cause_id=NULL,cause_state=NULL,
    reason='Accepted original queue claim released',queue_id=NULL,claim_id=NULL,retry_run_id=NULL,
    resume_message_id=NULL,decision_operation_id=NULL,version=version+1,updated_at=now()
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER resident_queue_recovery_release AFTER UPDATE OF released_at ON resident_queue_claim
  FOR EACH ROW EXECUTE FUNCTION session_recovery_release();

-- Budget changes are explicit, monotonic, controller-authored revisions. The original
-- attempt rows and the queue's adopted ordering are retained until separately reviewed.
CREATE TABLE resident_queue_budget_revision (
  project_id uuid NOT NULL,queue_id uuid NOT NULL,operation_id uuid NOT NULL,
  previous_version integer NOT NULL,version integer NOT NULL,
  previous_max_runs integer NOT NULL,max_runs integer NOT NULL,
  actor_id text NOT NULL,reason text NOT NULL,evidence_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,operation_id),UNIQUE(project_id,queue_id,version),
  FOREIGN KEY(project_id,queue_id) REFERENCES resident_queue(project_id,queue_id),
  CHECK(max_runs>previous_max_runs),CHECK(version=previous_version+1)
);
CREATE TRIGGER resident_queue_budget_revision_immutable BEFORE UPDATE OR DELETE ON resident_queue_budget_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE OR REPLACE FUNCTION protect_resident_queue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget_ok boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'resident queue cannot be deleted' USING ERRCODE='23514'; END IF;
  SELECT EXISTS(SELECT 1 FROM resident_queue_budget_revision b WHERE b.project_id=OLD.project_id AND b.queue_id=OLD.queue_id
    AND b.previous_version=OLD.version AND b.version=NEW.version AND b.previous_max_runs=OLD.max_runs
    AND b.max_runs=NEW.max_runs AND b.actor_id=OLD.actor_id AND b.reason=NEW.reason) INTO budget_ok;
  IF NEW.project_id<>OLD.project_id OR NEW.queue_id<>OLD.queue_id OR NEW.created_at<>OLD.created_at
    OR NEW.version NOT IN (OLD.version,OLD.version+1)
    OR (NEW.max_runs<>OLD.max_runs AND NOT budget_ok)
    OR (NEW.max_runs<>OLD.max_runs AND (NEW.adopted_version IS DISTINCT FROM OLD.adopted_version
      OR NEW.adopted_by IS DISTINCT FROM OLD.adopted_by OR NEW.adopted_at IS DISTINCT FROM OLD.adopted_at))
    OR (NEW.version=OLD.version AND (NEW.reason<>OLD.reason OR NEW.actor_id<>OLD.actor_id))
    OR (NEW.version=OLD.version+1 AND NEW.adopted_version IS NOT NULL AND NOT budget_ok) THEN
    RAISE EXCEPTION 'resident queue identity and budget are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
