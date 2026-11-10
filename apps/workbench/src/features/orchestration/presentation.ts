import type { OrchestrationDispatch, OrchestrationInbox, OrchestrationSourceFact, OrchestrationSubmission } from "@evoloop/contracts/orchestration";
import type { WorkTaskStatus } from "../../shared/workStatusPresentation";

function compactContext(value: string): string {
  const chars = [...value.replace(/\s+/g," ").trim()];
  return chars.length > 44 ? `${chars.slice(0,44).join("")}…` : chars.join("");
}

export function decisionHeading(hasWorkerDecision: boolean): string {
  return hasWorkerDecision ? "执行方署名判定" : "派发决定";
}

export function sourceTriggerLabel(source: OrchestrationSourceFact | undefined): string {
  if (!source) return "固定来源尚未读回；展开核对派发来源。";
  switch (source.kind) {
    case "loop.enrolled": return "职责循环首次规划";
    case "worker.outcome": return "上一轮工作结果需要接续判断";
    case "observation.record": return "交付的实际使用反馈需要接续判断";
    case "dispatch.gap": return "上一轮运行终结后缺少署名结果，需要恢复判断";
    default: return "其他已登记来源（原记录见来源层）";
  }
}

export function storyTitle(dispatch: OrchestrationDispatch, currentTaskTitle: string | undefined,
  source: OrchestrationSourceFact | undefined, status: WorkTaskStatus | undefined,
  sourceTaskStatus: WorkTaskStatus | undefined, scopeTitle: string | undefined): string {
  if (dispatch.purpose !== "cognition") return currentTaskTitle ?? "任务（名称待读取）";
  const trigger = sourceTriggerLabel(source);
  const matched = status?.dispatchId === dispatch.id ? status : undefined;
  const businessSource = matched?.sourceTaskTitle && sourceTaskStatus?.cognition === false ?
    `${matched.sourceTaskTitle}（源任务现名称）` : null;
  return `${trigger} · ${compactContext(businessSource ?? scopeTitle ?? "上轮判断")}`;
}

export const inboxStateLabel: Record<OrchestrationInbox["state"], string> = {
  pending: "待处理", acknowledged: "已接收待决定", disposed: "处理完成",
};
export const dispatchStateLabel: Record<OrchestrationDispatch["state"], string> = {
  pending: "待领取", claimed: "已领取", dispatching: "派发中", accepted: "运行已接受",
  unknown: "派发结果未知", rejected: "派发被拒绝", completed: "派发流程完成",
};
export const submissionStateLabel: Record<OrchestrationSubmission["state"], string> = {
  submitted: "执行方已提交意图", sealing: "封存中", sealed: "已封存交付",
  unknown: "封存结果未知", rejected: "封存被拒绝",
};
export function deliveryMeaning(submission: OrchestrationSubmission): string {
  if (submission.state === "sealed" && submission.deliveryId) return "已形成正式交付；仍须另行观察使用与任务验收。";
  if (submission.state === "unknown") return "封存结果未知；须按原操作核对，不可推定交付失败或重发。";
  return "这是一份有署名的提交意图；尚不能视为正式交付或验收。";
}
export function sealReasonLabel(reason: string): string {
  return ({AUTHORITATIVE_DELIVERY:"已按原交付操作读回并封存正式记录",
    ALREADY_SEALED:"正式交付已封存，重复核对未再次登记"} as Record<string,string>)[reason] ?? reason;
}

export const loopStateLabel: Record<string, string> = { active: "运行中", paused: "已暂停新派发", stopped: "已停止新派发" };
export const dispositionLabel = (value: string | null | undefined): string =>
  ({ no_action: "无后续动作", waiting: "等待", failed: "处理失败", stop: "停止", dispatch: "已请求派发" } as Record<string, string>)[value ?? ""] ?? "未登记";
export const outcomeLabel = (value: string): string =>
  ({ delivered: "已登记交付结果", no_action: "无后续动作", waiting: "等待", failed: "处理失败" } as Record<string, string>)[value] ?? "其他结果";
/** What an inbox entry or a dispatch is for; free-form purposes the page does not know stay in the source layer. */
export const purposeLabel = (value: string): string =>
  ({ cognitive_review: "判断复核", next_action: "下一步处理", cognition: "判断", business: "业务执行" } as Record<string, string>)[value] ?? "其他用途";

/**
 * What was read of a loop's goal and stage. `named` holds what could be said (a part that failed is said as such);
 * `failed` and `missing` mean neither could be named: a read that failed, or records that were read and are not there.
 * No value at all means the read has not come back yet.
 */
export type ScopeTitle = { state: "named"; title: string } | { state: "failed" } | { state: "missing" };

type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

/** The goal and stage of a loop from their reads; `notFound` says whether a failed read was an answer that it is not there. */
export function scopeTitleOf(goal: Settled<{ outcome: string }>, stage: Settled<{ deliverable: string } | null> | null,
  notFound: (cause: unknown) => boolean): ScopeTitle {
  const part = <T>(read: Settled<T>, kind: string, text: (value: T) => string) => read.status === "fulfilled"
    ? { known: true, missing: false, text: text(read.value).trim() || `${kind}（未写内容）` }
    : { known: false, missing: notFound(read.reason), text: `${kind}${notFound(read.reason) ? "未找到" : "暂不可读取"}` };
  const parts = [part(goal, "目标", value => value.outcome), ...stage ? [part(stage, "阶段", value => value?.deliverable ?? "")] : []];
  if (parts.some(item => item.known)) return { state: "named", title: parts.map(item => item.text).join(" · ") };
  return parts.every(item => item.missing) ? { state: "missing" } : { state: "failed" };
}

/** A loop's goal and stage in full: their names, or whether they are being read, could not be read, or are not there. */
export function scopeText(scope: ScopeTitle | undefined): string {
  if (!scope) return "目标与阶段待读取";
  if (scope.state === "failed") return "目标与阶段暂不可读取";
  if (scope.state === "missing") return "目标与阶段未找到";
  return scope.title;
}

/** A loop's name for a picker: its goal and stage, shortened. */
export function loopName(scope: ScopeTitle | undefined, max = 16): string {
  const chars = [...scopeText(scope).replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/**
 * A dispatched task's name from the loop's task pages: its title; 待读取 while unread pages remain; 暂不可读取 when
 * reading them failed; 未找到 when every page was read and it is not there.
 */
export function taskTitleText(title: string | undefined, pages: { more: boolean; failed: boolean }): string {
  if (title) return title;
  if (pages.failed) return "任务（名称暂不可读取）";
  return pages.more ? "任务（名称待读取）" : "任务（未找到）";
}
