-- 简报 is its own Document kind (Task afe7e585): the daily brief was a report titled "每日简报 YYYY-MM-DD" and could not be
-- found by type. This migration does two things only: widen the kind constraints, and move exactly those reports.
ALTER TABLE process_document DROP CONSTRAINT process_document_kind_check;
ALTER TABLE process_document ADD CONSTRAINT process_document_kind_check
  CHECK (kind IN ('task','issue','spec','discussion','report','organization_review','brief'));

-- A brief, like a report, may name the Task and Run that produced it.
ALTER TABLE process_document DROP CONSTRAINT document_origin_complete;
ALTER TABLE process_document ADD CONSTRAINT document_origin_complete CHECK (
  (origin_task_id IS NULL AND origin_task_revision_id IS NULL AND origin_run_id IS NULL) OR
  (origin_task_id IS NOT NULL AND origin_task_revision_id IS NOT NULL AND kind IN ('issue','report','organization_review','brief'))
);

-- Only a report whose whole title is "每日简报 " plus a date changes type. The version stays: this is a reclassification
-- of a stored label, not a new revision or a new Document version (the same way 012 backfilled status).
ALTER TABLE process_document DISABLE TRIGGER advance_document_version;
UPDATE process_document SET kind='brief'
  WHERE kind='report' AND title ~ '^每日简报 [0-9]{4}-[0-9]{2}-[0-9]{2}$';
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
ALTER TABLE process_document ENABLE TRIGGER advance_document_version;
