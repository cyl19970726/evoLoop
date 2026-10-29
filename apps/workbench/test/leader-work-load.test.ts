import assert from "node:assert/strict";
import test from "node:test";
import type { LeaderWorkDocument, LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  appendLeaderWorkPage, leaderProjectionMatchesTask, loadLeaderDocumentsForIds, visibleLeaderDocuments,
} from "../src/workflow/leaderWorkLoad.ts";

const document = (id: string): LeaderWorkDocument => ({
  kind: "document", documentId: id, version: 1, title: id, documentKind: "report", status: "published",
  currentRevisionId: `${id}-current`, adoptedRevisionId: `${id}-adopted`,
  nextAction: "Review", dates: { createdAt: "2026-10-29T00:00:00Z", currentRevisionAt: "2026-10-29T00:00:00Z",
    adoptedAt: "2026-10-29T00:00:00Z", changedAt: null, observedAt: "2026-10-29T00:00:00Z" },
  references: [], actionKey: `document:${id}`,
});

test("Document lifecycle enrichment continues until every rendered row is covered", async () => {
  const ids = Array.from({ length: 137 }, (_, index) => `document-${index}`);
  const calls: Array<string | undefined> = [];
  const result = await loadLeaderDocumentsForIds(async cursor => {
    calls.push(cursor);
    const page = Number(cursor ?? 0), start = page * 50;
    return {
      items: ids.slice(start, start + 50).map(document),
      nextCursor: start + 50 < ids.length ? String(page + 1) : null,
      total: ids.length, counts: { published: ids.length }, changeSequence: 1,
      observedAt: "2026-10-29T00:00:00Z", partial: false,
    } as LeaderWorkPage<LeaderWorkTask | LeaderWorkDocument>;
  }, ids);
  assert.equal(result.complete, true);
  assert.equal(result.items.size, 137);
  assert.deepEqual(calls, [undefined, "1", "2"]);
});

test("Document lifecycle enrichment rejects a repeated cursor and reports a missing target", async () => {
  let emptyReads = 0;
  const empty = await loadLeaderDocumentsForIds(async () => {
    emptyReads++;
    throw new Error("empty visible sets do not need a lifecycle read");
  }, []);
  assert.equal(empty.complete, true);
  assert.equal(empty.items.size, 0);
  assert.equal(emptyReads, 0);
  await assert.rejects(loadLeaderDocumentsForIds(async () => ({
    items: [], nextCursor: "loop", total: 1, counts: {}, changeSequence: 1,
    observedAt: "2026-10-29T00:00:00Z", partial: false,
  }), ["missing"]), /游标重复/);
  const missing = await loadLeaderDocumentsForIds(async () => ({
    items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 1,
    observedAt: "2026-10-29T00:00:00Z", partial: false,
  }), ["missing"]);
  assert.equal(missing.complete, false);
});

test("Leader index continuation retains prior Task rows in the same changing snapshot", () => {
  const page = (ids: string[], changeSequence: number, nextCursor: string | null) => ({
    items: ids.map(taskId => ({ taskId })), nextCursor, total: 3, counts: { ready: 3 },
    changeSequence, observedAt: "2026-10-29T00:00:00Z", partial: false,
  });
  const merged = appendLeaderWorkPage(page(["one", "two"], 7, "next"),
    page(["two", "three"], 7, null));
  assert.deepEqual(merged.items.map(item => item.taskId), ["one", "two", "three"]);
  assert.equal(merged.nextCursor, null);
  assert.throws(() => appendLeaderWorkPage(page(["one"], 7, "next"),
    page(["two"], 8, null)), /快照已变化/);
});

test("active Document enrichment never asks the default index for hidden archived rows", () => {
  const items = [
    { id: "draft", title: "Draft", kind: "spec", status: "draft" as const },
    { id: "published", title: "Published", kind: "report", status: "published" as const },
    { id: "archived", title: "Archived", kind: "spec", status: "archived" as const },
  ];
  assert.deepEqual(visibleLeaderDocuments(items, "active", "all", "").map(item => item.id),
    ["draft", "published"]);
  assert.deepEqual(visibleLeaderDocuments(items, "archived", "spec", "").map(item => item.id),
    ["archived"]);
});

test("late Leader reads cannot cross Task identity, version or revision", () => {
  const current = { id: "task-two", version: 3, currentRevisionId: "revision-three" };
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-two", version: 3, currentRevisionId: "revision-three",
  }, current), true);
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-one", version: 3, currentRevisionId: "revision-three",
  }, current), false);
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-two", version: 2, currentRevisionId: "revision-three",
  }, current), false);
  assert.equal(leaderProjectionMatchesTask({
    taskId: "task-two", version: 3, currentRevisionId: "revision-two",
  }, current), false);
});
