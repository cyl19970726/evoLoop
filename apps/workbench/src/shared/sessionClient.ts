import type { SessionActivityPage, SessionChanges, SessionDirectory } from "@evoloop/contracts/session-observation";
import type { SessionProfileRecord, TaskSessionAssignment, SessionAssignmentPage } from "@evoloop/contracts/session-assignments";
import type { SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import type { ObservationMetadata } from "@evoloop/contracts/session-work";
import type { RuntimeWorkTrace } from "@evoloop/contracts/runtime";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { WorkspaceEntry } from "@evoloop/contracts/session-timeline";
import type { SessionRecoveryView } from "@evoloop/contracts/session-recovery";
import type { SessionLine, SessionLineEntry } from "@evoloop/contracts/session-line";
import { request, requestNullable } from "./api";
import { checkedLiveRead, checkedSessionSnapshot, checkedTimelinePage } from "./sessionShapes";

const part = encodeURIComponent;
export type SessionConversationItem = SessionMessageRecord & {
  contentTruncated?: boolean;
  responseTruncated?: boolean;
  processing?: SessionMessageProcessing | null;
};
const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
};

export function sessionClient(token: string, projectId: string) {
  const base = `/api/projects/${part(projectId)}`;
  const get = <T>(path: string, signal?: AbortSignal) => request<T>(token, path, 15000, { signal });
  return {
    directory: (options: { limit?: number; cursor?: string; search?: string; membership?: string } = {}, signal?: AbortSignal) =>
      get<SessionDirectory>(`${base}/session-work?${query({ limit: 50, ...options })}`, signal),
    snapshot: async (key: string, signal?: AbortSignal) => checkedSessionSnapshot(await get<unknown>(`${base}/session-work/${part(key)}`, signal)),
    recovery: (sessionId: string, signal?: AbortSignal) => get<SessionRecoveryView>(`${base}/runtime/sessions/${part(sessionId)}/recovery`, signal),
    runtimeSessions: (signal?:AbortSignal) => get<RuntimeSessionRecord[]>(`${base}/runtime/sessions`,signal),
    models: (signal?:AbortSignal) => get<{status:'available'|'empty'|'unavailable';models:string[];
      options:Array<{model:string;supportedReasoningEfforts:string[];defaultReasoningEffort:string|null;displayName?:string|null}>;
      error:string|null}>(`${base}/runtime/models`,signal),
    changes: (cursor: string, key?: string, signal?: AbortSignal) =>
      get<SessionChanges>(`${base}/session-work/changes?${query({ cursor, limit: 100, key })}`, signal),
    activities: (key: string, cursor?: string, signal?: AbortSignal) =>
      get<SessionActivityPage>(`${base}/session-work/${part(key)}/activities?${query({ limit: 50, cursor, importance: "all" })}`, signal),
    /** The business steps of the Tasks this Session accepted, newest first, from `since` on (Task 13518ac6). */
    businessNodes: (key: string, since: string | null, cursor?: string, signal?: AbortSignal) =>
      get<SessionActivityPage>(`${base}/session-work/${part(key)}/activities?${query({ limit: 50, cursor, business: "1", since: since ?? undefined })}`, signal),
    profile: (key: string, signal?: AbortSignal) => get<SessionProfileRecord | null>(`${base}/session-work/${part(key)}/profile`, signal),
    assignment: (taskId: string, signal?: AbortSignal) => requestNullable<TaskSessionAssignment>(token, `${base}/tasks/${part(taskId)}/assignment`, 15000, signal),
    /** Every Session line of the project (DEC-045) with the entries still waiting or starting, in line order. */
    sessionLines: (signal?: AbortSignal) => get<{ lines: Array<SessionLine & { entries: SessionLineEntry[] }> }>(`${base}/session-lines`, signal),
    assignmentHistory: (taskId: string, cursor?: string, signal?: AbortSignal) =>
      get<SessionAssignmentPage<TaskSessionAssignment>>(`${base}/tasks/${part(taskId)}/assignment/history?${query({ limit: 50, cursor })}`, signal),
    messages: (key: string, cursor?: string, signal?: AbortSignal) =>
      get<{ items: SessionConversationItem[]; nextCursor: string | null; metadata: ObservationMetadata }>(`${base}/session-work/${part(key)}/messages?${query({ limit: 50, cursor })}`, signal),
    timeline: (key: string, options: { cursor?: string; messagesCursor?: string; limit?: number; source?: "native" | "messages" | "both" } = {}, signal?: AbortSignal) =>
      get<unknown>(`${base}/session-work/${part(key)}/timeline?${query({ limit: 25, ...options })}`, signal).then(checkedTimelinePage),
    timelineItem: (key: string, turnId: string, itemId: string, signal?: AbortSignal) =>
      get<WorkspaceEntry>(`${base}/session-work/${part(key)}/timeline/items/${part(itemId)}?${query({ turnId })}`, signal),
    timelineUpdates: (key: string, after?: string, signal?: AbortSignal) =>
      request<unknown>(token, `${base}/session-work/${part(key)}/timeline/updates?${query({ after })}`, 25000, { signal }).then(checkedLiveRead),
    message: (id: string, signal?: AbortSignal) => get<{ message: SessionMessageRecord; processing: SessionMessageProcessing | null; metadata: ObservationMetadata }>(`${base}/session-messages/${part(id)}`, signal),
    trace: (runId: string, cursor?: string, signal?: AbortSignal) =>
      get<RuntimeWorkTrace>(`${base}/runtime/runs/${part(runId)}/trace?${query({ cursor })}`, signal),
  };
}
