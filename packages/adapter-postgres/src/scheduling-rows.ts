import type { ScheduleDefinition, ScheduleRevision, Occurrence } from "@evoloop/contracts/scheduling";
const iso = (value: Date | string): string => new Date(value).toISOString();
export function rowRevision(row: Record<string, any>): ScheduleRevision {
  // The revision JSON is immutable. Older rows used `goal`; project it as
  // Task content without changing the stored historical bytes.
  const { goal: legacyGoal, ...template } = row.task_template ?? {};
  return { projectId: row.project_id, scheduleId: row.schedule_id, id: row.revision_id, version: row.version, timezone: row.timezone, rule: row.rule, misfire: row.misfire, overlap: row.overlap_policy,
    template: { ...template, content: template.content ?? legacyGoal } as ScheduleRevision["template"],
    authorization: row.authorization_scope, actorId: row.actor_id, reason: row.reason, createdAtUtc: iso(row.created_at_utc) };
}
export function rowDefinition(row: Record<string, any>): ScheduleDefinition {
  return { projectId: row.project_id, id: row.schedule_id, version: row.head_version, currentRevisionId: row.current_revision_id, state: row.state, watermarkUtc: iso(row.watermark_utc), revision: rowRevision(row) };
}
export function rowOccurrence(row: Record<string, any>): Occurrence {
  return { projectId: row.project_id, scheduleId: row.schedule_id, revisionId: row.schedule_revision_id, plannedAtUtc: iso(row.planned_at_utc), observedAtUtc: iso(row.observed_at_utc), state: row.state, taskId: row.task_id, operationId: row.operation_id, reason: row.reason };
}
