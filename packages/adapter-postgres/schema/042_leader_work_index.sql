-- Optional planning metadata belongs to the Task; it does not replace Task state.
CREATE TABLE task_work_plan (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  planned_start_at timestamptz,
  due_at timestamptz,
  priority smallint CHECK(priority BETWEEN 0 AND 4),
  actor_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id),
  CHECK(planned_start_at IS NULL OR due_at IS NULL OR planned_start_at<=due_at)
);

-- A Task may depend on another Task in any queue. The application validates the
-- prospective graph and requires the prerequisite's current revision to have
-- closure or an accepted queue release before dispatch.
CREATE TABLE task_dependency (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  actor_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id,depends_on_task_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id),
  FOREIGN KEY(project_id,depends_on_task_id) REFERENCES task(project_id,task_id),
  CHECK(task_id<>depends_on_task_id)
);
CREATE INDEX task_dependency_reverse_idx ON task_dependency(project_id,depends_on_task_id,task_id);
CREATE TABLE task_dependency_head (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(project_id,task_id),
  FOREIGN KEY(project_id,task_id) REFERENCES task(project_id,task_id)
);

-- A durable, monotonic change feed for Leader discovery. UUIDs remain object
-- identities; they are never reused as the ordering watermark.
CREATE TABLE leader_work_change (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project(project_id),
  entity_kind text NOT NULL CHECK(entity_kind IN ('task','document','assignment','delivery',
    'observation','closure','run','impact','queue','plan','dependency','review')),
  entity_id uuid NOT NULL,
  task_id uuid,
  document_id uuid,
  version integer,
  changed_at timestamptz NOT NULL,
  CHECK(task_id IS NOT NULL OR document_id IS NOT NULL)
);
CREATE INDEX leader_work_change_project_idx ON leader_work_change(project_id,sequence);
CREATE INDEX leader_work_change_task_idx ON leader_work_change(project_id,task_id,sequence);
CREATE INDEX leader_work_change_document_idx ON leader_work_change(project_id,document_id,sequence);

CREATE TABLE leader_work_review (
  project_id uuid NOT NULL,
  review_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_version integer NOT NULL CHECK(task_version>0),
  task_revision_id uuid NOT NULL,
  reviewed_change_sequence bigint NOT NULL CHECK(reviewed_change_sequence>=0),
  decision text NOT NULL CHECK(decision IN ('acknowledged','deferred')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000),
  actor_id text NOT NULL,
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  review_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  PRIMARY KEY(project_id,review_id),
  UNIQUE(project_id,operation_id),
  FOREIGN KEY(project_id,task_id,task_revision_id)
    REFERENCES task_revision(project_id,task_id,revision_id)
);
CREATE INDEX leader_work_review_current_idx
  ON leader_work_review(project_id,task_id,task_revision_id,review_sequence DESC);
CREATE TRIGGER immutable_leader_work_review BEFORE UPDATE OR DELETE ON leader_work_review
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();

CREATE FUNCTION record_leader_work_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb:=to_jsonb(NEW);
  changed_kind text;
  changed_entity uuid;
  changed_task uuid;
  changed_document uuid;
BEGIN
  row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  -- Sequence allocation and transaction commit use the same project lock order:
  -- a later sequence cannot commit while an earlier one is still uncommitted.
  PERFORM pg_advisory_xact_lock(hashtextextended('leader-work:'||(row_data->>'project_id'),0));
  changed_kind:=CASE
    WHEN TG_TABLE_NAME IN ('task','task_revision') THEN 'task'
    WHEN TG_TABLE_NAME IN ('process_document','document_revision','task_document_link') THEN 'document'
    WHEN TG_TABLE_NAME='task_session_assignment' THEN 'assignment'
    WHEN TG_TABLE_NAME='delivery' THEN 'delivery'
    WHEN TG_TABLE_NAME='consumer_observation' THEN 'observation'
    WHEN TG_TABLE_NAME='task_closure' THEN 'closure'
    WHEN TG_TABLE_NAME='runtime_run' THEN 'run'
    WHEN TG_TABLE_NAME='impact_review' THEN 'impact'
    WHEN TG_TABLE_NAME='resident_queue_entry' THEN 'queue'
    WHEN TG_TABLE_NAME='task_work_plan' THEN 'plan'
    WHEN TG_TABLE_NAME IN ('task_dependency','task_dependency_head') THEN 'dependency'
    WHEN TG_TABLE_NAME='leader_work_review' THEN 'review'
  END;
  changed_task:=NULLIF(row_data->>'task_id','')::uuid;
  changed_document:=CASE
    WHEN TG_TABLE_NAME IN ('process_document','document_revision') THEN (row_data->>'document_id')::uuid
    WHEN TG_TABLE_NAME='task_document_link' THEN (row_data->>'document_id')::uuid
  END;
  changed_entity:=CASE
    WHEN TG_TABLE_NAME IN ('task','task_revision') THEN (row_data->>'task_id')::uuid
    WHEN TG_TABLE_NAME IN ('process_document','document_revision') THEN (row_data->>'document_id')::uuid
    WHEN TG_TABLE_NAME='task_document_link' THEN (row_data->>'document_id')::uuid
    WHEN TG_TABLE_NAME='task_session_assignment' THEN (row_data->>'task_id')::uuid
    WHEN TG_TABLE_NAME IN ('delivery','consumer_observation','task_closure','impact_review','resident_queue_entry',
      'task_work_plan') THEN (row_data->>'task_id')::uuid
    WHEN TG_TABLE_NAME IN ('task_dependency','task_dependency_head') THEN (row_data->>'task_id')::uuid
    WHEN TG_TABLE_NAME='leader_work_review' THEN (row_data->>'review_id')::uuid
    ELSE COALESCE((row_data->>'run_id')::uuid,(row_data->>'task_id')::uuid)
  END;
  INSERT INTO leader_work_change(project_id,entity_kind,entity_id,task_id,document_id,version,changed_at)
    VALUES((row_data->>'project_id')::uuid,changed_kind,changed_entity,changed_task,changed_document,
      CASE WHEN TG_TABLE_NAME='leader_work_review' THEN (row_data->>'task_version')::integer
        ELSE NULLIF(row_data->>'version','')::integer END,now());
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER leader_work_task_change AFTER INSERT OR UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_task_revision_change AFTER INSERT ON task_revision
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_document_change AFTER INSERT OR UPDATE ON process_document
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_document_revision_change AFTER INSERT ON document_revision
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_document_link_change AFTER INSERT ON task_document_link
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_assignment_change AFTER INSERT OR UPDATE ON task_session_assignment
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_delivery_change AFTER INSERT ON delivery
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_observation_change AFTER INSERT ON consumer_observation
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_closure_change AFTER INSERT ON task_closure
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_run_change AFTER INSERT OR UPDATE OF state ON runtime_run
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_impact_change AFTER INSERT OR UPDATE ON impact_review
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_queue_change AFTER INSERT OR UPDATE ON resident_queue_entry
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_plan_change AFTER INSERT OR UPDATE ON task_work_plan
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_dependency_change AFTER INSERT OR UPDATE OR DELETE ON task_dependency
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_dependency_head_change AFTER INSERT OR UPDATE ON task_dependency_head
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
CREATE TRIGGER leader_work_review_change AFTER INSERT ON leader_work_review
  FOR EACH ROW EXECUTE FUNCTION record_leader_work_change();
