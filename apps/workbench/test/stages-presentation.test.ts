import assert from "node:assert/strict";
import { test } from "node:test";
import type { StageProjection, StageProjectionStage } from "@evoloop/contracts/stage-projection";
import { dueCell, groupTasks, isCurrent, isUnowned, ladderHeading, ladderMarks, stageLabel, overdueNote, stageName, stageRows, taskCell, unownedLine } from "../src/features/stages/stagesPresentation.ts";

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
test("the folded ladder row names each level by its number; only a level with no status carries a mark (未登记)", () => {
  const level = (key: string, status: string | null) => ({ key, name: key, status, evidenceStages: [] });
  const marks = ladderMarks({ available: true, source: { commit: null }, levels: [level("M0", "旧机上任务、交付、验收各有记录，共三十个字以上的整句说明"), level("M0.5", null), level("M1", "10-30 以来每天都有一份验收结论，已连续多日"), level("M2", "进行中"), level("M3", "未开始，没有证据"), level("M4", "常驻主机已运行，三十个字以上的整句说明")] } as never);
  assert.deepEqual(marks.map(mark => [mark.key, mark.registered]), [["M0", true], ["M0.5", false], ["M1", true], ["M2", true], ["M3", true], ["M4", true]]);
  assert.equal(ladderHeading({ available: true, source: { commit: null }, levels: marks.map(mark => ({ key: mark.key })) } as never), "验证阶梯 · 6 级");
});
test("a stage without a short name keeps the first line of its text, without the 名称： label", () => {
  assert.equal(stageName({ id: "12345678-aaaa", shortName: null }, "名称：旧阶段的名字\n交付：x"), "旧阶段的名字");
  assert.equal(stageName({ id: "12345678-aaaa", shortName: null }, "没有前缀的第一行\n第二行"), "没有前缀的第一行");
  assert.equal(stageName({ id: "12345678-aaaa", shortName: null }, "名称: 英文冒号"), "英文冒号");
  assert.deepEqual(stageLabel({ id: "a", shortName: "团队试用", dueOn: "2026-12-09" }, { id: "a", deliverable: "x" }), { name: "团队试用", due: { text: "12-09", title: "2026-12-09" } });
  assert.equal(stageLabel(undefined, { id: "a", deliverable: "名称：旧\n" }).due, null, "an unread projection says nothing about the date");
  assert.equal(stageLabel({ id: "a", shortName: null, dueOn: null }, { id: "a", deliverable: "旧" }).due?.text, "未定");
});
