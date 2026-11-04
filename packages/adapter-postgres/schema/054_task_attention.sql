-- Task attention is a scoped decision journal, not a runtime control channel.
CREATE TABLE task_attention_threshold (
  project_id uuid NOT NULL REFERENCES project(project_id), stage_id uuid,
  phase text NOT NULL CHECK (phase IN ('unassigned','awaiting_ack','awaiting_run','run_reserved',
    'running','awaiting_submission','awaiting_delivery','awaiting_publication','awaiting_acceptance','rework','blocked',
    'closed','cancelled','unknown')),
  version integer NOT NULL CHECK (version>0),
  stage_overdue_ms bigint, activity_without_progress_ms bigint, observation_gap_ms bigint,
  actor_id text NOT NULL, reason text NOT NULL, updated_at timestamptz NOT NULL,
  FOREIGN KEY(project_id,stage_id) REFERENCES project_stage(project_id,stage_id),
  CHECK(stage_overdue_ms IS NULL OR stage_overdue_ms BETWEEN 1000 AND 31536000000),
  CHECK(activity_without_progress_ms IS NULL OR activity_without_progress_ms BETWEEN 1000 AND 31536000000),
  CHECK(observation_gap_ms IS NULL OR observation_gap_ms BETWEEN 1000 AND 31536000000)
);
CREATE UNIQUE INDEX task_attention_threshold_key ON task_attention_threshold(project_id,stage_id,phase) NULLS NOT DISTINCT;
CREATE INDEX task_attention_threshold_project_idx ON task_attention_threshold(project_id,phase,stage_id);
CREATE TABLE task_attention_threshold_revision (
  project_id uuid NOT NULL, revision_id uuid NOT NULL DEFAULT gen_random_uuid(),
  stage_id uuid, phase text NOT NULL, version integer NOT NULL,
  stage_overdue_ms bigint, activity_without_progress_ms bigint, observation_gap_ms bigint,
  actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,revision_id), UNIQUE NULLS NOT DISTINCT (project_id,stage_id,phase,version),
  FOREIGN KEY(project_id) REFERENCES project(project_id)
);
CREATE TRIGGER immutable_task_attention_threshold_revision BEFORE UPDATE OR DELETE ON task_attention_threshold_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE TABLE task_attention_follow_up (
  project_id uuid NOT NULL, task_id uuid NOT NULL, task_revision_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), waiting_on jsonb,
  decision text NOT NULL CHECK(decision IN ('checked','waiting','acted')),
  action_taken text NOT NULL, evidence_ref text, next_check_at timestamptz,
  release_handoff jsonb, publication jsonb, actor_id text NOT NULL, reason text NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE INDEX task_attention_next_check_idx ON task_attention_follow_up(project_id,next_check_at,task_id)
  WHERE next_check_at IS NOT NULL;
CREATE TABLE task_attention_follow_up_revision (
  project_id uuid NOT NULL, task_id uuid NOT NULL, revision_id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_revision_id uuid NOT NULL, version integer NOT NULL,
  waiting_on jsonb, decision text NOT NULL, action_taken text NOT NULL, evidence_ref text,
  next_check_at timestamptz, release_handoff jsonb, publication jsonb,
  actor_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id,revision_id), UNIQUE(project_id,task_id,version),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE TRIGGER immutable_task_attention_follow_up_revision BEFORE UPDATE OR DELETE ON task_attention_follow_up_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE TABLE task_attention_item (
  project_id uuid NOT NULL, item_id uuid NOT NULL DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL, task_revision_id uuid NOT NULL, stage_id uuid,
  phase text NOT NULL, signal text NOT NULL CHECK(signal IN ('stage_overdue','activity_without_progress','observation_gap')),
  source_kind text NOT NULL, source_id text NOT NULL, waiting_on jsonb,
  state text NOT NULL CHECK(state IN ('open','resolved')),
  severity text NOT NULL CHECK(severity IN ('watch','urgent')), version integer NOT NULL CHECK(version>0),
  first_detected_at timestamptz NOT NULL, last_detected_at timestamptz NOT NULL,
  source_observed_at timestamptz NOT NULL, reason text NOT NULL, evidence jsonb NOT NULL,
  notice_id uuid, resolved_at timestamptz, resolution_reason text,
  PRIMARY KEY(project_id,item_id),
  FOREIGN KEY(project_id,task_id,task_revision_id) REFERENCES task_revision(project_id,task_id,revision_id),
  CHECK((state='open' AND resolved_at IS NULL AND resolution_reason IS NULL) OR
    (state='resolved' AND resolved_at IS NOT NULL AND resolution_reason IS NOT NULL))
);
CREATE UNIQUE INDEX task_attention_one_open_signal ON task_attention_item(project_id,task_id,signal) WHERE state='open';
CREATE INDEX task_attention_project_page ON task_attention_item(project_id,state,first_detected_at DESC,item_id DESC);
CREATE INDEX task_attention_task_page ON task_attention_item(project_id,task_id,state,first_detected_at DESC,item_id DESC);
CREATE INDEX task_attention_filter_idx ON task_attention_item(project_id,phase,signal,state,first_detected_at DESC,item_id DESC);
CREATE INDEX task_attention_waiting_idx ON task_attention_item(project_id,(waiting_on->>'kind'),(waiting_on->>'id'),first_detected_at DESC,item_id DESC);
CREATE TABLE task_attention_item_event (
  project_id uuid NOT NULL, event_id uuid NOT NULL DEFAULT gen_random_uuid(), item_id uuid NOT NULL,
  item_version integer NOT NULL, kind text NOT NULL CHECK(kind IN ('opened','escalated','resolved','source_expired')),
  severity text NOT NULL, evidence jsonb NOT NULL, actor_id text, reason text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,event_id), UNIQUE(project_id,item_id,item_version),
  FOREIGN KEY(project_id,item_id) REFERENCES task_attention_item(project_id,item_id)
);
CREATE INDEX task_attention_item_event_order ON task_attention_item_event(project_id,item_id,item_version);
CREATE TRIGGER immutable_task_attention_item_event BEFORE UPDATE OR DELETE ON task_attention_item_event
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
-- Keyset scan admits at most a caller-selected page. The projection itself verifies Task attribution.
CREATE INDEX task_attention_scan_idx ON task(project_id,task_id) WHERE state IN ('todo','in_progress');
ALTER TABLE leader_result_notice DROP CONSTRAINT leader_result_notice_kind_check;
ALTER TABLE leader_result_notice ADD CONSTRAINT leader_result_notice_kind_check CHECK (kind IN
  ('task_todo','delivery','observation','task_question','task_blocker','run_without_submission',
   'run_submission_blocked','task_attention'));
