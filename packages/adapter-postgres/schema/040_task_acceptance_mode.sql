-- Historical proposals retain NULL so new acceptance rules never rewrite old observations.
ALTER TABLE task_proposal ADD COLUMN acceptance_mode text
  CHECK (acceptance_mode IN ('independent_agent', 'human_required'));

ALTER TABLE delivery ADD COLUMN submitted_by_actor_id text;
ALTER TABLE delivery ADD COLUMN source_run_version integer CHECK (source_run_version > 0);
