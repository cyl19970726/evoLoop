-- Task acceptance convention (DEC-042): what the Task delivers, what must happen before the delivery can be checked, and a
-- declared-business-identity acceptance target that needs no relay. All columns are optional: older Tasks declare nothing.
ALTER TABLE task_proposal ADD COLUMN delivery_form text
  CHECK (delivery_form IS NULL OR delivery_form IN ('research','document','code','config','operation'));
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
