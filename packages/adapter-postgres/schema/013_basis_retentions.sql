-- Reviewer checkpoints are part of the sealed basis, never mutable after sealing.
ALTER TABLE basis_set ADD COLUMN retentions jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(retentions) = 'array');

CREATE OR REPLACE FUNCTION protect_basis_set() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'basis set cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF OLD.sealed OR NEW.project_id <> OLD.project_id OR NEW.task_id <> OLD.task_id
    OR NEW.task_revision_id <> OLD.task_revision_id OR NEW.basis_set_id <> OLD.basis_set_id
    OR NEW.retentions IS DISTINCT FROM OLD.retentions OR NOT NEW.sealed THEN
    RAISE EXCEPTION 'basis set can only be sealed once' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM basis_member m WHERE m.project_id = OLD.project_id AND m.task_id = OLD.task_id
    AND m.task_revision_id = OLD.task_revision_id AND m.basis_set_id = OLD.basis_set_id) THEN
    RAISE EXCEPTION 'cannot seal empty basis set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
