// 例行健康: one read for the schedule page's first screen. Every routine of the project in one list — a schedule definition or a timed Task series —
// with what a person checks first: how the last trigger went, how many skips in a row, when it runs next, and whether it should have run and left no record.
// Read-only; derived from the schedule, occurrence and Task records, never stored.
import type { MisfirePolicy, ScheduleRule } from "./scheduling.js";

export type RoutineState = "active" | "paused" | "stopped";
export type RoutineTaskState = "todo" | "in_progress" | "done" | "cancelled" | string;

/** A routine whose watermark lags by more than one period plus this many minutes, with no trigger record since, is overdue. */
export const routineOverdueGraceMinutes = 30;

export interface RoutineLastTrigger {
  /** The planned instant of the last trigger record (a timed series: the planned instant of its latest Task). */
  plannedAtUtc: string;
  observedAtUtc: string | null;
  /** created or queued: a Task was made (or is waiting its turn); skipped: nothing was made, `reason` says why. */
  outcome: "created" | "queued" | "skipped";
  /** The recorded reason code or sentence, as stored; the page says it in words and keeps this in the detail. */
  reason: string;
  task: { taskId: string; title: string; state: RoutineTaskState } | null;
}

export interface RoutineHealthItem {
  kind: "schedule" | "timed_series";
  /** scheduleId, or seriesId for a timed series. */
  id: string;
  title: string;
  state: RoutineState;
  /** What the schedule fires on; null for a timed series (its own repeat and zone are below). */
  rule: ScheduleRule | null;
  timezone: string;
  /** A timed series only: "none" is a one-time Task, "daily" repeats. Null for a schedule. */
  repeat: "none" | "daily" | null;
  /** A timed series only: the Task it opens from (`rootTaskId`) and the one it produced last. */
  rootTaskId: string | null;
  misfire: MisfirePolicy["kind"] | null;
  lastTrigger: RoutineLastTrigger | null;
  /** Skipped records at the tail of the trigger records, whatever the dispatch mode. Always 0 for a timed series (see `skippedTotal`). */
  consecutiveSkips: number;
  /** A timed series: slots the series missed in all (the series' own count). Null for a schedule. */
  skippedTotal: number | null;
  /** The next planned instant, computed here from the rule and the clock; null when there is none (stopped, paused, once done, authorization expired). */
  nextAtUtc: string | null;
  /** Set when an active routine should have triggered at `expectedAtUtc` and left no record. */
  overdue: { expectedAtUtc: string } | null;
  /** The last trigger made a Task and it is not closed. */
  lastTaskOpen: boolean;
  /** The schedule's watermark (checked through); null for a timed series. */
  watermarkUtc: string | null;
  /**
   * The last Task is still to do, has no assignment, is in no Agent's queue (waiting, held or started) and has no Run, and `sinceUtc` (when it was made)
   * is further back than the same two hours the Task attention policy gives a Task nobody was assigned. Only for an active routine; null otherwise.
   */
  lastTaskUnreceived: { sinceUtc: string } | null;
}

export interface RoutineHealth {
  projectId: string;
  /** Overdue first, then two or more skips in a row, then the last Task still open, then the rest by next time. */
  items: RoutineHealthItem[];
  observedAt: string;
  /** False when the timed series were cut at the read limit. */
  complete: boolean;
}

/** What the store reads for one schedule: its last trigger record with the Task it made, and the skips at the tail. */
export interface ScheduleHealthFacts {
  scheduleId: string;
  last: { plannedAtUtc: string; observedAtUtc: string; state: "created" | "queued" | "skipped"; reason: string;
    task: { taskId: string; title: string; state: RoutineTaskState } | null } | null;
  /** The Task of the latest trigger record that made one, which may be older than `last` (a skip made none). */
  lastTask: { taskId: string; title: string; state: RoutineTaskState } | null;
  consecutiveSkips: number;
}
/** A Task that is to do and that nobody has taken up: no assignment, not in any queue, no Run. `sinceUtc` is when its first revision was made. */
export interface UnreceivedTask { taskId: string; sinceUtc: string }
export interface ScheduleHealthReader {
  scheduleHealthFacts(): Promise<ScheduleHealthFacts[]>;
  /** Of these Tasks, the ones that are to do with no assignment, no queue entry and no Run. Same read for schedules and timed series. */
  unreceivedTasks(taskIds: string[]): Promise<UnreceivedTask[]>;
}
