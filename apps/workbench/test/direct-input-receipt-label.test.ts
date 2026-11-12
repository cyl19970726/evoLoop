import assert from "node:assert/strict";
import test from "node:test";
import { receiptLabel } from "../src/features/sessions/useDirectInput.tsx";

test("an accepted input says 'read' only once its native Item is recorded, and never says adopted", () => {
  assert.match(receiptLabel({ state: "accepted", nativeItemId: null }), /运行时已接收；不代表智能体已阅读或采用/);
  const read = receiptLabel({ state: "accepted", nativeItemId: "item-1" });
  assert.match(read, /已读到/);
  assert.match(read, /不代表智能体已采用/);
  assert.doesNotMatch(read, /^已采用/);
  for (const state of ["pending", "attempted", "rejected", "unknown"] as const)
    assert.doesNotMatch(receiptLabel({ state, nativeItemId: "item-1" }), /已读到/, `${state} is not read`);
});
