import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";

/** A bounded, project-authorized companion to one already paged Task list. */
export async function readWorkStatuses(pool: Pool, workflow: Pick<WorkflowService, "getProject">,
  principal: Principal, projectId: string, taskIds: string[]) {
  await workflow.getProject(principal, projectId);
  if (!taskIds.length) return {items: []};
  const result = await pool.query(`SELECT t.task_id,
      d.dispatch_id,d.data->>'purpose' AS purpose,d.data->>'state' AS dispatch_state,
      d.data->>'outcome' AS outcome,d.data->>'runtimeRunId' AS run_id,
      l.state AS loop_state,g.outcome AS goal_outcome,s.deliverable AS stage_deliverable,
      COALESCE(oe.kind,ob.kind) AS source_kind,
      COALESCE(origin.task_id,ob.entity_id) AS source_task_id,source_task.title AS source_task_title,
      r.state AS run_state,wd.data->>'kind' AS decision_kind,wd.data->>'reason' AS decision_reason,
      p.use_required,delivery.delivery_id,delivery.technical_result,
      observation.result AS observation_result,observation.observer_kind,
      closure.closure_id IS NOT NULL AS has_closure,
      (t.state='in_progress' AND delivery.task_revision_id=t.current_revision_id
        AND delivery.technical_result='passed' AND p.use_required
        AND consumer_use.result='used' AND closure.closure_id IS NULL) AS ready_for_acceptance
    FROM task t
    LEFT JOIN LATERAL (SELECT x.* FROM orchestration_dispatch x
      WHERE x.project_id=t.project_id AND x.task_id=t.task_id
      ORDER BY (x.data->>'createdAtUtc')::timestamptz DESC,x.dispatch_id DESC LIMIT 1) d ON true
    LEFT JOIN orchestration_loop l ON l.project_id=t.project_id AND l.loop_id=d.loop_id
    LEFT JOIN project_goal g ON g.project_id=l.project_id AND g.goal_id=(l.data->>'goalId')::uuid
    LEFT JOIN project_stage s ON s.project_id=l.project_id AND s.stage_id=(l.data->>'stageId')::uuid
    LEFT JOIN orchestration_event oe ON oe.project_id=t.project_id AND oe.loop_id=d.loop_id
      AND oe.event_id=(d.data->>'sourceEventId')::uuid
    LEFT JOIN outbox_event ob ON ob.project_id=t.project_id
      AND ob.event_id=(d.data->>'sourceEventId')::uuid
    LEFT JOIN orchestration_dispatch origin ON origin.project_id=oe.project_id
      AND origin.dispatch_id=oe.entity_id AND oe.kind IN ('worker.outcome','dispatch.gap')
    LEFT JOIN task source_task ON source_task.project_id=t.project_id
      AND source_task.task_id=COALESCE(origin.task_id,ob.entity_id)
    LEFT JOIN runtime_run r ON r.project_id=t.project_id
      AND r.run_id=(d.data->>'runtimeRunId')::uuid
    LEFT JOIN orchestration_decision wd ON wd.project_id=t.project_id AND wd.dispatch_id=d.dispatch_id
    LEFT JOIN LATERAL (SELECT proposal.use_required,proposal.consumer FROM task_proposal proposal
      JOIN task_revision revision ON revision.project_id=proposal.project_id
        AND revision.task_id=proposal.task_id AND revision.revision_id=proposal.task_revision_id
      WHERE proposal.project_id=t.project_id AND proposal.task_id=t.task_id
      ORDER BY revision.version DESC LIMIT 1) p ON true
    LEFT JOIN LATERAL (SELECT x.delivery_id,x.task_revision_id,x.technical_result FROM delivery x
      WHERE x.project_id=t.project_id AND x.task_id=t.task_id
      ORDER BY x.created_at DESC,x.delivery_id DESC LIMIT 1) delivery ON true
    LEFT JOIN LATERAL (SELECT x.result,x.observer_kind FROM consumer_observation x
      WHERE x.project_id=t.project_id AND x.delivery_id=delivery.delivery_id
      ORDER BY x.sequence DESC LIMIT 1) observation ON true
    LEFT JOIN LATERAL (SELECT x.result FROM consumer_observation x
      WHERE x.project_id=t.project_id AND x.delivery_id=delivery.delivery_id AND x.observer=p.consumer
      ORDER BY x.sequence DESC LIMIT 1) consumer_use ON true
    LEFT JOIN LATERAL (SELECT x.closure_id FROM task_closure x
      WHERE x.project_id=t.project_id AND x.task_id=t.task_id LIMIT 1) closure ON true
    WHERE t.project_id=$1 AND t.task_id=ANY($2::uuid[])`,[projectId,taskIds]);
  return {items:result.rows.map(row => ({taskId:row.task_id as string,
    cognition:row.purpose === "cognition",dispatchId:row.dispatch_id as string | null,
    dispatchState:row.dispatch_state as string | null,outcome:row.outcome as string | null,
    runId:row.run_id as string | null,runState:row.run_state as string | null,
    loopState:row.loop_state as string | null,goalOutcome:row.goal_outcome as string | null,
    stageDeliverable:row.stage_deliverable as string | null,sourceKind:row.source_kind as string | null,
    sourceTaskId:row.source_task_id as string | null,sourceTaskTitle:row.source_task_title as string | null,
    decisionKind:row.decision_kind as string | null,decisionReason:row.decision_reason as string | null,
    useRequired:row.use_required as boolean | null,deliveryId:row.delivery_id as string | null,
    technicalResult:row.technical_result as string | null,
    observationResult:row.observation_result as string | null,
    observerKind:row.observer_kind as string | null,hasClosure:row.has_closure as boolean,
    readyForAcceptance:row.ready_for_acceptance === true}))};
}
