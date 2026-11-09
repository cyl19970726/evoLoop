import type { SessionMessageState } from "@evoloop/contracts/session-messages";
import type { NativeProgressView } from "./NativeSessionPanel";

const messageLabels: Record<SessionMessageState, string> = {
  queued: "待派发", processing: "处理中", replied: "已回复", completed_without_reply: "已完成无回复",
  failed: "失败", unknown: "结果未知", cancelled: "已取消", manual_pending: "待人工转交",
};

export function nativeExecutionLabel(progress: NativeProgressView | null, currentRead: boolean): string {
  if (!progress) return "原生执行状态未读到";
  if (!currentRead || progress.freshness === "stale") return "原生观察已过期，当前状态待核对";
  if (progress.status === "notLoaded") return "原生会话未加载";
  if (progress.status === "systemError") return "原生状态异常，待核对";
  if (progress.status === "idle" && progress.turn?.status === "inProgress")
    return "原生状态与 Turn 状态不一致，待核对";
  if (progress.turn?.status === "inProgress") return "原生宿主回报 Turn 进行中";
  if (progress.turn?.status === "completed") return "原生宿主回报 Turn 已结束";
  if (progress.turn?.status === "failed") return "原生宿主回报 Turn 失败";
  if (progress.turn?.status === "interrupted") return "原生宿主回报 Turn 已中断";
  if (progress.turn?.status === "unknown") return "原生宿主回报 Turn 状态未知";
  return progress.status === "idle" ? "原生宿主回报空闲" : "原生执行状态待核对";
}

export function messageStateLabel(state: SessionMessageState): string {
  return messageLabels[state];
}

/** Compare only the exact ordinary message bound to this Turn. Neither source settles the other. */
export function executionSourceNote(progress: NativeProgressView | null, currentRead: boolean,
  messageState: SessionMessageState | null): string {
  if (!progress || !currentRead || progress.freshness !== "live")
    return "当前原生状态未核实；保留已读记录，按原 Session、Turn 和消息核对。";
  if (progress.status === "idle" && progress.turn?.status === "inProgress")
    return "同一原生观察内状态冲突；按原 Turn 核对，不能据此重派或判定失败。";
  const turn = progress.turn;
  if (!turn || turn.source?.kind !== "message" || !messageState)
    return "原生连接 live 只表示连接与绑定仍匹配，不证明有新的有效工作；消息状态须按原记录核对。";
  const terminal = ["completed", "failed", "interrupted"].includes(turn.status);
  if (turn.status === "inProgress" && messageState !== "processing" && messageState !== "unknown" ||
    terminal && ["processing", "queued", "manual_pending"].includes(messageState))
    return "原生 Turn 与持久消息状态不一致；先核对原 Turn 和 processing，不能据单一来源重派或判定失败。";
  if (turn.status === "unknown" || messageState === "unknown")
    return "执行或消息结果未知；按原 Turn 和 processing 核对，不能据此重试或判定失败。";
  return "原生连接 live 只表示连接与绑定仍匹配；最近活动和消息状态另列，不能据此认定仍在有效推进。";
}
