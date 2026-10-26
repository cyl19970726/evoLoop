import type { RuntimeRecordEvent, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { request } from "../api";
export interface ExecutionGrant { projectId: string; actorId: string; roleId: string; authorizationScope: string; cwd: string; sandbox: "read-only" | "workspace-write" }
export interface RuntimeStatus { available: boolean; error: string | null; allowedCwds: string[]; grants: ExecutionGrant[] }
export interface NativeResult { messages: string[]; source: "owned-native-history"; finalPhaseConfirmed: boolean; observedAt: string }
export function runtimeClient(token: string, projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/runtime`;
  const get = <T>(path: string) => request<T>(token, base + path, 15000);
  return {
    status: () => get<RuntimeStatus>(""), sessions: () => get<RuntimeSessionRecord[]>("/sessions"),
    session: (sessionId: string) => get<RuntimeSessionRecord>(`/sessions/${encodeURIComponent(sessionId)}`),
    runs: (taskId?: string) => get<RuntimeRunRecord[]>(`/runs${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`),
    run: (runId: string) => get<RuntimeRunRecord>(`/runs/${encodeURIComponent(runId)}`),
    events: (runId: string) => get<RuntimeRecordEvent[]>(`/runs/${encodeURIComponent(runId)}/events`),
    history: (sessionId: string) => get<{turns:{id:string;status:string;messages:{type:string;text:string}[]}[];truncated:boolean;observedAt:string}>(`/sessions/${encodeURIComponent(sessionId)}/history`),
    sessionEvents: (sessionId: string) => get<RuntimeRecordEvent[]>(`/sessions/${encodeURIComponent(sessionId)}/events`),
    result: (runId: string) => get<NativeResult>(`/runs/${encodeURIComponent(runId)}/result`),
    reconcile: (runId: string, expectedVersion: number, reason: string) => request<RuntimeRunRecord>(token, `${base}/runs/${encodeURIComponent(runId)}/reconcile`, 120000, { method: "POST", body: JSON.stringify({ expectedVersion, reason }) }),
    recover: () => request<{ available: boolean }>(token, `${base}/recover`, 30000, { method: "POST" }),
  };
}
