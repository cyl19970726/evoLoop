-- A Task is the first occurrence. Later slots own independent Task identities.
CREATE TABLE task_timing_series (
  project_id uuid NOT NULL REFERENCES project(project_id),
  series_id uuid NOT NULL,
  root_task_id uuid NOT NULL,
  authorized_actor_id text NOT NULL,
  authorized_role_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  current_revision_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active','stopped')),
  first_at_utc timestamptz NOT NULL,
  watermark_utc timestamptz,
  skipped_count bigint NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  updated_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,series_id),
  UNIQUE (project_id,root_task_id),
  FOREIGN KEY (project_id,root_task_id) REFERENCES task(project_id,task_id)
);
CREATE TABLE task_timing_series_revision (
  project_id uuid NOT NULL,
  series_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  source_task_id uuid NOT NULL,
  source_task_revision_id uuid NOT NULL,
  timezone text NOT NULL,
  repeat text NOT NULL CHECK (repeat IN ('none','daily')),
  execute_at_utc timestamptz NOT NULL,
  template jsonb NOT NULL CHECK (jsonb_typeof(template) = 'object'),
  state text NOT NULL CHECK (state IN ('active','stopped')),
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,series_id,revision_id),
  UNIQUE (project_id,series_id,version),
  FOREIGN KEY (project_id,series_id) REFERENCES task_timing_series(project_id,series_id),
  FOREIGN KEY (project_id,source_task_id,source_task_revision_id)
    REFERENCES task_revision(project_id,task_id,revision_id)
);
ALTER TABLE task_timing_series ADD CONSTRAINT task_timing_current_revision_fk
  FOREIGN KEY (project_id,series_id,current_revision_id)
  REFERENCES task_timing_series_revision(project_id,series_id,revision_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE task_timing_occurrence (
  project_id uuid NOT NULL,
  series_id uuid NOT NULL,
  planned_at_utc timestamptz NOT NULL,
  task_id uuid NOT NULL,
  series_revision_id uuid NOT NULL,
  previous_task_id uuid,
  created_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,series_id,planned_at_utc),
  UNIQUE (project_id,task_id),
  FOREIGN KEY (project_id,series_id) REFERENCES task_timing_series(project_id,series_id),
  FOREIGN KEY (project_id,series_id,series_revision_id)
    REFERENCES task_timing_series_revision(project_id,series_id,revision_id),
  FOREIGN KEY (project_id,task_id) REFERENCES task(project_id,task_id),
  FOREIGN KEY (project_id,previous_task_id) REFERENCES task(project_id,task_id)
);
-- A pending occurrence may be rescheduled. The old and new key are recorded
-- before the key changes; generated/started work is never rewritten.
CREATE TABLE task_timing_occurrence_revision (
  project_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  series_id uuid NOT NULL,
  task_id uuid NOT NULL,
  previous_at_utc timestamptz NOT NULL,
  next_at_utc timestamptz NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL,
  created_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,revision_id),
  FOREIGN KEY (project_id,series_id) REFERENCES task_timing_series(project_id,series_id),
  FOREIGN KEY (project_id,task_id) REFERENCES task(project_id,task_id)
);
CREATE INDEX task_timing_occurrence_latest_idx
  ON task_timing_occurrence(project_id,series_id,planned_at_utc DESC);
CREATE TABLE task_timing (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  series_id uuid NOT NULL,
  planned_at_utc timestamptz NOT NULL,
  PRIMARY KEY (project_id,task_id),
  FOREIGN KEY (project_id,series_id,planned_at_utc)
    REFERENCES task_timing_occurrence(project_id,series_id,planned_at_utc)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (project_id,task_id) REFERENCES task(project_id,task_id)
);
CREATE TRIGGER task_timing_revision_immutable BEFORE UPDATE OR DELETE ON task_timing_series_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE FUNCTION guard_task_timing_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'timing occurrence is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.project_id<>OLD.project_id OR NEW.series_id<>OLD.series_id OR NEW.task_id<>OLD.task_id
    OR NEW.series_revision_id<>OLD.series_revision_id OR NEW.previous_task_id IS DISTINCT FROM OLD.previous_task_id
    OR NEW.created_at_utc<>OLD.created_at_utc
    OR (SELECT state FROM task WHERE project_id=OLD.project_id AND task_id=OLD.task_id)<>'todo'
    OR NOT EXISTS(SELECT 1 FROM task_timing_occurrence_revision r
      WHERE r.project_id=OLD.project_id AND r.series_id=OLD.series_id AND r.task_id=OLD.task_id
        AND r.previous_at_utc=OLD.planned_at_utc AND r.next_at_utc=NEW.planned_at_utc) THEN
    RAISE EXCEPTION 'only an audited pending slot may move' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_timing_occurrence_immutable BEFORE UPDATE OR DELETE ON task_timing_occurrence
  FOR EACH ROW EXECUTE FUNCTION guard_task_timing_occurrence();
CREATE TRIGGER task_timing_occurrence_revision_immutable BEFORE UPDATE OR DELETE ON task_timing_occurrence_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE FUNCTION guard_task_timing_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'timing binding is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.project_id<>OLD.project_id OR NEW.task_id<>OLD.task_id
    OR NEW.series_id<>OLD.series_id OR NOT EXISTS(SELECT 1 FROM task_timing_occurrence o
      WHERE o.project_id=NEW.project_id AND o.series_id=NEW.series_id AND o.task_id=NEW.task_id
        AND o.planned_at_utc=NEW.planned_at_utc) THEN
    RAISE EXCEPTION 'timing binding can only follow its audited occurrence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_timing_binding_immutable BEFORE UPDATE OR DELETE ON task_timing
  FOR EACH ROW EXECUTE FUNCTION guard_task_timing_binding();
