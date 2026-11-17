import type { Occurrence, ScheduleDefinition, ScheduleRevision } from "@evoloop/contracts/scheduling";
import type { ScheduleDispatchLogPage, ScheduleDispatchPolicy } from "@evoloop/contracts/schedule-dispatch";
import { request, requestNullable } from "../../shared/api";

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
    // Read-only: how the schedule hands its Task over (null: no policy registered, so the Leader default) and what was decided for each trigger, oldest first.
    dispatchPolicy: (scheduleId: string) => requestNullable<ScheduleDispatchPolicy>(token, `${base}/${key(scheduleId)}/dispatch`, 15000),
    dispatches: (scheduleId: string, cursor?: string) => request<ScheduleDispatchLogPage>(token, `${base}/${key(scheduleId)}/dispatches?limit=100${cursor ? `&cursor=${key(cursor)}` : ""}`, 15000),
  };
}
