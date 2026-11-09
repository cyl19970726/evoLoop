import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { api } from "../src/shared/api";
import { errorOutcome, resultOutcome } from "../src/shared/submissionOutcome";
import { roleCardKey, roleListScope, rolesWhileRereading } from "../src/features/roles/roleListRefresh";
import { savedRuntimeNotice } from "../src/features/roles/roleRuntimePresentation";

const operationId = "30000003-0000-4000-8000-000000000003";
const command = { type: "role.runtime.set", operationId } as never;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const reply = (status: number, body: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch; };

test("a saved revision rereads into an open card: same key, kept list, revision shown", () => {
  const before = [{ id: "r1", version: 2 }], after = [{ id: "r1", version: 3 }];
  assert.equal(roleCardKey(before[0]!), roleCardKey(after[0]!), "a new version must not remount the card");
  assert.deepEqual(rolesWhileRereading(roleListScope("t", "p"), roleListScope("t", "p"), before), before, "a same-scope refresh keeps the cards while rereading");
  assert.deepEqual(rolesWhileRereading(roleListScope("t", "p"), roleListScope("t", "p2"), before), [], "another project never shows the old list");
  assert.equal(savedRuntimeNotice(false, false, null), null);
  assert.equal(savedRuntimeNotice(true, true, null), "已保存，正在读取新修订…");
  const view = { binding: { revision: 4 } } as never;
  assert.equal(savedRuntimeNotice(true, false, view), "已保存；回读到第 4 次修订。");
});

test("the real command contract: an applied echo discards the draft and triggers the readback", async () => {
  reply(200, { status: "applied", operationId, entityId: "r1" });
  const outcome = resultOutcome(await api("t").command(command));
  assert.deepEqual([outcome.applied, outcome.failed], [true, false]);
});

test("a rejected save keeps the input and shows the service's error", async () => {
  reply(200, { status: "rejected", operationId, code: "INVALID", message: "技能名称不合法" });
  const outcome = resultOutcome(await api("t").command(command));
  assert.deepEqual([outcome.applied, outcome.failed, outcome.stale], [false, true, false]);
  assert.equal(outcome.message, "技能名称不合法");
});

test("a stale or unverifiable save keeps the draft and says what to do", async () => {
  reply(200, { status: "rejected", operationId, code: "VERSION_CONFLICT", message: "版本已变化" });
  assert.equal(resultOutcome(await api("t").command(command)).stale, true);
  reply(409, { code: "OTHER", message: "业务拒绝" });
  const refused = await api("t").command(command).then(() => null, cause => errorOutcome(cause));
  assert.ok(refused && !refused.applied && refused.failed && !refused.unconfirmed);
  assert.match(refused.message, /草稿保留/);
  reply(200, { status: "applied", operationId: "someone-else", entityId: "r1" });
  const unverified = await api("t").command(command).then(() => null, cause => errorOutcome(cause));
  assert.ok(unverified && !unverified.applied && unverified.unconfirmed);
  assert.match(unverified.message, /原操作 ID/);
});
