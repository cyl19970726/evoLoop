-- Formal allocation action paths and accepted concrete recipient revisions.
CREATE INDEX discussion_allocation_action_target_idx
  ON discussion_event(project_id,target_kind,target_id,discussion_id,event_id) WHERE kind='action';
CREATE INDEX discussion_allocation_action_discussion_idx
  ON discussion_event(project_id,discussion_id,event_id) WHERE kind='action';
CREATE INDEX assignment_accepted_target_idx
  ON task_session_assignment_revision(project_id,target_kind,target_id,task_id,task_revision_id,version)
  WHERE state='accepted';
CREATE INDEX assignment_accepted_task_revision_idx
  ON task_session_assignment_revision(project_id,task_id,task_revision_id,version)
  WHERE state='accepted';
CREATE INDEX discussion_kind_page_idx ON discussion(project_id,kind,discussion_id);

-- Relation summaries also observe independently edited Document and Stage heads.
-- Reuse the commit-ordered journal; it retains only bounded metadata, not bodies
-- or a second relation authority. Normal writes and these invalidations commit
-- atomically, so an old relation cursor cannot silently mix these head states.
CREATE FUNCTION record_allocation_source_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; entity uuid;
BEGIN
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  entity := CASE TG_TABLE_NAME
    WHEN 'process_document' THEN (row_data->>'document_id')::uuid
    WHEN 'document_revision' THEN (row_data->>'document_id')::uuid
    WHEN 'project_stage' THEN (row_data->>'stage_id')::uuid
    WHEN 'stage_revision' THEN (row_data->>'stage_id')::uuid
    WHEN 'discussion' THEN (row_data->>'discussion_id')::uuid END;
  PERFORM append_session_observation_row(TG_TABLE_NAME,
    row_data || jsonb_build_object('event_id',entity),
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD)->>'state' ELSE NULL END);
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$
DECLARE source_name text;
BEGIN
  FOREACH source_name IN ARRAY ARRAY['process_document','document_revision','project_stage','stage_revision','discussion'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_allocation_source_observation()',
      source_name||'_allocation_observation',source_name);
  END LOOP;
END $$;
