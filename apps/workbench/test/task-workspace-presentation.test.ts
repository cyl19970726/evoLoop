import assert from "node:assert/strict";
import test from "node:test";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  latestProgressPresentation, taskGoal, taskTimestamp, taskType,
} from "../src/workflow/taskWorkspacePresentation.ts";

const stamp = "2026-10-31T08:15:00.000Z";
const item = {
  kind: "task", taskId: "task", version: 2, currentRevisionId: "revision",
  workChangeSequence: 9, title: "Task", taskKind: "research", taskState: "todo", phase: "unassigned",
  nextAction: "等待承接", responsible: { kind: "role", id: "role", label: "负责 Role role" },
  assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null,
  goal: { goalId: "goal", outcome: "让读者判断下一步" }, stage: null, plan: null,
  dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp },
  latestProgress: {
    sequence: 12, entityKind: "delivery", entityId: "delivery", eventName: "交付已登记",
    changedAt: "2026-10-31T09:30:00.000Z",
  },
  actionKey: "task:task:v2:unassigned:9",
} satisfies LeaderWorkTask;

test("Task workspace labels use the current work type and explicit fallback", () => {
  assert.equal(taskType("implementation"), "实施");
  assert.equal(taskType("validation"), "验证");
  assert.equal(taskType(null), "未分类");
});

test("Task goal prefers the real stage goal and otherwise reads the Task body", () => {
  assert.equal(taskGoal(item, { content: "# Heading\n\nFallback goal" }), "让读者判断下一步");
  assert.equal(taskGoal({ ...item, goal: null }, { content: "# Heading\n\nFallback **goal**" }), "Fallback goal");
  assert.equal(taskGoal(null, { content: "# Heading only" }), "目标见任务正文");
});

test("latest progress distinguishes a real business event from unavailable or missing data", () => {
  const current = latestProgressPresentation(item);
  assert.equal(current.name, "交付已登记");
  assert.equal(current.time, taskTimestamp("2026-10-31T09:30:00.000Z"));
  assert.equal(current.unavailable, false);
  assert.equal(current.missing, false);

  const missing = latestProgressPresentation({ ...item, latestProgress: null });
  assert.equal(missing.name, "未记录");
  assert.equal(missing.missing, true);

  const unavailable = latestProgressPresentation(undefined);
  assert.equal(unavailable.name, "最近进展尚未读回");
  assert.equal(unavailable.unavailable, true);
});
