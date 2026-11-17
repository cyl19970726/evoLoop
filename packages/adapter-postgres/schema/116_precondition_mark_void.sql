-- A wrong acceptance precondition mark could not be corrected: marks are immutable and one per delivery (Task e7b2d9a4). It can now be withdrawn, and the delivery marked again.
-- Nothing is rewritten: the withdrawal is its own immutable row naming who, when and why, the withdrawn mark and its evidence stay, and a new mark is the next generation.
-- A mark also records when the release it cites took place (`satisfied_at`); the service refuses a time earlier than the delivery. Marks written before this migration have none
-- (NULL): it is not backfilled, and nothing is inferred.
ALTER TABLE task_acceptance_precondition_mark ADD COLUMN satisfied_at timestamptz, ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK(generation>=1);
ALTER TABLE task_acceptance_precondition_mark DROP CONSTRAINT task_acceptance_precondition_mark_project_id_delivery_id_key;
ALTER TABLE task_acceptance_precondition_mark ADD CONSTRAINT task_acceptance_precondition_mark_generation_key UNIQUE(project_id,delivery_id,generation);
CREATE TABLE task_acceptance_precondition_mark_void (
  project_id uuid NOT NULL, mark_id uuid NOT NULL, task_id uuid NOT NULL, delivery_id uuid NOT NULL,
  actor_id text NOT NULL CHECK(length(btrim(actor_id))>0), reason text NOT NULL CHECK(length(btrim(reason))>0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,mark_id),
  FOREIGN KEY(project_id,mark_id) REFERENCES task_acceptance_precondition_mark(project_id,mark_id)
);
CREATE TRIGGER task_acceptance_precondition_mark_void_immutable BEFORE UPDATE OR DELETE ON task_acceptance_precondition_mark_void
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
-- Withdrawing a mark changes what a reader of the work index sees (ready becomes waiting again): the same change record and scheduling event as marking.
CREATE FUNCTION record_precondition_void_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('leader-work:'||NEW.project_id::text,0));
  INSERT INTO leader_work_change(project_id,entity_kind,entity_id,task_id,document_id,version,changed_at)
    VALUES(NEW.project_id,'delivery',NEW.task_id,NEW.task_id,NULL,NULL,now());
  RETURN NEW;
END $$;
CREATE TRIGGER leader_work_precondition_void_change AFTER INSERT ON task_acceptance_precondition_mark_void
  FOR EACH ROW EXECUTE FUNCTION record_precondition_void_change();
