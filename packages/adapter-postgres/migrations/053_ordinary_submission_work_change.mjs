// Keep submission changes in the Leader's persisted cursor, including seal transitions.
export const up = pgm => {
  pgm.sql(`ALTER TABLE leader_work_change DROP CONSTRAINT leader_work_change_entity_kind_check;
    ALTER TABLE leader_work_change ADD CONSTRAINT leader_work_change_entity_kind_check
      CHECK(entity_kind IN ('task','document','assignment','delivery','observation','closure',
        'run','submission','impact','queue','plan','dependency','review'));
    CREATE FUNCTION record_ordinary_submission_work_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND NEW.state=OLD.state THEN RETURN NEW; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('leader-work:'||NEW.project_id::text,0));
      INSERT INTO leader_work_change(project_id,entity_kind,entity_id,task_id,version,changed_at)
        VALUES(NEW.project_id,'submission',NEW.submission_id,NEW.task_id,NEW.version,now());
      RETURN NEW;
    END $$;
    CREATE TRIGGER leader_work_submission_change AFTER INSERT OR UPDATE OF state ON ordinary_run_submission
      FOR EACH ROW EXECUTE FUNCTION record_ordinary_submission_work_change();`);
};
