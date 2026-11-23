// 例行健康 on 日程: the first screen's table. Pure wording for one row, so the plain-language skip reasons, the overdue sentence and
// the order of the table are tested without a browser. Facts come from one read (`/routine-health`); nothing here guesses a missing one.
import type { RoutineHealthItem, RoutineLastTrigger } from "@evoloop/contracts/routine-health";
import { readerZone } from "../../shared/zonedTime";
import { dispatchReasonKnown, dispatchReasonText } from "./dispatch";
import { overdueText, shortTime, unreceivedText, warnsSkips, waitedText, needsAttention } from "./routineAttention";
export { overdueText, shortTime, unreceivedText, warnsSkips, waitedText, needsAttention };
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
