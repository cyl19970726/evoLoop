-- A waiting cognition Task can close after the controller's later Division continuation
-- only when the original decision, formal transfer, and receiving worker receipt agree.
-- This adds no business rows and leaves the ordinary pre-decision child branch intact.
CREATE FUNCTION verified_division_closure_handoff(p_project uuid,p_child uuid,p_waiting uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM orchestration_dispatch child
    JOIN orchestration_loop loop ON loop.project_id=child.project_id AND loop.loop_id=child.loop_id
    JOIN runtime_role_binding b ON b.project_id=child.project_id AND b.binding_id=child.binding_id
      AND b.loop_id=child.loop_id AND b.role_id::text=child.data->>'recipientRoleId'
      AND b.first_task_id=child.task_id AND b.parent_dispatch_id::text=child.data->>'parentDispatchId'
      AND b.source_event_id::text=child.data->>'sourceEventId'
      AND child.data->>'bindingId'=b.binding_id::text
      AND valid_runtime_role_binding_snapshot(b.data)
    JOIN task business_task ON business_task.project_id=child.project_id AND business_task.task_id=child.task_id
      AND business_task.state<>'cancelled'
    JOIN loop_policy_revision policy ON policy.project_id=child.project_id AND policy.policy_id=child.policy_revision_id
      AND policy.loop_id=child.loop_id AND policy.binding_by_role->>b.role_id::text=b.binding_id::text
      AND policy.decision_operation_id=b.decision_operation_id
      AND child.data->>'policyRevisionId'=policy.policy_id::text
    JOIN orchestration_dispatch parent ON parent.project_id=child.project_id
      AND parent.dispatch_id=b.parent_dispatch_id AND parent.loop_id=child.loop_id
      AND parent.data->>'sourceEventId'=child.data->>'sourceEventId'
      AND parent.data->>'recipientRoleId'=loop.data->>'cognitiveRoleId'
      AND parent.data->>'purpose'='cognition' AND parent.state='completed' AND parent.data->>'outcome'='waiting'
    JOIN orchestration_decision waiting ON waiting.project_id=child.project_id
      AND waiting.decision_id=p_waiting AND waiting.dispatch_id=parent.dispatch_id
      AND waiting.data->>'kind'='waiting' AND waiting.data->>'divisionDecisionId'=b.binding_id::text
      AND waiting.data->>'runId'=parent.data->>'runtimeRunId'
      AND waiting.data->>'actorId'=b.data->>'decidedBy'
    JOIN runtime_run parent_run ON parent_run.project_id=parent.project_id
      AND parent_run.run_id=(parent.data->>'runtimeRunId')::uuid
      AND parent_run.task_id=parent.task_id AND parent_run.state='completed'
    JOIN orchestration_inbox inbox ON inbox.project_id=child.project_id AND inbox.inbox_id=child.inbox_id
      AND inbox.loop_id=child.loop_id AND inbox.source_event_id=b.source_event_id
      AND inbox.purpose='next_action' AND inbox.state='disposed'
      AND inbox.data->>'disposition'='dispatch' AND inbox.data->>'dispatchId'=child.dispatch_id::text
      AND inbox.data->>'evidenceRef'='division:'||b.binding_id::text
    JOIN orchestration_event decided ON decided.project_id=b.project_id AND decided.loop_id=b.loop_id
      AND decided.entity_type='binding' AND decided.entity_id=b.binding_id
      AND decided.kind='division.decided' AND decided.operation_id=b.decision_operation_id
      AND decided.actor_id=b.data->>'decidedBy'
      AND decided.detail->>'parentDispatchId'=parent.dispatch_id::text
      AND decided.detail->>'sourceEventId'=b.source_event_id::text
      AND decided.detail->>'firstTaskId'=b.first_task_id::text
      AND decided.detail->>'policyRevisionId'=policy.policy_id::text
    JOIN orchestration_operation decided_op ON decided_op.project_id=decided.project_id
      AND decided_op.operation_id=decided.operation_id AND decided_op.actor_id=decided.actor_id
      AND decided_op.result->>'entityType'='binding' AND decided_op.result->>'entityId'=b.binding_id::text
    JOIN orchestration_event consumed ON consumed.project_id=child.project_id AND consumed.loop_id=child.loop_id
      AND consumed.entity_type='dispatch' AND consumed.entity_id=child.dispatch_id
      AND consumed.kind='division.consumed' AND consumed.actor_id=child.data->>'requestedBy'
      AND consumed.detail->>'bindingId'=b.binding_id::text
      AND consumed.detail->>'waitingDecisionId'=waiting.decision_id::text
      AND consumed.detail->>'parentDispatchId'=parent.dispatch_id::text
      AND consumed.detail->>'sourceEventId'=b.source_event_id::text
      AND consumed.detail->>'firstTaskId'=child.task_id::text
      AND consumed.detail->>'policyRevisionId'=policy.policy_id::text
    JOIN orchestration_operation consumed_op ON consumed_op.project_id=consumed.project_id
      AND consumed_op.operation_id=consumed.operation_id AND consumed_op.actor_id=consumed.actor_id
      AND consumed_op.result->>'entityType'='dispatch'
      AND consumed_op.result->>'entityId'=child.dispatch_id::text AND consumed_op.result->>'version'='1'
    JOIN orchestration_event transfer ON transfer.project_id=child.project_id AND transfer.loop_id=child.loop_id
      AND transfer.entity_type='dispatch' AND transfer.entity_id=child.dispatch_id
      AND transfer.kind='division.transferConfirmed' AND transfer.actor_id=consumed.actor_id
      AND transfer.detail->>'bindingId'=b.binding_id::text
      AND transfer.detail->>'observedTaskVersion'=b.first_task_version::text
      AND transfer.detail->>'transferredTaskVersion'=child.task_version::text
    JOIN orchestration_operation transfer_op ON transfer_op.project_id=transfer.project_id
      AND transfer_op.operation_id=transfer.operation_id AND transfer_op.actor_id=transfer.actor_id
      AND transfer_op.result->>'entityType'='dispatch'
      AND transfer_op.result->>'entityId'=child.dispatch_id::text AND transfer_op.result->>'version'='2'
    JOIN task_revision before_transfer ON before_transfer.project_id=child.project_id
      AND before_transfer.task_id=child.task_id AND before_transfer.version=b.first_task_version
      AND before_transfer.owner<>b.role_id::text
    JOIN task_revision after_transfer ON after_transfer.project_id=child.project_id
      AND after_transfer.task_id=child.task_id AND after_transfer.version=child.task_version
      AND after_transfer.version=before_transfer.version+1 AND after_transfer.owner=b.role_id::text
      AND after_transfer.actor_id=consumed.actor_id
      AND after_transfer.reason='division-transfer:'||b.binding_id::text
      AND transfer.detail->>'revisionId'=after_transfer.revision_id::text
    JOIN operation_journal task_op ON task_op.project_id=child.project_id
      AND task_op.operation_id=(transfer.detail->>'transferOperationId')::uuid
      AND task_op.actor_id=consumed.actor_id AND task_op.command_type='task.update'
      AND task_op.result->>'status'='applied'
      AND task_op.result->>'revisionId'=after_transfer.revision_id::text
      AND task_op.result->>'version'=after_transfer.version::text
    JOIN runtime_run receiving ON receiving.project_id=child.project_id
      AND receiving.run_id=(child.data->>'runtimeRunId')::uuid
      AND receiving.task_id=child.task_id
      AND receiving.state IN ('running','completed','failed','interrupted')
      AND receiving.native_turn_id IS NOT NULL
    JOIN document_revision material ON material.project_id=b.project_id
      AND material.document_id=b.document_id AND material.revision_id=b.document_revision_id
      AND material.content_hash=b.document_content_hash
    JOIN orchestration_event ack ON ack.project_id=child.project_id AND ack.loop_id=child.loop_id
      AND ack.entity_type='dispatch' AND ack.entity_id=child.dispatch_id
      AND ack.kind='division.handoffAcknowledged' AND ack.actor_id LIKE 'worker-%'
      AND ack.detail->>'runId'=receiving.run_id::text
      AND ack.detail->>'taskRevisionId'=receiving.task_revision_id::text
      AND ack.detail->>'documentRevisionId'=material.revision_id::text
      AND ack.detail->>'documentContentHash'=material.content_hash
      AND EXISTS (SELECT 1 FROM runtime_record_event bound_turn
        WHERE bound_turn.project_id=receiving.project_id AND bound_turn.run_id=receiving.run_id
          AND bound_turn.kind='run.bound' AND bound_turn.native_turn_id=receiving.native_turn_id
          AND ((ack.detail->>'nativeTurnId'=receiving.native_turn_id
                AND bound_turn.created_at<=ack.created_at_utc)
            OR (NOT (ack.detail ? 'nativeTurnId') AND bound_turn.created_at<ack.created_at_utc)))
    JOIN orchestration_operation ack_op ON ack_op.project_id=ack.project_id
      AND ack_op.operation_id=ack.operation_id AND ack_op.actor_id=ack.actor_id
      AND ack_op.created_at_utc=ack.created_at_utc
      AND ack_op.result->>'entityType'='dispatch' AND ack_op.result->>'entityId'=child.dispatch_id::text
      AND ack_op.command_hash=encode(sha256(convert_to(
        '{"dispatchId":'||to_json(ack.entity_id::text)::text||
        ',"documentContentHash":'||to_json(ack.detail->>'documentContentHash')::text||
        ',"documentRevisionId":'||to_json(ack.detail->>'documentRevisionId')::text||
        ',"operationId":'||to_json(ack.operation_id::text)::text||
        ',"projectId":'||to_json(ack.project_id::text)::text||
        ',"reason":'||to_json(ack.detail->>'declaration')::text||
        ',"runId":'||to_json(ack.detail->>'runId')::text||
        ',"taskRevisionId":'||to_json(ack.detail->>'taskRevisionId')::text||
        ',"type":"division.ackHandoff"}', 'UTF8')),'hex')
    WHERE child.project_id=p_project AND child.dispatch_id=p_child AND child.binding_id IS NOT NULL
      AND child.data->>'purpose'='division' AND child.state IN ('accepted','completed')
      AND child.data->>'authorizationScopeId'=b.data->>'authorizationScopeId'
      AND child.data->>'requestedBy'=b.data->>'actorId'
      AND child.task_version=b.first_task_version+1
      AND b.template_id::text=b.data->'template'->>'id'
      AND b.template_revision::text=b.data->'template'->>'revision'
      AND b.template_hash=b.data->'template'->>'hash')=1
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
        OR (child.data->>'purpose'<>'division' AND child.data->>'requestedBy'<>signed.data->>'actorId')
        OR child.data->>'recipientRoleId'=(SELECT data->>'cognitiveRoleId' FROM orchestration_loop
          WHERE project_id=NEW.project_id AND loop_id=dispatched.loop_id)
        OR NOT division_historical_role_allowed(NEW.project_id,child.dispatch_id,child.data->>'recipientRoleId')
        OR child_inbox.inbox_id IS NULL OR child_inbox.loop_id<>dispatched.loop_id
        OR child_inbox.source_event_id<>NEW.source_event_id OR child_inbox.purpose<>'next_action'
        OR child_inbox.state<>'disposed' OR child_inbox.data->>'disposition'<>'dispatch'
        OR child_inbox.data->>'dispatchId'<>child.dispatch_id::text
        OR EXISTS(SELECT 1 FROM task WHERE project_id=NEW.project_id AND task_id=child.task_id AND state='cancelled')
        OR child.data->>'purpose' IS NULL
        OR (child.data->>'purpose'='division' AND NOT verified_division_closure_handoff(
          NEW.project_id,child.dispatch_id,signed.decision_id))
        OR (child.data->>'purpose'<>'division' AND NOT EXISTS(SELECT 1 FROM orchestration_event request_event JOIN orchestration_operation request_op
          ON request_op.project_id=request_event.project_id AND request_op.operation_id=request_event.operation_id
          AND request_op.actor_id=request_event.actor_id AND request_op.result->>'entityId'=child.dispatch_id::text
          WHERE request_event.project_id=NEW.project_id AND request_event.loop_id=dispatched.loop_id
            AND request_event.entity_id=child.dispatch_id AND request_event.kind='dispatch.requested'
            AND request_event.actor_id=signed.data->>'actorId'
            AND request_event.created_at_utc<=(signed.data->>'createdAtUtc')::timestamptz)) THEN
        RAISE EXCEPTION 'waiting closure requires an earlier signed child business dispatch' USING ERRCODE='23514'; END IF;
    END IF;
  ELSIF NEW.waiting_inbox_id IS NOT NULL OR NEW.handoff_dispatch_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-waiting closure cannot cite a waiting handoff' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
