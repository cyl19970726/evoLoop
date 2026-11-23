// 例行健康 rules (packages/core/src/scheduling/health.ts): the next time, overdue, the order, and a timed series beside the schedules.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import type { ScheduleHealthFacts } from "@evoloop/contracts/routine-health";
import type { TaskTimingSeriesSummary } from "@evoloop/contracts/task-timing";
import { buildRoutineHealth, nextScheduledAfter, overdueExpectedAt } from "../src/scheduling/health.js";

const now = "2026-11-23T08:00:00.000Z";
const hours = (h: number) => new Date(Date.parse(now) - h * 3_600_000).toISOString();
const definition = (title: string, extra: Partial<ScheduleDefinition> = {}, rule: ScheduleDefinition["revision"]["rule"] = { kind: "interval", anchorUtc: "2026-11-01T00:00:00.000Z", everyMinutes: 60 }): ScheduleDefinition => {
  const id = randomUUID(), revisionId = randomUUID(), projectId = randomUUID();
  return { projectId, id, version: 1, currentRevisionId: revisionId, state: "active", watermarkUtc: now, ...extra,
    revision: { projectId, scheduleId: id, id: revisionId, version: 1, timezone: "UTC", rule, misfire: { kind: "latest" }, overlap: "skip",
      template: { title, content: "c", acceptance: "a", owner: "role" }, authorization: { scopeId: "s", roleId: "role", authorizedBy: "h", expiresAtUtc: null },
      reason: "r", actorId: "h", createdAtUtc: "2026-11-01T00:00:00.000Z" } };
};
const fact = (scheduleId: string, extra: Partial<ScheduleHealthFacts> = {}): ScheduleHealthFacts => ({ scheduleId, last: null, lastTask: null, consecutiveSkips: 0, ...extra });
const task = (state: string) => ({ taskId: randomUUID(), title: "任务", state });
const created = (state: string): Pick<ScheduleHealthFacts, "last" | "lastTask"> => { const made = task(state);
  return { last: { plannedAtUtc: hours(2), observedAtUtc: hours(2), state: "created", reason: "due", task: made }, lastTask: made }; };

test("the next instant after a time, for each rule", () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(new Date(nextScheduledAfter(definition("x").revision, at("2026-11-23T08:10:00.000Z"))!).toISOString(), "2026-11-23T09:00:00.000Z");
  assert.equal(nextScheduledAfter(definition("x", {}, { kind: "once", atUtc: "2026-11-23T07:00:00.000Z" }).revision, at(now)), null, "a one-time rule that passed has no next");
  const daily = definition("d", {}, { kind: "daily", localTime: "09:00" }).revision;
  assert.equal(new Date(nextScheduledAfter({ ...daily, timezone: "Asia/Taipei" }, at(now))!).toISOString(), "2026-11-24T01:00:00.000Z", "09:00 in Taipei is 01:00 UTC, already past today");
  assert.equal(nextScheduledAfter({ ...daily, timezone: "Bad/Zone" }, at(now)), null);
  const expiring = definition("e"); expiring.revision.authorization.expiresAtUtc = "2026-11-23T08:30:00.000Z";
  assert.equal(nextScheduledAfter(expiring.revision, at(now)), null, "no next after the authorization expires");
});

test("overdue means the watermark lags by more than a period plus 30 minutes; only an active schedule is overdue", () => {
  const lag = (h: number, extra: Partial<ScheduleDefinition> = {}) => definition("x", { watermarkUtc: hours(h), ...extra });
  assert.equal(overdueExpectedAt(lag(1.4), Date.parse(now)), null, "an hour and 24 minutes behind an hourly rule is within period + 30 minutes");
  assert.equal(new Date(overdueExpectedAt(lag(2), Date.parse(now))!).toISOString(), "2026-11-23T07:00:00.000Z", "the first instant after the watermark");
  assert.equal(overdueExpectedAt(lag(2, { state: "paused" }), Date.parse(now)), null);
  assert.equal(overdueExpectedAt(lag(2, { state: "stopped" }), Date.parse(now)), null);
});

test("order: overdue, two skips in a row, the last Task still open, the rest by next time; a stopped routine is last; each row's own facts", () => {
  const healthy = definition("健康的"), open = definition("任务还开着"), skipping = definition("连续跳过"), late = definition("逾期的", { watermarkUtc: hours(5) });
  const stopped = definition("已停止", { state: "stopped" }), paused = definition("已暂停", { state: "paused" }), fresh = definition("从未触发");
  const health = buildRoutineHealth({ projectId: randomUUID(), now, complete: true, series: [],
    schedules: [healthy, open, skipping, late, stopped, paused, fresh],
    facts: [fact(healthy.id, created("done")), fact(open.id, created("in_progress")),
      fact(skipping.id, { ...created("in_progress"), last: { plannedAtUtc: hours(1), observedAtUtc: hours(1), state: "skipped", reason: "overlap", task: null }, consecutiveSkips: 2 }),
      fact(late.id), fact(stopped.id, created("done")), fact(paused.id, created("done"))] });
  assert.deepEqual(health.items.map(item => item.title), ["逾期的", "连续跳过", "任务还开着", "从未触发", "健康的", "已暂停", "已停止"]);
  const by = (title: string) => health.items.find(item => item.title === title)!;
  assert.equal(by("逾期的").overdue?.expectedAtUtc, "2026-11-23T04:00:00.000Z");
  assert.equal(by("逾期的").lastTrigger, null, "no record: the page says it never triggered, not skipped");
  assert.equal(by("连续跳过").consecutiveSkips, 2);
  assert.equal(by("连续跳过").lastTrigger?.outcome, "skipped");
  assert.equal(by("连续跳过").lastTaskOpen, true, "the Task made before the skips is still open");
  assert.equal(by("健康的").lastTaskOpen, false);
  assert.equal(by("已暂停").nextAtUtc, null);
  assert.equal(by("已停止").nextAtUtc, null);
  assert.equal(by("健康的").nextAtUtc, "2026-11-23T09:00:00.000Z");
  assert.equal(health.complete, true);
});

test("a timed series is a routine too: its next time, its open Task and its missed slots, with no consecutive-skip count", () => {
  const series = (title: string, extra: Partial<TaskTimingSeriesSummary> & { latestState?: string; planned?: string } = {}): TaskTimingSeriesSummary => ({ projectId: "p", seriesId: randomUUID(), rootTaskId: randomUUID(), version: 1,
    seriesState: "active", title, timezone: "Asia/Taipei", repeat: "daily", executeAtUtc: "2026-11-20T01:00:00.000Z", nextAtUtc: "2026-11-24T01:00:00.000Z", skippedCount: 0, occurrenceCount: 4,
    latestTask: { taskId: randomUUID(), title: `${title}任务`, state: (extra.latestState ?? "done") as "done", plannedAtUtc: extra.planned ?? "2026-11-23T01:00:00.000Z" }, ...extra });
  const health = buildRoutineHealth({ projectId: "p", now, complete: false, schedules: [], facts: [],
    series: [series("按时"), series("有漏过", { skippedCount: 2 }), series("已停止", { seriesState: "stopped" }), series("协调器没补上", { nextAtUtc: "2026-11-22T01:00:00.000Z" }), series("一次定时", { repeat: "none", nextAtUtc: null, latestState: "todo", planned: "2026-11-25T01:00:00.000Z" })] });
  const by = (title: string) => health.items.find(item => item.title === title)!;
  assert.equal(health.items[0]!.title, "协调器没补上");
  assert.equal(by("协调器没补上").overdue?.expectedAtUtc, "2026-11-22T01:00:00.000Z");
  assert.equal(by("有漏过").skippedTotal, 2);
  assert.equal(by("有漏过").consecutiveSkips, 0);
  assert.equal(by("按时").nextAtUtc, "2026-11-24T01:00:00.000Z");
  assert.equal(by("一次定时").nextAtUtc, "2026-11-25T01:00:00.000Z", "a one-time Task still to start: its own time");
  assert.equal(by("一次定时").lastTaskOpen, true);
  assert.equal(by("已停止").nextAtUtc, null);
  assert.equal(health.items.at(-1)!.title, "已停止");
  assert.equal(health.complete, false);
});

test("a Task nobody took up: only an active routine whose last Task is still to do, unclaimed, and older than two hours; ordered with the skips", () => {
  // The eight routines of Task 27f49bab plus a paused one. `claimed` stands for the store's answer: a Task with an assignment, a queue entry or a Run is not in it.
  const todo = (hoursAgo: number) => { const made = { taskId: randomUUID(), title: "例行任务", state: "todo" }; return { made, since: hours(hoursAgo) }; };
  const a = definition("a 三小时没人接"), b = definition("b 一小时"), c = definition("c 在队伍里"), d = definition("d 已有分派"), e = definition("e 进行中"),
    f = definition("f 连续跳过 3 次"), g = definition("g 应触发没有记录", { watermarkUtc: hours(5) }), paused = definition("暂停的", { state: "paused" }), edge = definition("恰好两小时"), over = definition("两小时零一分");
  const madeA = todo(3), madeB = todo(1), madeC = todo(5), madeD = todo(5), madeEdge = todo(2), madeOver = { ...todo(2), since: hours(2 + 1 / 60) }, madePaused = todo(9);
  const inProgress = { taskId: randomUUID(), title: "在做", state: "in_progress" };
  const lastOf = (made: { taskId: string; title: string; state: string }, at: number): Pick<ScheduleHealthFacts, "last" | "lastTask"> =>
    ({ last: { plannedAtUtc: hours(at), observedAtUtc: hours(at), state: "created", reason: "due", task: made }, lastTask: made });
  const series = (title: string, state: "todo" | "done", hoursAgo: number): TaskTimingSeriesSummary => ({ projectId: "p", seriesId: randomUUID(), rootTaskId: randomUUID(), version: 1,
    seriesState: "active", title, timezone: "UTC", repeat: "daily", executeAtUtc: hours(hoursAgo), nextAtUtc: "2026-11-24T07:30:00.000Z", skippedCount: 0, occurrenceCount: 4,
    latestTask: { taskId: seriesTasks.get(title)!.taskId, title: `${title}任务`, state, plannedAtUtc: hours(hoursAgo) } } as TaskTimingSeriesSummary);
  const seriesTasks = new Map([["h 每日重复", { taskId: randomUUID(), since: hours(26) }], ["i 每日重复，有人接", { taskId: randomUUID(), since: hours(26) }]]);
  const built = (unreceived: Array<{ taskId: string; sinceUtc: string }>) => buildRoutineHealth({ projectId: "p", now, complete: true,
    schedules: [a, b, c, d, e, f, g, paused, edge, over],
    facts: [fact(a.id, lastOf(madeA.made, 3)), fact(b.id, lastOf(madeB.made, 1)), fact(c.id, lastOf(madeC.made, 5)), fact(d.id, lastOf(madeD.made, 5)), fact(e.id, lastOf(inProgress, 4)),
      fact(f.id, { ...lastOf({ taskId: randomUUID(), title: "旧的", state: "done" }, 9), consecutiveSkips: 3 }), fact(g.id), fact(paused.id, lastOf(madePaused.made, 9)),
      fact(edge.id, lastOf(madeEdge.made, 2)), fact(over.id, lastOf(madeOver.made, 2))],
    series: [series("h 每日重复", "todo", 26), series("i 每日重复，有人接", "todo", 26)], unreceived });
  const unclaimed = [madeA, madeB, madeEdge, madeOver, madePaused].map(entry => ({ taskId: entry.made.taskId, sinceUtc: entry.since }));
  const health = built([...unclaimed, { taskId: seriesTasks.get("h 每日重复")!.taskId, sinceUtc: seriesTasks.get("h 每日重复")!.since }]);
  const by = (title: string) => health.items.find(item => item.title === title)!;
  assert.deepEqual(Object.fromEntries(health.items.map(item => [item.title, item.lastTaskUnreceived?.sinceUtc ?? null])), {
    "a 三小时没人接": hours(3), "b 一小时": null, "c 在队伍里": null, "d 已有分派": null, "e 进行中": null, "f 连续跳过 3 次": null, "g 应触发没有记录": null,
    "暂停的": null, "恰好两小时": null, "两小时零一分": hours(2 + 1 / 60), "h 每日重复": hours(26), "i 每日重复，有人接": null }, "only (a), (h) and the one just past the threshold carry the fact; the threshold is 'more than two hours'; a paused routine never");
  // (g) first, then (f)(a)(h) and the one past the threshold in one group (by next time), then the rest.
  const titles = health.items.map(item => item.title);
  assert.equal(titles[0], "g 应触发没有记录");
  assert.deepEqual(new Set(titles.slice(1, 5)), new Set(["f 连续跳过 3 次", "a 三小时没人接", "h 每日重复", "两小时零一分"]));
  assert.ok(titles.indexOf("b 一小时") > 4 && titles.indexOf("c 在队伍里") > 4 && titles.indexOf("e 进行中") > 4);
  // The store's answer decides: a Task it does not return (assigned, queued or run) is not flagged, whatever its age.
  assert.equal(by("c 在队伍里").lastTaskUnreceived, null);
  assert.equal(built([]).items.filter(item => item.lastTaskUnreceived).length, 0);
  assert.equal(buildRoutineHealth({ projectId: "p", now, complete: true, schedules: [a], facts: [fact(a.id, lastOf(madeA.made, 3))], series: [] }).items[0]!.lastTaskUnreceived, null, "no answer from the store: not guessed");
});
