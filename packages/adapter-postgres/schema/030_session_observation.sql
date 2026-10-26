-- A rebuildable metadata journal, never a second authority for Task/Document bodies.
-- The project counter is transactionally locked until COMMIT. Unlike a global
-- sequence allocated before commit, a committed cursor cannot skip a late writer.
CREATE TABLE session_observation_head (
  project_id uuid PRIMARY KEY REFERENCES project(project_id), sequence bigint NOT NULL CHECK(sequence>=0)
);
CREATE TABLE session_observation_change (
  project_id uuid NOT NULL REFERENCES project(project_id), sequence bigint NOT NULL,
  source_table text NOT NULL, entity_id uuid NOT NULL, source_revision text,
  session_id uuid, role_id text, task_id uuid, run_id uuid, discussion_id uuid, message_id uuid, target_kind text, target_id uuid,
  actor_id text, occurred_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail jsonb NOT NULL, PRIMARY KEY(project_id,sequence)
);
CREATE INDEX session_observation_session_idx ON session_observation_change(project_id,session_id,sequence DESC);
CREATE INDEX session_observation_task_idx ON session_observation_change(project_id,task_id,sequence DESC);
CREATE INDEX session_observation_role_idx ON session_observation_change(project_id,role_id,sequence DESC);
CREATE INDEX session_observation_target_idx ON session_observation_change(project_id,target_kind,target_id,sequence DESC);
CREATE INDEX runtime_event_session_idx ON runtime_record_event(project_id,session_id,sequence);
CREATE INDEX runtime_run_session_updated_idx ON runtime_run(project_id,session_id,created_at DESC,run_id DESC);
CREATE INDEX task_owner_state_idx ON task(project_id,owner,state,task_id);
CREATE INDEX discussion_session_idx ON discussion(project_id,collaboration_session_id,discussion_id);
CREATE INDEX discussion_reply_idx ON discussion_event(project_id,discussion_id,(collaboration_payload->>'replyToEventId'));

CREATE FUNCTION append_session_observation_row(source_name text, row_data jsonb, previous_state text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE project uuid; current_sequence bigint; identity_text text; timestamp_text text; related record;
BEGIN
  project := (row_data->>'project_id')::uuid;
  IF source_name='discussion_event' THEN
    SELECT task_id,collaboration_session_id INTO related FROM discussion
      WHERE project_id=project AND discussion_id=(row_data->>'discussion_id')::uuid;
    row_data := row_data || jsonb_build_object('task_id',related.task_id,'collaboration_session_id',related.collaboration_session_id);
  END IF;
  IF source_name='role_host_link_revision' THEN
    row_data := row_data || jsonb_build_object('target_kind',row_data->'host'->>'kind',
      'target_id',CASE WHEN row_data->'host'->>'kind'='owned' THEN row_data->'host'->>'sessionId' ELSE row_data->>'link_id' END,
      'session_id',row_data->'host'->>'sessionId');
  END IF;
  identity_text := CASE source_name
    WHEN 'role_revision' THEN row_data->>'role_id'
    WHEN 'role_host_link_revision' THEN row_data->>'link_id'
    WHEN 'task_revision' THEN row_data->>'task_id'
    WHEN 'session_profile' THEN row_data->>'target_id'
    WHEN 'task_session_assignment' THEN row_data->>'task_id'
    ELSE COALESCE(row_data->>'event_id',row_data->>'delivery_id',row_data->>'observation_id',
      row_data->>'processing_id',row_data->>'message_id',row_data->>'entry_id',row_data->>'claim_id',
      row_data->>'run_id',row_data->>'session_id',row_data->>'discussion_id',row_data->>'link_id',row_data->>'role_id',row_data->>'task_id') END;
  IF project IS NULL OR identity_text IS NULL THEN
    RAISE EXCEPTION 'observation source identity missing for %',source_name;
  END IF;
  INSERT INTO session_observation_head(project_id,sequence) VALUES(project,1)
    ON CONFLICT(project_id) DO UPDATE SET sequence=session_observation_head.sequence+1
    RETURNING sequence INTO current_sequence;
  timestamp_text := COALESCE(row_data->>'updated_at',row_data->>'created_at',row_data->>'created_at_utc',row_data->>'updated_at_utc');
  INSERT INTO session_observation_change(project_id,sequence,source_table,entity_id,source_revision,
    session_id,role_id,task_id,run_id,discussion_id,message_id,target_kind,target_id,actor_id,occurred_at,detail)
  VALUES(project,current_sequence,source_name,identity_text::uuid,
    COALESCE(row_data->>'revision_id',row_data->>'current_revision_id',row_data->>'version'),
    NULLIF(COALESCE(row_data->>'session_id',row_data->>'collaboration_session_id',row_data->'target'->>'sessionId'),'')::uuid,
    COALESCE(row_data->>'role_id',CASE WHEN source_name='task_revision' THEN row_data->>'owner' END),
    NULLIF(COALESCE(row_data->>'task_id',row_data->>'context_task_id',row_data->'context'->>'taskId'),'')::uuid,
    NULLIF(row_data->>'run_id','')::uuid,NULLIF(row_data->>'discussion_id','')::uuid,NULLIF(row_data->>'message_id','')::uuid,
    COALESCE(row_data->>'target_kind',row_data->'target'->>'kind'),
    NULLIF(COALESCE(row_data->>'target_id',row_data->>'link_id',row_data->'target'->>'sessionId',row_data->'target'->>'linkId'),'')::uuid,
    COALESCE(row_data->>'actor_id',row_data->>'sender_actor_id'),
    CASE WHEN timestamp_text IS NULL THEN NULL ELSE timestamp_text::timestamptz END,
    jsonb_strip_nulls(jsonb_build_object('state',row_data->>'state','previousState',previous_state,
      'kind',row_data->>'kind','result',COALESCE(row_data->>'result',row_data->>'technical_result'),
      'title',left(row_data->>'title',240),
      'summary',left(COALESCE(row_data->>'detail',row_data->>'hold_reason',row_data->>'reason',''),600))));
END $$;
CREATE FUNCTION record_session_observation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM append_session_observation_row(TG_TABLE_NAME,to_jsonb(OLD)||jsonb_build_object('state','removed'),to_jsonb(OLD)->>'state');
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND
    (to_jsonb(OLD)->>'target_kind',to_jsonb(OLD)->>'target_id') IS DISTINCT FROM
    (to_jsonb(NEW)->>'target_kind',to_jsonb(NEW)->>'target_id') THEN
    PERFORM append_session_observation_row(TG_TABLE_NAME,to_jsonb(OLD)||jsonb_build_object('state','moved'),to_jsonb(OLD)->>'state');
  END IF;
  PERFORM append_session_observation_row(TG_TABLE_NAME,to_jsonb(NEW),
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'state' ELSE NULL END);
  RETURN NEW;
END $$;

-- Existing immutable history remains readable after the upgrade. This initial
-- projection records original occurrence times, with a separate migration-time
-- observation timestamp. No source row, revision or native history is modified.
DO $$
DECLARE source_name text; row_data jsonb;
BEGIN
  FOREACH source_name IN ARRAY ARRAY['runtime_session','runtime_run','runtime_record_event','role_revision',
    'role_host_link_revision','task_revision','resident_queue_entry','resident_queue_claim','discussion_event','delivery','consumer_observation']
  LOOP
    FOR row_data IN EXECUTE format('SELECT to_jsonb(s) FROM %I s',source_name) LOOP
      PERFORM append_session_observation_row(source_name,row_data);
    END LOOP;
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_session_observation_change()',
      source_name||'_session_observation',source_name);
  END LOOP;
END $$;
CREATE TRIGGER session_observation_change_immutable BEFORE UPDATE OR DELETE ON session_observation_change
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
