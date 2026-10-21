-- A delivery revision is a later registration. The Run is its explicit execution source.
ALTER TABLE runtime_run ADD CONSTRAINT runtime_run_project_task_identity
  UNIQUE(project_id,run_id,task_id);
ALTER TABLE delivery ADD COLUMN run_id uuid;
ALTER TABLE delivery ADD CONSTRAINT delivery_run_same_task_fk
  FOREIGN KEY(project_id,run_id,task_id) REFERENCES runtime_run(project_id,run_id,task_id);
CREATE INDEX delivery_run_idx ON delivery(project_id,run_id) WHERE run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION check_evaluation_assessment_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a evaluation_attempt%ROWTYPE;
DECLARE r runtime_run%ROWTYPE;
DECLARE d delivery%ROWTYPE;
DECLARE o consumer_observation%ROWTYPE;
BEGIN
  SELECT * INTO a FROM evaluation_attempt WHERE project_id=NEW.project_id AND attempt_id=NEW.attempt_id;
  SELECT * INTO r FROM runtime_run WHERE project_id=NEW.project_id AND run_id=a.run_id;
  IF NEW.delivery_id IS NOT NULL THEN
    SELECT * INTO d FROM delivery WHERE project_id=NEW.project_id AND delivery_id=NEW.delivery_id;
    IF d.task_id IS DISTINCT FROM r.task_id OR d.run_id IS DISTINCT FROM a.run_id THEN
      RAISE EXCEPTION 'evaluation delivery must identify the attempt Run and Task' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.observation_id IS NOT NULL THEN
    SELECT * INTO o FROM consumer_observation WHERE project_id=NEW.project_id AND observation_id=NEW.observation_id;
    IF NEW.delivery_id IS NULL OR o.delivery_id IS DISTINCT FROM NEW.delivery_id OR o.task_id IS DISTINCT FROM r.task_id THEN
      RAISE EXCEPTION 'evaluation observation must target assessed delivery' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
