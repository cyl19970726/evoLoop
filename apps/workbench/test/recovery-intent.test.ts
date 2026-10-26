import assert from "node:assert/strict";
import { test } from "node:test";
import type { Command, Operation } from "@evoloop/contracts";
import { ApiError } from "../src/api.ts";
import type { OperationReceipt } from "../src/recovery.ts";
import { clearRecoveryIntents, recoveryIntent, rememberRecoveryIntent, replayRecoveryIntent, verifyRecoveryOperation } from "../src/recoveryIntent.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const command: Command = { type: "task.create", projectId, operationId, taskId,
  title: "首项真实任务", content: "保留原固定正文", acceptance: "可以实际读取", owner: "Lead" };
const receipt: OperationReceipt = { actorId: "owner", projectId, operationId, taskId,
  commandType: "task.create", createdAt: "2026-10-26T00:00:00Z" };
const applied = { status: "applied" as const, operationId, entityId: taskId, revisionId: taskId, version: 1, replayed: false };
// SHA-256 of core canonicalJson({ actorId: "owner", command }).
const commandHash = "37e82174125e7b03f4a6dd9fff90fdc490c462bc7fc06d258290dcd32ebfac35";

test("same-page recovery reads first and explicitly replays the exact core command after 404", async () => {
  clearRecoveryIntents(); rememberRecoveryIntent("owner", command);
  let reads = 0, sends = 0;
  const result = await replayRecoveryIntent(receipt,
    async () => { reads++; throw new ApiError(404, "not found", { code: "OPERATION_NOT_FOUND" }); },
    async actual => { sends++; assert.deepEqual(actual, command); return applied; });
  assert.deepEqual(result, applied);
  assert.equal(reads, 1); assert.equal(sends, 1);
  clearRecoveryIntents();
});

test("a now-visible operation is confirmed without replay", async () => {
  clearRecoveryIntents(); rememberRecoveryIntent("owner", command);
  const operation = { id: operationId, projectId, actorId: "owner", commandType: "task.create", commandHash, result: applied } as Operation;
  const result = await replayRecoveryIntent(receipt, async () => operation, async () => { throw new Error("must not send"); });
  assert.deepEqual(result, applied);
  clearRecoveryIntents();
});

test("same ID, actor and type with a different command hash stays unconfirmed", async () => {
  clearRecoveryIntents(); rememberRecoveryIntent("owner", command);
  const operation = { id: operationId, projectId, actorId: "owner", commandType: "task.create", commandHash: "different", result: applied } as Operation;
  assert.equal(await verifyRecoveryOperation(receipt, operation), "mismatch");
  await assert.rejects(replayRecoveryIntent(receipt, async () => operation,
    async () => { throw new Error("must not send"); }), /摘要不匹配/);
  clearRecoveryIntents();
});

test("a legacy receipt without its original body cannot confirm even a same-ID record", async () => {
  clearRecoveryIntents();
  const operation = { id: operationId, projectId, actorId: "owner", commandType: "task.create", commandHash, result: applied } as Operation;
  assert.equal(await verifyRecoveryOperation(receipt, operation), "unavailable");
  await assert.rejects(replayRecoveryIntent(receipt, async () => operation,
    async () => { throw new Error("must not send"); }), /没有完整原命令/);
});

test("a visible record for another actor cannot clear this receipt or replay", async () => {
  clearRecoveryIntents(); rememberRecoveryIntent("owner", command);
  const operation = { id: operationId, projectId, actorId: "other", commandType: "task.create", commandHash, result: applied } as Operation;
  await assert.rejects(replayRecoveryIntent(receipt, async () => operation,
    async () => { throw new Error("must not send"); }), /不匹配/);
  clearRecoveryIntents();
});

test("old, refreshed, wrong-actor and non-core receipts cannot replay", async () => {
  clearRecoveryIntents();
  const read404 = async (): Promise<Operation> => { throw new ApiError(404, "not found", { code: "OPERATION_NOT_FOUND" }); };
  const send = async (): Promise<typeof applied> => { throw new Error("must not send"); };
  await assert.rejects(replayRecoveryIntent(receipt, read404, send), /原命令已不在/);
  rememberRecoveryIntent("owner", command);
  assert.equal(await recoveryIntent({ ...receipt, actorId: "someone-else" }), null);
  assert.equal(await recoveryIntent({ ...receipt, projectId: "44444444-4444-4444-8444-444444444444" }), null);
  rememberRecoveryIntent("owner", { type: "document.payload", projectId, operationId });
  clearRecoveryIntents();
  await assert.rejects(replayRecoveryIntent(receipt, read404, send), /原命令已不在/);
});

test("read failure other than 404 never triggers replay", async () => {
  clearRecoveryIntents(); rememberRecoveryIntent("owner", command);
  await assert.rejects(replayRecoveryIntent(receipt,
    async () => { throw new ApiError(503, "offline"); },
    async () => { throw new Error("must not send"); }), /offline/);
  clearRecoveryIntents();
});

test("an unrelated 404 cannot authorize replay", async () => {
  clearRecoveryIntents(); rememberRecoveryIntent("owner", command);
  await assert.rejects(replayRecoveryIntent(receipt,
    async () => { throw new ApiError(404, "project missing", { code: "PROJECT_NOT_FOUND" }); },
    async () => { throw new Error("must not send"); }), /project missing/);
  clearRecoveryIntents();
});
