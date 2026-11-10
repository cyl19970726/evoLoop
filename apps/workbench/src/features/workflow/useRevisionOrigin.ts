// A task revision's author and reason as the page says them (revisionPresentation), with the name of the schedule
// that generated it read on demand (useRevisionOrigin). The schedules list is read only for a revision a schedule generated; until it is
// back, or when it cannot be read, the line says “由日程生成” and the identifiers stay in 完整标识.
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import { request } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { date } from "../../shared/ui/shared";
import { revisionOrigin, type RevisionOrigin } from "./revisionPresentation";

export function useRevisionOrigin(projectId: string, revision: { actorId?: string | null; reason?: string | null }): RevisionOrigin {
  const first = revisionOrigin(revision, null, date);
  const scheduleId = first.scheduleId;
  const schedules = useProjectQuery(projectId, ["schedules", "names"], signal =>
    request<ScheduleDefinition[]>("", `/api/projects/${encodeURIComponent(projectId)}/schedules`, 15000, { signal }),
  { enabled: !!scheduleId, retry: false });
  if (!scheduleId) return first;
  const found = Array.isArray(schedules.data) ? schedules.data.find(item => item.id === scheduleId && item.projectId === projectId) : undefined;
  return found ? revisionOrigin(revision, found.revision.template.title, date) : first;
}
