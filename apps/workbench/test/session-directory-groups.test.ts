import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionClient } from "../src/sessions/client.ts";
import { readSessionDirectoryPages } from "../src/sessions/useSessionDirectoryGroup.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const totals = { current: 5, historical: 37, unclassified: 14 };
const item = (membership: string, number: number) => ({ key: `${membership}:${number}`, membership, title: `${membership} ${number}` });
const response = (items: unknown[], nextCursor: string | null) => Response.json({ items, nextCursor, totals,
  observationCursor: "head", metadata: { generatedAt: "2026-10-27T00:00:00Z", sourceObservedAt: null, partial: !!nextCursor, limitations: [] },
  attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 14 } });

test("current first read is bounded; expanded categories use independent filters and cursors", async () => {
  const previous = globalThis.fetch;
  const requests: Array<{ membership: string | null; cursor: string | null; search: string | null }> = [];
  globalThis.fetch = async input => {
    const query = new URL(String(input), "http://localhost").searchParams;
    const membership = query.get("membership"), cursor = query.get("cursor");
    requests.push({ membership, cursor, search: query.get("search") });
    assert.equal(query.get("limit"), "20");
    if (membership === "current") return response(Array.from({ length: 5 }, (_, i) => item("current", i)), null);
    if (membership === "historical") return cursor
      ? response(Array.from({ length: 17 }, (_, i) => item("historical", i + 20)), null)
      : response(Array.from({ length: 20 }, (_, i) => item("historical", i)), "history-only-cursor");
    if (membership === "unclassified") return response([item("unclassified", 0)], null);
    return Response.json({ message: "missing membership filter" }, { status: 400 });
  };
  try {
    const client = sessionClient("token", projectId);
    const current = await readSessionDirectoryPages(client, "current", "", 1);
    assert.equal(current.items.length, 5);
    assert.deepEqual(requests.map(request => request.membership), ["current"], "opening the sidebar does not fetch history");
    const historical = await readSessionDirectoryPages(client, "historical", "", 2);
    assert.equal(historical.items.length, 37);
    assert.equal(historical.page.nextCursor, null);
    const unclassified = await readSessionDirectoryPages(client, "unclassified", "离线", 1);
    assert.equal(unclassified.items.length, 1);
    assert.deepEqual(requests, [
      { membership: "current", cursor: null, search: null },
      { membership: "historical", cursor: null, search: null },
      { membership: "historical", cursor: "history-only-cursor", search: null },
      { membership: "unclassified", cursor: null, search: "离线" },
    ]);
    await readSessionDirectoryPages(client, "historical", "离线", 1);
    assert.deepEqual(requests.at(-1), { membership: "historical", cursor: null, search: "离线" },
      "search and reopening start from the selected category's first page");
  } finally { globalThis.fetch = previous; }
});

test("a mismatched membership response cannot be displayed under another category", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => response([item("current", 1)], null);
  try {
    await assert.rejects(readSessionDirectoryPages(sessionClient("token", projectId), "historical", "", 1),
      /分类与请求不符/);
  } finally { globalThis.fetch = previous; }
});
