import assert from "node:assert/strict";
import { test } from "node:test";
import type { StageProjection, StageProjectionStage } from "@evoloop/contracts/stage-projection";
import { dueCell, groupTasks, isCurrent, isUnowned, ladderSummary, overdueNote, stageName, stageRows, taskCell, unownedLine } from "../src/features/stages/stagesPresentation.ts";

const zero = { inProgress: 0, blocked: 0, notStarted: 0, closed: 0, total: 0 };
const stage = (id: string, extra: Partial<StageProjectionStage> = {}) => ({ id, shortName: null, dueOn: null, inMainTable: true, tasks: zero, ...extra }) as unknown as StageProjectionStage;
const projection = (stages: StageProjectionStage[], currentStageId: string | null) => ({ stages, currentStageId, today: "2026-12-03", timeZone: "Asia/Tashkent" }) as unknown as StageProjection;

test("the task cell reads in the four forms the service counts allow", () => {
  assert.equal(taskCell(zero), "还没有任务");
  assert.equal(taskCell({ ...zero, inProgress: 3, blocked: 1, total: 4 }), "进行 3 · 卡住 1");
  assert.equal(taskCell({ ...zero, blocked: 2, total: 2 }), "进行 0 · 卡住 2");
  assert.equal(taskCell({ ...zero, notStarted: 2, closed: 1, total: 3 }), "未开始 2");
  assert.equal(taskCell({ ...zero, closed: 5, total: 5 }), "已关闭 5");
});
test("the due date is MM-DD with the whole date as its title, 未定 when none", () => {
  assert.deepEqual(dueCell("2026-12-02"), { text: "12-02", title: "2026-12-02" });
  assert.equal(dueCell(null).text, "未定");
});
test("only the stage the service names is current, however many are active", () => {
  const stages = ["a", "b", "c"].map(id => stage(id));
  const p = projection(stages, "b");
  assert.deepEqual(stages.filter(s => isCurrent(p, s)).map(s => s.id), ["b"]);
  assert.equal(stages.filter(s => isCurrent(projection(stages, null), s)).length, 0);
});
test("rows sort by due date, undated last; stages the service keeps out of the main table fold", () => {
  const p = projection([stage("late", { dueOn: "2026-12-16" }), stage("none"), stage("early", { dueOn: "2026-12-02" }), stage("old", { inMainTable: false })], null);
  const rows = stageRows(p);
  assert.deepEqual(rows.main.map(s => s.id), ["early", "late", "none"]);
  assert.deepEqual(rows.folded.map(s => s.id), ["old"]);
});
test("a stage is named by its short name, else the first line of its text, else its id", () => {
  assert.equal(stageName(stage("12345678-x", { shortName: "团队试用" }), "ignored"), "团队试用");
  assert.equal(stageName(stage("12345678-x"), "\n  第一行\n第二行"), "第一行");
  assert.ok(stageName(stage("12345678-x")).includes("12345678"));
});
test("the overdue note names the time zone and the day it counted", () => {
  assert.equal(overdueNote(projection([], null)), "按 Asia/Tashkent 的 2026-12-03 算");
});
test("the unassigned line never says zero when there are some, and says when the read was partial", () => {
  assert.equal(unownedLine(3, { items: 10, complete: true }), "3 项未关闭任务未归属阶段");
  assert.match(unownedLine(3, { items: 10, complete: false }), /已读 10 项，未读全/);
  assert.equal(unownedLine(0, null), "没有未归属阶段的未关闭任务");
});
test("tasks group as 进行/卡住/未开始/已关闭 and empty groups are left out", () => {
  const groups = groupTasks([{ phase: "running", taskState: "in_progress" }, { phase: "blocked", taskState: "in_progress" }, { phase: "x", taskState: "closed" }] as never);
  assert.ok(groups.length >= 2);
  assert.ok(groups.every(group => group.tasks.length > 0));
});
test("only open Tasks the service marks unassigned go in the unassigned area", () => {
  assert.equal(isUnowned({ taskState: "todo", stageOwnership: { state: "unassigned", reason: null } } as never), true);
  assert.equal(isUnowned({ taskState: "closed", stageOwnership: { state: "unassigned", reason: null } } as never), false);
  assert.equal(isUnowned({ taskState: "todo", stageOwnership: { state: "none", reason: "x" } } as never), false);
  assert.equal(isUnowned({ taskState: "todo" } as never), false);
});
test("the ladder summary lists a level with no recorded status as 未登记", () => {
  const text = ladderSummary({ available: true, source: { commit: "a".repeat(40) }, levels: [{ key: "M0", name: "最小闭环", status: null, evidenceStages: [] }] } as never);
  assert.equal(text, "M0 未登记");
});
