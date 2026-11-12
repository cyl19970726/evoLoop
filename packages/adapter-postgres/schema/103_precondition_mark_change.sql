-- Marking an acceptance precondition met (task.acceptancePrecondition.mark) is a work change like any other Task change: it takes a
-- sequence in leader_work_change, so a reader paging through the work index notices it (WORK_INDEX_CHANGED) and reads the delivery
-- as ready instead of still waiting. The shared record_leader_work_change() is left as it is: this table has its own small trigger.
CREATE FUNCTION record_precondition_mark_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Same lock order as record_leader_work_change(): the sequence cannot commit out of order.
  PERFORM pg_advisory_xact_lock(hashtextextended('leader-work:'||NEW.project_id::text,0));
  INSERT INTO leader_work_change(project_id,entity_kind,entity_id,task_id,document_id,version,changed_at)
    VALUES(NEW.project_id,'delivery',NEW.task_id,NEW.task_id,NULL,NULL,now());
  RETURN NEW;
END $$;
CREATE TRIGGER leader_work_precondition_mark_change AFTER INSERT ON task_acceptance_precondition_mark
  FOR EACH ROW EXECUTE FUNCTION record_precondition_mark_change();
