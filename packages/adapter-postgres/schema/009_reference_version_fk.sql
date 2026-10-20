-- 008 was applied to an early pilot with an FK that did not include slot_version.
-- Preserve its data and add the stronger constraint; fresh 008 already has it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='task_external_ref_decision'::regclass AND contype='u'
      AND pg_get_constraintdef(oid) LIKE 'UNIQUE (project_id, task_id, slot_id, slot_version, decision_id)%'
  ) THEN
    ALTER TABLE task_external_ref_decision ADD CONSTRAINT task_external_ref_decision_version_key
      UNIQUE(project_id,task_id,slot_id,slot_version,decision_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='task_external_ref_head'::regclass AND contype='f'
      AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (project_id, task_id, slot_id, slot_version, decision_id)%'
  ) THEN
    ALTER TABLE task_external_ref_head ADD CONSTRAINT task_external_ref_head_decision_version_fk
      FOREIGN KEY(project_id,task_id,slot_id,slot_version,decision_id)
      REFERENCES task_external_ref_decision(project_id,task_id,slot_id,slot_version,decision_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='task_external_ref_snapshot'::regclass AND contype='f'
      AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (project_id, task_id, slot_id, slot_version, decision_id)%'
  ) THEN
    ALTER TABLE task_external_ref_snapshot ADD CONSTRAINT task_external_ref_snapshot_decision_version_fk
      FOREIGN KEY(project_id,task_id,slot_id,slot_version,decision_id)
      REFERENCES task_external_ref_decision(project_id,task_id,slot_id,slot_version,decision_id);
  END IF;
END $$;
