import type { PoolClient } from "pg";
import type { OrchestrationSourceFact } from "@evoloop/contracts/orchestration";

/** Read only an occurrence created by the original schedule transaction and fixed to this Loop. */
export async function scheduledSourceFacts(db: PoolClient, projectId: string, options: {
  eventId?: string | undefined; loopId?: string | undefined; afterUtc?: string | undefined; afterId?: string | null | undefined;
  cursorUtc?: string | undefined; cursorId?: string | undefined; limit?: number | undefined;
  historicalClosure?: boolean | undefined;
}): Promise<OrchestrationSourceFact[]> {
  if (options.historicalClosure && (!options.eventId || !options.loopId))
    throw new Error("Historical schedule closure requires an exact event and Loop");
  const result = await db.query(`SELECT e.event_id,e.created_at,o.schedule_id,o.schedule_revision_id,o.planned_at_utc,
      o.task_id,o.operation_id,j.actor_id,created.revision_id AS task_revision_id,
      p.stage_id, r.task_template->'managedTarget'->>'loopId' AS target_loop_id
    FROM outbox_event e
    JOIN schedule_occurrence o ON o.project_id=e.project_id AND o.operation_id=e.operation_id
      AND o.task_id=e.entity_id AND o.state='created' AND o.observed_at_utc=e.created_at
    JOIN schedule_revision r ON r.project_id=o.project_id AND r.schedule_id=o.schedule_id
      AND r.revision_id=o.schedule_revision_id
    CROSS JOIN LATERAL (SELECT o.project_id::text || ':' || o.schedule_id::text || ':' ||
      to_char(o.planned_at_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurrence_key) key
    CROSS JOIN LATERAL (SELECT
      encode(sha256(convert_to('schedule-operation:' || key.occurrence_key,'UTF8')),'hex') AS operation_hex,
      encode(sha256(convert_to('schedule-task:' || key.occurrence_key,'UTF8')),'hex') AS task_hex,
      encode(sha256(convert_to('schedule-task-revision:' || key.occurrence_key,'UTF8')),'hex') AS revision_hex,
      encode(sha256(convert_to('schedule-outbox:' || key.occurrence_key,'UTF8')),'hex') AS event_hex) stable
    JOIN operation_journal j ON j.project_id=e.project_id AND j.operation_id=e.operation_id
      AND j.command_type='schedule.occurrence' AND j.result->>'status'='applied'
      AND j.result->>'entityId'=e.entity_id::text AND j.result->>'version'='1'
      AND j.actor_id=('schedule:' || (r.authorization_scope->>'roleId'))
      AND j.command_hash=encode(sha256(convert_to(key.occurrence_key,'UTF8')),'hex')
    JOIN task t ON t.project_id=e.project_id AND t.task_id=e.entity_id
    JOIN task_revision created ON created.project_id=t.project_id AND created.task_id=t.task_id
      AND created.version=1 AND created.state='todo' AND created.owner=r.task_template->>'owner'
      AND created.actor_id=j.actor_id
    JOIN task_proposal p ON p.project_id=created.project_id AND p.task_id=created.task_id
      AND p.task_revision_id=created.revision_id
    JOIN project_stage s ON s.project_id=p.project_id AND s.stage_id=p.stage_id
    JOIN orchestration_loop l ON l.project_id=e.project_id
      AND l.loop_id::text=r.task_template->'managedTarget'->>'loopId'
    WHERE e.project_id=$1 AND e.kind='schedule.task.todo' AND e.version=1
      AND e.effect_key='schedule:' || o.schedule_id::text || ':' ||
        to_char(o.planned_at_utc AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      AND e.operation_id::text=(substr(stable.operation_hex,1,8)||'-'||substr(stable.operation_hex,9,4)||'-5'||
        substr(stable.operation_hex,14,3)||'-a'||substr(stable.operation_hex,18,3)||'-'||substr(stable.operation_hex,21,12))
      AND e.entity_id::text=(substr(stable.task_hex,1,8)||'-'||substr(stable.task_hex,9,4)||'-5'||
        substr(stable.task_hex,14,3)||'-a'||substr(stable.task_hex,18,3)||'-'||substr(stable.task_hex,21,12))
      AND created.revision_id::text=(substr(stable.revision_hex,1,8)||'-'||substr(stable.revision_hex,9,4)||'-5'||
        substr(stable.revision_hex,14,3)||'-a'||substr(stable.revision_hex,18,3)||'-'||substr(stable.revision_hex,21,12))
      AND e.event_id::text=(substr(stable.event_hex,1,8)||'-'||substr(stable.event_hex,9,4)||'-5'||
        substr(stable.event_hex,14,3)||'-a'||substr(stable.event_hex,18,3)||'-'||substr(stable.event_hex,21,12))
      AND r.task_template->'managedTarget'->>'stageId'=p.stage_id::text
      AND l.data->>'stageId'=p.stage_id::text AND l.data->>'goalId'=s.goal_id::text
      AND r.task_template->>'owner'=r.authorization_scope->>'roleId'
      AND ($9::boolean OR (l.data->'allowedBusinessRoleIds') ? (r.task_template->>'owner'))
      AND ($2::uuid IS NULL OR e.event_id=$2)
      AND ($3::uuid IS NULL OR l.loop_id=$3)
      AND ($4::timestamptz IS NULL OR e.created_at>$4::timestamptz OR
        (e.created_at=$4::timestamptz AND ($5::uuid IS NULL OR e.event_id>$5::uuid)))
      AND ($6::timestamptz IS NULL OR (e.created_at,e.event_id)>($6::timestamptz,$7::uuid))
    ORDER BY e.created_at,e.event_id LIMIT $8`, [
    projectId, options.eventId ?? null, options.loopId ?? null,
    options.afterUtc ?? null, options.afterId ?? null,
    options.cursorUtc ?? null, options.cursorId ?? null, options.limit ?? 1,
    options.historicalClosure === true,
  ]);
  return result.rows.map(row => ({
    projectId, id: row.event_id, createdAtUtc: new Date(row.created_at).toISOString(),
    kind: "schedule.task.todo", subjectId: row.task_id, subjectVersion: 1,
    sourceLoopId: row.target_loop_id, originDispatchId: null,
    operationId: row.operation_id, sourceActorId: row.actor_id,
    observationId: null, deliveryId: null, observationResult: null,
    scheduleId: row.schedule_id, scheduleRevisionId: row.schedule_revision_id,
    plannedAtUtc: new Date(row.planned_at_utc).toISOString(),
    scheduleTargetLoopId: row.target_loop_id, scheduleTargetStageId: row.stage_id,
    scheduleTaskRevisionId: row.task_revision_id,
  }));
}
