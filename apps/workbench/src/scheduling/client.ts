import type { Occurrence, ScheduleDefinition, ScheduleRevision } from "@evoloop/contracts/scheduling";
import { request } from "../api";

const key = (value: string) => encodeURIComponent(value);
export interface SchedulingGrant { projectId: string; actorId: string; scopeId: string; roleId: string }
export interface SchedulingStatus {
  state: "stopped" | "idle" | "running" | "disabled" | "unavailable" | "no-authority" | "error";
  lastTickAt: string | null; lastError: string | null; lastCreated: number; grants: SchedulingGrant[];
}
export function schedulingClient(token: string, projectId: string) {
  const base = `/api/projects/${key(projectId)}/schedules`;
  return {
    status: () => request<SchedulingStatus>(token, `/api/projects/${key(projectId)}/scheduling/status`, 15000),
    list: () => request<ScheduleDefinition[]>(token, base, 15000),
    revisions: (scheduleId: string) => request<ScheduleRevision[]>(token, `${base}/${key(scheduleId)}/revisions`, 15000),
    occurrences: (scheduleId: string) => request<Occurrence[]>(token, `${base}/${key(scheduleId)}/occurrences`, 15000),
  };
}
