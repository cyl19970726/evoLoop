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
  const seriesZone = first.series ? timing.data?.timezone ?? null : null;
  if (!found && !seriesZone) return first;
  return revisionOrigin(revision, { schedule: found ? { title: found.revision.template.title, timezone: found.revision.timezone } : null, seriesZone });
}
