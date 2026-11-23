// The words and rules behind the overview's first screen (src/features/overview/overviewFirstScreen.ts): who is stalled, the one organisation line,
// "还有 K 项", the result words, and which document is the latest 复盘.
import test from "node:test";
import assert from "node:assert/strict";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { daysSince, latestReview, longestStall, moreText, organisationText, outcomeText, priorityLimit, priorityTitle, stalledTasks } from "../src/features/overview/overviewFirstScreen.ts";

const now = Date.parse("2026-11-23T08:00:00Z");
const ago = (days: number) => new Date(now - days * 86_400_000 - 1000).toISOString();
const row = (taskId: string, phase: string, changed: string, extra: Partial<LeaderWorkTask> = {}) =>
  ({ taskId, title: `任务 ${taskId}`, phase, taskState: "in_progress", nextAction: "", responsible: { kind: "role", id: null, label: "开发" }, dates: { businessChangedAt: changed },
    delivery: null, queueHold: null, pendingImpactCount: 0, dependencies: [], ...extra }) as unknown as LeaderWorkTask;

test("a blocked or rework task with three days without progress is stalled; younger ones, other phases and closed tasks are not", () => {
  const rows = [row("old", "blocked", ago(4)), row("edge", "rework", ago(3)), row("young", "blocked", ago(1)), row("fine", "running", ago(9)),
    row("closed", "blocked", ago(9), { taskState: "done" } as Partial<LeaderWorkTask>), row("undated", "blocked", "not a date")];
  assert.deepEqual(stalledTasks(rows, now).map(task => [task.taskId, task.days]), [["old", 4], ["edge", 3]], "the longest first; 3 days counts");
  assert.equal(longestStall(rows, now), 4, "the longest wait counts every blocked or rework task, not only the escalated");
  assert.equal(longestStall([row("a", "running", ago(5))], now), null);
});

test("the latest progress, not the last change of the record, is when a task stopped moving", () => {
  const moved = row("moved", "blocked", ago(10), { latestProgress: { changedAt: ago(1) } } as Partial<LeaderWorkTask>);
  assert.deepEqual(stalledTasks([moved], now), [], "progress yesterday: not stalled");
});

test("days since a time are whole days, never negative, and unknown when the time is missing", () => {
  assert.equal(daysSince(ago(2), now), 2);
  assert.equal(daysSince(new Date(now + 5000).toISOString(), now), 0);
  assert.equal(daysSince(null, now), null);
  assert.equal(daysSince("x", now), null);
});

test("the organisation line uses the index counts, names the longest wait only when something is blocked, and says unreadable when there are no counts", () => {
  assert.equal(organisationText({ running: 3, rework: 1, awaiting_acceptance: 2, blocked: 1 }, 13), "组织自己在处理：运行中 3 · 待返工 1 · 待验收 2 · 受阻 1（最久 13 天）");
  assert.equal(organisationText({ running: 3 }, null), "组织自己在处理：运行中 3 · 待返工 0 · 待验收 0 · 受阻 0");
  assert.equal(organisationText({ running: 1, blocked: 0, rework: 0 }, 8), "组织自己在处理：运行中 1 · 待返工 0 · 待验收 0 · 受阻 0", "no blocked or rework task: no longest wait");
  assert.equal(organisationText(undefined, null), "组织自己在处理：这一项读不到");
});

test("the title counts the rows, never a number when it could not be counted; more rows than three say how many are left", () => {
  assert.equal(priorityTitle(5), "要你决定或处理的 · 5");
  assert.equal(priorityTitle(null), "要你决定或处理的");
  assert.equal(moreText(5), "还有 2 项");
  assert.equal(moreText(priorityLimit), null);
  assert.equal(moreText(0), null);
});

test("a use result names whose and what", () => {
  assert.equal(outcomeText("任务甲", "human", "zhang", "used"), "任务甲 · 真人 zhang 已使用");
  assert.equal(outcomeText("任务乙", "agent", "acceptance-agent", "failed"), "任务乙 · 智能体 acceptance-agent 使用失败");
  assert.equal(outcomeText("任务丙", "agent", "a", "notUsed"), "任务丙 · 智能体 a 未使用");
});

test("the latest 复盘 is the one that observed to the latest day, else the one changed last", () => {
  const doc = (id: string, updatedAt: string, observedTo?: string) => ({ id, updatedAt, organizationReview: observedTo ? { observedTo } : null });
  assert.equal(latestReview([doc("a", "2026-11-01"), doc("b", "2026-11-10", "2026-11-09"), doc("c", "2026-11-20", "2026-11-05")])?.id, "b");
  assert.equal(latestReview([doc("a", "2026-11-01"), doc("b", "2026-11-03")])?.id, "b");
  assert.equal(latestReview([]), null);
});
