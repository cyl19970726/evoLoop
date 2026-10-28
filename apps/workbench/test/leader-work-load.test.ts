import assert from "node:assert/strict";
import test from "node:test";
import type { LeaderWorkDocument, LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { loadLeaderDocumentsForIds } from "../src/workflow/leaderWorkLoad.ts";

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
