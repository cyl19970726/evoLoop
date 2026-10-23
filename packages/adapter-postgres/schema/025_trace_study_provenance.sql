ALTER TABLE task_external_ref_decision ADD COLUMN study_provenance jsonb
  CHECK (study_provenance IS NULL OR jsonb_typeof(study_provenance) = 'object');
