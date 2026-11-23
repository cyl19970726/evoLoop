// What the overview's first screen says (docs/frontend/pages/overview.md): the rows a person has to decide or handle, the deliveries waiting for their
// own use, the latest use feedback, and the one line about what the organisation is handling itself. Pure; the page reads, this decides the words and the
// order. A read that failed is never turned into "nothing": the caller passes `failed`, and the empty sentence is only for a settled empty read.
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { workItemNextStep } from "../../shared/workPresentation";

export const priorityLimit = 3;
/** A blocked or rework Task with no progress for this long moves up to 要你决定或处理的; younger ones only count in the one organisation line. */
export const stalledDays = 3;
const dayMs = 86_400_000;

/** The five kinds of 待我处理 the first row of the overview takes, in the order they are listed. */
export const priorityKinds = ["runtime", "decision", "acceptance", "impact", "usage"] as const;
export type PriorityKind = typeof priorityKinds[number];

/** "N 项" shown beside a block's title, or why it cannot be counted. */
export function priorityTitle(count: number | null): string {
  return count === null ? "要你决定或处理的" : `要你决定或处理的 · ${count}`;
}

/** The rows after the first `limit`, said as "还有 K 项"; null when everything fits. */
export function moreText(total: number, limit = priorityLimit): string | null {
  return total > limit ? `还有 ${total - limit} 项` : null;
}

const sinceOf = (row: Pick<LeaderWorkTask, "latestProgress"> & { dates?: LeaderWorkTask["dates"] }) => row.latestProgress?.changedAt ?? row.dates?.businessChangedAt;

/** Whole days since `iso`, never negative; null when the time is missing or not a date. */
export function daysSince(iso: string | null | undefined, now: number): number | null {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / dayMs)) : null;
}

export interface StalledTask { taskId: string; title: string; days: number; reason: string }
/** Blocked or waiting-for-rework open Tasks with no progress for `stalledDays` or more, the longest first. A Task with no usable time is not guessed into the list. */
export function stalledTasks(rows: readonly LeaderWorkTask[], now: number): StalledTask[] {
  return rows.filter(row => (row.phase === "blocked" || row.phase === "rework") && row.taskState !== "done" && row.taskState !== "cancelled")
    .flatMap(row => { const days = daysSince(sinceOf(row), now); return days !== null && days >= stalledDays ? [{ taskId: row.taskId, title: row.title, days, reason: workItemNextStep(row) }] : []; })
    .sort((a, b) => b.days - a.days || a.taskId.localeCompare(b.taskId));
}

/** The longest wait among blocked and rework Tasks, in days, for the "最久" figure; null when there are none or none has a time. */
export function longestStall(rows: readonly LeaderWorkTask[], now: number): number | null {
  const days = rows.filter(row => (row.phase === "blocked" || row.phase === "rework") && row.taskState !== "done" && row.taskState !== "cancelled")
    .map(row => daysSince(sinceOf(row), now)).filter((value): value is number => value !== null);
  return days.length ? Math.max(...days) : null;
}

/** 组织自己在处理：运行中 a · 待返工 b · 待验收 c · 受阻 d（最久 N 天）; the numbers are the work index's own `counts`, as on the task page. */
export function organisationText(counts: Record<string, number> | undefined, longest: number | null): string {
  if (!counts) return "组织自己在处理：这一项读不到";
  const n = (key: string) => counts[key] ?? 0;
  return `组织自己在处理：运行中 ${n("running")} · 待返工 ${n("rework")} · 待验收 ${n("awaiting_acceptance")} · 受阻 ${n("blocked")}${longest !== null && (n("blocked") + n("rework")) > 0 ? `（最久 ${longest} 天）` : ""}`;
}

/**
 * When the latest use feedback of this Task was registered, read from the work index's own timeline (the interval that began at an observation), never from
 * the Task revision's time. Null when the timeline has none: such a Task sorts last rather than being given a guessed time.
 */
export function latestFeedbackAt(row: Pick<LeaderWorkTask, "timing">): string | null {
  let latest: string | null = null;
  for (const round of row.timing?.rounds ?? []) for (const interval of round.intervals) {
    if (interval.source?.kind !== "observation" || !interval.startedAt || !Number.isFinite(Date.parse(interval.startedAt))) continue;
    if (latest === null || Date.parse(interval.startedAt) > Date.parse(latest)) latest = interval.startedAt;
  }
  return latest;
}

/** Tasks that have a recorded use for their current delivery, the most recently registered feedback first (ties by Task id). */
export function feedbackCandidates<T extends Pick<LeaderWorkTask, "timing" | "taskId">>(rows: readonly T[]): T[] {
  const at = (row: T) => { const value = latestFeedbackAt(row); return value === null ? -Infinity : Date.parse(value); };
  return [...rows].sort((a, b) => at(b) - at(a) || a.taskId.localeCompare(b.taskId));
}

export const useResultText = { used: "已使用", failed: "使用失败", notUsed: "未使用" } as const;
/** The latest use feedback of one delivery: whose, and what they found. */
export function outcomeText(title: string, observerKind: "human" | "agent" | string, observer: string, result: keyof typeof useResultText): string {
  return `${title} · ${observerKind === "human" ? "真人" : "智能体"} ${observer} ${useResultText[result]}`;
}

/** The newest 复盘: by the day it observed to, else when the document last changed; null when there is none. */
export function latestReview<T extends { id: string; updatedAt?: string | null; organizationReview?: { observedTo?: string | null } | null }>(items: readonly T[]): T | null {
  const key = (item: T) => Date.parse(item.organizationReview?.observedTo ?? item.updatedAt ?? "1970-01-01");
  return [...items].sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id))[0] ?? null;
}
