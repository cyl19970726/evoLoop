ALTER TABLE process_document DROP CONSTRAINT process_document_kind_check;
ALTER TABLE process_document ADD CONSTRAINT process_document_kind_check
  CHECK (kind IN ('task','issue','spec','discussion','report','organization_review'));

ALTER TABLE document_revision ADD COLUMN organization_review jsonb
  CHECK (organization_review IS NULL OR jsonb_typeof(organization_review) = 'object');

CREATE INDEX process_document_kind_id_idx ON process_document(project_id,kind,document_id);

ALTER TABLE process_document DROP CONSTRAINT document_origin_complete;
ALTER TABLE process_document ADD CONSTRAINT document_origin_complete CHECK (
  (origin_task_id IS NULL AND origin_task_revision_id IS NULL AND origin_run_id IS NULL) OR
  (origin_task_id IS NOT NULL AND origin_task_revision_id IS NOT NULL AND kind IN ('issue','report','organization_review'))
);
