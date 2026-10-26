import type { SessionRecoveryView } from "@evoloop/contracts/session-recovery";
export type { SessionRecoveryView } from "@evoloop/contracts/session-recovery";

export type RecoveryRead =
  | { status: "loading" }
  | { status: "ready"; view: SessionRecoveryView }
  | { status: "unavailable" | "forbidden" | "failed"; message: string };

const phaseText: Record<NonNullable<SessionRecoveryView["gate"]>["phase"], string> = {
  open: "可按正常规则接续",
  blocked: "已停止接续",
  retrying: "等待原任务重试",
  message_pending: "等待原排队消息",
  awaiting_acceptance: "等待交付与验收",
};
const nextActionText: Record<string, string> = {
  reconcile_original_operation: "先核对原操作结果",
  review_recovery_decision: "等待负责人明确恢复决定",
  await_authorized_retry: "等待已批准的原任务重试；是否运行以 Run 记录为准",
  await_original_message: "等待处理原消息；是否回复以消息记录为准",
  record_delivery_use_and_accepted_release: "等待交付、实际使用与验收放行",
  dispatch_authorized_business_attempt: "配置待在已授权业务尝试中激活",
  normal_work: "按正常工作规则继续，仍需满足权限与业务条件",
};
const causeText: Record<NonNullable<SessionRecoveryView["gate"]>["causeKind"] & string, string> = {
  run: "原任务 Run", message: "原消息", execution_profile: "执行配置修订",
};
const activationText: Record<NonNullable<SessionRecoveryView["executionProfile"]>["activationState"], string> = {
  active: "已登记激活", pending: "待激活", attempting: "激活尝试中，结果未确认", unknown: "激活结果未知，需核对", rejected: "激活被拒绝",
};
export const recoveryPhaseLabel = (phase: NonNullable<SessionRecoveryView["gate"]>["phase"]) => phaseText[phase];
export const recoveryNextActionLabel = (action: string, runtimeState?: string | null) =>
  runtimeState === "closed" && action === "normal_work" ? "会话已关闭；先核对生命周期与授权，不能直接接续"
    : nextActionText[action] ?? "下一动作暂无法解释，请核对服务记录";
export const recoveryCauseLabel = (kind: NonNullable<SessionRecoveryView["gate"]>["causeKind"]) => kind ? causeText[kind] : "来源未记录";
export const recoveryActivationLabel = (state: NonNullable<SessionRecoveryView["executionProfile"]>["activationState"]) => activationText[state];

export function checkedRecoveryView(value: SessionRecoveryView, projectId: string, sessionId: string): SessionRecoveryView {
  if (!value || value.sessionId !== sessionId || !Array.isArray(value.decisions) || !Array.isArray(value.queues)
    || typeof value.observedAtUtc !== "string" || typeof value.partial !== "boolean" || typeof value.nextAction !== "string"
    || value.gate !== null && (!value.gate || value.gate.projectId !== projectId || value.gate.sessionId !== sessionId
      || !(value.gate.phase in phaseText) || value.gate.causeKind !== null && !(value.gate.causeKind in causeText)
      || typeof value.gate.reason !== "string")
    || value.executionProfile !== null && (!value.executionProfile || !value.executionProfile.revision
      || value.executionProfile.revision.projectId !== projectId || value.executionProfile.revision.sessionId !== sessionId
      || typeof value.executionProfile.revision.revisionId !== "string"
      || value.executionProfile.revision.model !== null && typeof value.executionProfile.revision.model !== "string"
      || !(value.executionProfile.activationState in activationText))
    || value.queues.some(queue => !queue || typeof queue.queueId !== "string" || !Number.isSafeInteger(queue.maxRuns)
      || !Number.isSafeInteger(queue.attemptsUsed) || !Number.isSafeInteger(queue.attemptsRemaining)
      || queue.maxRuns < 0 || queue.attemptsUsed < 0 || queue.attemptsRemaining < 0
      || queue.attemptsRemaining !== Math.max(0, queue.maxRuns - queue.attemptsUsed))
    || value.decisions.some(decision => !decision || decision.projectId !== projectId || decision.sessionId !== sessionId
      || (decision.kind !== "retry_failed" && decision.kind !== "resume")
      || typeof decision.id !== "string" || typeof decision.reason !== "string")) {
    throw new Error("恢复观察响应与所选 Session 不符或内容不完整");
  }
  return value;
}

export function recoveryBudget(queue: SessionRecoveryView["queues"][number]) {
  return { used: queue.attemptsUsed, max: queue.maxRuns, remaining: queue.attemptsRemaining };
}
