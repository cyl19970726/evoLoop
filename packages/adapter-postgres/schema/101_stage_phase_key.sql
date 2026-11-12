-- A stage may be linked to a roadmap phase (M0, M0.5, M1, ...): the overview's milestones read the phase text from the roadmap and the status
-- and dates from the linked stage. The link is its own table, so project_stage and its revision history stay as they are; one link per
-- stage, changed or cleared by stage.phaseKey.set (review permission). Stages with no row are simply not linked ("未登记").
CREATE TABLE stage_phase_key (
  project_id uuid NOT NULL, stage_id uuid NOT NULL,
  phase_key text NOT NULL CHECK (phase_key ~ '^M[0-9]+(\.[0-9]+)?$'),
  actor_id text NOT NULL CHECK (length(btrim(actor_id))>0), reason text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, stage_id),
  FOREIGN KEY (project_id, stage_id) REFERENCES project_stage(project_id, stage_id)
);
CREATE INDEX stage_phase_key_phase_idx ON stage_phase_key(project_id, phase_key);
