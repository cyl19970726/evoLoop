-- First signed intent for an ordinary Run. The original command and Run binding never change.
CREATE TABLE ordinary_run_submission (
  project_id uuid NOT NULL, submission_id uuid NOT NULL, run_id uuid NOT NULL,
  task_id uuid NOT NULL, session_id uuid NOT NULL, task_revision_id uuid NOT NULL,
  run_input_hash text NOT NULL CHECK (run_input_hash ~ '^[a-fA-F0-9]{64}$'),
  operation_id uuid NOT NULL, command_hash text NOT NULL CHECK (command_hash ~ '^[a-fA-F0-9]{64}$'),
  delivery_operation_id uuid NOT NULL,
  delivery_command_hash text CHECK (delivery_command_hash ~ '^[a-fA-F0-9]{64}$'),
  delivery_intent jsonb NOT NULL,
  submitted_by text NOT NULL CHECK (length(btrim(submitted_by)) > 0),
  state text NOT NULL CHECK (state IN ('submitted','blocked','sealing','unknown','sealed','rejected')),
  version integer NOT NULL CHECK (version > 0),
  expected_task_version integer CHECK (expected_task_version > 0),
  terminal_run_version integer CHECK (terminal_run_version > 0),
  sealed_by text CHECK (length(btrim(sealed_by)) > 0),
  delivery_id uuid, reason text,
  created_at_utc timestamptz NOT NULL, updated_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,run_id),
  UNIQUE (project_id,submission_id), UNIQUE (project_id,operation_id),
  UNIQUE (project_id,delivery_operation_id),
  CHECK (operation_id <> delivery_operation_id),
  FOREIGN KEY (project_id,run_id) REFERENCES runtime_run(project_id,run_id),
  FOREIGN KEY (project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY (project_id,session_id) REFERENCES runtime_session(project_id,session_id),
  FOREIGN KEY (project_id,delivery_id) REFERENCES delivery(project_id,delivery_id),
  CHECK (jsonb_typeof(delivery_intent)='object' AND
    delivery_intent ?& ARRAY['artifactRef','artifactRevision','contentHash','technicalResult','technicalEvidence','reason'] AND
    jsonb_typeof(delivery_intent->'artifactRef')='string' AND
    jsonb_typeof(delivery_intent->'artifactRevision')='string' AND
    jsonb_typeof(delivery_intent->'contentHash')='string' AND
    (delivery_intent->>'contentHash') ~ '^[a-fA-F0-9]{64}$' AND
    delivery_intent->>'technicalResult' IN ('passed','failed') AND
    jsonb_typeof(delivery_intent->'technicalEvidence')='string' AND
    jsonb_typeof(delivery_intent->'reason')='string'),
  CHECK (updated_at_utc >= created_at_utc),
  CHECK (state <> 'submitted' OR (version=1 AND expected_task_version IS NULL AND delivery_command_hash IS NULL AND
    terminal_run_version IS NULL AND sealed_by IS NULL AND delivery_id IS NULL AND reason IS NULL)),
  CHECK (state <> 'sealed' OR (expected_task_version IS NOT NULL AND terminal_run_version IS NOT NULL
    AND sealed_by IS NOT NULL AND delivery_id IS NOT NULL)),
  CHECK (state NOT IN ('sealing','unknown') OR (expected_task_version IS NOT NULL
    AND terminal_run_version IS NOT NULL AND sealed_by IS NOT NULL AND delivery_command_hash IS NOT NULL)),
  CHECK (state <> 'rejected' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
  CHECK (state <> 'blocked' OR (reason IS NOT NULL AND length(btrim(reason)) > 0 AND delivery_id IS NULL)),
  CHECK (state NOT IN ('submitted','blocked','sealing','unknown') OR delivery_id IS NULL)
);
CREATE INDEX ordinary_run_submission_unsettled_idx ON ordinary_run_submission(project_id,created_at_utc,run_id)
  WHERE state IN ('submitted','blocked','sealing','unknown');

CREATE FUNCTION protect_ordinary_run_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Run submission cannot be deleted' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.project_id,NEW.submission_id,NEW.run_id,NEW.task_id,NEW.session_id,NEW.task_revision_id,
      NEW.run_input_hash,NEW.operation_id,NEW.command_hash,NEW.delivery_operation_id,
      NEW.delivery_intent,NEW.submitted_by,NEW.created_at_utc)
    IS DISTINCT FROM ROW(OLD.project_id,OLD.submission_id,OLD.run_id,OLD.task_id,OLD.session_id,OLD.task_revision_id,
      OLD.run_input_hash,OLD.operation_id,OLD.command_hash,OLD.delivery_operation_id,
      OLD.delivery_intent,OLD.submitted_by,OLD.created_at_utc)
    OR NEW.version<>OLD.version+1 OR NEW.updated_at_utc<OLD.updated_at_utc
    OR (OLD.delivery_command_hash IS NOT NULL AND NEW.delivery_command_hash IS DISTINCT FROM OLD.delivery_command_hash)
    OR OLD.state IN ('sealed','rejected')
    OR (OLD.state='submitted' AND NEW.state NOT IN ('blocked','sealing','rejected'))
    OR (OLD.state='blocked' AND NEW.state NOT IN ('blocked','sealing','rejected'))
    OR (OLD.state='sealing' AND NEW.state NOT IN ('blocked','unknown','sealed','rejected'))
    OR (OLD.state='unknown' AND NEW.state NOT IN ('blocked','sealing','sealed','rejected')) THEN
    RAISE EXCEPTION 'Run submission origin or transition is invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ordinary_run_submission_identity BEFORE UPDATE OR DELETE ON ordinary_run_submission
  FOR EACH ROW EXECUTE FUNCTION protect_ordinary_run_submission();

CREATE FUNCTION validate_ordinary_run_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'submitted' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'First Run submission must be an unsealed intent' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.run_id=NEW.run_id
    AND r.task_id=NEW.task_id AND r.session_id=NEW.session_id AND r.task_revision_id=NEW.task_revision_id
    AND r.input_hash=NEW.run_input_hash) THEN
    RAISE EXCEPTION 'Run submission fixed binding differs from Run' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ordinary_run_submission_binding BEFORE INSERT ON ordinary_run_submission
  FOR EACH ROW EXECUTE FUNCTION validate_ordinary_run_submission();

-- The future Delivery operation ID is reserved for this exact signed intent. A
-- deferred check can see the Delivery row written in the same workflow transaction.
CREATE FUNCTION guard_ordinary_delivery_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ordinary_run_submission%ROWTYPE;
BEGIN
  SELECT * INTO s FROM ordinary_run_submission
    WHERE project_id=NEW.project_id AND delivery_operation_id=NEW.operation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Preserve a definite rejection of the signer's original Delivery command so
  -- the sealer can read and classify that operation instead of looping on unknown.
  IF NEW.command_type='delivery.record' AND NEW.actor_id=s.submitted_by
    AND NEW.command_hash=s.delivery_command_hash
    AND NEW.result->>'status'='rejected' AND s.state IN ('sealing','unknown') THEN
    RETURN NULL;
  END IF;
  IF NEW.command_type<>'delivery.record' OR NEW.actor_id<>s.submitted_by
    OR NEW.command_hash IS DISTINCT FROM s.delivery_command_hash
    OR NEW.result->>'status'<>'applied' OR NEW.result->>'entityId'<>s.task_id::text
    OR s.state NOT IN ('sealing','unknown') OR NOT EXISTS (
      SELECT 1 FROM delivery d WHERE d.project_id=s.project_id
        AND d.delivery_id=(NEW.result->>'revisionId')::uuid AND d.task_id=s.task_id
        AND d.run_id=s.run_id AND d.actor_id=s.submitted_by
        AND d.artifact_ref=s.delivery_intent->>'artifactRef'
        AND d.artifact_revision=s.delivery_intent->>'artifactRevision'
        AND d.content_hash=s.delivery_intent->>'contentHash'
        AND d.technical_result=s.delivery_intent->>'technicalResult'
        AND d.technical_evidence=s.delivery_intent->>'technicalEvidence'
        AND d.reason=s.delivery_intent->>'reason') THEN
    RAISE EXCEPTION 'Delivery operation is reserved for a signed Run submission' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ordinary_delivery_operation_guard
  AFTER INSERT ON operation_journal DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_ordinary_delivery_operation();
