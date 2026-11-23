import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoutineHealthItem } from "@evoloop/contracts/routine-health";
import { groupRoutines, lastTriggerView, needsAttention, nextText, overdueText, skipReasonText, warnsSkips } from "../src/features/scheduling/routineHealth";

const item = (over: Partial<RoutineHealthItem> = {}): RoutineHealthItem => ({ kind: "schedule", id: "s1", title: "每日巡检", state: "active", rule: { kind: "daily", localTime: "09:00" },
  timezone: "Asia/Shanghai", repeat: null, rootTaskId: null, misfire: "latest", lastTrigger: null, consecutiveSkips: 0, skippedTotal: null, nextAtUtc: null,
  overdue: null, lastTaskOpen: false, watermarkUtc: null, ...over });

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
