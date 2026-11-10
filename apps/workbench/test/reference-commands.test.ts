// Git 与外部来源登记 on the shared command form: each write still goes to its own route with exactly the fields it sent
// before (the coordinator adds project, task and actor), the task decision carries the version and revision recorded
// when the form opened, and a text over the contract's limit is named instead of cut.
import assert from "node:assert/strict";
import test from "node:test";
import { prepareCommand } from "../src/shared/command/rules.ts";
import {
  checkReferenceCommand, formalDecisionCommand, gitReferenceCommand, referenceBody, referencePath, taskReferenceCommand,
} from "../src/features/references/referenceCommands.ts";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000002";
const revisionId = "30000000-0000-4000-8000-000000000003";
const operationId = "40000000-0000-4000-8000-000000000004";
const id = (n: number) => `5000000${n}-0000-4000-8000-00000000000${n}`;
const commit = "a".repeat(40), hash = "b".repeat(64);
const sent = (built: Record<string, unknown>) => {
  const command = prepareCommand(built, projectId, operationId, { validate: candidate => checkReferenceCommand(candidate, "actor") }) as Record<string, unknown>;
  return { command, path: referencePath(command), body: referenceBody(command) };
};

test("登记 Git 固定来源 sends the same body as before, the task only on the receipt", () => {
  const { command, path, body } = sent(gitReferenceCommand({ repositoryId: " evoLoop ", path: " docs/api.md ", commit, contentHash: hash }, { referenceId: id(1), taskId }));
  assert.equal(path, `/api/projects/${projectId}/references/git`);
  assert.deepEqual(body, { referenceId: id(1), repositoryId: "evoLoop", path: "docs/api.md", commit, contentHash: hash, operationId });
  assert.deepEqual([command.type, command.taskId, command.projectId], ["reference.git", taskId, projectId], "the receipt names the write and its task");
});

test("记录正式文档关系 sends the same body as before", () => {
  const { path, body } = sent(formalDecisionCommand({ gitReferenceId: id(1), documentId: id(2), documentRevisionId: id(3), decision: "incorporated", reason: " 已并入第 3 节 " },
    { decisionId: id(4) }));
  assert.equal(path, `/api/projects/${projectId}/references/formal-decisions`);
  assert.deepEqual(body, { decisionId: id(4), gitReferenceId: id(1), documentId: id(2), documentRevisionId: id(3), decision: "incorporated", reason: "已并入第 3 节", operationId });
});

test("采用外部依据 sends the task version and revision recorded when the form opened", () => {
  const values = { slotId: id(5), headVersion: 2, decision: "retain" as const, kind: "git" as const, referenceId: id(1), revision: commit, contentHash: hash,
    reason: "仍适用", actionImpact: "按固定说明改文档" };
  const { path, body } = sent(taskReferenceCommand(values, { taskVersion: 3, revisionId }, { decisionId: id(6), taskId }));
  assert.equal(path, `/api/projects/${projectId}/references/tasks/${taskId}/decisions`);
  assert.deepEqual(body, { decisionId: id(6), taskRevisionId: revisionId, expectedTaskVersion: 3, slotId: id(5), expectedHeadVersion: 2, decision: "retain",
    kind: "git", referenceId: id(1), revision: commit, contentHash: hash, reason: "仍适用", actionImpact: "按固定说明改文档", operationId });
});

test("an incomplete or oversized write is refused with a message, never cut", () => {
  assert.throws(() => gitReferenceCommand({ repositoryId: "r", path: "p", commit: "short", contentHash: hash }, { referenceId: id(1) }), /完整 commit/);
  assert.throws(() => formalDecisionCommand({ gitReferenceId: id(1), documentId: id(2), documentRevisionId: id(3), decision: "adopted", reason: "x".repeat(4001) },
    { decisionId: id(4) }), /理由最多 4000 字，现在是 4001 字/);
  assert.throws(() => taskReferenceCommand({ slotId: id(5), headVersion: 0, decision: "adopt", kind: "git", referenceId: id(1), revision: commit, contentHash: hash,
    reason: "r", actionImpact: "y".repeat(4001) }, { taskVersion: 1, revisionId }, { decisionId: id(6), taskId }), /会改变的实际行动最多 4000 字/);
  // A Git or run source must name its fixed reference by ID; the route's own schema refuses it before anything is sent.
  assert.throws(() => sent(taskReferenceCommand({ slotId: id(5), headVersion: 0, decision: "adopt", kind: "git", referenceId: "not-an-id", revision: commit,
    contentHash: hash, reason: "r", actionImpact: "a" }, { taskVersion: 1, revisionId }, { decisionId: id(6), taskId })), /请补全必需字段/);
});
