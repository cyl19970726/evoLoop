import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeBinding, RuntimePage, RuntimeTurn } from "@evoloop/contracts/runtime";
import { lookupKnownTurn } from "../src/runtime/turn-lookup.js";

const binding = { nativeThreadId: "owned-thread" } as RuntimeBinding;
test("known recent Turn stops before traversing a history of more than 1000", async () => {
  let reads = 0;
  const list = async (_binding: RuntimeBinding, cursor?: string): Promise<RuntimePage<RuntimeTurn>> => {
    reads++;
    assert.equal(cursor, undefined);
    return { data: [{ id: "known", status: "completed" }], nextCursor: "older-100" };
  };
  assert.deepEqual(await lookupKnownTurn(list, binding, "known"), { status: "found", turn: { id: "known", status: "completed" } });
  assert.equal(reads, 1);
});

test("old Turn lookup is continuable and only exhausted history proves not_found", async () => {
  const seen: (string | undefined)[] = [];
  const list = async (_binding: RuntimeBinding, cursor?: string): Promise<RuntimePage<RuntimeTurn>> => {
    seen.push(cursor);
    if (cursor === "page-3") return { data: [{ id: "old", status: "completed" }], nextCursor: "page-4" };
    if (cursor === "page-4") return { data: [], nextCursor: null };
    return { data: [{ id: cursor ?? "recent", status: "completed" }], nextCursor: cursor ? "page-3" : "page-2" };
  };
  const first = await lookupKnownTurn(list, binding, "old");
  assert.deepEqual(first, { status: "partial", nextTurnCursor: "page-3" });
  assert.deepEqual(await lookupKnownTurn(list, binding, "old", "page-3"),
    { status: "found", turn: { id: "old", status: "completed" } });
  assert.deepEqual(await lookupKnownTurn(list, binding, "absent", "page-4"), { status: "not_found" });
  assert.deepEqual(seen, [undefined, "page-2", "page-3", "page-4"]);
});

test("repeated native Turn cursor fails safely", async () => {
  const list = async (): Promise<RuntimePage<RuntimeTurn>> => ({ data: [], nextCursor: "same" });
  await assert.rejects(() => lookupKnownTurn(list, binding, "old", "same"), /cursor repeated/);
});
