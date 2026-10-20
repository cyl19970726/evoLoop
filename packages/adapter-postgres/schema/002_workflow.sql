CREATE TABLE project_goal (
  project_id uuid NOT NULL REFERENCES project(project_id), goal_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), outcome text NOT NULL, constraints text NOT NULL,
  consumer text NOT NULL, authority text NOT NULL, scope text NOT NULL, owner text NOT NULL,
  actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,goal_id)
);
CREATE TABLE goal_revision (
  project_id uuid NOT NULL, goal_id uuid NOT NULL, version integer NOT NULL CHECK(version > 0),
  outcome text NOT NULL, constraints text NOT NULL, consumer text NOT NULL, authority text NOT NULL,
  scope text NOT NULL, owner text NOT NULL, actor_id text NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,goal_id,version),
  FOREIGN KEY(project_id,goal_id) REFERENCES project_goal(project_id,goal_id)
);
CREATE TABLE project_stage (
  project_id uuid NOT NULL, stage_id uuid NOT NULL, goal_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), deliverable text NOT NULL,
  learning_question text NOT NULL, state text NOT NULL CHECK(state IN ('proposed','active','reviewed')),
  actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,stage_id),
  FOREIGN KEY(project_id,goal_id) REFERENCES project_goal(project_id,goal_id)
);
CREATE TABLE stage_revision (
  project_id uuid NOT NULL, stage_id uuid NOT NULL, revision_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), state text NOT NULL CHECK(state IN ('proposed','active','reviewed')),
  deliverable text NOT NULL, learning_question text NOT NULL, actor_id text NOT NULL,
  reason text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,stage_id,revision_id), UNIQUE(project_id,stage_id,version),
  FOREIGN KEY(project_id,stage_id) REFERENCES project_stage(project_id,stage_id)
);
CREATE TABLE stage_review (
  project_id uuid NOT NULL, review_id uuid NOT NULL, stage_id uuid NOT NULL,
  stage_version integer NOT NULL, adopted text NOT NULL, rejected text NOT NULL, gap text NOT NULL,
  next_choice text NOT NULL CHECK(next_choice IN ('continue','newTask','research','stop')),
  evidence text NOT NULL, reason text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,review_id),
  FOREIGN KEY(project_id,stage_id) REFERENCES project_stage(project_id,stage_id)
);
CREATE TABLE task_proposal (
  project_id uuid NOT NULL, task_id uuid NOT NULL, task_revision_id uuid NOT NULL,
  stage_id uuid, consumer text NOT NULL, use_required boolean NOT NULL,
  evidence text NOT NULL, stop_condition text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id,task_revision_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY(project_id,stage_id) REFERENCES project_stage(project_id,stage_id)
);
CREATE TABLE task_judgement (
  project_id uuid NOT NULL, judgement_id uuid NOT NULL, task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL, decision text NOT NULL CHECK(decision IN ('approve','needsEvidence','defer','reject')),
  reason text NOT NULL, evidence text NOT NULL, relook_condition text,
  actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,judgement_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE INDEX task_judgement_latest_idx ON task_judgement(project_id,task_id,created_at DESC,judgement_id DESC);
CREATE TABLE delivery (
  project_id uuid NOT NULL, delivery_id uuid NOT NULL, task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL, artifact_ref text NOT NULL, artifact_revision text NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-fA-F0-9]{64}$'),
  technical_result text NOT NULL CHECK(technical_result IN ('passed','failed')),
  technical_evidence text NOT NULL, reason text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,delivery_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE INDEX delivery_task_idx ON delivery(project_id,task_id,created_at,delivery_id);
CREATE TABLE consumer_observation (
  project_id uuid NOT NULL, observation_id uuid NOT NULL, task_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  delivery_id uuid NOT NULL, observer text NOT NULL, observer_kind text NOT NULL CHECK(observer_kind IN ('human','agent')),
  result text NOT NULL CHECK(result IN ('used','failed','notUsed')),
  evidence text NOT NULL, reason text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,observation_id),
  FOREIGN KEY(project_id,delivery_id) REFERENCES delivery(project_id,delivery_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id)
);
CREATE INDEX observation_delivery_idx ON consumer_observation(project_id,delivery_id,sequence);
CREATE TABLE task_closure (
  project_id uuid NOT NULL, closure_id uuid NOT NULL, task_id uuid NOT NULL,
  task_revision_id uuid NOT NULL, delivery_id uuid NOT NULL,
  acceptance_result text NOT NULL CHECK(acceptance_result='met'), acceptance_evidence text NOT NULL,
  reason text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,closure_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  FOREIGN KEY(project_id,delivery_id) REFERENCES delivery(project_id,delivery_id)
);
CREATE UNIQUE INDEX task_closure_once_idx ON task_closure(project_id,task_id);

-- A proposal may be withdrawn before any accepted basis exists.
ALTER TABLE task_revision DROP CONSTRAINT task_revision_check;
ALTER TABLE task_revision ADD CONSTRAINT task_revision_basis_state_check
  CHECK ((state IN ('proposed','cancelled') AND basis_set_id IS NULL) OR (state <> 'proposed' AND basis_set_id IS NOT NULL));
CREATE OR REPLACE FUNCTION check_task_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_task task%ROWTYPE;
DECLARE current_revision task_revision%ROWTYPE;
BEGIN
  SELECT * INTO current_task FROM task WHERE project_id=NEW.project_id AND task_id=NEW.task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO current_revision FROM task_revision WHERE project_id=current_task.project_id
    AND task_id=current_task.task_id AND revision_id=current_task.current_revision_id;
  IF NOT FOUND OR current_revision.version <> current_task.version
    OR current_revision.title <> current_task.title OR current_revision.goal <> current_task.goal
    OR current_revision.acceptance <> current_task.acceptance OR current_revision.owner <> current_task.owner
    OR current_revision.state <> current_task.state THEN
    RAISE EXCEPTION 'task head does not match current revision' USING ERRCODE='23514';
  END IF;
  IF current_task.state NOT IN ('proposed','cancelled') AND (current_revision.basis_set_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM basis_set b WHERE b.project_id=current_task.project_id AND b.task_id=current_task.task_id
      AND b.task_revision_id=current_revision.revision_id AND b.basis_set_id=current_revision.basis_set_id AND b.sealed
  )) THEN
    RAISE EXCEPTION 'active task requires sealed basis' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION immutable_workflow_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow history is append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER goal_revision_immutable BEFORE UPDATE OR DELETE ON goal_revision FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
CREATE TRIGGER stage_revision_immutable BEFORE UPDATE OR DELETE ON stage_revision FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
CREATE TRIGGER stage_review_immutable BEFORE UPDATE OR DELETE ON stage_review FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
CREATE TRIGGER task_proposal_immutable BEFORE UPDATE OR DELETE ON task_proposal FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
CREATE TRIGGER task_judgement_immutable BEFORE UPDATE OR DELETE ON task_judgement FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
CREATE TRIGGER delivery_immutable BEFORE UPDATE OR DELETE ON delivery FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
CREATE TRIGGER observation_immutable BEFORE UPDATE OR DELETE ON consumer_observation FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
CREATE TRIGGER task_closure_immutable BEFORE UPDATE OR DELETE ON task_closure FOR EACH ROW EXECUTE FUNCTION immutable_workflow_history();
