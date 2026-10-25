import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import type { WorkTaskStatus } from "../workflow/workStatusPresentation";
import type { TaskLoopContext } from "./client";

const inFlight = new Set(["requested", "dispatching", "running", "unknown"]);

export type TaskLoopAssociation =
  | { kind: "current" | "recent"; loopId: string; runId: string | null }
  | { kind: "unresolved"; reason: string };

/** Only a formal Task dispatch can establish the Task's Loop; an active Run must also match. */
export function taskLoopAssociation(
  status: WorkTaskStatus | null, contexts: TaskLoopContext[], runs: RuntimeRunRecord[] | null,
  hasMoreContexts: boolean,
): TaskLoopAssociation {
  if (!status) return { kind: "unresolved", reason: "任务的正式派发状态尚未读回" };
  if (!status.dispatchId) return { kind: "unresolved", reason: "任务尚无可核对的正式派发" };
  if (hasMoreContexts) return { kind: "unresolved", reason: "关联循环仍有分页未读取，尚不能确认唯一对应" };
  const matches = contexts.filter(item => item.dispatchIds.includes(status.dispatchId!));
  if (matches.length !== 1) return { kind: "unresolved", reason: matches.length > 1
    ? "同一派发关联多个循环，需核对来源" : "正式派发未匹配已读回循环" };
  const loopId = matches[0]!.loopId;
  if (runs === null) return { kind: "unresolved", reason: "运行记录尚未读回，不能确认当前循环" };
  if (runs.some(run => run.taskId !== status.taskId))
    return { kind: "unresolved", reason: "运行记录不属于当前任务，不能关联循环" };
  const active = runs.filter(run => inFlight.has(run.state));
  if (active.length > 1) return { kind: "unresolved", reason: "任务有多个在途运行，不能确定唯一当前循环" };
  if (active.length === 1 && (active[0]!.id !== status.runId || active[0]!.state !== status.runState))
    return { kind: "unresolved", reason: "在途运行与正式派发状态未对应，需重新核对" };
  if (active.length === 1) return { kind: "current", loopId, runId: active[0]!.id };
  if (inFlight.has(status.runState ?? ""))
    return { kind: "unresolved", reason: "正式派发标记在途，但运行记录尚未对应" };
  if (status.runId && !runs.some(run => run.id === status.runId))
    return { kind: "unresolved", reason: "正式派发的运行未在任务运行记录中读回" };
  return { kind: "recent", loopId, runId: status.runId };
}

export function selectedTaskLoop(manualLoopId: string | null, association: TaskLoopAssociation,
  loadedLoopIds: string[]): string | null {
  if (manualLoopId && loadedLoopIds.includes(manualLoopId)) return manualLoopId;
  return association.kind === "unresolved" || !loadedLoopIds.includes(association.loopId) ? null : association.loopId;
}
