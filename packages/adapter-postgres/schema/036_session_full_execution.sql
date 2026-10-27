-- Existing launch revisions and immutable Run snapshots remain unchanged. A reviewed
-- revision may move the current Session head to the full-access native policy.
-- Retire the 035 process-wide cold-switch admission path. Keep its durable control
-- row and original operation epochs as historical evidence; new starts use the
-- Session slot and recovery gates instead of a global environment permit.
DROP TRIGGER zz_runtime_run_native_execution_fence ON runtime_run;
DROP TRIGGER zz_session_message_native_execution_fence ON session_message_processing;
DROP TRIGGER zz_runtime_session_native_execution_fence ON runtime_session;
DROP FUNCTION native_execution_start_fence();

ALTER TABLE runtime_session DROP CONSTRAINT runtime_session_sandbox_check;
ALTER TABLE runtime_session ADD CONSTRAINT runtime_session_sandbox_check
  CHECK(sandbox IN ('read-only','workspace-write','danger-full-access'));
ALTER TABLE runtime_session DROP CONSTRAINT runtime_session_approval_policy_check;
ALTER TABLE runtime_session ADD CONSTRAINT runtime_session_approval_policy_check
  CHECK(approval_policy IN ('on-request','untrusted','never'));
ALTER TABLE session_execution_profile_revision DROP CONSTRAINT session_execution_profile_revision_sandbox_check;
ALTER TABLE session_execution_profile_revision ADD CONSTRAINT session_execution_profile_revision_sandbox_check
  CHECK(sandbox IN ('read-only','workspace-write','danger-full-access'));
ALTER TABLE session_execution_profile_revision DROP CONSTRAINT session_execution_profile_revision_approval_policy_check;
ALTER TABLE session_execution_profile_revision ADD CONSTRAINT session_execution_profile_revision_approval_policy_check
  CHECK(approval_policy IN ('on-request','untrusted','never'));

-- Historical Sessions may keep their original policy and continue to settle. New
-- Session identity rows, including direct SQL inserts, must use one full policy.
CREATE FUNCTION require_full_runtime_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sandbox<>'danger-full-access' OR NEW.approval_policy<>'never' THEN
    RAISE EXCEPTION 'new runtime Session requires the full-access execution policy' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_session_full_policy BEFORE INSERT ON runtime_session
  FOR EACH ROW EXECUTE FUNCTION require_full_runtime_session();

-- The latest delegation validator was defined by 022. Admit the new tuple while
-- retaining byte-for-byte validation of historical immutable bindings.
CREATE OR REPLACE FUNCTION valid_delegation_snapshot(g jsonb, decided_at jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR NOT coalesce(g ?& ARRAY[
    'id','revision','projectId','goalId','loopId','existingRoleIds','cognitionRoleIds','newRoleAllocation','firstTaskId',
    'actorId','authorizationScopeId','decisionActorIds','allowedChoices','cwd','model','sandbox',
    'networkAccess','approvalPolicy','expiresAtUtc'],false) OR
    g - ARRAY['id','revision','projectId','goalId','loopId','existingRoleIds','cognitionRoleIds','newRoleAllocation','firstTaskId',
      'actorId','authorizationScopeId','decisionActorIds','allowedChoices','cwd','model','sandbox',
      'networkAccess','approvalPolicy','expiresAtUtc'] <> '{}'::jsonb THEN RETURN false; END IF;
  IF jsonb_typeof(g->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(g->'revision') IS DISTINCT FROM 'number' OR
    jsonb_typeof(g->'projectId') IS DISTINCT FROM 'string' OR jsonb_typeof(g->'goalId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(g->'loopId') IS DISTINCT FROM 'string' OR jsonb_typeof(g->'firstTaskId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(g->'existingRoleIds') IS DISTINCT FROM 'array' OR
    jsonb_typeof(g->'cognitionRoleIds') IS DISTINCT FROM 'array' OR
    jsonb_typeof(g->'decisionActorIds') IS DISTINCT FROM 'array' OR
    jsonb_typeof(g->'allowedChoices') IS DISTINCT FROM 'array' OR
    jsonb_typeof(g->'actorId') IS DISTINCT FROM 'string' OR length(g->>'actorId') NOT BETWEEN 1 AND 100 OR
    jsonb_typeof(g->'authorizationScopeId') IS DISTINCT FROM 'string' OR
    length(g->>'authorizationScopeId') NOT BETWEEN 1 AND 4000 OR
    jsonb_typeof(g->'cwd') IS DISTINCT FROM 'string' OR length(g->>'cwd') NOT BETWEEN 1 AND 1024 OR
    left(g->>'cwd',1)<>'/' OR jsonb_typeof(g->'model') IS DISTINCT FROM 'string' OR
    length(g->>'model') NOT BETWEEN 1 AND 100 OR
    jsonb_typeof(g->'sandbox') IS DISTINCT FROM 'string' OR g->>'sandbox' NOT IN ('read-only','workspace-write','danger-full-access') OR
    jsonb_typeof(g->'networkAccess') IS DISTINCT FROM 'boolean' OR
    jsonb_typeof(g->'approvalPolicy') IS DISTINCT FROM 'string' OR
    g->>'approvalPolicy' NOT IN ('on-request','untrusted','never') OR
    ((g->>'sandbox'='danger-full-access' OR g->>'approvalPolicy'='never') AND
      (g->>'sandbox'<>'danger-full-access' OR g->>'approvalPolicy'<>'never' OR g->'networkAccess'<>'true'::jsonb)) OR
    NOT valid_new_role_allocation(g->'newRoleAllocation') OR
    jsonb_array_length(g->'existingRoleIds')>20 OR jsonb_array_length(g->'cognitionRoleIds')>1 OR
    jsonb_array_length(g->'decisionActorIds')>20 OR
    (jsonb_array_length(g->'decisionActorIds')=0 AND jsonb_array_length(g->'cognitionRoleIds')=0) OR
    jsonb_array_length(g->'allowedChoices') NOT BETWEEN 1 AND 3 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(g->'existingRoleIds') x WHERE jsonb_typeof(x)<>'string' OR
      x #>> '{}' !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$') OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(g->'cognitionRoleIds') x WHERE jsonb_typeof(x)<>'string' OR
      length(x #>> '{}') NOT BETWEEN 1 AND 4000) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(g->'decisionActorIds') x WHERE jsonb_typeof(x)<>'string' OR
      length(x #>> '{}') NOT BETWEEN 1 AND 100) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(g->'allowedChoices') x WHERE jsonb_typeof(x)<>'string' OR
      x #>> '{}' NOT IN ('same-role-instance','temporary-assignment','new-role')) OR
    NOT finite_utc_instant(g->'expiresAtUtc') OR NOT finite_utc_instant(decided_at) THEN RETURN false; END IF;
  RETURN (g->>'expiresAtUtc')::timestamptz > (decided_at #>> '{}')::timestamptz;
END $$;

CREATE OR REPLACE FUNCTION protect_runtime_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile record; prior record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'runtime record cannot be deleted' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='runtime_session' THEN
    IF NEW.model IS DISTINCT FROM OLD.model OR NEW.sandbox<>OLD.sandbox OR NEW.approval_policy<>OLD.approval_policy THEN
      SELECT h.activation_state,p.* INTO profile FROM session_execution_profile h
        JOIN session_execution_profile_revision p ON p.project_id=h.project_id AND p.session_id=h.session_id
          AND p.revision_id=h.revision_id WHERE h.project_id=NEW.project_id AND h.session_id=NEW.session_id;
      SELECT * INTO prior FROM session_execution_profile_revision
        WHERE project_id=OLD.project_id AND session_id=OLD.session_id AND revision_id=profile.previous_revision_id;
      IF profile IS NULL OR prior IS NULL OR profile.activation_state<>'pending' OR profile.provenance<>'revised'
        OR profile.sandbox<>'danger-full-access' OR profile.approval_policy<>'never'
        OR profile.model IS DISTINCT FROM NEW.model OR profile.sandbox<>NEW.sandbox OR profile.approval_policy<>NEW.approval_policy
        OR prior.model IS DISTINCT FROM OLD.model OR prior.sandbox<>OLD.sandbox OR prior.approval_policy<>OLD.approval_policy
        OR profile.version<>prior.version+1 THEN
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
