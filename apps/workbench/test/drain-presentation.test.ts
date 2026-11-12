import assert from "node:assert/strict";
import { test } from "node:test";
import { drainNotice } from "../src/app/drainPresentation.ts";

const base = { actorId: "target-owner", reason: "发布 0dd0baa", changedAt: "2026-11-11T02:00:00.000Z", queued: { messages: 8, runs: 1 } };
const counts = (runs: number, messageTurns: number) => ({ runs: [], messageTurns: [], counts: { runs, messageTurns, total: runs + messageTurns } });

test("the page says nothing while the instance is active, what is left while draining, and that it may stop once drained", () => {
  assert.equal(drainNotice(null), null);
  assert.equal(drainNotice({ items: [], nextCursor: null } as never), null, "an older service that does not know the path says nothing");
  assert.equal(drainNotice({ ...base, state: "active", inFlight: counts(0, 0) }), null);
  const draining = drainNotice({ ...base, state: "draining", inFlight: counts(3, 2) }, iso => `T(${iso.slice(11, 16)})`)!;
  assert.equal(draining.tone, "waiting");
  assert.match(draining.text, /实例排空中：不再启动新的 Run 和消息 Turn（新消息照常保存并排队，已排队 8 条消息、1 个 Run）/);
  assert.match(draining.text, /还有 5 项在途（3 个 Run、2 个消息 Turn），全部完成后显示“已排空”/);
  assert.equal(draining.detail, "target-owner 于 T(02:00) 开启：发布 0dd0baa");
  const drained = drainNotice({ ...base, state: "drained", inFlight: counts(0, 0) })!;
  assert.equal(drained.tone, "info");
  assert.match(drained.text, /实例已排空，可以停服：没有在途的 Run 和消息 Turn。排队中的 8 条消息和 1 个 Run 在解除排空后按原顺序继续/);
  assert.doesNotMatch(drained.text, /排空中/);
  assert.doesNotMatch(drainNotice({ ...base, state: "draining", queued: { messages: 0, runs: 0 }, inFlight: counts(1, 0) })!.text, /已排队/);
});
