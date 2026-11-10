// 负责职责与同职责的其他智能体: a record of another project in the bindings or the agent list is reported as a
// mismatch, never dropped quietly; only agents of this project bound to the owner role are offered.
import assert from "node:assert/strict";
import test from "node:test";
import type { RoleSessionBinding } from "@evoloop/contracts/roles";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { boundAgents } from "../src/features/workflow/taskOwnerPresentation.ts";

const projectId = "10000000-0000-4000-8000-000000000001";
const owner = "20000000-0000-4000-8000-000000000002";
const binding = (sessionId: string, overrides: Partial<RoleSessionBinding> = {}): RoleSessionBinding => ({
  projectId, id: `b-${sessionId}`, roleId: owner, sessionId, roleRevisionId: "r", actorId: "a", note: "", createdAtUtc: "2026-11-01T00:00:00.000Z", ...overrides,
});
const session = (id: string, overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord => ({
  projectId, id, roleId: owner, cwd: "/w", authorizationScope: "s", model: "m", sandbox: "danger-full-access", approvalPolicy: "never",
  state: "ready", version: 1, nativeThreadId: "t", nativeSessionId: "n", operationId: "o", actorId: "a", createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z", ...overrides,
});

test("bound agents of this project and role are offered", () => {
  const result = boundAgents(projectId, owner, [binding("s1")], [session("s1"), session("s2")]);
  assert.deepEqual(result.agents.map(item => item.id), ["s1"]);
  assert.equal(result.note, null);
});

test("an agent record of another project is a mismatch, not a quiet filter", () => {
  assert.throws(() => boundAgents(projectId, owner, [binding("s1")], [session("s1"), session("s9", { projectId: "other" })]), /与当前项目不符/);
  assert.throws(() => boundAgents(projectId, owner, [binding("s1", { projectId: "other" })], [session("s1")]), /与当前项目不符/);
  assert.throws(() => boundAgents(projectId, owner, [binding("s1", { roleId: "another-role" })], [session("s1")]), /与当前项目不符/);
});

test("a binding whose agent is not found is named in the note", () => {
  const result = boundAgents(projectId, owner, [binding("s1"), binding("s3")], [session("s1")]);
  assert.deepEqual(result.agents.map(item => item.id), ["s1"]);
  assert.match(result.note ?? "", /未能核对/);
});
