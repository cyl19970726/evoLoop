// A revision's author and reason as the page says them (revisionPresentation), with what the words need read on demand:
// the generating schedule's name and time zone (the schedules list, only for a revision a schedule generated) and a
// daily repetition's time zone (the task's timing, only for a revision a repetition generated). Until they are back,
// or when they cannot be read, the line says what it can without them and the identifiers stay in 完整标识.
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import { api, request } from "./api";
import { useProjectQuery } from "./query";
import { revisionOrigin, type RevisionOrigin } from "./revisionPresentation";

export function useRevisionOrigin(projectId: string, revision: { actorId?: string | null; reason?: string | null }, taskId?: string | null): RevisionOrigin {
  const first = revisionOrigin(revision);
  const scheduleId = first.scheduleId;
  const schedules = useProjectQuery(projectId, ["schedules", "names"], signal =>
    request<ScheduleDefinition[]>("", `/api/projects/${encodeURIComponent(projectId)}/schedules`, 15000, { signal }),
  { enabled: !!scheduleId, retry: false });
  // Same key as the task's 执行时间与重复 (TaskScheduleSection), so the two share one read.
  const timing = useProjectQuery(projectId, ["tasks", "timing", taskId], () => api().taskTiming(projectId, taskId!),
    { enabled: first.series && !!taskId, retry: false });
  const found = scheduleId && Array.isArray(schedules.data) ? schedules.data.find(item => item.id === scheduleId && item.projectId === projectId) : undefined;
  // Pages that show a revision without a task (a document's page, the side peek, the two-version comparison) cannot ask the task's timing: the
  // series the reason names is looked up in the project's timed tasks instead, which carry their own time zone.
  const byTask = !!taskId;
  const listed = useProjectQuery(projectId, ["task-timings", "zone", first.seriesId], async signal => {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const read = await api().taskTimings(projectId, cursor, signal);
      const hit = read.items.find(item => item.seriesId === first.seriesId);
      if (hit) return hit.timezone ?? null;
      if (!read.nextCursor) return null;
      cursor = read.nextCursor;
    }
    return null;
  }, { enabled: first.series && !byTask && !!first.seriesId, retry: false });
  const seriesZone = first.series ? (byTask ? timing.data?.timezone : listed.data) ?? null : null;
  if (!found && !seriesZone) return first;
  return revisionOrigin(revision, { schedule: found ? { title: found.revision.template.title, timezone: found.revision.timezone } : null, seriesZone });
}
