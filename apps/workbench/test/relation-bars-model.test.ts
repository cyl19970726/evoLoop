// Task 13462b20: the pure parts of the document and stage relation bars.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dueText, deliveryCounts } from "../src/features/workflow/stageRelationsModel.ts";
import { artifactIsDocument, documentDelivery, taskItem } from "../src/features/documents/documentRelationsModel.ts";

test("the due text counts calendar days from the projection's own today, and says nothing without a date", () => {
  assert.equal(dueText("2026-12-02", "2026-11-23"), "12-02到期 · 还有 9 天");
  assert.equal(dueText("2026-11-23", "2026-11-23"), "11-23到期 · 就是今天");
  assert.equal(dueText("2026-11-21", "2026-11-23"), "11-21到期 · 已过 2 天");
  assert.equal(dueText("2027-01-02", "2026-12-30"), "01-02到期 · 还有 3 天");
  assert.equal(dueText(null, "2026-11-23"), null);
  assert.equal(dueText("soon", "2026-11-23"), null);
});

test("delivery counts only open tasks: no answer yet is waiting, a failed use is failed", () => {
  const task = (taskState: string, observationResult: string | null | undefined) =>
    ({ taskState, delivery: observationResult === undefined ? null : { observationResult } }) as never;
  assert.deepEqual(deliveryCounts([task("in_progress", null), task("todo", "failed"), task("done", null), task("in_progress", "used"), task("todo", undefined)]), { waiting: 1, failed: 1 });
  assert.deepEqual(deliveryCounts([]), { waiting: 0, failed: 0 });
});

test("a delivery names a document by its own two address forms only", () => {
  assert.ok(artifactIsDocument("document:d1@r1", "p", "d1"));
  assert.ok(artifactIsDocument("#/p/p/documents/d1?revision=r1", "p", "d1"));
  assert.ok(!artifactIsDocument("document:d10@r1", "p", "d1"));
  assert.ok(!artifactIsDocument("https://example.test/document:d1@r1", "p", "d1"));
});

test("the document's delivery word is the newest answer for the newest delivery naming it, 待验收 without one", () => {
  const deliveries = [
    { id: "x1", artifactRef: "document:d1@r1", createdAt: "2026-11-01T00:00:00Z" },
    { id: "x2", artifactRef: "document:d1@r2", createdAt: "2026-11-02T00:00:00Z" },
    { id: "x3", artifactRef: "document:other@r1", createdAt: "2026-11-03T00:00:00Z" },
  ];
  const observations = [{ deliveryId: "x1", result: "used", createdAt: "2026-11-01T01:00:00Z" }, { deliveryId: "x2", result: "failed", createdAt: "2026-11-02T01:00:00Z" }];
  assert.deepEqual(documentDelivery({ deliveries, observations } as never, "p", "d1"), { word: "使用失败" });
  assert.deepEqual(documentDelivery({ deliveries: deliveries.slice(1), observations: [] } as never, "p", "d1"), { word: "待验收" });
  assert.equal(documentDelivery({ deliveries: [], observations: [] } as never, "p", "d1"), null);
});

test("the task item names the owning task, a single referencing task, or counts several", () => {
  const ref = (taskId: string) => ({ taskId }) as never;
  assert.deepEqual(taskItem("t1", [ref("a"), ref("b")]), { kind: "primary" });
  assert.deepEqual(taskItem(null, [ref("a")]), { kind: "only", task: ref("a") });
  assert.deepEqual(taskItem(undefined, [ref("a"), ref("b"), ref("c")]), { kind: "many", count: 3 });
  assert.deepEqual(taskItem(null, []), { kind: "none" });
});
