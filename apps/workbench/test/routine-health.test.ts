import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoutineHealthItem } from "@evoloop/contracts/routine-health";
import { groupRoutines, lastTriggerView, needsAttention, nextText, overdueText, skipReasonText, unreceivedText, waitedText, warnsSkips } from "../src/features/scheduling/routineHealth";
import { routineAttention } from "../src/features/scheduling";

const item = (over: Partial<RoutineHealthItem> = {}): RoutineHealthItem => ({ kind: "schedule", id: "s1", title: "每日巡检", state: "active", rule: { kind: "daily", localTime: "09:00" },
  timezone: "Asia/Shanghai", repeat: null, rootTaskId: null, misfire: "latest", lastTrigger: null, consecutiveSkips: 0, skippedTotal: null, nextAtUtc: null,
  overdue: null, lastTaskOpen: false, watermarkUtc: null, lastTaskUnreceived: null, ...over });

test("a routine that never triggered says so and is not read as skipped", () => {
  assert.deepEqual(lastTriggerView(item()), { kind: "none", text: "还没有触发过" });
});

test("skip reasons are said in words; an unknown code is not shown raw", () => {
  assert.equal(skipReasonText("overlap skipped"), "上一份任务还没结束，按设置跳过这个时刻");
  assert.equal(skipReasonText("PREVIOUS_STILL_OPEN"), "上一次生成的任务还没关闭，这次不再生成");
  assert.equal(skipReasonText("WHATEVER_NEW"), "这次没有创建任务，原因见详情");
  assert.ok(!skipReasonText("WHATEVER_NEW").includes("WHATEVER_NEW"));
});

test("a skipped last trigger carries its reason; a created one carries its Task and state", () => {
  const skipped = lastTriggerView(item({ lastTrigger: { plannedAtUtc: "2026-11-22T01:00:00.000Z", observedAtUtc: "2026-11-22T01:00:01.000Z", outcome: "skipped", reason: "overlap skipped", task: null } }));
  assert.equal(skipped.kind, "skipped");
  const created = lastTriggerView(item({ lastTrigger: { plannedAtUtc: "2026-11-22T01:00:00.000Z", observedAtUtc: null, outcome: "created", reason: "scheduled", task: { taskId: "t", title: "巡检报告", state: "done" } } }));
  assert.equal(created.kind === "created" && created.task.title, "巡检报告");
});

test("overdue reads 应在…触发，没有记录, and overdue or two skips share the warning; one skip does not", () => {
  const late = item({ overdue: { expectedAtUtc: "2026-11-22T01:00:00.000Z" } });
  assert.match(overdueText(late)!, /^应在 .+ 触发，没有记录$/);
  assert.equal(needsAttention(late), true);
  assert.equal(needsAttention(item({ consecutiveSkips: 2 })), true);
  assert.equal(warnsSkips(item({ consecutiveSkips: 1 })), false);
  assert.equal(overdueText(item()), null);
});

test("next time or why there is none; stopped and sample routines fold away", () => {
  assert.equal(nextText(item({ state: "paused" })), "暂停中");
  assert.match(nextText(item({ nextAtUtc: "2026-11-23T01:00:00.000Z" })), /^\d\d\/\d\d \d\d:\d\d$/);
  const groups = groupRoutines([item({ id: "a" }), item({ id: "b", state: "stopped" }), item({ id: "c", title: "测试样本" })], title => title.includes("样本"));
  assert.deepEqual([groups.shown, groups.stopped, groups.samples].map(list => list.map(entry => entry.id)), [["a"], ["b"], ["c"]]);
});

const at = Date.parse("2026-11-23T08:00:00.000Z");
const since = (hours: number) => ({ sinceUtc: new Date(at - hours * 3_600_000).toISOString() });

test("nobody took the Task up: 待办，已 N 小时没人接, in days past 48 hours, and it is a warning", () => {
  assert.equal(unreceivedText(item({ lastTaskUnreceived: since(26) }), at), "待办，已 26 小时没人接");
  assert.equal(unreceivedText(item({ lastTaskUnreceived: since(48) }), at), "待办，已 48 小时没人接", "48 hours is still hours");
  assert.equal(unreceivedText(item({ lastTaskUnreceived: since(49) }), at), "待办，已 2 天没人接");
  assert.equal(waitedText(since(150).sinceUtc, at), "6 天");
  assert.equal(unreceivedText(item(), at), null);
  assert.equal(needsAttention(item({ lastTaskUnreceived: since(3) })), true);
});

test("the overview's 例行工作 row: counts three kinds once each, names the first, and leaves out paused, stopped and sample routines", () => {
  const rows = [item({ id: "g", title: "g", overdue: { expectedAtUtc: "2026-11-23T07:30:00.000Z" } }), item({ id: "f", title: "f", consecutiveSkips: 3 }),
    item({ id: "a", title: "a", lastTaskUnreceived: since(3) }), item({ id: "both", title: "两样都有", consecutiveSkips: 2, lastTaskUnreceived: since(5) }),
    item({ id: "p", title: "已暂停", state: "paused", lastTaskUnreceived: since(30) }), item({ id: "x", title: "已停止", state: "stopped", consecutiveSkips: 5 }),
    item({ id: "s", title: "测试样本", lastTaskUnreceived: since(30) }), item({ id: "ok", title: "正常" })];
  const sample = (title: string) => title.includes("样本");
  const first = routineAttention(rows, sample, at)!;
  assert.equal(first.count, 4, "g, f, a and the one with two problems (once)");
  assert.equal(first.first.title, "g");
  assert.match(first.first.text, /^应在 .+ 触发，没有记录$/);
  const second = routineAttention(rows.slice(1), sample, at)!;
  assert.deepEqual([second.count, second.first.title, second.first.text], [3, "f", "连续跳过 3 次"]);
  const third = routineAttention(rows.slice(2), sample, at)!;
  assert.deepEqual([third.count, third.first.text], [2, "生成的任务已 3 小时没人接"]);
  assert.equal(routineAttention(rows.filter(row => row.id === "ok" || row.id === "p" || row.id === "x" || row.id === "s"), sample, at), null, "nothing left: no row");
});
