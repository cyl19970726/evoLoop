-- A cancelled Task's known failed claim can be stopped without accepting its work.
ALTER TABLE resident_queue_claim DROP CONSTRAINT resident_queue_claim_release_kind_check;
ALTER TABLE resident_queue_claim ADD CONSTRAINT resident_queue_claim_release_kind_check
  CHECK(release_kind IN ('accepted','bounded','stopped'));
ALTER TABLE resident_queue_claim ADD COLUMN stop_decision_id uuid;
ALTER TABLE resident_queue_claim ADD CONSTRAINT resident_queue_claim_stop_evidence
  CHECK(release_kind IS DISTINCT FROM 'stopped' OR stop_decision_id IS NOT NULL);

CREATE TABLE resident_queue_stop_decision (
  project_id uuid NOT NULL, decision_id uuid NOT NULL, claim_id uuid NOT NULL,
  source_run_id uuid NOT NULL, expected_entry_version integer NOT NULL,
  expected_run_version integer NOT NULL, expected_gate_version integer NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>0),
  next_responsibility text NOT NULL CHECK(length(btrim(next_responsibility))>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,decision_id), UNIQUE(project_id,claim_id),
  FOREIGN KEY(project_id,claim_id) REFERENCES resident_queue_claim(project_id,claim_id),
  FOREIGN KEY(project_id,source_run_id) REFERENCES runtime_run(project_id,run_id)
);
CREATE TRIGGER resident_queue_stop_decision_immutable BEFORE UPDATE OR DELETE ON resident_queue_stop_decision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
