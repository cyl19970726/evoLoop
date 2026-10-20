import assert from "node:assert/strict";
import { test } from "node:test";
import { addReceipt, parseReceipts, removeReceipt, visibleReceipts, type OperationReceipt } from "../src/recovery.ts";

const a: OperationReceipt = {
  actorId: "reviewer-a", projectId: "project-1", taskId: "task-a",
  operationId: "operation-a", commandType: "task.reviewBasis", createdAt: "2026-10-20T00:00:00Z",
};
const b: OperationReceipt = { ...a, taskId: "task-b", operationId: "operation-b" };

test("independent unknown operations survive addition and selective confirmation", () => {
  const both = addReceipt(addReceipt([], a), b);
  assert.deepEqual(both.map(item => item.operationId), ["operation-a", "operation-b"]);
  assert.equal(addReceipt(both, a).length, 2);
  assert.deepEqual(removeReceipt(both, a.operationId), [b]);
});

test("recovery index keeps only receipt fields and isolates identities", () => {
  const raw = JSON.stringify([{ ...a, reason: "sensitive draft", token: "secret" }, b, { ...b, actorId: "reviewer-b", operationId: "operation-c" }]);
  const parsed = parseReceipts(raw);
  assert.equal(parsed.length, 3);
  assert.equal("reason" in parsed[0], false);
  assert.equal("token" in parsed[0], false);
  assert.deepEqual(visibleReceipts(parsed, "reviewer-a", ["project-1"]).map(item => item.operationId), ["operation-a", "operation-b"]);
  assert.deepEqual(visibleReceipts(parsed, "reviewer-b", ["project-1"]).map(item => item.operationId), ["operation-c"]);
  assert.deepEqual(visibleReceipts(parsed, "reviewer-a", ["different-project"]), []);
  assert.deepEqual(parseReceipts("malformed"), []);
});
