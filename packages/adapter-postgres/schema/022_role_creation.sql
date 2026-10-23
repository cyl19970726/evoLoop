-- Accept legacy grants byte-for-byte and require explicit, bounded creation authority in new revisions.
CREATE FUNCTION valid_new_role_allocation(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value='null'::jsonb THEN true
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'object' OR
      value - ARRAY['maxTotal','requiredState','creation'] <> '{}'::jsonb OR
      value->'maxTotal' IS DISTINCT FROM '1'::jsonb OR
      value->'requiredState' IS DISTINCT FROM '"trial"'::jsonb THEN false
    WHEN NOT (value ? 'creation') OR value->'creation'='null'::jsonb THEN true
    ELSE jsonb_typeof(value->'creation')='object' AND
      (value->'creation') ?& ARRAY['allowProposeAndAcceptTrial','maxTrialDays'] AND
      (value->'creation') - ARRAY['allowProposeAndAcceptTrial','maxTrialDays']='{}'::jsonb AND
      value->'creation'->'allowProposeAndAcceptTrial'='true'::jsonb AND
      jsonb_typeof(value->'creation'->'maxTrialDays')='number' AND
      value->'creation'->>'maxTrialDays' ~ '^([1-9]|[1-8][0-9]|90)$'
    END;
$$;

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
    jsonb_typeof(g->'sandbox') IS DISTINCT FROM 'string' OR g->>'sandbox' NOT IN ('read-only','workspace-write') OR
    jsonb_typeof(g->'networkAccess') IS DISTINCT FROM 'boolean' OR
    jsonb_typeof(g->'approvalPolicy') IS DISTINCT FROM 'string' OR
    g->>'approvalPolicy' NOT IN ('on-request','untrusted') OR
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

CREATE OR REPLACE FUNCTION verify_division_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delegated_grant jsonb := NEW.data->'grant'; parent orchestration_dispatch%ROWTYPE;
  owner_loop orchestration_loop%ROWTYPE; observed_stage uuid; observed_goal uuid;
BEGIN
  IF NOT coalesce(valid_runtime_role_binding_snapshot(NEW.data),false) OR
    NEW.data IS DISTINCT FROM jsonb_build_object(
    'projectId',NEW.project_id,'id',NEW.binding_id,'loopId',NEW.loop_id,'goalId',NEW.goal_id,
    'roleId',NEW.role_id,'choice',NEW.choice,'actorId',delegated_grant->'actorId',
    'authorizationScopeId',delegated_grant->'authorizationScopeId','decisionOperationId',NEW.decision_operation_id,
    'sourceEventId',NEW.source_event_id,'parentDispatchId',NEW.parent_dispatch_id,
    'firstTaskId',NEW.first_task_id,'firstTaskVersion',NEW.first_task_version,
    'documentId',NEW.document_id,'documentRevisionId',NEW.document_revision_id,
    'documentContentHash',NEW.document_content_hash,
    'template',jsonb_build_object('id',NEW.template_id,'revision',NEW.template_revision,'hash',NEW.template_hash),
    'grant',delegated_grant,'runtime',NEW.data->'runtime','decidedBy',NEW.data->'decidedBy',
    'createdAtUtc',NEW.data->'createdAtUtc') OR
    NOT valid_delegation_snapshot(delegated_grant,NEW.data->'createdAtUtc') OR
    delegated_grant->>'id' IS DISTINCT FROM NEW.template_id::text OR
    delegated_grant->>'revision' IS DISTINCT FROM NEW.template_revision::text OR
    delegated_grant->>'projectId' IS DISTINCT FROM NEW.project_id::text OR
    delegated_grant->>'goalId' IS DISTINCT FROM NEW.goal_id::text OR
    delegated_grant->>'loopId' IS DISTINCT FROM NEW.loop_id::text OR
    delegated_grant->>'firstTaskId' IS DISTINCT FROM NEW.first_task_id::text OR
    delegated_grant->>'actorId' IS DISTINCT FROM NEW.data->>'actorId' OR
    delegated_grant->>'authorizationScopeId' IS DISTINCT FROM NEW.data->>'authorizationScopeId' OR
    NOT (coalesce(delegated_grant->'decisionActorIds' ? (NEW.data->>'decidedBy'),false) OR
      (NEW.data->>'decidedBy' LIKE 'worker-%' AND coalesce(delegated_grant->'cognitionRoleIds' ?
        (SELECT data->>'cognitiveRoleId' FROM orchestration_loop
          WHERE project_id=NEW.project_id AND loop_id=NEW.loop_id),false))) OR
    NOT coalesce(delegated_grant->'allowedChoices' ? NEW.choice,false) OR
    (CASE WHEN NEW.choice='new-role' THEN delegated_grant->'newRoleAllocation'='null'::jsonb OR
        NOT valid_new_role_allocation(delegated_grant->'newRoleAllocation') OR coalesce(delegated_grant->'existingRoleIds' ? NEW.role_id::text,false)
      ELSE NOT coalesce(delegated_grant->'existingRoleIds' ? NEW.role_id::text,false) END) OR
    NEW.data->'runtime' IS DISTINCT FROM jsonb_build_object(
      'cwd',delegated_grant->'cwd','model',delegated_grant->'model','sandbox',delegated_grant->'sandbox',
      'networkAccess',delegated_grant->'networkAccess','approvalPolicy',delegated_grant->'approvalPolicy',
      'expiresAtUtc',delegated_grant->'expiresAtUtc') THEN
    RAISE EXCEPTION 'division binding JSON and delegated template disagree' USING ERRCODE='23514'; END IF;
  SELECT * INTO owner_loop FROM orchestration_loop WHERE project_id=NEW.project_id AND loop_id=NEW.loop_id;
  SELECT * INTO parent FROM orchestration_dispatch WHERE project_id=NEW.project_id AND dispatch_id=NEW.parent_dispatch_id;
  SELECT p.stage_id,s.goal_id INTO observed_stage,observed_goal FROM task_revision r
    JOIN task_proposal p ON p.project_id=r.project_id AND p.task_id=r.task_id AND p.task_revision_id=r.revision_id
    JOIN project_stage s ON s.project_id=p.project_id AND s.stage_id=p.stage_id
    WHERE r.project_id=NEW.project_id AND r.task_id=NEW.first_task_id AND r.version<=NEW.first_task_version
    ORDER BY r.version DESC LIMIT 1;
  IF owner_loop.loop_id IS NULL OR owner_loop.data->>'goalId' IS DISTINCT FROM NEW.goal_id::text OR
    parent.dispatch_id IS NULL OR parent.loop_id<>NEW.loop_id OR parent.data->>'sourceEventId' IS DISTINCT FROM NEW.source_event_id::text OR
    parent.data->>'recipientRoleId' IS DISTINCT FROM owner_loop.data->>'cognitiveRoleId' OR
    parent.state<>'accepted' OR
    NOT EXISTS(SELECT 1 FROM runtime_run r WHERE r.project_id=NEW.project_id
      AND r.run_id::text=parent.data->>'runtimeRunId' AND r.task_id=parent.task_id
      AND r.state IN ('requested','dispatching','running')) OR
    NOT EXISTS(SELECT 1 FROM task_revision r WHERE r.project_id=NEW.project_id AND r.task_id=NEW.first_task_id
      AND r.version=NEW.first_task_version) OR observed_goal IS DISTINCT FROM NEW.goal_id OR
    (owner_loop.data->>'stageId' IS NOT NULL AND observed_stage::text IS DISTINCT FROM owner_loop.data->>'stageId') OR
    NOT EXISTS(SELECT 1 FROM role_definition d JOIN role_revision r ON r.project_id=d.project_id
      AND r.role_id=d.role_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=NEW.project_id AND d.role_id=NEW.role_id AND d.state IN ('trial','active')
        AND EXISTS(SELECT 1 FROM role_decision decision WHERE decision.project_id=d.project_id
          AND decision.role_id=d.role_id AND decision.decision='accept-trial')
        AND (NEW.choice<>'new-role' OR (d.state='trial' AND r.proposal->>'firstTaskId'=NEW.first_task_id::text))) OR
    (NEW.data->'grant'->>'expiresAtUtc')::timestamptz <= (NEW.data->>'createdAtUtc')::timestamptz OR
    NOT EXISTS(SELECT 1 FROM document_revision d WHERE d.project_id=NEW.project_id AND d.document_id=NEW.document_id
      AND d.revision_id=NEW.document_revision_id AND d.content_hash=NEW.document_content_hash) OR
    NOT EXISTS(SELECT 1 FROM orchestration_operation o WHERE o.project_id=NEW.project_id AND o.operation_id=NEW.decision_operation_id
      AND o.actor_id=NEW.data->>'decidedBy' AND o.result->>'entityType'='binding'
      AND o.result->>'entityId'=NEW.binding_id::text AND o.result->>'version'='1'
      AND o.created_at_utc=(NEW.data->>'createdAtUtc')::timestamptz) OR
    NOT EXISTS(SELECT 1 FROM orchestration_event e WHERE e.project_id=NEW.project_id AND e.loop_id=NEW.loop_id
      AND e.entity_type='binding' AND e.entity_id=NEW.binding_id AND e.operation_id=NEW.decision_operation_id
      AND e.actor_id=NEW.data->>'decidedBy' AND e.kind='division.decided'
      AND e.detail->>'choice'=NEW.choice AND e.detail->>'sourceEventId'=NEW.source_event_id::text
      AND e.detail->>'parentDispatchId'=NEW.parent_dispatch_id::text AND e.detail->>'firstTaskId'=NEW.first_task_id::text
      AND e.detail->>'firstTaskVersion'=NEW.first_task_version::text AND e.detail->>'documentId'=NEW.document_id::text
      AND e.detail->>'documentRevisionId'=NEW.document_revision_id::text
      AND e.detail->>'documentContentHash'=NEW.document_content_hash AND e.detail->>'roleId'=NEW.role_id::text
      AND e.detail->'template'=NEW.data->'template'
      AND e.created_at_utc=(NEW.data->>'createdAtUtc')::timestamptz) THEN
    RAISE EXCEPTION 'division binding lacks fixed Task, material, parent or signed decision' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
