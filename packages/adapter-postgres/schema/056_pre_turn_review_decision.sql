-- Existing candidate databases have already applied 055. Keep the immutable
-- operation binding in its own migration so those databases upgrade safely.
CREATE TABLE IF NOT EXISTS pre_turn_review_decision (
  project_id uuid NOT NULL REFERENCES project(project_id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('run','message')),
  subject_id uuid NOT NULL,
  intent_json text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (project_id, operation_id)
);
