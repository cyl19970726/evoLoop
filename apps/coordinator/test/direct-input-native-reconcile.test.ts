import assert from "node:assert/strict";
import test from "node:test";
import type { DirectInputRecord } from "@evoloop/contracts/direct-input";
import type { RuntimeBinding } from "@evoloop/contracts/runtime";
import { RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { DirectInputService } from "../src/direct-input/service.js";

const projectId = "97000001-0000-4000-8000-000000000001";
const sessionId = "97000002-0000-4000-8000-000000000002";
const turnId = "97000003-0000-4000-8000-000000000003";
const binding: RuntimeBinding = { projectId, sessionId, roleId: "role", nativeThreadId: "thread",
  nativeSessionId: "thread", cwd: "/private/tmp/isolated", authorizationScope: "test",
  owner: "evoloop-codex-app-server" };
const principal = { actorId: "sender", projectIds: [projectId], permissions: ["read", "write"] as Array<"read" | "write"> };
const input = (inputId: string, kind: "run" | "message", state: DirectInputRecord["state"] = "unknown"): DirectInputRecord => ({
  projectId, sessionId, inputId, operationId: inputId, actorId: "sender", content: "private input",
  mode: "steer", source: { kind, id: `source-${kind}`, processingId: kind === "message" ? "processing" : null },
  expectedTurnId: turnId, actualTurnId: null, nativeItemId: null, state, reason: null,
  version: 1, createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z",
});

test("materialized alpha.6 clientId links two steers on one Turn without guessing by text", async () => {
  const first = "97000004-0000-4000-8000-000000000004", second = "97000005-0000-4000-8000-000000000005";
  const records = new Map([[first, input(first, "run")], [second, input(second, "message")]]);
  const accepted: Array<[string, string, string | null]> = [];
  const store = { get: async (_project: string, id: string) => records.get(id) ?? null,
    accept: async (_project: string, id: string, turn: string, item: string | null) => {
      accepted.push([id, turn, item]); return { ...records.get(id)!, state: "accepted" as const, actualTurnId: turn, nativeItemId: item };
    } };
  const runtime = { registerBinding: async () => {}, listTurns: async () => ({ data: [{ id: turnId, status: "completed" }], nextCursor: null }),
    listItems: async () => ({ data: [
      { id: "item-first", type: "userMessage", clientId: first, content: [{ type: "text", text: "same body" }] },
      { id: "item-second", type: "userMessage", clientId: second, content: [{ type: "text", text: "same body" }] },
    ], nextCursor: null }) };
  const service = new DirectInputService({ store: store as never, runtime: () => runtime as never,
    canWrite: () => true, admission: async () => { throw Error("unused"); }, bindingFor: async () => binding });
  assert.equal((await service.reconcile(principal, projectId, first)).nativeItemId, "item-first");
  assert.equal((await service.reconcile(principal, projectId, second)).nativeItemId, "item-second");
  assert.deepEqual(accepted, [[first, turnId, "item-first"], [second, turnId, "item-second"]]);
});

test("unavailable native Item or zero-Turn history preserves the original intent", async () => {
  const id = "97000006-0000-4000-8000-000000000006";
  const record = input(id, "message", "attempted");
  let unknownCount = 0;
  const store = { get: async () => record, unknown: async () => { unknownCount++; return { ...record, state: "unknown" as const }; },
    accept: async () => { assert.fail("unreadable history cannot prove acceptance"); } };
  let zeroTurn = false;
  const runtime = { registerBinding: async () => {},
    listTurns: async () => zeroTurn ? Promise.reject(new RuntimeServerError("thread/turns/list", 7, -32600, "not materialized")) :
      { data: [{ id: turnId, status: "inProgress" }], nextCursor: null },
    listItems: async () => { throw new RuntimeServerError("thread/items/list", 8, -32601, "not supported yet"); } };
  const service = new DirectInputService({ store: store as never, runtime: () => runtime as never,
    canWrite: () => true, admission: async () => { throw Error("unused"); }, bindingFor: async () => binding });
  assert.equal((await service.reconcile(principal, projectId, id)).state, "unknown");
  assert.equal(unknownCount, 1);
  zeroTurn = true;
  const startRecord = { ...record, mode: "start" as const, expectedTurnId: null };
  store.get = async () => startRecord;
  assert.equal((await service.reconcile(principal, projectId, id)).state, "unknown");
  assert.equal(unknownCount, 2);
});

test("after a Turn ends, the native Item of an accepted start and of an accepted supplement is read back and recorded; an unfinished Turn, an ambiguous history or a failed read records nothing", async () => {
  const start = "97000010-0000-4000-8000-000000000010", steer = "97000011-0000-4000-8000-000000000011", startOp = "97000012-0000-4000-8000-000000000012";
  const accepted = (id: string, mode: "start" | "steer", operationId: string): DirectInputRecord =>
    ({ ...input(id, "message", "accepted"), operationId, mode, actualTurnId: turnId, expectedTurnId: mode === "steer" ? turnId : null });
  const records = [accepted(start, "start", startOp), accepted(steer, "steer", steer)];
  const recorded: Array<[string, string, string | null]> = [];
  const store = { unboundAccepted: async () => records,
    accept: async (_project: string, id: string, turn: string, item: string | null) => { recorded.push([id, turn, item]); return records[0]!; } };
  let turnStatus = "completed", completedAtUtc: string | null = "2026-11-11T00:00:00.000Z", items: unknown[] = [], failRead = false;
  const runtime = { isReady: () => true, registerBinding: async () => {},
    listTurns: async () => ({ data: [{ id: turnId, status: turnStatus, completedAtUtc }], nextCursor: null }),
    listItems: async () => { if (failRead) throw new Error("history unavailable"); return { data: items, nextCursor: null }; } };
  let writer = true;
  const service = new DirectInputService({ store: store as never, runtime: () => runtime as never, canWrite: () => writer,
    admission: async () => { throw Error("unused"); }, bindingFor: async () => binding });
  const startItem = { id: "item-start", type: "userMessage", clientId: start, content: [{ type: "text", text: `[evoloop-message-operation:${startOp}]\nhello` }] };
  const steerItem = { id: "item-steer", type: "userMessage", clientId: steer, content: [{ type: "text", text: "more" }] };
  // The Turn has not finished: nothing is read into the record yet.
  turnStatus = "inProgress"; completedAtUtc = null; items = [startItem, steerItem];
  assert.equal(await service.backfillItems(), 0); assert.deepEqual(recorded, []);
  // Finished: both Items are recorded. The start is found by its marker, the supplement by its client ID.
  turnStatus = "completed"; completedAtUtc = "2026-11-11T00:00:00.000Z";
  assert.equal(await service.backfillItems(), 2);
  assert.deepEqual(recorded, [[start, turnId, "item-start"], [steer, turnId, "item-steer"]]);
  // Two Items that both claim the same input: no guess.
  recorded.length = 0; items = [startItem, { ...startItem, id: "item-start-2" }, steerItem];
  assert.equal(await service.backfillItems(), 1); assert.deepEqual(recorded, [[steer, turnId, "item-steer"]]);
  // A read that fails proves nothing and never throws.
  recorded.length = 0; failRead = true;
  assert.equal(await service.backfillItems(), 0); assert.deepEqual(recorded, []);
  // Not the current writer: no reads, no writes.
  failRead = false; items = [startItem, steerItem]; writer = false;
  assert.equal(await service.backfillItems(), 0); assert.deepEqual(recorded, []);
});
