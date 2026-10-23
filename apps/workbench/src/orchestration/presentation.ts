import type { OrchestrationDispatch, OrchestrationInbox, OrchestrationSubmission } from "@evoloop/contracts/orchestration";

export const inboxStateLabel: Record<OrchestrationInbox["state"], string> = {
  pending: "待处理", acknowledged: "已接收待决定", disposed: "处理完成",
};
export const dispatchStateLabel: Record<OrchestrationDispatch["state"], string> = {
  pending: "待领取", claimed: "已领取", dispatching: "派发中", accepted: "运行已接受",
  unknown: "派发结果未知", rejected: "派发被拒绝", completed: "派发流程完成",
};
export const submissionStateLabel: Record<OrchestrationSubmission["state"], string> = {
  submitted: "Worker 已提交意图", sealing: "封存中", sealed: "已封存交付",
  unknown: "封存结果未知", rejected: "封存被拒绝",
};
export function deliveryMeaning(submission: OrchestrationSubmission): string {
  if (submission.state === "sealed" && submission.deliveryId) return "已形成正式 Delivery；仍须另行观察使用与 Task 验收。";
  if (submission.state === "unknown") return "封存结果未知；须按原操作 ID 核对，不可推定交付失败或重发。";
  return "这是一份有署名的提交意图；尚不能视为正式 Delivery 或验收。";
}
