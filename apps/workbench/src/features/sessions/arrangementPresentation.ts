// Words for 统筹安排. The server's `nextAction` is written for agents working through the CLI and names internal
// records; people see a next step per phase instead (`workNextStep` in shared/workPresentation.ts, shared with
// the overview). Read states decide what the page may conclude: a read that is still running or failed never becomes
// "free", "no conflict" or a count of 0, and a failed reread that keeps the previous answer on screen says so.
import type { ObservedTask } from "@evoloop/contracts/session-observation";
import type { FreeCapacity } from "./arrangementModel";

const directoryRelations: Record<ObservedTask["relation"], string> = {
  accepted: "已接手",
  assigned: "已分派，待确认接手",
  claimed: "已从排队中领取",
  run: "有执行记录关联",
  "role-responsibility": "属于其职责，未确认接手",
};

/** The agent directory's own record of current work: only used while Tasks cannot be read, and labelled as such. */
export function directoryWorkCaption(relation: ObservedTask["relation"]): string {
  return `智能体目录记录：${directoryRelations[relation] ?? "关系待核对"} · 阶段未读取`;
}

/** loading: no answer yet; failed: no answer at all; stale: a reread failed and the previous answer is kept. */
export type ReadState = "loading" | "failed" | "stale" | "ready";

export function readStateOf(query: { data?: unknown; error?: unknown }): ReadState {
  if (query.data === undefined) return query.error ? "failed" : "loading";
  return query.error ? "stale" : "ready";
}

export const staleLabel = "上次读回，当前待核对";

/** Why nobody can be called free yet, or null when the records are complete enough to judge. */
export function capacityUnknownReason(tasks: ReadState, tasksComplete: boolean, queues: ReadState): string | null {
  if (tasks === "loading") return "正在读取任务，暂不能判断谁空闲。";
  if (tasks === "failed") return "任务暂不可读取，无法判断谁空闲。";
  if (!tasksComplete) return "任务没有读全，无法确认谁空闲。";
  if (queues === "loading") return "正在读取队列，暂不能判断谁空闲。";
  if (queues === "failed") return "队列暂不可读取，无法确认谁空闲。";
  return null;
}

/** The line under 空闲与过载 when nobody is free. Only says "everyone has work" when every agent's work is on record. */
export function noFreeAgentText(capacity: FreeCapacity): string {
  if (!capacity.others) return "统筹以外还没有其他智能体。";
  if (capacity.unknown === capacity.others) return "各智能体的占用都待核对，暂不能确认谁空闲。";
  if (capacity.unknown) return "没有可确认空闲的智能体。";
  return capacity.others === 1 ? "没有空闲的智能体：统筹以外唯一的智能体有在做、已分派或排队的工作。"
    : "没有空闲的智能体：统筹以外的智能体都有在做、已分派或排队的工作。";
}

/** The line under 冲突与风险 when no risk is listed. */
export function noConflictText(tasks: ReadState, tasksComplete: boolean, error: string): string {
  if (tasks === "loading") return "正在读取任务，暂不能判断冲突。";
  if (tasks === "failed") return `任务暂不可读取，无法判断冲突：${error}`;
  if (!tasksComplete) return "已读取的任务里没有看出冲突；其余任务还没核对。";
  return "记录里没有看出冲突。总览文档里写的冲突以文档为准。";
}
