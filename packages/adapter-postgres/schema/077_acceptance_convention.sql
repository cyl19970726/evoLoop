-- Task acceptance convention (DEC-042): what must happen before a delivery can be checked, a declared-business-identity
-- acceptance target that needs no relay, and three more work types. Older Tasks declare nothing new: every change widens a
-- constraint or adds an optional column, so no existing row changes.

-- Work types: add defect, documentation and operation next to implementation, research and validation.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
    WHERE contype='c' AND conrelid IN ('task'::regclass,'task_revision'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) LIKE '%implementation%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;
ALTER TABLE task ADD CONSTRAINT task_kind_check
  CHECK (kind IN ('implementation','research','validation','defect','documentation','operation'));
ALTER TABLE task_revision ADD CONSTRAINT task_revision_kind_check
  CHECK (kind IN ('implementation','research','validation','defect','documentation','operation'));

ALTER TABLE task_proposal ADD COLUMN acceptance_precondition text
  CHECK (acceptance_precondition IS NULL OR acceptance_precondition IN ('none','refresh','release','migration','config_restart'));
ALTER TABLE task_proposal DROP CONSTRAINT task_proposal_acceptance_target_check;
ALTER TABLE task_proposal ADD CONSTRAINT task_proposal_acceptance_target_check
  CHECK (acceptance_target IN ('human','leader','business_session','named_agent'));

-- A reviewer/publisher states that a delivery's precondition (release, migration, ...) is met. Explicit, immutable, one per delivery.
CREATE TABLE task_acceptance_precondition_mark (
  project_id uuid NOT NULL, mark_id uuid NOT NULL, task_id uuid NOT NULL, delivery_id uuid NOT NULL,
  actor_id text NOT NULL CHECK(length(btrim(actor_id))>0), evidence text NOT NULL CHECK(length(btrim(evidence))>0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,mark_id), UNIQUE(project_id,delivery_id),
  FOREIGN KEY(project_id,delivery_id) REFERENCES delivery(project_id,delivery_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id)
);
CREATE TRIGGER task_acceptance_precondition_mark_immutable BEFORE UPDATE OR DELETE ON task_acceptance_precondition_mark
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
