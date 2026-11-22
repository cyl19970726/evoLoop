-- Milestones are stages (decision of 11-22): a stage gets four fields (short name, due date, how to check it, which verification-ladder levels it
-- supplies evidence for) and a Task's stage ownership gets its own record. Both live in side tables, so project_stage, stage_revision, stage_review,
-- stage_phase_key and the Task revision chain keep every existing row and rule. Forward only (down=false): rolling back means a later forward
-- migration that drops these four tables, which loses nothing that existed before this one.

-- One row per stage; version counts changes; every change also appends the full state to stage_milestone_history (append-only, with who and why).
CREATE TABLE stage_milestone (
  project_id uuid NOT NULL, stage_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  short_name text CHECK (short_name IS NULL OR (length(btrim(short_name)) > 0 AND char_length(short_name) <= 40)),
  due_on date,
  check_method text,
  ladder_keys text[] NOT NULL DEFAULT '{}',
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0), reason text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, stage_id),
  FOREIGN KEY (project_id, stage_id) REFERENCES project_stage(project_id, stage_id)
);
CREATE TABLE stage_milestone_history (
  project_id uuid NOT NULL, stage_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  short_name text, due_on date, check_method text, ladder_keys text[] NOT NULL DEFAULT '{}',
  actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, stage_id, version),
  FOREIGN KEY (project_id, stage_id) REFERENCES project_stage(project_id, stage_id)
);

-- One row per Task that has an ownership record; stage_id NULL means explicitly "not part of any stage" (the reason is then required).
-- No row means unassigned. The history also records the removal of a row (stage_id and no_stage_reason both NULL).
CREATE TABLE task_stage (
  project_id uuid NOT NULL, task_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  stage_id uuid, no_stage_reason text,
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0), reason text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, task_id),
  FOREIGN KEY (project_id, task_id) REFERENCES task(project_id, task_id),
  FOREIGN KEY (project_id, stage_id) REFERENCES project_stage(project_id, stage_id),
  CHECK ((stage_id IS NOT NULL AND no_stage_reason IS NULL) OR (stage_id IS NULL AND length(btrim(coalesce(no_stage_reason, ''))) > 0))
);
CREATE INDEX task_stage_stage_idx ON task_stage(project_id, stage_id);
CREATE TABLE task_stage_history (
  project_id uuid NOT NULL, task_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0),
  stage_id uuid, no_stage_reason text,
  actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, task_id, version),
  FOREIGN KEY (project_id, task_id) REFERENCES task(project_id, task_id),
  FOREIGN KEY (project_id, stage_id) REFERENCES project_stage(project_id, stage_id)
);

-- Backfill 1: each existing stage_phase_key becomes ladder_keys = {phase_key} (short name, due date and check method stay empty: nothing is guessed).
INSERT INTO stage_milestone(project_id, stage_id, version, short_name, due_on, check_method, ladder_keys, actor_id, reason, updated_at)
  SELECT project_id, stage_id, 1, NULL, NULL, NULL, ARRAY[phase_key], actor_id, '迁移自 stage_phase_key：' || reason, updated_at FROM stage_phase_key;
INSERT INTO stage_milestone_history(project_id, stage_id, version, short_name, due_on, check_method, ladder_keys, actor_id, reason, created_at)
  SELECT project_id, stage_id, 1, NULL, NULL, NULL, ARRAY[phase_key], actor_id, '迁移自 stage_phase_key：' || reason, updated_at FROM stage_phase_key;

-- Backfill 2: every Task whose latest proposal names a stage (closed ones included) gets one ownership row; the rest stay unassigned.
-- "Latest" is the proposal at the newest Task revision that has one, the same rule getTaskProposal reads by.
WITH latest AS (
  SELECT DISTINCT ON (p.project_id, p.task_id) p.project_id, p.task_id, p.stage_id
  FROM task_proposal p JOIN task_revision r ON r.project_id = p.project_id AND r.task_id = p.task_id AND r.revision_id = p.task_revision_id
  ORDER BY p.project_id, p.task_id, r.version DESC
), written AS (
  INSERT INTO task_stage(project_id, task_id, version, stage_id, no_stage_reason, actor_id, reason, updated_at)
    SELECT l.project_id, l.task_id, 1, l.stage_id, NULL, 'migration-118', '迁移自 task_proposal', now() FROM latest l WHERE l.stage_id IS NOT NULL
    RETURNING project_id, task_id, version, stage_id, actor_id, reason, updated_at
)
INSERT INTO task_stage_history(project_id, task_id, version, stage_id, no_stage_reason, actor_id, reason, created_at)
  SELECT project_id, task_id, version, stage_id, NULL, actor_id, reason, updated_at FROM written;
