import assert from "node:assert/strict";
import { test } from "node:test";
import type { Stage } from "@evoloop/contracts";
import type { OrchestrationLoop } from "@evoloop/contracts/orchestration";
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import { managedTargetProblem, scheduleTemplate, suspendSchedule } from "../src/scheduling/managedTarget.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const goalId = "33333333-3333-4333-8333-333333333333";
const stageId = "44444444-4444-4444-8444-444444444444";
const loopId = "55555555-5555-4555-8555-555555555555";
const target = { loopId, stageId };
const definition = { projectId, id: "66666666-6666-4666-8666-666666666666", version: 3, state: "active",
  revision: { timezone: "Asia/Taipei", rule: { kind: "daily", localTime: "09:00" }, misfire: { kind: "latest" }, overlap: "skip",
    template: { title: "巡检", content: "核对来源", acceptance: "留下报告", owner: "analyst", managedTarget: target },
    authorization: { scopeId: "project", roleId: "analyst", authorizedBy: "owner", expiresAtUtc: null } } } as ScheduleDefinition;
const loop = { projectId, id: loopId, stageId, goalId, state: "active", allowedBusinessRoleIds: ["analyst"] } as OrchestrationLoop;
const stage = { projectId, id: stageId, goalId, state: "active", deliverable: "固定报告" } as Stage;
const values = { title: "更新后的巡检", content: "保留来源", acceptance: "留下新报告", owner: "analyst",
  managedTarget: JSON.stringify({ loopId: otherProjectId, stageId: otherProjectId }) };

test("ordinary edit preserves the recorded target exactly and cannot rebind it through form values", () => {
  const revised = scheduleTemplate(values, definition);
  assert.deepEqual(revised.managedTarget, target);
  assert.equal(revised.title, "更新后的巡检");
  assert.equal(managedTargetProblem(projectId, definition, loop, stage), null);
  const suspended = suspendSchedule(definition, "paused", "先暂停核对", "reviewer");
  assert.deepEqual(suspended.template, definition.revision.template);
  assert.equal(suspended.authorization.authorizedBy, "reviewer");
  assert.equal(suspended.expectedVersion, 3);
});

test("ordinary schedule without a managed target does not gain one while editing", () => {
  const ordinary = { ...definition, revision: { ...definition.revision,
    template: { ...definition.revision.template, managedTarget: undefined } } };
  const revised = scheduleTemplate(values, ordinary);
  assert.equal(Object.hasOwn(revised, "managedTarget"), false);
});

test("target verification rejects missing, cross-project and changed Loop/Stage facts", () => {
  assert.match(managedTargetProblem(projectId, definition, null, stage)!, /不在当前项目/);
  assert.match(managedTargetProblem(projectId, definition, loop, null)!, /不在当前项目/);
  assert.match(managedTargetProblem(projectId, definition, { ...loop, projectId: otherProjectId }, stage)!, /不在当前项目/);
  assert.match(managedTargetProblem(projectId, definition, loop, { ...stage, projectId: otherProjectId })!, /不在当前项目/);
  assert.match(managedTargetProblem(projectId, definition, { ...loop, stageId: otherProjectId }, stage)!, /不一致/);
  assert.match(managedTargetProblem(projectId, definition, loop, { ...stage, goalId: otherProjectId })!, /不一致/);
  assert.match(managedTargetProblem(projectId, definition, { ...loop, state: "stopped" }, stage)!, /已停止/);
  assert.match(managedTargetProblem(projectId, definition, loop, { ...stage, state: "reviewed" })!, /不再活动/);
  assert.match(managedTargetProblem(projectId, definition, { ...loop, allowedBusinessRoleIds: [] }, stage)!, /职责/);
});
