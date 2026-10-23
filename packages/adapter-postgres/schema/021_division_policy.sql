-- Candidate migration number 021. Reorder on integration if another branch claims it.
CREATE TABLE loop_policy_revision (
  project_id uuid NOT NULL, policy_id uuid NOT NULL, loop_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0), previous_policy_id uuid,
  allowed_business_role_ids jsonb NOT NULL CHECK(jsonb_typeof(allowed_business_role_ids)='array'),
  binding_by_role jsonb NOT NULL CHECK(jsonb_typeof(binding_by_role)='object'),
  changed_binding_id uuid, decision_operation_id uuid, actor_id text NOT NULL, created_at_utc timestamptz NOT NULL,
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(project_id,policy_id), UNIQUE(project_id,loop_id,version), UNIQUE(project_id,loop_id,policy_id),
  FOREIGN KEY(project_id,loop_id) REFERENCES orchestration_loop(project_id,loop_id),
  FOREIGN KEY(project_id,loop_id,previous_policy_id) REFERENCES loop_policy_revision(project_id,loop_id,policy_id),
  FOREIGN KEY(project_id,decision_operation_id) REFERENCES orchestration_operation(project_id,operation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE runtime_role_binding (
  project_id uuid NOT NULL, binding_id uuid NOT NULL, loop_id uuid NOT NULL, goal_id uuid NOT NULL,
  role_id uuid NOT NULL, choice text NOT NULL CHECK(choice IN ('same-role-instance','temporary-assignment','new-role')),
  template_id uuid NOT NULL, template_revision integer NOT NULL CHECK(template_revision>0), template_hash text NOT NULL CHECK(template_hash ~ '^[a-f0-9]{64}$'),
  decision_operation_id uuid NOT NULL, source_event_id uuid NOT NULL, parent_dispatch_id uuid NOT NULL,
  first_task_id uuid NOT NULL, first_task_version integer NOT NULL CHECK(first_task_version>0),
  document_id uuid NOT NULL, document_revision_id uuid NOT NULL, document_content_hash text NOT NULL CHECK(document_content_hash ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(project_id,binding_id), UNIQUE(project_id,decision_operation_id),
  FOREIGN KEY(project_id,loop_id) REFERENCES orchestration_loop(project_id,loop_id),
  FOREIGN KEY(project_id,goal_id) REFERENCES project_goal(project_id,goal_id),
  FOREIGN KEY(project_id,role_id) REFERENCES role_definition(project_id,role_id),
  FOREIGN KEY(project_id,parent_dispatch_id) REFERENCES orchestration_dispatch(project_id,dispatch_id),
  FOREIGN KEY(project_id,first_task_id) REFERENCES task(project_id,task_id),
  FOREIGN KEY(project_id,document_id,document_revision_id) REFERENCES document_revision(project_id,document_id,revision_id),
  FOREIGN KEY(project_id,decision_operation_id) REFERENCES orchestration_operation(project_id,operation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX runtime_role_binding_one_new_role_per_template
  ON runtime_role_binding(project_id,template_id,template_revision) WHERE choice='new-role';
ALTER TABLE loop_policy_revision ADD CONSTRAINT loop_policy_changed_binding_fk
  FOREIGN KEY(project_id,changed_binding_id) REFERENCES runtime_role_binding(project_id,binding_id);
ALTER TABLE orchestration_loop ADD COLUMN current_policy_revision_id uuid;
ALTER TABLE orchestration_dispatch ADD COLUMN policy_revision_id uuid;
ALTER TABLE orchestration_dispatch ADD COLUMN binding_id uuid;
INSERT INTO loop_policy_revision(project_id,policy_id,loop_id,version,previous_policy_id,allowed_business_role_ids,binding_by_role,changed_binding_id,decision_operation_id,actor_id,created_at_utc,data)
SELECT l.project_id,md5(l.project_id::text||l.loop_id::text||':legacy-policy')::uuid,l.loop_id,1,NULL,
  l.data->'allowedBusinessRoleIds','{}'::jsonb,NULL,NULL,l.data->>'enrolledBy',
  (l.data->>'createdAtUtc')::timestamptz,
  jsonb_build_object('projectId',l.project_id,'id',md5(l.project_id::text||l.loop_id::text||':legacy-policy')::uuid,
    'loopId',l.loop_id,'version',1,'previousId',NULL,'allowedBusinessRoleIds',l.data->'allowedBusinessRoleIds',
    'bindingByRole','{}'::jsonb,'changedBindingId',NULL,'decisionOperationId',NULL,'actorId',l.data->>'enrolledBy','createdAtUtc',l.data->>'createdAtUtc')
FROM orchestration_loop l;
UPDATE orchestration_loop l SET current_policy_revision_id=p.policy_id,
  data=jsonb_set(l.data,'{currentPolicyRevisionId}',to_jsonb(p.policy_id::text),true)
FROM loop_policy_revision p WHERE p.project_id=l.project_id AND p.loop_id=l.loop_id AND p.version=1;
UPDATE orchestration_dispatch d SET policy_revision_id=l.current_policy_revision_id,
  data=jsonb_set(jsonb_set(d.data,'{policyRevisionId}',to_jsonb(l.current_policy_revision_id::text),true),'{bindingId}','null'::jsonb,true)
FROM orchestration_loop l WHERE l.project_id=d.project_id AND l.loop_id=d.loop_id;
ALTER TABLE orchestration_loop ALTER COLUMN current_policy_revision_id SET NOT NULL;
ALTER TABLE orchestration_dispatch ALTER COLUMN policy_revision_id SET NOT NULL;
ALTER TABLE orchestration_loop ADD CONSTRAINT orchestration_loop_current_policy_fk
  FOREIGN KEY(project_id,loop_id,current_policy_revision_id) REFERENCES loop_policy_revision(project_id,loop_id,policy_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE orchestration_dispatch ADD CONSTRAINT orchestration_dispatch_policy_fk
  FOREIGN KEY(project_id,loop_id,policy_revision_id) REFERENCES loop_policy_revision(project_id,loop_id,policy_id);
ALTER TABLE orchestration_dispatch ADD CONSTRAINT orchestration_dispatch_binding_fk
  FOREIGN KEY(project_id,binding_id) REFERENCES runtime_role_binding(project_id,binding_id);
ALTER TABLE orchestration_event DROP CONSTRAINT orchestration_event_entity_type_check;
ALTER TABLE orchestration_event ADD CONSTRAINT orchestration_event_entity_type_check
  CHECK(entity_type IN ('loop','inbox','dispatch','submission','decision','binding'));
CREATE UNIQUE INDEX orchestration_division_decision_id ON orchestration_event(project_id,entity_id) WHERE kind='division.decided';
CREATE UNIQUE INDEX orchestration_division_source_task ON orchestration_event(project_id,loop_id,(detail->>'sourceEventId'),(detail->>'firstTaskId')) WHERE kind='division.decided';
CREATE UNIQUE INDEX orchestration_division_parent_intent ON orchestration_event(project_id,(detail->>'parentDispatchId')) WHERE kind='division.decided';
CREATE TRIGGER loop_policy_revision_immutable BEFORE UPDATE OR DELETE ON loop_policy_revision
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE TRIGGER runtime_role_binding_immutable BEFORE UPDATE OR DELETE ON runtime_role_binding
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_change();
CREATE FUNCTION validate_loop_policy_bindings() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry record; previous_policy loop_policy_revision%ROWTYPE;
  changed_role text; changed_operation uuid; initial_has_role boolean; expected_roles jsonb;
BEGIN
  IF NEW.version=1 THEN
    IF NEW.previous_policy_id IS NOT NULL OR NEW.changed_binding_id IS NOT NULL OR NEW.decision_operation_id IS NOT NULL
      OR NEW.binding_by_role<>'{}'::jsonb THEN
      RAISE EXCEPTION 'initial Loop policy must contain only static enrollment' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO previous_policy FROM loop_policy_revision
      WHERE project_id=NEW.project_id AND loop_id=NEW.loop_id AND policy_id=NEW.previous_policy_id;
    SELECT role_id::text,decision_operation_id INTO changed_role,changed_operation FROM runtime_role_binding
      WHERE project_id=NEW.project_id AND loop_id=NEW.loop_id AND binding_id=NEW.changed_binding_id;
    IF previous_policy.policy_id IS NULL OR NEW.version<>previous_policy.version+1 OR
      changed_role IS NULL OR NEW.decision_operation_id IS NULL THEN
      RAISE EXCEPTION 'Loop policy revision must continue a decision and binding' USING ERRCODE='23514'; END IF;
    SELECT allowed_business_role_ids ? changed_role INTO initial_has_role FROM loop_policy_revision
      WHERE project_id=NEW.project_id AND loop_id=NEW.loop_id AND version=1;
    IF previous_policy.binding_by_role ? changed_role THEN
      expected_roles := CASE WHEN initial_has_role THEN previous_policy.allowed_business_role_ids ELSE
        (SELECT coalesce(jsonb_agg(value),'[]'::jsonb) FROM jsonb_array_elements(previous_policy.allowed_business_role_ids) AS e(value)
          WHERE value #>> '{}' <> changed_role) END;
      IF previous_policy.binding_by_role->>changed_role<>NEW.changed_binding_id::text OR
        NEW.binding_by_role<>previous_policy.binding_by_role-changed_role OR
        NEW.allowed_business_role_ids<>expected_roles THEN
        RAISE EXCEPTION 'Loop policy revocation must remove exactly its current binding' USING ERRCODE='23514'; END IF;
    ELSE
      expected_roles := CASE WHEN previous_policy.allowed_business_role_ids ? changed_role THEN
        previous_policy.allowed_business_role_ids ELSE previous_policy.allowed_business_role_ids||to_jsonb(changed_role) END;
      IF NEW.decision_operation_id<>changed_operation OR
        NEW.binding_by_role<>jsonb_set(previous_policy.binding_by_role,ARRAY[changed_role],to_jsonb(NEW.changed_binding_id::text),true) OR
        NEW.allowed_business_role_ids<>expected_roles THEN
        RAISE EXCEPTION 'Loop policy decision must add exactly its signed binding' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  FOR entry IN SELECT key,value FROM jsonb_each_text(NEW.binding_by_role) LOOP
    IF NOT NEW.allowed_business_role_ids ? entry.key OR NOT EXISTS(
      SELECT 1 FROM runtime_role_binding b WHERE b.project_id=NEW.project_id AND b.loop_id=NEW.loop_id
        AND b.binding_id::text=entry.value AND b.role_id::text=entry.key) THEN
      RAISE EXCEPTION 'Loop policy binding map must cite matching immutable bindings' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER loop_policy_binding_validate BEFORE INSERT ON loop_policy_revision
  FOR EACH ROW EXECUTE FUNCTION validate_loop_policy_bindings();
-- The service inserts the event before its operation receipt, so provenance is
-- checked at commit. Readers consume data JSON; it must describe the same fact
-- as the indexed columns rather than a second, wider authority.
CREATE FUNCTION finite_utc_instant(value jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' OR
    value #>> '{}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?Z$' THEN
    RETURN false; END IF;
  RETURN isfinite((value #>> '{}')::timestamptz);
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN false;
END $$;
CREATE FUNCTION valid_delegation_snapshot(g jsonb, decided_at jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
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
    (g->'newRoleAllocation'<>'null'::jsonb AND g->'newRoleAllocation'<>
      '{"maxTotal":1,"requiredState":"trial"}'::jsonb) OR
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
CREATE FUNCTION valid_runtime_role_binding_snapshot(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE t jsonb := d->'template'; g jsonb := d->'grant'; r jsonb := d->'runtime';
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT coalesce(d ?& ARRAY[
      'projectId','id','loopId','goalId','roleId','choice','actorId','authorizationScopeId',
      'decisionOperationId','sourceEventId','parentDispatchId','firstTaskId','firstTaskVersion',
      'documentId','documentRevisionId','documentContentHash','template','grant','runtime',
      'decidedBy','createdAtUtc'],false) OR d - ARRAY[
      'projectId','id','loopId','goalId','roleId','choice','actorId','authorizationScopeId',
      'decisionOperationId','sourceEventId','parentDispatchId','firstTaskId','firstTaskVersion',
      'documentId','documentRevisionId','documentContentHash','template','grant','runtime',
      'decidedBy','createdAtUtc'] <> '{}'::jsonb THEN RETURN false; END IF;
  IF NOT valid_delegation_snapshot(g,d->'createdAtUtc') OR
    jsonb_typeof(t) IS DISTINCT FROM 'object' OR t - ARRAY['id','revision','hash'] <> '{}'::jsonb OR
    NOT coalesce(t ?& ARRAY['id','revision','hash'],false) OR
    jsonb_typeof(r) IS DISTINCT FROM 'object' OR r - ARRAY[
      'cwd','model','sandbox','networkAccess','approvalPolicy','expiresAtUtc'] <> '{}'::jsonb OR
    NOT coalesce(r ?& ARRAY['cwd','model','sandbox','networkAccess','approvalPolicy','expiresAtUtc'],false) THEN RETURN false; END IF;
  IF jsonb_typeof(t->'id') IS DISTINCT FROM 'string' OR
    jsonb_typeof(t->'revision') IS DISTINCT FROM 'number' OR
    jsonb_typeof(t->'hash') IS DISTINCT FROM 'string' OR t->>'hash' !~ '^[a-f0-9]{64}$' OR
    jsonb_typeof(d->'firstTaskVersion') IS DISTINCT FROM 'number' OR
    d->>'firstTaskVersion' !~ '^[1-9][0-9]*$' OR
    jsonb_typeof(d->'choice') IS DISTINCT FROM 'string' OR
    d->>'choice' NOT IN ('same-role-instance','temporary-assignment','new-role') OR
    jsonb_typeof(d->'actorId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(d->'authorizationScopeId') IS DISTINCT FROM 'string' OR
    jsonb_typeof(d->'decidedBy') IS DISTINCT FROM 'string' OR
    length(d->>'decidedBy') NOT BETWEEN 1 AND 100 OR
    jsonb_typeof(d->'documentContentHash') IS DISTINCT FROM 'string' OR
    d->>'documentContentHash' !~ '^[a-f0-9]{64}$' OR
    d->'actorId' IS DISTINCT FROM g->'actorId' OR
    d->'authorizationScopeId' IS DISTINCT FROM g->'authorizationScopeId' OR
    r IS DISTINCT FROM jsonb_build_object(
      'cwd',g->'cwd','model',g->'model','sandbox',g->'sandbox',
      'networkAccess',g->'networkAccess','approvalPolicy',g->'approvalPolicy',
      'expiresAtUtc',g->'expiresAtUtc') THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(d) AS x(key,value) WHERE key IN (
      'projectId','id','loopId','goalId','roleId','decisionOperationId','sourceEventId',
      'parentDispatchId','firstTaskId','documentId','documentRevisionId')
      AND (jsonb_typeof(value)<>'string' OR value #>> '{}' !~
        '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$')) THEN RETURN false; END IF;
  RETURN true;
END;
$$;
CREATE FUNCTION verify_division_binding() RETURNS trigger LANGUAGE plpgsql AS $$
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
    (CASE WHEN NEW.choice='new-role' THEN delegated_grant->'newRoleAllocation' IS DISTINCT FROM
        '{"maxTotal":1,"requiredState":"trial"}'::jsonb OR coalesce(delegated_grant->'existingRoleIds' ? NEW.role_id::text,false)
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
CREATE CONSTRAINT TRIGGER division_binding_provenance AFTER INSERT ON runtime_role_binding
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_division_binding();
CREATE FUNCTION verify_division_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior loop_policy_revision%ROWTYPE; expected_kind text; expected_version text;
BEGIN
  IF NEW.data IS DISTINCT FROM jsonb_build_object('projectId',NEW.project_id,'id',NEW.policy_id,
    'loopId',NEW.loop_id,'version',NEW.version,'previousId',NEW.previous_policy_id,
    'allowedBusinessRoleIds',NEW.allowed_business_role_ids,'bindingByRole',NEW.binding_by_role,
    'changedBindingId',NEW.changed_binding_id,'decisionOperationId',NEW.decision_operation_id,
    'actorId',NEW.actor_id,'createdAtUtc',NEW.data->'createdAtUtc') OR
    NEW.data->>'createdAtUtc' IS DISTINCT FROM to_char(NEW.created_at_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'Loop policy JSON differs from immutable columns' USING ERRCODE='23514'; END IF;
  IF NEW.version=1 THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM loop_policy_revision WHERE project_id=NEW.project_id AND policy_id=NEW.previous_policy_id;
  expected_kind := CASE WHEN prior.binding_by_role ? (SELECT role_id::text FROM runtime_role_binding
    WHERE project_id=NEW.project_id AND binding_id=NEW.changed_binding_id) THEN 'division.revoked' ELSE 'division.decided' END;
  expected_version := CASE WHEN expected_kind='division.revoked' THEN '2' ELSE '1' END;
  IF NOT EXISTS(SELECT 1 FROM orchestration_operation o WHERE o.project_id=NEW.project_id
      AND o.operation_id=NEW.decision_operation_id AND o.actor_id=NEW.actor_id
      AND o.result->>'entityType'='binding' AND o.result->>'entityId'=NEW.changed_binding_id::text
      AND o.result->>'version'=expected_version AND o.created_at_utc=NEW.created_at_utc) OR
    NOT EXISTS(SELECT 1 FROM orchestration_event e WHERE e.project_id=NEW.project_id AND e.loop_id=NEW.loop_id
      AND e.entity_type='binding' AND e.entity_id=NEW.changed_binding_id AND e.operation_id=NEW.decision_operation_id
      AND e.actor_id=NEW.actor_id AND e.kind=expected_kind AND e.detail->>'policyRevisionId'=NEW.policy_id::text
      AND e.created_at_utc=NEW.created_at_utc) THEN
    RAISE EXCEPTION 'Loop policy lacks matching signed division decision or revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER division_policy_provenance AFTER INSERT ON loop_policy_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_division_policy();
CREATE FUNCTION protect_dispatch_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data->>'policyRevisionId' IS DISTINCT FROM NEW.policy_revision_id::text OR
    NEW.data->'bindingId' IS DISTINCT FROM coalesce(to_jsonb(NEW.binding_id::text),'null'::jsonb) OR
    (TG_OP='UPDATE' AND (NEW.policy_revision_id IS DISTINCT FROM OLD.policy_revision_id OR
      NEW.binding_id IS DISTINCT FROM OLD.binding_id OR
      NEW.data->>'policyRevisionId' IS DISTINCT FROM OLD.data->>'policyRevisionId' OR
      NEW.data->'bindingId' IS DISTINCT FROM OLD.data->'bindingId')) THEN
    RAISE EXCEPTION 'Dispatch historical policy reference is immutable and consistent' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_policy_protect BEFORE INSERT OR UPDATE ON orchestration_dispatch
  FOR EACH ROW EXECUTE FUNCTION protect_dispatch_policy();
-- Historical child evidence refers to the policy pinned at request time.
CREATE OR REPLACE FUNCTION division_historical_role_allowed(p_project uuid,p_dispatch uuid,p_role text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM orchestration_dispatch d JOIN loop_policy_revision p
    ON p.project_id=d.project_id AND p.loop_id=d.loop_id AND p.policy_id=d.policy_revision_id
    WHERE d.project_id=p_project AND d.dispatch_id=p_dispatch AND p.allowed_business_role_ids ? p_role
      AND (NOT (p.binding_by_role ? p_role) OR d.binding_id::text=p.binding_by_role->>p_role
        OR EXISTS(SELECT 1 FROM loop_policy_revision initial WHERE initial.project_id=p.project_id
          AND initial.loop_id=p.loop_id AND initial.version=1 AND initial.allowed_business_role_ids ? p_role)))
$$;
CREATE OR REPLACE FUNCTION verify_cognitive_task_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE signed orchestration_decision%ROWTYPE; dispatched orchestration_dispatch%ROWTYPE;
  original_inbox orchestration_inbox%ROWTYPE; waited orchestration_inbox%ROWTYPE;
  fixed_run runtime_run%ROWTYPE; child orchestration_dispatch%ROWTYPE; child_inbox orchestration_inbox%ROWTYPE;
BEGIN
  IF NEW.decision_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO signed FROM orchestration_decision WHERE project_id=NEW.project_id AND decision_id=NEW.decision_id;
  SELECT * INTO dispatched FROM orchestration_dispatch WHERE project_id=NEW.project_id AND dispatch_id=signed.dispatch_id;
  SELECT * INTO original_inbox FROM orchestration_inbox WHERE project_id=NEW.project_id AND inbox_id=dispatched.inbox_id;
  SELECT * INTO fixed_run FROM runtime_run WHERE project_id=NEW.project_id AND run_id=(dispatched.data->>'runtimeRunId')::uuid;
  IF signed.decision_id IS NULL OR dispatched.dispatch_id IS NULL OR original_inbox.inbox_id IS NULL OR fixed_run.run_id IS NULL
    OR dispatched.task_id<>NEW.task_id OR dispatched.state<>'completed' OR dispatched.data->>'purpose'<>'cognition'
    OR dispatched.data->>'outcome' NOT IN ('no_action','waiting') OR signed.data->>'kind' NOT IN ('no_action','waiting','stop')
    OR signed.data->>'taskId'<>NEW.task_id::text OR signed.data->>'runId'<>fixed_run.run_id::text
    OR fixed_run.task_id<>NEW.task_id OR fixed_run.state NOT IN ('completed','failed','interrupted')
    OR original_inbox.inbox_id<>NEW.source_inbox_id OR original_inbox.source_event_id<>NEW.source_event_id THEN
    RAISE EXCEPTION 'cognitive closure must cite its settled decision and original source' USING ERRCODE='23514';
  END IF;
  IF signed.data->>'kind'='waiting' THEN
    IF (NEW.waiting_inbox_id IS NULL) = (NEW.handoff_dispatch_id IS NULL) THEN
      RAISE EXCEPTION 'waiting closure requires exactly one handoff' USING ERRCODE='23514'; END IF;
    IF NEW.waiting_inbox_id IS NOT NULL THEN
      SELECT * INTO waited FROM orchestration_inbox WHERE project_id=NEW.project_id AND inbox_id=NEW.waiting_inbox_id;
      IF waited.inbox_id IS NULL OR waited.loop_id<>dispatched.loop_id OR waited.source_event_id<>NEW.source_event_id
        OR waited.purpose<>'next_action' OR waited.state<>'disposed' OR waited.data->>'disposition'<>'waiting'
        OR NEW.source_task_id IS NULL OR NEW.source_task_id=NEW.task_id
        OR EXISTS(SELECT 1 FROM orchestration_dispatch source_dispatch WHERE source_dispatch.project_id=NEW.project_id
          AND source_dispatch.task_id=NEW.source_task_id AND source_dispatch.data->>'purpose'='cognition') THEN
        RAISE EXCEPTION 'waiting closure requires a discoverable same-source business Task' USING ERRCODE='23514'; END IF;
    ELSE
      SELECT * INTO child FROM orchestration_dispatch WHERE project_id=NEW.project_id AND dispatch_id=NEW.handoff_dispatch_id;
      SELECT * INTO child_inbox FROM orchestration_inbox WHERE project_id=NEW.project_id AND inbox_id=child.inbox_id;
      IF child.dispatch_id IS NULL OR child.task_id<>NEW.handoff_task_id OR child.task_id=NEW.task_id
        OR child.loop_id<>dispatched.loop_id OR child.data->>'parentDispatchId'<>dispatched.dispatch_id::text
        OR child.data->>'sourceEventId'<>NEW.source_event_id::text OR child.state='rejected'
        OR child.data->>'requestedBy'<>signed.data->>'actorId'
        OR child.data->>'recipientRoleId'=(SELECT data->>'cognitiveRoleId' FROM orchestration_loop
          WHERE project_id=NEW.project_id AND loop_id=dispatched.loop_id)
        OR NOT division_historical_role_allowed(NEW.project_id,child.dispatch_id,child.data->>'recipientRoleId')
        OR child_inbox.inbox_id IS NULL OR child_inbox.loop_id<>dispatched.loop_id
        OR child_inbox.source_event_id<>NEW.source_event_id OR child_inbox.purpose<>'next_action'
        OR child_inbox.state<>'disposed' OR child_inbox.data->>'disposition'<>'dispatch'
        OR child_inbox.data->>'dispatchId'<>child.dispatch_id::text
        OR EXISTS(SELECT 1 FROM task WHERE project_id=NEW.project_id AND task_id=child.task_id AND state='cancelled')
        OR NOT EXISTS(SELECT 1 FROM orchestration_event request_event JOIN orchestration_operation request_op
          ON request_op.project_id=request_event.project_id AND request_op.operation_id=request_event.operation_id
          AND request_op.actor_id=request_event.actor_id AND request_op.result->>'entityId'=child.dispatch_id::text
          WHERE request_event.project_id=NEW.project_id AND request_event.loop_id=dispatched.loop_id
            AND request_event.entity_id=child.dispatch_id AND request_event.kind='dispatch.requested'
            AND request_event.actor_id=signed.data->>'actorId'
            AND request_event.created_at_utc<=(signed.data->>'createdAtUtc')::timestamptz) THEN
        RAISE EXCEPTION 'waiting closure requires an earlier signed child business dispatch' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF NEW.waiting_inbox_id IS NOT NULL OR NEW.handoff_dispatch_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-waiting closure cannot cite a waiting handoff' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
