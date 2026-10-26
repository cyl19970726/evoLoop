import type { SessionActivityPage, SessionChanges, SessionDirectory, SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionProfileRecord, TaskSessionAssignment, SessionAssignmentPage } from "@evoloop/contracts/session-assignments";
import type { SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import type { ObservationMetadata } from "@evoloop/contracts/session-work";
import { request, requestNullable } from "../api";

const part = encodeURIComponent;
const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
};

export function sessionClient(token: string, projectId: string) {
  const base = `/api/projects/${part(projectId)}`;
  const get = <T>(path: string, signal?: AbortSignal) => request<T>(token, path, 15000, { signal });
  return {
    directory: (options: { cursor?: string; search?: string; membership?: string } = {}, signal?: AbortSignal) =>
      get<SessionDirectory>(`${base}/session-work?${query({ limit: 50, ...options })}`, signal),
    snapshot: (key: string, signal?: AbortSignal) => get<SessionSnapshot>(`${base}/session-work/${part(key)}`, signal),
    changes: (cursor: string, key?: string, signal?: AbortSignal) =>
      get<SessionChanges>(`${base}/session-work/changes?${query({ cursor, limit: 100, key })}`, signal),
    activities: (key: string, cursor?: string, signal?: AbortSignal) =>
      get<SessionActivityPage>(`${base}/session-work/${part(key)}/activities?${query({ limit: 50, cursor, importance: "all" })}`, signal),
    profile: (key: string, signal?: AbortSignal) => get<SessionProfileRecord | null>(`${base}/session-work/${part(key)}/profile`, signal),
    assignment: (taskId: string, signal?: AbortSignal) => requestNullable<TaskSessionAssignment>(token, `${base}/tasks/${part(taskId)}/assignment`, 15000, signal),
    assignmentHistory: (taskId: string, cursor?: string, signal?: AbortSignal) =>
      get<SessionAssignmentPage<TaskSessionAssignment>>(`${base}/tasks/${part(taskId)}/assignment/history?${query({ limit: 50, cursor })}`, signal),
    messages: (key: string, cursor?: string, signal?: AbortSignal) =>
      get<{ items: SessionMessageRecord[]; nextCursor: string | null; metadata: ObservationMetadata }>(`${base}/session-work/${part(key)}/messages?${query({ limit: 50, cursor })}`, signal),
    message: (id: string, signal?: AbortSignal) => get<{ message: SessionMessageRecord; processing: SessionMessageProcessing | null; metadata: ObservationMetadata }>(`${base}/session-messages/${part(id)}`, signal),
  };
}
