import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { MutationContext } from "../src/workflow/ActionForm.tsx";
import { LeaderTaskFacts } from "../src/workflow/LeaderTaskFacts.tsx";
import { TaskWorkflow } from "../src/workflow/TaskWorkflow.tsx";

const owner = "10000002-0000-4000-8000-000000000002";
const task = { projectId: "10000001-0000-4000-8000-000000000001", id: "10000003-0000-4000-8000-000000000003",
  version: 2, currentRevisionId: "10000004-0000-4000-8000-000000000004", title: "保留原任务编辑", kind: "implementation",
  content: "已写正文", acceptance: "独立验收", owner, state: "todo" };
const detail = { task, revision: { id: task.currentRevisionId }, basis: null, links: [], impacts: [], deliveries: [], observations: [], closures: [] } as unknown as TaskDetail;
const context = { token: "fixture", projectId: task.projectId,
  principal: { actorId: "editor", projectIds: [task.projectId], permissions: ["read", "write"] }, blocked: false,
  onAttempt: () => true, onKnown: () => {}, onChanged: () => {}, draftScope: `task:${task.id}`, draftBaseline: task.currentRevisionId } as MutationContext;

test("Task edit remains available while the Role directory is loading or unavailable", () => {
  const html = renderToStaticMarkup(createElement(TaskWorkflow, { context, detail, mode: "actions" }));
  assert.match(html, /更新任务内容/);
  assert.match(html, /name="content"/);
  assert.match(html, /name="acceptance"/);
  assert.match(html, /当前负责者（职责目录待核对）/);
  assert.match(html, new RegExp(`value="${owner}"`));
});

test("Task actions expose planning, dependency and exact-position Leader review", () => {
  const leader: LeaderWorkTask = {
    kind: "task", taskId: task.id, version: task.version, currentRevisionId: task.currentRevisionId,
    workChangeSequence: 17, title: task.title, taskKind: "implementation", taskState: "todo",
    phase: "ready", nextAction: "核对当前版本后安排执行", responsible: { kind: "role", id: owner, label: "实施负责人" },
    assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null,
    goal: null, stage: null,
    plan: { plannedStartAt: null, dueAt: null, priority: null, version: 0, actorId: null, updatedAt: null },
    dependencies: [], dependencyVersion: 0, review: null,
    dates: { createdAt: "2026-10-29T00:00:00Z", businessChangedAt: "2026-10-29T00:00:00Z",
      startedAt: null, completedAt: null, observedAt: "2026-10-29T00:00:00Z" },
    actionKey: "task:fixture",
  };
  const reviewContext = { ...context,
    principal: { ...context.principal, permissions: ["read", "write", "review"] } } as MutationContext;
  const html = renderToStaticMarkup(createElement(TaskWorkflow, {
    context: reviewContext, detail, leader, mode: "actions",
  }));
  assert.match(html, /设置计划、截止与优先级/);
  assert.match(html, /设置前置 Task 依赖/);
  assert.match(html, /记录 Leader 处理决定/);
  assert.match(html, /已核对当前工作/);
});

test("Task detail exposes current plan, responsibility, consumer, source and next action", () => {
  const leader: LeaderWorkTask = {
    kind: "task", taskId: task.id, version: task.version, currentRevisionId: task.currentRevisionId,
    workChangeSequence: 21, title: task.title, taskKind: "implementation", taskState: "todo",
    phase: "blocked", nextAction: "等待前置结果验收", responsible: { kind: "role", id: owner, label: "实施负责人" },
    assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: "dependency",
    goal: { goalId: "10000005-0000-4000-8000-000000000005", outcome: "交付可核对结果" },
    stage: { stageId: "10000006-0000-4000-8000-000000000006", deliverable: "最小切片" },
    plan: { plannedStartAt: "2026-10-29T01:00:00Z", dueAt: "2026-10-30T01:00:00Z",
      priority: 2, version: 3, actorId: "leader", updatedAt: "2026-10-29T00:00:00Z" },
    dependencies: [{ taskId: "10000007-0000-4000-8000-000000000007", title: "前置结果",
      state: "in_progress", currentRevisionId: "10000008-0000-4000-8000-000000000008",
      acceptanceSatisfied: false, reason: "需先验收" }],
    dependencyVersion: 2, review: null,
    dates: { createdAt: "2026-10-29T00:00:00Z", businessChangedAt: "2026-10-29T00:00:00Z",
      startedAt: null, completedAt: null, observedAt: "2026-10-29T00:00:00Z" },
    actionKey: "task:fixture",
  };
  const withAcceptance = { ...detail, proposal: {
    projectId: task.projectId, taskId: task.id, taskRevisionId: task.currentRevisionId, stageId: null,
    consumer: "acceptance-agent", useRequired: true, acceptanceMode: "independent_agent",
    evidence: "来自需求会话的固定依据", stopCondition: "前置结果变化时停止", createdAt: "2026-10-29T00:00:00Z",
  } } as TaskDetail;
  const html = renderToStaticMarkup(createElement(LeaderTaskFacts, {
    leader, detail: withAcceptance, projectId: task.projectId,
  }));
  assert.match(html, /等待前置结果验收/);
  assert.match(html, /P2 · 计划开始/);
  assert.match(html, /实施负责人/);
  assert.match(html, /acceptance-agent/);
  assert.match(html, /来自需求会话的固定依据/);
  assert.match(html, /仍在等待真实验收/);
});
