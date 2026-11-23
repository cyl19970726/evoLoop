// The schedule page's health table, decided (docs/frontend/pages/schedules.md): for every routine, when it runs next, whether it is overdue, and the order
// a person reads them in. Pure: the stores read the facts, this applies the rules, so the numbers on the page and in the test are the same.
import { dailyRuleInstant, scheduleWallClock, scheduleZoneFormat, type ScheduleDefinition, type ScheduleRevision } from "@evoloop/contracts/scheduling";
import { routineOverdueGraceMinutes, type RoutineHealth, type RoutineHealthItem, type ScheduleHealthFacts } from "@evoloop/contracts/routine-health";
import type { TaskTimingSeriesSummary } from "@evoloop/contracts/task-timing";

const MINUTE = 60_000;
const DAY = 86_400_000;
const closed = (state: string | undefined) => state === "done" || state === "cancelled";

/** The first planned instant of a rule strictly after `afterMs`, or null: none left (a one-time rule passed, authorization expired) or the zone is unknown. */
export function nextScheduledAfter(revision: ScheduleRevision, afterMs: number): number | null {
  const expires = revision.authorization.expiresAtUtc ? Date.parse(revision.authorization.expiresAtUtc) : null;
  const within = (at: number | null) => at !== null && (expires === null || at <= expires) ? at : null;
  const { rule } = revision;
  if (rule.kind === "once") { const at = Date.parse(rule.atUtc); return within(at > afterMs ? at : null); }
  if (rule.kind === "interval") {
    const anchor = Date.parse(rule.anchorUtc), period = rule.everyMinutes * MINUTE;
    return within(afterMs < anchor ? anchor : anchor + (Math.floor((afterMs - anchor) / period) + 1) * period);
  }
  let format: Intl.DateTimeFormat;
  try { format = scheduleZoneFormat(revision.timezone); } catch { return null; }
  const [hour, minute] = rule.localTime.split(":").map(Number);
  const start = scheduleWallClock(format, afterMs);
  const firstDay = Date.UTC(start.year, start.month - 1, start.day);
  // A daylight-saving gap can skip one day; a week is more than enough to find the next instant.
  for (let day = firstDay; day <= firstDay + 7 * DAY; day += DAY) {
    const date = new Date(day);
    const at = dailyRuleInstant(format, { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }, hour!, minute!);
    if (at !== null && at > afterMs) return within(at);
  }
  return null;
}

const periodMs = (revision: ScheduleRevision): number => revision.rule.kind === "interval" ? revision.rule.everyMinutes * MINUTE : revision.rule.kind === "daily" ? DAY : 0;

/** The instant an active schedule should have fired and left no record: its watermark lags by more than one period plus the grace; null when it does not. */
export function overdueExpectedAt(definition: ScheduleDefinition, nowMs: number): number | null {
  if (definition.state !== "active") return null;
  const watermark = Date.parse(definition.watermarkUtc);
  if (!Number.isFinite(watermark) || nowMs - watermark <= periodMs(definition.revision) + routineOverdueGraceMinutes * MINUTE) return null;
  const expected = nextScheduledAfter(definition.revision, watermark);
  return expected !== null && expected <= nowMs - routineOverdueGraceMinutes * MINUTE ? expected : null;
}

const rank = (item: RoutineHealthItem) => item.state === "stopped" ? 4 : item.overdue ? 0 : item.consecutiveSkips >= 2 ? 1 : item.lastTaskOpen ? 2 : 3;

export function buildRoutineHealth(input: { projectId: string; schedules: ScheduleDefinition[]; facts: ScheduleHealthFacts[]; series: TaskTimingSeriesSummary[];
  now: string; complete: boolean }): RoutineHealth {
  const nowMs = Date.parse(input.now);
  const factsOf = new Map(input.facts.map(fact => [fact.scheduleId, fact]));
  const items: RoutineHealthItem[] = [];
  for (const definition of input.schedules) {
    const fact = factsOf.get(definition.id);
    const expected = overdueExpectedAt(definition, nowMs);
    const next = definition.state === "active" ? nextScheduledAfter(definition.revision, nowMs) : null;
    items.push({ kind: "schedule", id: definition.id, title: definition.revision.template.title, state: definition.state, rule: definition.revision.rule,
      timezone: definition.revision.timezone, repeat: null, rootTaskId: null, misfire: definition.revision.misfire.kind,
      lastTrigger: fact?.last ? { plannedAtUtc: fact.last.plannedAtUtc, observedAtUtc: fact.last.observedAtUtc, outcome: fact.last.state, reason: fact.last.reason, task: fact.last.task } : null,
      consecutiveSkips: fact?.consecutiveSkips ?? 0, skippedTotal: null,
      nextAtUtc: next === null ? null : new Date(next).toISOString(), overdue: expected === null ? null : { expectedAtUtc: new Date(expected).toISOString() },
      lastTaskOpen: !!fact?.lastTask && !closed(fact.lastTask.state), watermarkUtc: definition.watermarkUtc });
  }
  for (const series of input.series) {
    const active = series.seriesState === "active";
    const latest = series.latestTask;
    // The Task's own slot comes first while it is still to start; after that, the next daily slot. A one-time Task has no later one.
    const planned = Date.parse(latest.plannedAtUtc);
    const next = !active ? null
      : latest.state === "todo" && planned > nowMs ? latest.plannedAtUtc
        : series.repeat === "daily" ? series.nextAtUtc : null;
    const overdue = active && series.repeat === "daily" && series.nextAtUtc && Date.parse(series.nextAtUtc) <= nowMs - routineOverdueGraceMinutes * MINUTE
      && !(latest.state === "todo" && planned > nowMs) ? { expectedAtUtc: series.nextAtUtc } : null;
    items.push({ kind: "timed_series", id: series.seriesId, title: series.title, state: active ? "active" : "stopped", rule: null, timezone: series.timezone,
      repeat: series.repeat, rootTaskId: series.rootTaskId, misfire: null,
      lastTrigger: { plannedAtUtc: latest.plannedAtUtc, observedAtUtc: null, outcome: "created", reason: "", task: { taskId: latest.taskId, title: latest.title, state: latest.state } },
      consecutiveSkips: 0, skippedTotal: series.skippedCount, nextAtUtc: next, overdue, lastTaskOpen: !closed(latest.state), watermarkUtc: null });
  }
  items.sort((a, b) => rank(a) - rank(b)
    || (a.nextAtUtc === null ? Infinity : Date.parse(a.nextAtUtc)) - (b.nextAtUtc === null ? Infinity : Date.parse(b.nextAtUtc))
    || a.title.localeCompare(b.title, "zh-CN") || a.id.localeCompare(b.id));
  return { projectId: input.projectId, items, observedAt: input.now, complete: input.complete };
}
