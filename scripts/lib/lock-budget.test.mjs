import assert from "node:assert/strict";
import test from "node:test";
import { lockSafeConcurrency, nominalLockSlots } from "./lock-budget.mjs";

test("a default PostgreSQL (64 x 100) carries fewer concurrent test files than the runner's default of 4", () => {
  assert.equal(nominalLockSlots({ maxLocksPerTransaction: 64, maxConnections: 100 }), 6400);
  assert.equal(lockSafeConcurrency({ maxLocksPerTransaction: 64, maxConnections: 100 }), 2);
});

test("the CI server (256 x 200) carries more than 4 files, a tiny lock table still runs one", () => {
  assert.ok(lockSafeConcurrency({ maxLocksPerTransaction: 256, maxConnections: 200 }) >= 4);
  assert.equal(lockSafeConcurrency({ maxLocksPerTransaction: 8, maxConnections: 20 }), 1);
});

test("prepared transactions enlarge the table", () => {
  assert.ok(lockSafeConcurrency({ maxLocksPerTransaction: 64, maxConnections: 100, maxPreparedTransactions: 100 }) > 2);
});
