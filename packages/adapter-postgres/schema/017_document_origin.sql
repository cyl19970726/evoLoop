-- An issue/report can cite the Task revision observed when it was written.
-- Existing Documents remain unscoped; no historical provenance is inferred.
-- A full legacy upgrade runs 012's Task primary-Document backfill and this
-- migration in one transaction. Drain its deferred FK/constraint events before
-- changing process_document's shape, then restore deferred migration checks.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE process_document ADD COLUMN origin_task_id uuid;
ALTER TABLE process_document ADD COLUMN origin_task_revision_id uuid;
ALTER TABLE process_document ADD COLUMN origin_run_id uuid;
ALTER TABLE process_document ADD CONSTRAINT document_origin_complete CHECK (
  (origin_task_id IS NULL AND origin_task_revision_id IS NULL AND origin_run_id IS NULL) OR
  (origin_task_id IS NOT NULL AND origin_task_revision_id IS NOT NULL AND kind IN ('issue','report'))
);
ALTER TABLE process_document ADD CONSTRAINT document_origin_task_revision_fk
  FOREIGN KEY(project_id,origin_task_id,origin_task_revision_id)
  REFERENCES task_revision(project_id,task_id,revision_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE process_document ADD CONSTRAINT document_origin_run_fk
  FOREIGN KEY(project_id,origin_run_id) REFERENCES runtime_run(project_id,run_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION protect_document_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.origin_task_id IS DISTINCT FROM OLD.origin_task_id OR
    NEW.origin_task_revision_id IS DISTINCT FROM OLD.origin_task_revision_id OR
    NEW.origin_run_id IS DISTINCT FROM OLD.origin_run_id) THEN
    RAISE EXCEPTION 'document origin is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.origin_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id AND r.run_id=NEW.origin_run_id
      AND r.task_id=NEW.origin_task_id AND r.task_revision_id=NEW.origin_task_revision_id
  ) THEN
    RAISE EXCEPTION 'document origin Run does not match fixed Task revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_origin_guard BEFORE INSERT OR UPDATE ON process_document
  FOR EACH ROW EXECUTE FUNCTION protect_document_origin();
CREATE INDEX process_document_origin_task ON process_document(project_id,origin_task_id,origin_task_revision_id)
  WHERE origin_task_id IS NOT NULL;
