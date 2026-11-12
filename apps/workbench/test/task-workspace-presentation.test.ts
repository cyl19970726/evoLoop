import assert from "node:assert/strict";
import test from "node:test";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  latestProgressPresentation, progressEventName, taskGoal, taskTimestamp, taskType,
} from "../src/features/workflow/taskWorkspacePresentation.ts";

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

test("Task goal is the explicit stage goal only; the body is never quoted back as a goal", () => {
  assert.equal(taskGoal(item), "让读者判断下一步");
  assert.equal(taskGoal({ ...item, goal: { ...item.goal!, outcome: "  改 `apps/x.ts` 里的显示  " } }), "改 `apps/x.ts` 里的显示", "inline code is kept for rendering");
  assert.equal(taskGoal({ ...item, goal: null }), null, "no stage goal: no goal section, so the first body paragraph is not repeated");
  assert.equal(taskGoal(null), null);
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

test("latest progress never shows an internal event name", () => {
  assert.equal(progressEventName({ eventName: "交付已登记", entityKind: "delivery" }), "交付已登记");
  assert.equal(progressEventName({ eventName: "task.revised", entityKind: "task" }), "任务内容或状态更新");
  assert.equal(progressEventName({ eventName: "", entityKind: "run" }), "运行状态已更新");
  const raw = latestProgressPresentation({ ...item, latestProgress: { ...item.latestProgress!, eventName: "delivery.recorded" } });
  assert.equal(raw.name, "交付已登记");
  assert.equal(raw.source, "交付已登记");
});
