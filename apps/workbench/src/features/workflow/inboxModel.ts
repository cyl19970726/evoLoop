// 待我处理 (tasks.md 收件页): which deliveries wait for me to use them, and what the 待我处理 count may claim. Pure
// decisions over the work index (GET /work-management/index, readable by every project member) and a task's record,
// tested without React or a server (inbox-model.test.ts).
//
// The declared consumer is an exact actorId (contracts `consumer`); the index's observation is the latest one on the
// current delivery by anyone, so a later observation by someone else hides mine: then mine is read from the task.
// When my latest observation of the current delivery is 使用失败, the next step is the executor's rework, not mine:
// the delivery is not listed and not counted until a new delivery comes (未使用 stays listed).
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { UsageBudget, SessionUsage } from "@evoloop/contracts";
import type { DecisionItem } from "@evoloop/contracts/decision-requests";

export { judgeMyDelivery, myLatestObservation, type MyDeliveryJudgement, type NotUsedResult, type UseResult } from "@evoloop/contracts/delivery-for-me";
import type { NotUsedResult } from "@evoloop/contracts/delivery-for-me";

/** When the current delivery was recorded, from the index's timeline; null when the index does not say. */
export function deliveredAt(item: Pick<LeaderWorkTask, "delivery" | "timing" | "latestProgress">): string | null {
  const deliveryId = item.delivery?.deliveryId;
  if (!deliveryId) return null;
  for (const round of [...item.timing?.rounds ?? []].reverse())
    for (const interval of [...round.intervals].reverse())
      if (interval.source?.kind === "delivery" && interval.source.id === deliveryId && interval.startedAt) return interval.startedAt;
  if (item.latestProgress?.entityKind === "delivery" && item.latestProgress.entityId === deliveryId) return item.latestProgress.changedAt;
  const progress = item.timing?.latestEffectiveProgress;
  return progress?.kind === "delivery" && progress.sourceId === deliveryId ? progress.at : null;
}

/** One row of 等我使用的交付. */
export interface DeliveryForMe {
  taskId: string;
  title: string;
  deliveryId: string;
  taskRevisionId: string;
  deliveredAt: string | null;
  useRequired: boolean;
  /** My latest observation of this delivery (only 未使用 here), or null when I have not recorded one. */
  last: { result: NotUsedResult; at: string | null } | null;
  /** Someone else observed this delivery after me or instead of me; `last` was read from the task. */
  othersObserved: boolean;
}

export const useRequirementText = (useRequired: boolean) => useRequired ? "必须使用才能关闭" : "只是声明的使用者";

const lastResultText: Record<NotUsedResult, string> = { notUsed: "未使用" };

/** 你上次：未使用, or 尚未记录使用. */
export function lastUseText(last: DeliveryForMe["last"]): string {
  return last ? `你上次：${lastResultText[last.result]}` : "尚未记录使用";
}

/**
 * 待我处理 › a task (its 交付与使用 or 依据与影响 tab, or its first tab), carrying where it came from (`return`, `actor`,
 * `returnTitle`, as other returns do): every row of the page leads back to 待我验收与判断.
 */
export function inboxTaskLink(projectId: string, taskId: string, actorId: string, tab?: "delivery" | "basis"): string {
  const params = new URLSearchParams({ ...tab ? { tab } : {}, return: `/p/${projectId}/inbox`, actor: actorId, returnTitle: "待我验收与判断" });
  return `/p/${projectId}/tasks/${taskId}?${params}`;
}

/** 等我使用的交付 › the task's 交付与使用 tab. */
export const deliveryLink = (projectId: string, taskId: string, actorId: string): string => inboxTaskLink(projectId, taskId, actorId, "delivery");

/** One part of the 待我处理 count: its answer, whether that answer is current, and whether it covers everything. */
export interface InboxPart {
  label: string;
  /** Items in the answer on screen; undefined while it was never read. */
  count: number | undefined;
  /** The read failed, the first time or on a reread: the answer on screen (if any) is not current. */
  failed: boolean;
  /** The answer is current but does not cover everything (pages left unread). */
  incomplete?: boolean;
}

export type InboxBadge =
  | { state: "known"; count: number }
  | { state: "reading" }
  /** At least one part cannot be counted: the count is not shown, `text` says why and what was read. */
  | { state: "unknown"; known: number; text: string };

/** The 待我处理 count is the sum of its parts, and only when every part is current and whole; a smaller number never stands in. */
export function inboxBadge(parts: readonly InboxPart[]): InboxBadge {
  const failed = parts.filter(part => part.failed);
  const incomplete = parts.filter(part => !part.failed && part.incomplete && part.count !== undefined);
  if (failed.length || incomplete.length) {
    const known = parts.filter(part => !part.failed && part.count !== undefined).reduce((sum, part) => sum + part.count!, 0);
    const why = [
      ...failed.length ? [`${failed.map(part => part.label).join("、")}读取失败`] : [],
      ...incomplete.length ? [`${incomplete.map(part => part.label).join("、")}没有读完`] : [],
    ].join("，");
    return { state: "unknown", known, text: `待我处理的数目暂时无法判断：${why}${known ? `；已读回的 ${known} 项不是全部` : ""}。` };
  }
  if (parts.some(part => part.count === undefined)) return { state: "reading" };
  return { state: "known", count: parts.reduce((sum, part) => sum + part.count!, 0) };
}

/**
 * The `inboxCount` handed to the shell: the count once every part is current and whole; null while a part cannot be
 * counted, which the shell's dot shows as 待核对 (a shell notice says why); 0 while the parts are still being read.
 */
export function shellInboxCount(badge: InboxBadge): number | null {
  return badge.state === "known" ? badge.count : badge.state === "unknown" ? null : 0;
}

/** 待我决定: what each kind of item is called, and the page that decides it (a request is answered right in the row). */
export const decisionKindText: Record<DecisionItem["kind"], string> = {
  role_proposal: "职责提案", stage_proposal: "阶段提案", task_question: "任务讨论里的问题", decision_request: "请你确认",
};
const blank = (value: string | null | undefined) => !value || !value.trim();
/**
 * Why one item cannot be opened at its own place, or null when it can: the id that locates it is missing. The row then says so and offers
 * no link, rather than sending the reader to a list and letting that pass for the item.
 */
export function decisionLinkProblem(item: DecisionItem): string | null {
  switch (item.kind) {
    case "role_proposal": return blank(item.roleId) ? "这条职责提案没有带职责编号，无法直接打开；请到职责页按标题查找。" : null;
    case "stage_proposal": return blank(item.stageId) ? "这条阶段提案没有带阶段编号，无法直接打开；请到目标与阶段页按标题查找。" : null;
    case "task_question":
      return blank(item.taskId) ? "这个问题没有带任务编号，无法直接打开。"
        : blank(item.discussionId) ? "这个问题没有带讨论编号，无法定位到那条讨论；请到该任务的协作里查找。"
          : blank(item.eventId) ? "这个问题没有带问题编号，无法定位到具体问题；请到该任务的协作里查找。" : null;
    case "decision_request": return null;
  }
}

/**
 * Where to decide one item, at the item itself: the Roles page on that role (`?role=`), the Goals and stages page on that stage (`?stage=`),
 * or the task page on its collaboration section at that discussion and question. Null when the item is answered in the list, or when its
 * id is missing (see {@link decisionLinkProblem}).
 */
export function decisionLink(projectId: string, item: DecisionItem, actorId: string): string | null {
  if (decisionLinkProblem(item)) return null;
  const back = { return: `/p/${projectId}/inbox`, actor: actorId, returnTitle: "待我验收与判断" };
  const decisionBack = { ...back, returnTitle: "待我处理" };
  switch (item.kind) {
    case "role_proposal": return `/p/${projectId}/roles?${new URLSearchParams({ role: item.roleId, ...decisionBack })}`;
    case "stage_proposal": return `/p/${projectId}/journey?${new URLSearchParams({ stage: item.stageId, ...decisionBack })}`;
    case "task_question": return `/p/${projectId}/tasks/${item.taskId}?${new URLSearchParams({ section: "collaboration", discussion: item.discussionId, question: item.eventId,
      ...back })}`;
    case "decision_request": return item.taskId ? inboxTaskLink(projectId, item.taskId, actorId) : null;
  }
}

/** One budget or context alert for the person (W5: these never go to the Leader). `limit` means ordinary Turns are held or a hand-off is needed. */
export interface UsageAlert { kind: "budget" | "context"; severity: "warning" | "limit"; text: string; sessionId?: string }
/**
 * The alerts in a usage overview: the day's budget when it is at its warning line or used up, and each Session whose context is near its limit or
 * must be handed off. Nothing is listed for ok, unknown or unconfigured, and nothing when the overview was not read.
 */
export function usageAlerts(overview: { budget: UsageBudget; sessions: SessionUsage[] } | null | undefined): UsageAlert[] {
  if (!overview) return [];
  const alerts: UsageAlert[] = [];
  const { budget } = overview;
  if (budget.configured && (budget.state === "warning" || budget.state === "exhausted"))
    alerts.push({ kind: "budget", severity: budget.state === "exhausted" ? "limit" : "warning",
      text: budget.reason ?? (budget.state === "exhausted" ? "今日用量已达到上限。" : "今日用量接近上限。") });
  for (const session of overview.sessions) {
    const state = session.context?.state;
    if (state === "warning") alerts.push({ kind: "context", severity: "warning", sessionId: session.sessionId, text: session.context.reason ?? "这个智能体的上下文接近上限，请留意。" });
    if (state === "handoff_required") alerts.push({ kind: "context", severity: "limit", sessionId: session.sessionId, text: session.context.reason ?? "这个智能体的上下文已满，需要交接后才能继续普通消息。" });
  }
  return alerts;
}

/**
 * The days to ask the usage overview for. The server counts "today" in the project's time zone and finds today's usage inside the asked window, so the
 * window must contain the project's day whatever its offset: UTC-12 to UTC+14 are never more than one calendar day from the UTC day.
 */
export function usageWindow(nowIso: string): { from: string; to: string } {
  const day = (offset: number) => new Date(Date.parse(nowIso) + offset * 86_400_000).toISOString().slice(0, 10);
  return { from: day(-1), to: day(1) };
}
