import type { Goal, Stage, TaskDetail } from "@evoloop/contracts";
import type { OrchestrationDispatch, OrchestrationEvent, OrchestrationInbox, OrchestrationLoop, OrchestrationSubmission, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import { ApiError, request } from "../api";

export interface OrchestrationStatus { state?: string; running?: boolean; busy?: boolean; faults?: Array<string | {loopId: string; dispatchId?: string; code: string}>; lastError?: string | null }
export interface TaskLoopContext { loopId: string; sourceEventIds: string[]; dispatchIds: string[]; parentDispatchIds: string[] }
export interface ResultPage<T> { items: T[]; nextCursor: string | null }
export type LoopPart = "inbox" | "dispatches" | "submissions" | "events";
export type LoopPartItem = {
  inbox: OrchestrationInbox; dispatches: OrchestrationDispatch; submissions: OrchestrationSubmission; events: OrchestrationEvent;
};

function checkedPage<T>(value: unknown): ResultPage<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(0, "自动循环列表响应不完整；未将首批记录视为全部。");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || page.nextCursor !== null && typeof page.nextCursor !== "string")
    throw new ApiError(0, "自动循环分页状态无法核实；未将首批记录视为全部。");
  return { items: page.items as T[], nextCursor: page.nextCursor as string | null };
}

export function mergePage<T extends { id: string }>(previous: ResultPage<T>, next: ResultPage<T>): ResultPage<T> {
  const byId = new Map(previous.items.map(item => [item.id, item]));
  for (const item of next.items) byId.set(item.id, item);
  return { items: [...byId.values()], nextCursor: next.nextCursor };
}

export function orchestrationClient(token: string, projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/orchestration`;
  const get = <T>(path: string) => request<T>(token, base + path, 15000);
  const page = <T>(path: string, cursor?: string) => get<unknown>(`${path}?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`).then(checkedPage<T>);
  const client = {
    status: async (): Promise<OrchestrationStatus> => {
      try { return await get<OrchestrationStatus>("/status"); }
      catch (cause) { if (cause instanceof ApiError && cause.status === 404) return { state: "disabled" }; throw cause; }
    },
    loops: (cursor?: string) => page<OrchestrationLoop>("/loops", cursor),
    loop: (loopId: string) => get<OrchestrationLoop>(`/loops/${encodeURIComponent(loopId)}`),
    goal: (goalId: string) => request<Goal>(token, `/api/projects/${encodeURIComponent(projectId)}/goals/${encodeURIComponent(goalId)}`, 15000),
    stage: (stageId: string) => request<Stage>(token, `/api/projects/${encodeURIComponent(projectId)}/stages/${encodeURIComponent(stageId)}`, 15000),
    taskRevisions: (taskId: string) => request<Array<{revision:{id:string;version:number}}>>(token,
      `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/revisions`, 15000),
    taskContext: (taskId: string, cursor?: string) => page<TaskLoopContext>(`/tasks/${encodeURIComponent(taskId)}/context`, cursor),
    tasks: (loopId: string, cursor?: string) => page<TaskDetail>(`/loops/${encodeURIComponent(loopId)}/tasks`, cursor),
    decision: (decisionId: string) => get<OrchestrationWorkerDecision>(`/decisions/${encodeURIComponent(decisionId)}`),
    part: <K extends LoopPart>(loopId: string, kind: K, cursor?: string) =>
      page<LoopPartItem[K]>(`/loops/${encodeURIComponent(loopId)}/${kind}`, cursor),
  };
  return {
    ...client,
    overview: async () => {
      const status = await client.status();
      try { return { status, loops: await client.loops() }; }
      catch (cause) {
        if (status.state === "disabled" && cause instanceof ApiError && cause.status === 404)
          return { status, loops: { items: [], nextCursor: null } as ResultPage<OrchestrationLoop> };
        throw cause;
      }
    },
  };
}
