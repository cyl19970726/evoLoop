-- 051: keep old confirmed model while a running Turn finishes; a saved target is not native activation.
ALTER TABLE session_execution_profile_revision ADD COLUMN reasoning_effort text
  CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('minimal','low','medium','high','xhigh','max','ultra'));

-- Run snapshots remain byte-identical for historical revisions without an explicit effort.
CREATE OR REPLACE FUNCTION session_recovery_run_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile record; expected jsonb;
BEGIN
  SELECT p.* INTO profile FROM session_execution_profile h JOIN session_execution_profile_revision p
    ON p.project_id=h.project_id AND p.session_id=h.session_id AND p.revision_id=h.revision_id
    WHERE h.project_id=NEW.project_id AND h.session_id=NEW.session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'run has no configured Session profile' USING ERRCODE='23514'; END IF;
  expected:=jsonb_build_object('revisionId',profile.revision_id,'version',profile.version,'model',profile.model,
    'sandbox',profile.sandbox,'approvalPolicy',profile.approval_policy,'cwd',profile.cwd,
    'authorizationScope',profile.authorization_scope,'provenance',profile.provenance)
    || CASE WHEN profile.reasoning_effort IS NULL THEN '{}'::jsonb
       ELSE jsonb_build_object('reasoningEffort',profile.reasoning_effort) END;
  IF NEW.execution_profile_snapshot IS NOT NULL AND NEW.execution_profile_snapshot<>expected THEN
    RAISE EXCEPTION 'run configured profile differs from adopted Session revision' USING ERRCODE='23514';
  END IF;
  NEW.execution_profile_snapshot:=expected;
  RETURN NEW;
END $$;

-- The active revision can precede the head after an explicitly rejected target.
CREATE OR REPLACE FUNCTION protect_runtime_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile record; prior record; predecessor record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'runtime record cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='runtime_session' THEN
    IF NEW.model IS DISTINCT FROM OLD.model OR NEW.sandbox<>OLD.sandbox OR NEW.approval_policy<>OLD.approval_policy THEN
      SELECT h.activation_state,h.active_revision_id,p.* INTO profile FROM session_execution_profile h
        JOIN session_execution_profile_revision p ON p.project_id=h.project_id AND p.session_id=h.session_id
          AND p.revision_id=h.revision_id WHERE h.project_id=NEW.project_id AND h.session_id=NEW.session_id;
      SELECT * INTO prior FROM session_execution_profile_revision
        WHERE project_id=OLD.project_id AND session_id=OLD.session_id AND revision_id=profile.active_revision_id;
      SELECT * INTO predecessor FROM session_execution_profile_revision
        WHERE project_id=OLD.project_id AND session_id=OLD.session_id AND revision_id=profile.previous_revision_id;
      IF profile IS NULL OR prior IS NULL OR predecessor IS NULL OR profile.activation_state<>'pending' OR profile.provenance<>'revised'
        OR profile.sandbox<>'danger-full-access' OR profile.approval_policy<>'never'
        OR profile.model IS DISTINCT FROM NEW.model OR profile.sandbox<>NEW.sandbox OR profile.approval_policy<>NEW.approval_policy
        OR (prior.model IS DISTINCT FROM OLD.model AND predecessor.model IS DISTINCT FROM OLD.model)
        OR prior.sandbox<>OLD.sandbox OR prior.approval_policy<>OLD.approval_policy
        OR profile.version<>predecessor.version+1 THEN
        RAISE EXCEPTION 'runtime session execution policy requires an adopted immutable profile revision' USING ERRCODE='23514';
      END IF;
    END IF;
    IF NEW.project_id<>OLD.project_id OR NEW.session_id<>OLD.session_id OR NEW.role_id<>OLD.role_id
      OR NEW.cwd<>OLD.cwd OR NEW.authorization_scope<>OLD.authorization_scope
      OR NEW.operation_id<>OLD.operation_id OR NEW.actor_id<>OLD.actor_id OR NEW.created_at<>OLD.created_at
      OR (OLD.native_thread_id IS NOT NULL AND (NEW.native_thread_id IS DISTINCT FROM OLD.native_thread_id OR NEW.native_session_id IS DISTINCT FROM OLD.native_session_id))
      OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'runtime session identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.project_id<>OLD.project_id OR NEW.run_id<>OLD.run_id OR NEW.task_id<>OLD.task_id
      OR NEW.task_revision_id<>OLD.task_revision_id OR NEW.basis_set_id<>OLD.basis_set_id
      OR NEW.session_id<>OLD.session_id OR NEW.operation_id<>OLD.operation_id
      OR NEW.input<>OLD.input OR NEW.input_hash<>OLD.input_hash OR NEW.actor_id<>OLD.actor_id
      OR NEW.execution_profile_snapshot IS DISTINCT FROM OLD.execution_profile_snapshot
      OR NEW.created_at<>OLD.created_at OR NEW.version<>OLD.version+1
      OR (OLD.native_turn_id IS NOT NULL AND NEW.native_turn_id IS DISTINCT FROM OLD.native_turn_id) THEN
      RAISE EXCEPTION 'runtime run origin is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
