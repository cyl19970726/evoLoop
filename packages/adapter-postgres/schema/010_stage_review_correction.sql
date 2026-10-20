-- Preserve prior reviews while linking each explicit correction to the same stage.
ALTER TABLE stage_review ADD COLUMN supersedes_review_id uuid;
ALTER TABLE stage_review
  ADD CONSTRAINT stage_review_same_stage_identity UNIQUE (project_id, stage_id, review_id),
  ADD CONSTRAINT stage_review_one_per_version UNIQUE (project_id, stage_id, stage_version),
  ADD CONSTRAINT stage_review_no_self_supersede CHECK (supersedes_review_id IS NULL OR supersedes_review_id <> review_id),
  ADD CONSTRAINT stage_review_same_stage_supersedes
    FOREIGN KEY (project_id, stage_id, supersedes_review_id)
    REFERENCES stage_review(project_id, stage_id, review_id);
