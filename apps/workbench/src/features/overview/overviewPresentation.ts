// Words for the overview's right column and work items. Codes become Chinese here; free server text (a hold
// reason, a waiting reason) is summarised in one general line and its original goes to the full-identifier layer.
import type { QueueHoldCode } from "@evoloop/contracts/queues";

const holdLabels: Record<QueueHoldCode, string> = {
  not_adopted: "队列尚未采纳", task_changed: "任务修订已变化", task_unavailable: "任务不可承接",
  dependency: "依赖尚未放行", session_unready: "智能体尚未就绪", binding_changed: "职责绑定已变化",
  grant_revoked: "授权已撤销", occupied: "智能体已占用", run_in_flight: "运行仍在途",
  unknown: "运行结果未知", awaiting_acceptance: "等待消费者使用与验收", budget_exhausted: "尝试达到上限",
  manual_review: "等待人工复核",
};

/** Why a queue entry is held. The free-text hold reason never joins this line. */
export function holdText(code: QueueHoldCode | null | undefined): string {
  return (code && holdLabels[code]) || "队列已暂停，原因待核对";
}

const runStates: Record<string, string> = {
  requested: "执行已请求，尚未开始", dispatching: "执行正在派发", running: "正在执行", unknown: "上次执行结果未知",
};

/** A run that has not settled, in words; null when there is none. */
export function unsettledRunText(state: string | null | undefined): string | null {
  if (!state) return null;
  return runStates[state] ?? "执行状态待核对";
}

/** The server's waiting reason is free text naming the previous task by ID; the line only says that there is one. */
export const timingWaitText = "有未满足的等待条件";

/** What 约定执行 says when no scheduled task is listed. Only a complete, current read may say there are none. */
export function scheduledEmptyText(read: { hasSnapshot: boolean; stale: boolean; timingReadFailed: number; timingScanLimited: boolean }): string {
  if (!read.hasSnapshot) return "约定执行任务待读回。";
  if (read.timingReadFailed > 0) return `${read.timingReadFailed} 项任务的执行时间未能读回，无法判断是否有约定执行的任务。`;
  if (read.stale) return "上次读回时没有约定执行的任务；当前待核对。";
  if (read.timingScanLimited) return "已核对的前 60 项未结束任务中没有约定执行；其余任务未核对。";
  return "已读范围内没有约定执行的未结束任务。";
}
