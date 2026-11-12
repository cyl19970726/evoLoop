// 待我处理 (tasks.md 收件页): which deliveries wait for me to use them, and what the 待我处理 count may claim. Pure
// decisions over the work index (GET /work-management/index, readable by every project member) and a task's record,
// tested without React or a server (inbox-model.test.ts).
//
// The declared consumer is an exact actorId (contracts `consumer`); the index's observation is the latest one on the
// current delivery by anyone, so a later observation by someone else hides mine: then mine is read from the task.
// When my latest observation of the current delivery is 使用失败, the next step is the executor's rework, not mine:
// the delivery is not listed and not counted until a new delivery comes (未使用 stays listed).
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";

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
