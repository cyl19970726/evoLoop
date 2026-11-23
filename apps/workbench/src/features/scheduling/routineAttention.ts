// What is wrong with a routine, in words and in count: the schedule page's warning marker and the overview's 例行工作 row read the same rules from here.
// Kept free of the page's other wording so the overview's first screen does not pull the schedule page in.
import type { RoutineHealthItem } from "@evoloop/contracts/routine-health";
import { readerZone } from "../../shared/zonedTime";

/** A table-sized time, "11/23 09:00", on the routine's clock (the reader's when the zone cannot be read). The full time is in the hover text. */
export function shortTime(value: string, timezone: string, reader = readerZone()): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const parts = (zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  let found: Intl.DateTimeFormatPart[];
  try { found = parts(timezone); } catch { found = parts(reader); }
  const part = (type: string) => found.find(item => item.type === type)?.value ?? "";
  return `${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
}

/** “应在〈时间〉触发，没有记录”: an active routine that should have fired and left no record. */
export const overdueText = (item: RoutineHealthItem, reader = readerZone()): string | null =>
  item.overdue ? `应在 ${shortTime(item.overdue.expectedAtUtc, item.timezone, reader)} 触发，没有记录` : null;

/** Two skips in a row or more share the overdue warning marker; one skip is a fact, not yet a warning. */
export const warnsSkips = (item: RoutineHealthItem): boolean => item.consecutiveSkips >= 2;
export const needsAttention = (item: RoutineHealthItem): boolean => !!item.overdue || warnsSkips(item) || !!item.lastTaskUnreceived;

/** How long, as the read saw it: hours, or days once it is past 48 hours. */
export function waitedText(sinceUtc: string, atMs: number): string {
  const hours = Math.max(0, Math.floor((atMs - Date.parse(sinceUtc)) / 3_600_000));
  return hours > 48 ? `${Math.floor(hours / 24)} 天` : `${hours} 小时`;
}
/** “待办，已 N 小时没人接”: the last Task was made, is still to do, and nobody took it up. */
export const unreceivedText = (item: RoutineHealthItem, atMs: number): string | null =>
  item.lastTaskUnreceived ? `待办，已 ${waitedText(item.lastTaskUnreceived.sinceUtc, atMs)}没人接` : null;


export type RoutineProblem = "overdue" | "skips" | "unreceived";
/** The one thing to say about a routine that is not well, the most pressing first (no record, then skips, then nobody took the Task up); null when it is well. */
export function routineProblem(item: RoutineHealthItem, atMs: number, reader = readerZone()): { kind: RoutineProblem; text: string } | null {
  if (item.overdue) return { kind: "overdue", text: overdueText(item, reader)! };
  if (warnsSkips(item)) return { kind: "skips", text: `连续跳过 ${item.consecutiveSkips} 次` };
  if (item.lastTaskUnreceived) return { kind: "unreceived", text: `生成的任务已 ${waitedText(item.lastTaskUnreceived.sinceUtc, atMs)}没人接` };
  return null;
}

/**
 * The overview's 例行工作 row: how many active routines are not well and the first of them as the server ordered them. A paused or stopped routine and the
 * test and sample ones are not counted; they stay in the schedule page's table.
 */
export function routineAttention(items: readonly RoutineHealthItem[], isSample: (title: string) => boolean, atMs: number, reader = readerZone()):
  { count: number; first: { id: string; title: string; text: string } } | null {
  const bad = items.filter(item => item.state === "active" && !isSample(item.title)).flatMap(item => { const problem = routineProblem(item, atMs, reader); return problem ? [{ item, problem }] : []; });
  const first = bad[0];
  return first ? { count: bad.length, first: { id: first.item.id, title: first.item.title, text: first.problem.text } } : null;
}
