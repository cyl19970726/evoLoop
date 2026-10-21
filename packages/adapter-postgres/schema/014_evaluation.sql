-- Evaluation definitions are versioned; all evidence and conclusions are append-only.
CREATE TABLE evaluation_head (
  project_id uuid NOT NULL REFERENCES project(project_id), evaluation_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), current_revision_id uuid NOT NULL,
  PRIMARY KEY(project_id,evaluation_id)
);
CREATE TABLE evaluation_revision (
  project_id uuid NOT NULL, evaluation_id uuid NOT NULL, revision_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), definition jsonb NOT NULL,
  owner_task_id uuid NOT NULL, case_task_id uuid NOT NULL, source_task_revision_id uuid NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,evaluation_id,revision_id),
  UNIQUE(project_id,evaluation_id,version),
  FOREIGN KEY(project_id,evaluation_id) REFERENCES evaluation_head(project_id,evaluation_id),
  FOREIGN KEY(project_id,owner_task_id) REFERENCES task(project_id,task_id),
  FOREIGN KEY(project_id,case_task_id,source_task_revision_id)
    REFERENCES task_revision(project_id,task_id,revision_id),
  CHECK(jsonb_typeof(definition)='object' AND definition ?& ARRAY['ownerTaskId','case','conditions']
    AND jsonb_typeof(definition->'case')='object'
    AND jsonb_typeof(definition->'conditions')='array'
    AND (definition->'case') ?& ARRAY['taskId','sourceTaskRevisionId']
    AND definition->>'ownerTaskId'=owner_task_id::text
    AND definition#>>'{case,taskId}'=case_task_id::text
    AND definition#>>'{case,sourceTaskRevisionId}'=source_task_revision_id::text)
);
ALTER TABLE evaluation_head ADD CONSTRAINT evaluation_current_revision_fk
  FOREIGN KEY(project_id,evaluation_id,current_revision_id)
  REFERENCES evaluation_revision(project_id,evaluation_id,revision_id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX evaluation_case_task_idx ON evaluation_revision(project_id,case_task_id,evaluation_id);
CREATE INDEX evaluation_owner_task_idx ON evaluation_revision(project_id,owner_task_id,evaluation_id);

ALTER TABLE runtime_run
  ADD COLUMN evaluation_id uuid,
  ADD COLUMN evaluation_revision_id uuid,
  ADD COLUMN evaluation_case_id uuid,
  ADD COLUMN evaluation_condition_id uuid,
  ADD COLUMN evaluation_source_task_revision_id uuid,
  ADD COLUMN evaluation_actual_task_revision_id uuid,
  ADD COLUMN evaluation_attempt_id uuid,
  ADD COLUMN evaluation_packet jsonb,
  ADD CONSTRAINT runtime_evaluation_binding_complete CHECK (
    (evaluation_id IS NULL AND evaluation_revision_id IS NULL AND evaluation_case_id IS NULL
      AND evaluation_condition_id IS NULL AND evaluation_source_task_revision_id IS NULL
      AND evaluation_actual_task_revision_id IS NULL AND evaluation_attempt_id IS NULL)
    OR (evaluation_id IS NOT NULL AND evaluation_revision_id IS NOT NULL AND evaluation_case_id IS NOT NULL
      AND evaluation_condition_id IS NOT NULL AND evaluation_source_task_revision_id IS NOT NULL
      AND evaluation_actual_task_revision_id IS NOT NULL AND evaluation_attempt_id IS NOT NULL)),
  ADD CONSTRAINT runtime_evaluation_packet_requires_binding CHECK(evaluation_packet IS NULL OR evaluation_id IS NOT NULL),
  ADD CONSTRAINT runtime_evaluation_packet_shape CHECK(evaluation_packet IS NULL OR (
    jsonb_typeof(evaluation_packet)='object'
    AND evaluation_packet ?& ARRAY['payloadRef','contentHash','manifestHash','builderVersion','sources']
    AND jsonb_typeof(evaluation_packet->'payloadRef')='string'
    AND jsonb_typeof(evaluation_packet->'builderVersion')='string'
    AND jsonb_typeof(evaluation_packet->'sources')='array'
    AND evaluation_packet->>'contentHash' ~ '^[a-f0-9]{64}$'
    AND evaluation_packet->>'manifestHash' ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT runtime_evaluation_actual_revision CHECK(evaluation_actual_task_revision_id IS NULL OR evaluation_actual_task_revision_id=task_revision_id),
  ADD CONSTRAINT runtime_evaluation_revision_fk FOREIGN KEY(project_id,evaluation_id,evaluation_revision_id)
    REFERENCES evaluation_revision(project_id,evaluation_id,revision_id),
  ADD CONSTRAINT runtime_evaluation_source_revision_fk FOREIGN KEY(project_id,task_id,evaluation_source_task_revision_id)
    REFERENCES task_revision(project_id,task_id,revision_id);

CREATE TABLE evaluation_attempt (
  project_id uuid NOT NULL, attempt_id uuid NOT NULL, evaluation_id uuid NOT NULL, revision_id uuid NOT NULL,
  case_id uuid NOT NULL, condition_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal > 0),
  run_id uuid NOT NULL, source_task_revision_id uuid NOT NULL, actual_task_revision_id uuid NOT NULL,
  session_id uuid NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,attempt_id),
  UNIQUE(project_id,evaluation_id,revision_id,attempt_id),
  UNIQUE(project_id,evaluation_id,revision_id,case_id,condition_id,ordinal),
  UNIQUE(project_id,run_id),
  FOREIGN KEY(project_id,evaluation_id,revision_id)
    REFERENCES evaluation_revision(project_id,evaluation_id,revision_id),
  FOREIGN KEY(project_id,run_id) REFERENCES runtime_run(project_id,run_id),
  FOREIGN KEY(project_id,session_id) REFERENCES runtime_session(project_id,session_id)
);
ALTER TABLE runtime_run ADD CONSTRAINT runtime_evaluation_attempt_fk
  FOREIGN KEY(project_id,evaluation_id,evaluation_revision_id,evaluation_attempt_id)
  REFERENCES evaluation_attempt(project_id,evaluation_id,revision_id,attempt_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX evaluation_attempt_revision_idx ON evaluation_attempt(project_id,evaluation_id,revision_id,case_id,condition_id,ordinal);

CREATE TABLE evaluation_assessment (
  project_id uuid NOT NULL, assessment_id uuid NOT NULL, evaluation_id uuid NOT NULL, revision_id uuid NOT NULL,
  attempt_id uuid NOT NULL, delivery_id uuid, observation_id uuid, supersedes_id uuid,
  values jsonb NOT NULL, costs jsonb NOT NULL, evidence jsonb NOT NULL,
  assessor_kind text NOT NULL CHECK(assessor_kind IN ('human','agent')),
  actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,assessment_id),
  UNIQUE(project_id,evaluation_id,revision_id,assessment_id),
  UNIQUE(project_id,evaluation_id,revision_id,attempt_id,assessment_id),
  UNIQUE(project_id,evaluation_id,revision_id,attempt_id,supersedes_id),
  FOREIGN KEY(project_id,evaluation_id,revision_id,attempt_id)
    REFERENCES evaluation_attempt(project_id,evaluation_id,revision_id,attempt_id),
  FOREIGN KEY(project_id,delivery_id) REFERENCES delivery(project_id,delivery_id),
  FOREIGN KEY(project_id,observation_id) REFERENCES consumer_observation(project_id,observation_id),
  FOREIGN KEY(project_id,evaluation_id,revision_id,attempt_id,supersedes_id)
    REFERENCES evaluation_assessment(project_id,evaluation_id,revision_id,attempt_id,assessment_id),
  CHECK(supersedes_id IS NULL OR supersedes_id<>assessment_id),
  CHECK(jsonb_typeof(costs)='array'), CHECK(jsonb_typeof(evidence)='array')
);
CREATE INDEX evaluation_assessment_revision_idx ON evaluation_assessment(project_id,evaluation_id,revision_id,created_at,assessment_id);
CREATE UNIQUE INDEX evaluation_assessment_initial_once ON evaluation_assessment(project_id,evaluation_id,revision_id,attempt_id)
  WHERE supersedes_id IS NULL;

CREATE TABLE evaluation_conclusion (
  project_id uuid NOT NULL, conclusion_id uuid NOT NULL, evaluation_id uuid NOT NULL, revision_id uuid NOT NULL,
  assessment_ids uuid[] NOT NULL CHECK(cardinality(assessment_ids) > 0), supersedes_id uuid,
  finding text NOT NULL, limits text NOT NULL,
  comparability text NOT NULL CHECK(comparability IN ('comparable','with_limits','unknown')),
  comparability_reason text NOT NULL,
  next_choice text NOT NULL CHECK(next_choice IN ('read_direct','adopt_with_limits','maintain','research','wait','stop')),
  affected_refs jsonb NOT NULL, next_action_ref jsonb,
  actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,conclusion_id),
  UNIQUE(project_id,evaluation_id,revision_id,conclusion_id),
  UNIQUE(project_id,evaluation_id,revision_id,supersedes_id),
  FOREIGN KEY(project_id,evaluation_id,revision_id)
    REFERENCES evaluation_revision(project_id,evaluation_id,revision_id),
  FOREIGN KEY(project_id,evaluation_id,revision_id,supersedes_id)
    REFERENCES evaluation_conclusion(project_id,evaluation_id,revision_id,conclusion_id),
  CHECK(supersedes_id IS NULL OR supersedes_id<>conclusion_id),
  CHECK(jsonb_typeof(affected_refs)='array')
);
CREATE INDEX evaluation_conclusion_revision_idx ON evaluation_conclusion(project_id,evaluation_id,revision_id,created_at,conclusion_id);
CREATE UNIQUE INDEX evaluation_conclusion_initial_once ON evaluation_conclusion(project_id,evaluation_id,revision_id)
  WHERE supersedes_id IS NULL;

CREATE FUNCTION check_evaluation_attempt_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r runtime_run%ROWTYPE;
DECLARE rev evaluation_revision%ROWTYPE;
BEGIN
  SELECT * INTO r FROM runtime_run WHERE project_id=NEW.project_id AND run_id=NEW.run_id;
  SELECT * INTO rev FROM evaluation_revision WHERE project_id=NEW.project_id AND evaluation_id=NEW.evaluation_id AND revision_id=NEW.revision_id;
  IF r.evaluation_id IS DISTINCT FROM NEW.evaluation_id OR r.evaluation_revision_id IS DISTINCT FROM NEW.revision_id
    OR r.evaluation_case_id IS DISTINCT FROM NEW.case_id OR r.evaluation_condition_id IS DISTINCT FROM NEW.condition_id
    OR r.evaluation_attempt_id IS DISTINCT FROM NEW.attempt_id
    OR r.evaluation_source_task_revision_id IS DISTINCT FROM NEW.source_task_revision_id
    OR r.evaluation_actual_task_revision_id IS DISTINCT FROM NEW.actual_task_revision_id
    OR r.task_revision_id IS DISTINCT FROM NEW.actual_task_revision_id OR r.session_id IS DISTINCT FROM NEW.session_id
    OR r.actor_id IS DISTINCT FROM NEW.actor_id OR rev.source_task_revision_id IS DISTINCT FROM NEW.source_task_revision_id
    OR rev.case_task_id IS DISTINCT FROM r.task_id OR rev.definition#>>'{case,id}' IS DISTINCT FROM NEW.case_id::text
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(rev.definition->'conditions') c WHERE c->>'id'=NEW.condition_id::text)
  THEN RAISE EXCEPTION 'evaluation attempt does not match frozen Run and definition' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER evaluation_attempt_binding AFTER INSERT ON evaluation_attempt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_evaluation_attempt_binding();

CREATE FUNCTION check_evaluation_assessment_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a evaluation_attempt%ROWTYPE;
DECLARE r runtime_run%ROWTYPE;
DECLARE d delivery%ROWTYPE;
DECLARE o consumer_observation%ROWTYPE;
BEGIN
  SELECT * INTO a FROM evaluation_attempt WHERE project_id=NEW.project_id AND attempt_id=NEW.attempt_id;
  SELECT * INTO r FROM runtime_run WHERE project_id=NEW.project_id AND run_id=a.run_id;
  IF NEW.delivery_id IS NOT NULL THEN
    SELECT * INTO d FROM delivery WHERE project_id=NEW.project_id AND delivery_id=NEW.delivery_id;
    IF d.task_id IS DISTINCT FROM r.task_id OR d.task_revision_id IS DISTINCT FROM a.actual_task_revision_id THEN
      RAISE EXCEPTION 'evaluation delivery must target actual Run Task revision' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.observation_id IS NOT NULL THEN
    SELECT * INTO o FROM consumer_observation WHERE project_id=NEW.project_id AND observation_id=NEW.observation_id;
    IF NEW.delivery_id IS NULL OR o.delivery_id IS DISTINCT FROM NEW.delivery_id OR o.task_id IS DISTINCT FROM r.task_id THEN
      RAISE EXCEPTION 'evaluation observation must target assessed delivery' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_assessment_sources BEFORE INSERT ON evaluation_assessment
  FOR EACH ROW EXECUTE FUNCTION check_evaluation_assessment_sources();

CREATE FUNCTION check_evaluation_conclusion_assessments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids_count integer;
BEGIN
  SELECT count(*) INTO ids_count FROM (
    SELECT DISTINCT unnest(NEW.assessment_ids) AS id
  ) ids JOIN evaluation_assessment a ON a.project_id=NEW.project_id AND a.evaluation_id=NEW.evaluation_id
    AND a.revision_id=NEW.revision_id AND a.assessment_id=ids.id;
  IF ids_count<>cardinality(NEW.assessment_ids) THEN
    RAISE EXCEPTION 'conclusion assessment IDs must be distinct and belong to the frozen revision' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_conclusion_assessments BEFORE INSERT ON evaluation_conclusion
  FOR EACH ROW EXECUTE FUNCTION check_evaluation_conclusion_assessments();

CREATE FUNCTION protect_evaluation_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id
    OR NEW.version<>OLD.version+1 OR NEW.current_revision_id=OLD.current_revision_id THEN
    RAISE EXCEPTION 'evaluation head must advance one revision' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evaluation_head_advance BEFORE UPDATE OR DELETE ON evaluation_head
  FOR EACH ROW EXECUTE FUNCTION protect_evaluation_head();
CREATE FUNCTION check_evaluation_head_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM evaluation_revision r WHERE r.project_id=NEW.project_id
    AND r.evaluation_id=NEW.evaluation_id AND r.revision_id=NEW.current_revision_id AND r.version=NEW.version) THEN
    RAISE EXCEPTION 'evaluation head must point to its versioned revision' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER evaluation_head_revision AFTER INSERT OR UPDATE ON evaluation_head
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_evaluation_head_revision();
CREATE TRIGGER evaluation_revision_immutable BEFORE UPDATE OR DELETE ON evaluation_revision FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER evaluation_attempt_immutable BEFORE UPDATE OR DELETE ON evaluation_attempt FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER evaluation_assessment_immutable BEFORE UPDATE OR DELETE ON evaluation_assessment FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER evaluation_conclusion_immutable BEFORE UPDATE OR DELETE ON evaluation_conclusion FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE FUNCTION protect_evaluation_run_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.evaluation_id,NEW.evaluation_revision_id,NEW.evaluation_case_id,NEW.evaluation_condition_id,
      NEW.evaluation_source_task_revision_id,NEW.evaluation_actual_task_revision_id,NEW.evaluation_attempt_id)
    IS DISTINCT FROM
     (OLD.evaluation_id,OLD.evaluation_revision_id,OLD.evaluation_case_id,OLD.evaluation_condition_id,
      OLD.evaluation_source_task_revision_id,OLD.evaluation_actual_task_revision_id,OLD.evaluation_attempt_id)
    OR (OLD.evaluation_packet IS NOT NULL AND NEW.evaluation_packet IS DISTINCT FROM OLD.evaluation_packet)
  THEN RAISE EXCEPTION 'evaluation Run binding and packet are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_evaluation_binding_immutable BEFORE UPDATE ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION protect_evaluation_run_binding();
