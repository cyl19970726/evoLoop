import type { SessionActivity } from "@evoloop/contracts/session-observation";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A related project record is context for this Session, not necessarily its action. */
export function activityPresentation(item: SessionActivity, projectId: string): { sourceLabel: string; discussionHref: string | null } {
  const source = item.source;
  const evidence = source.kind === "discussion" ? "讨论记录"
    : source.kind === "task" ? "关联任务记录"
      : source.evidence === "independent-use" ? "独立使用观察"
        : source.evidence === "session-statement" ? "会话陈述" : "项目记录";
  const sourceLabel = `${evidence} · 登记者 ${item.actorId?.trim() || "未记录"}`;
  const discussionHref = source.kind === "discussion" && uuid.test(source.id)
    ? `#/p/${encodeURIComponent(projectId)}/discussions?discussion=${encodeURIComponent(source.id)}` : null;
  return { sourceLabel, discussionHref };
}

const messageStates: Record<string, string> = {
  queued: "已排队", processing: "处理中", replied: "已回复", completed_without_reply: "已完成无回复",
  failed: "失败", unknown: "结果待核对", cancelled: "已取消", manual_pending: "待人工转交",
};
const assignmentStates: Record<string, string> = { assigned: "待确认接手", accepted: "已接手", released: "已释放" };

/** A short label from recorded kinds and states; the full summary remains in source details. */
export function activityHeadline(items: SessionActivity[], taskTitle: string | null): string {
  const latest = items[0];
  if (!latest) return "来源记录待核对";
  const state = latest.summary.split(" · ")[1]?.trim().split(/\s/, 1)[0] ?? "";
  if (latest.kind.startsWith("session_message")) {
    const message = items.find(item => item.kind === "session_message");
    const messageState = message?.summary.split(" · ")[1]?.trim() ?? state;
    return `普通消息 · ${messageStates[messageState] ?? "状态待核对"}`;
  }
  if (latest.kind === "task_session_assignment") return `${taskTitle ?? "关联任务"} · 分派${assignmentStates[state] ?? "状态待核对"}`;
  if (latest.kind === "session_native_input_request") return `原生提问 · ${state === "pending" ? "待回答" : state === "resolved" ? "已结束" : state === "response_saved" ? "答复已保存" : "状态待核对"}`;
  if (latest.kind === "consumer_observation") return `使用观察 · ${state === "used" ? "已使用" : "结果待核对"}`;
  if (latest.kind === "delivery") return `${taskTitle ?? "关联任务"} · 交付记录`;
  if (latest.kind === "implementation") return `${taskTitle ?? "关联任务"} · 任务修订`;
  return latest.summary.length > 160 ? `${latest.summary.slice(0, 160)}…` : latest.summary;
}
