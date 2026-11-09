import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import { assignedObservedSession, eligibleOwnedSessions } from "../src/features/sessions/assignmentEligibility.ts";

const projectId = "20000001-0000-4000-8000-000000000001";
const taskId = "20000002-0000-4000-8000-000000000002";
const roleId = "20000003-0000-4000-8000-000000000003";
const firstId = "20000004-0000-4000-8000-000000000004";
const secondId = "20000005-0000-4000-8000-000000000005";
const revisionId = "20000006-0000-4000-8000-000000000006";
const task = { projectId, id: taskId, owner: roleId, currentRevisionId: revisionId };
const sessions = [
  { id: firstId, roleId, state: "ready" },
  { id: secondId, roleId, state: "ready" },
  { id: "20000007-0000-4000-8000-000000000007", roleId, state: "closed" },
];
const assignment = (overrides: Partial<TaskSessionAssignment> = {}): TaskSessionAssignment => ({
  projectId, taskId, version: 1, taskRevisionId: revisionId, target: { kind: "owned", sessionId: firstId },
  recipientActorId: null, state: "assigned", ack: null, actorId: "lead", reason: "正式分派", updatedAt: "2026-10-26T00:00:00Z",
  ...overrides,
});

test("new runs and queues follow the exact owned assignment", () => {
  assert.deepEqual(eligibleOwnedSessions(task, sessions, assignment()).map(item => item.id), [firstId]);
  assert.deepEqual(eligibleOwnedSessions(task, sessions, assignment({ state: "accepted" })).map(item => item.id), [firstId]);
});

test("external and old-revision assignments cannot choose a different owned Session", () => {
  assert.deepEqual(eligibleOwnedSessions(task, sessions, assignment({ target: { kind: "external", linkId: secondId } })), []);
  assert.deepEqual(eligibleOwnedSessions(task, sessions, assignment({ taskRevisionId: secondId })), []);
});

test("released or absent assignments preserve the legacy ready same-Role path", () => {
  assert.deepEqual(eligibleOwnedSessions(task, sessions, assignment({ state: "released" })).map(item => item.id), [firstId, secondId]);
  assert.deepEqual(eligibleOwnedSessions(task, sessions, null).map(item => item.id), [firstId, secondId]);
});

test("a mismatched assignment response never enables a run", () => {
  assert.deepEqual(eligibleOwnedSessions(task, sessions, assignment({ taskId: secondId })), []);
});

test("an external HostLink alias retains its proven directory Session in the Task handoff", () => {
  const canonical = { kind: "external" as const, linkId: firstId };
  const alias = { kind: "external" as const, linkId: secondId };
  const observed = { target: canonical, aliases: [canonical, alias], title: "同一原生会话" };
  const unrelated = { target: { kind: "owned" as const, sessionId: firstId }, aliases: [], title: "同名但不同来源" };
  assert.equal(assignedObservedSession(assignment({ target: alias }), projectId, taskId, [unrelated, observed]), observed);
  assert.equal(assignedObservedSession(assignment({ target: alias, projectId: secondId }), projectId, taskId, [observed]), undefined);
  assert.equal(assignedObservedSession(assignment({ target: alias, taskId: secondId }), projectId, taskId, [observed]), undefined);
});
