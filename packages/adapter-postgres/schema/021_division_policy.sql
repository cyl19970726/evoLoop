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
