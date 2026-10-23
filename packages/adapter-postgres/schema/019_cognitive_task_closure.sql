-- Delivery and settled cognition decisions are distinct, exclusive acceptance evidence.
-- Existing delivery closures retain their identity and all original field values.
ALTER TABLE task_closure ALTER COLUMN delivery_id DROP NOT NULL;
ALTER TABLE task_closure ADD COLUMN decision_id uuid;
ALTER TABLE task_closure ADD COLUMN source_inbox_id uuid;
ALTER TABLE task_closure ADD COLUMN source_event_id uuid;
ALTER TABLE task_closure ADD COLUMN source_task_id uuid;
ALTER TABLE task_closure ADD COLUMN waiting_inbox_id uuid;
ALTER TABLE task_closure ADD CONSTRAINT task_closure_one_evidence CHECK ((delivery_id IS NULL) <> (decision_id IS NULL));
ALTER TABLE task_closure ADD CONSTRAINT task_closure_decision_source CHECK (
  (decision_id IS NULL AND source_inbox_id IS NULL AND source_event_id IS NULL AND source_task_id IS NULL AND waiting_inbox_id IS NULL)
  OR (decision_id IS NOT NULL AND source_inbox_id IS NOT NULL AND source_event_id IS NOT NULL)
);
ALTER TABLE task_closure ADD CONSTRAINT task_closure_decision_fk
  FOREIGN KEY(project_id,decision_id) REFERENCES orchestration_decision(project_id,decision_id);
ALTER TABLE task_closure ADD CONSTRAINT task_closure_source_inbox_fk
  FOREIGN KEY(project_id,source_inbox_id) REFERENCES orchestration_inbox(project_id,inbox_id);
ALTER TABLE task_closure ADD CONSTRAINT task_closure_waiting_inbox_fk
  FOREIGN KEY(project_id,waiting_inbox_id) REFERENCES orchestration_inbox(project_id,inbox_id);
ALTER TABLE task_closure ADD CONSTRAINT task_closure_source_task_fk
  FOREIGN KEY(project_id,source_task_id) REFERENCES task(project_id,task_id);

CREATE FUNCTION verify_cognitive_task_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signed orchestration_decision%ROWTYPE;
DECLARE dispatched orchestration_dispatch%ROWTYPE;
DECLARE original_inbox orchestration_inbox%ROWTYPE;
DECLARE waited orchestration_inbox%ROWTYPE;
DECLARE fixed_run runtime_run%ROWTYPE;
BEGIN
  IF NEW.decision_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO signed FROM orchestration_decision WHERE project_id=NEW.project_id AND decision_id=NEW.decision_id;
  SELECT * INTO dispatched FROM orchestration_dispatch WHERE project_id=NEW.project_id AND dispatch_id=signed.dispatch_id;
  SELECT * INTO original_inbox FROM orchestration_inbox WHERE project_id=NEW.project_id AND inbox_id=dispatched.inbox_id;
  SELECT * INTO fixed_run FROM runtime_run WHERE project_id=NEW.project_id
    AND run_id=(dispatched.data->>'runtimeRunId')::uuid;
  IF signed.decision_id IS NULL OR dispatched.dispatch_id IS NULL OR original_inbox.inbox_id IS NULL
    OR fixed_run.run_id IS NULL OR dispatched.task_id<>NEW.task_id OR dispatched.state<>'completed'
    OR dispatched.data->>'purpose'<>'cognition' OR dispatched.data->>'outcome' NOT IN ('no_action','waiting')
    OR signed.data->>'kind' NOT IN ('no_action','waiting','stop')
    OR signed.data->>'taskId'<>NEW.task_id::text OR signed.data->>'runId'<>fixed_run.run_id::text
    OR fixed_run.task_id<>NEW.task_id OR fixed_run.state NOT IN ('completed','failed','interrupted')
    OR original_inbox.inbox_id<>NEW.source_inbox_id OR original_inbox.source_event_id<>NEW.source_event_id THEN
    RAISE EXCEPTION 'cognitive closure must cite its settled decision and original source' USING ERRCODE='23514';
  END IF;
  IF signed.data->>'kind'='waiting' THEN
    SELECT * INTO waited FROM orchestration_inbox WHERE project_id=NEW.project_id AND inbox_id=NEW.waiting_inbox_id;
    IF waited.inbox_id IS NULL OR waited.loop_id<>dispatched.loop_id OR waited.source_event_id<>NEW.source_event_id
      OR waited.purpose<>'next_action' OR waited.state<>'disposed' OR waited.data->>'disposition'<>'waiting'
      OR NEW.source_task_id IS NULL OR NEW.source_task_id=NEW.task_id THEN
      RAISE EXCEPTION 'waiting closure requires a discoverable same-source handoff' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.waiting_inbox_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-waiting closure cannot cite a waiting handoff' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cognitive_task_closure_guard BEFORE INSERT ON task_closure
  FOR EACH ROW EXECUTE FUNCTION verify_cognitive_task_closure();
