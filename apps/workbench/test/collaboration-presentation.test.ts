import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryRecord, IncomingRecord } from "@evoloop/contracts/delivery";
import {
  canApplyIncoming, clearReceipt, connectionSummary, mergeById, readReceipts, reasonText, receiptSettled, receiptsFor, rememberReceipt, type Receipt,
} from "../src/features/collaboration/collaborationPresentation.ts";

function memoryStore() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("connector reasons are said in Chinese; an unknown one is kept verbatim", () => {
  assert.deepEqual(reasonText("prior update outcome unresolved; no automatic replay"), { text: "上一次更新的结果还没核实，不会自动重放。", original: null });
  assert.deepEqual(reasonText("brand new failure"), { text: "协调器给出了一条页面不认识的原因，原文在“完整标识”里。", original: "brand new failure" });
  assert.deepEqual(reasonText(null), { text: "", original: null });
});

test("connection status separates configured, verified and failing to verify", () => {
  assert.equal(connectionSummary(false, null, "no grant").label, "未配置");
  assert.equal(connectionSummary(true, "2026-11-09T00:00:00.000Z", "timeout").label, "无法核实");
  assert.equal(connectionSummary(true, null, null).label, "待核实");
  assert.equal(connectionSummary(true, "2026-11-09T00:00:00.000Z", null).tone, "done");
});

test("only a verified editor's title-only change can be applied", () => {
  const base = { state: "pending", reviewOnly: false, actor: { verified: true }, patch: { title: "新标题" } } as unknown as IncomingRecord;
  assert.equal(canApplyIncoming(base), true);
  assert.equal(canApplyIncoming({ ...base, patch: { title: "新标题", status: "done" } }), false);
  assert.equal(canApplyIncoming({ ...base, actor: null }), false);
  assert.equal(canApplyIncoming({ ...base, reviewOnly: true }), false);
  assert.equal(canApplyIncoming({ ...base, state: "review-only" }), false);
});

test("receipts keep IDs per project and actor, replace the same object, and clear by the same IDs", () => {
  const store = memoryStore();
  const receipt = (patch: Partial<Receipt>): Receipt => ({ projectId: "p", actorId: "a", kind: "reconcile", id: "e1", createdAt: "2026-11-09T00:00:00.000Z", ...patch });
  rememberReceipt(store, receipt({}));
  rememberReceipt(store, receipt({ createdAt: "2026-11-09T01:00:00.000Z" }));
  rememberReceipt(store, receipt({ projectId: "q" }));
  rememberReceipt(store, receipt({ actorId: "b", kind: "poll", id: "p" }));
  assert.equal(readReceipts(store).length, 3);
  assert.deepEqual(receiptsFor(store, "p", "a").map(item => item.createdAt), ["2026-11-09T01:00:00.000Z"]);
  clearReceipt(store, receipt({}));
  assert.deepEqual(receiptsFor(store, "p", "a"), []);
  assert.equal(readReceipts({ getItem: () => "{broken", setItem: () => undefined }).length, 0);
  assert.ok(!JSON.stringify(readReceipts(store)).includes("token"));
});

test("a receipt settles only when the original object reads back in a final state", () => {
  const at = "2026-11-09T01:00:00.000Z";
  const delivery = (state: DeliveryRecord["state"]) => ({ state }) as DeliveryRecord;
  const reconcile: Receipt = { projectId: "p", actorId: "a", kind: "reconcile", id: "e", createdAt: at };
  assert.equal(receiptSettled(reconcile, { delivery: delivery("unknown") }), false);
  assert.equal(receiptSettled(reconcile, { delivery: delivery("conflict") }), true);
  assert.equal(receiptSettled({ ...reconcile, kind: "retry" }, { delivery: delivery("failed") }), false);
  assert.equal(receiptSettled({ ...reconcile, kind: "retry" }, { delivery: delivery("pending") }), true);
  assert.equal(receiptSettled({ ...reconcile, kind: "retry" }, { delivery: null }), false);
  assert.equal(receiptSettled({ ...reconcile, kind: "poll" }, { verifiedAt: "2026-11-09T00:59:00.000Z" }), false);
  assert.equal(receiptSettled({ ...reconcile, kind: "poll" }, { verifiedAt: at }), true);
  assert.equal(receiptSettled({ ...reconcile, kind: "review" }, { incoming: { state: "unknown" } as IncomingRecord }), false);
  assert.equal(receiptSettled({ ...reconcile, kind: "review" }, { incoming: { state: "rejected" } as IncomingRecord }), true);
});

test("pages merge by identity", () => {
  assert.deepEqual(mergeById([{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "a", v: 2 }], item => item.id), [{ id: "a", v: 2 }, { id: "b", v: 1 }]);
});
