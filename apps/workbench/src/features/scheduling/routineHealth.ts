// 例行健康 on 日程: the first screen's table. Pure wording for one row, so the plain-language skip reasons, the overdue sentence and
// the order of the table are tested without a browser. Facts come from one read (`/routine-health`); nothing here guesses a missing one.
import type { RoutineHealthItem, RoutineLastTrigger } from "@evoloop/contracts/routine-health";
import { readerZone } from "../../shared/zonedTime";
import { dispatchReasonKnown, dispatchReasonText } from "./dispatch";
import { occurrenceReasonKnown, occurrenceReasonText, scheduleTime } from "./presentation";

export const routineStateLabel = { active: "在跑", paused: "已暂停", stopped: "已停止" } as const;

/** Why a trigger made no Task, in words. The stored code goes in the detail, not here. */
export function skipReasonText(reason: string): string {
  if (occurrenceReasonKnown(reason)) return occurrenceReasonText(reason);
  if (dispatchReasonKnown(reason) && reason) return dispatchReasonText(reason);
  return "这次没有创建任务，原因见详情";
}

/** The full time of an instant, in the routine's own zone with the reader's clock added when it differs (kept as the cell's hover text). */
export const routineTime = (value: string, timezone: string, reader = readerZone()): string => scheduleTime(value, timezone, reader);

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

export type LastTriggerText =
  | { kind: "none"; text: string }
  | { kind: "created"; at: string; full: string; task: NonNullable<RoutineLastTrigger["task"]>; queued: boolean }
  | { kind: "skipped"; at: string; full: string; reason: string };

/** The last trigger of one row: none yet, a Task (with where it stands now), or a skip with its reason in words. */
export function lastTriggerView(item: RoutineHealthItem, reader = readerZone()): LastTriggerText {
  const last = item.lastTrigger;
  if (!last) return { kind: "none", text: "还没有触发过" };
  const at = shortTime(last.plannedAtUtc, item.timezone, reader), full = routineTime(last.plannedAtUtc, item.timezone, reader);
  if (last.outcome === "skipped" || !last.task) return { kind: "skipped", at, full, reason: skipReasonText(last.reason) };
  return { kind: "created", at, full, task: last.task, queued: last.outcome === "queued" };
}

/** “应在〈时间〉触发，没有记录”: an active routine that should have fired and left no record. */
export const overdueText = (item: RoutineHealthItem, reader = readerZone()): string | null =>
  item.overdue ? `应在 ${shortTime(item.overdue.expectedAtUtc, item.timezone, reader)} 触发，没有记录` : null;

/** Two skips in a row or more share the overdue warning marker; one skip is a fact, not yet a warning. */
export const warnsSkips = (item: RoutineHealthItem): boolean => item.consecutiveSkips >= 2;
export const needsAttention = (item: RoutineHealthItem): boolean => !!item.overdue || warnsSkips(item);

/** Next time, or why there is none. A stopped routine never reaches here (it is folded). */
export function nextText(item: RoutineHealthItem, reader = readerZone()): string {
  if (item.nextAtUtc) return shortTime(item.nextAtUtc, item.timezone, reader);
  if (item.state === "paused") return "暂停中";
  if (item.state === "stopped") return "已停止";
  return "没有后续时刻";
}

export interface RoutineGroups { shown: RoutineHealthItem[]; stopped: RoutineHealthItem[]; samples: RoutineHealthItem[] }
/** The table keeps the server's order; stopped routines fold into one line, test and sample ones into another. */
export function groupRoutines(items: RoutineHealthItem[], isSample: (title: string) => boolean): RoutineGroups {
  const samples = items.filter(item => isSample(item.title));
  const rest = items.filter(item => !isSample(item.title));
  return { shown: rest.filter(item => item.state !== "stopped"), stopped: rest.filter(item => item.state === "stopped"), samples };
}

/** One sentence of what a schedule fires on, or a timed Task series' own repeat. */
export function periodText(item: RoutineHealthItem, ruleWords: (item: RoutineHealthItem) => string): string {
  if (item.kind === "timed_series") return item.repeat === "daily" ? "每日重复（任务自己的执行时间）" : "一次定时（任务自己的执行时间）";
  return ruleWords(item);
}
