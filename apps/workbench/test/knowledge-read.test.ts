import test from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeCapabilities, KnowledgeGraph, KnowledgeRevision } from "@evoloop/contracts/knowledge";
import { readKnowledgePage, readPagesTo, serviceState, titleKey } from "../src/features/knowledge/knowledgeRead.ts";
import { knowledgeAvailability } from "../src/features/knowledge/availability.ts";

const caps: KnowledgeCapabilities = { backendVersion: null, backendReachable: true, fixedRevisionRead: "adapter_verified",
  conditionalPublish: "unavailable", boundedRelations: "unavailable", migration: "unsupported", semanticIndex: "unverified" };
const pages = { items: [], nextCursor: "retained-range" };
const q = <T>(data: T | undefined, isFetching = false, isError = false) => ({ data, isFetching, isError });
const fullRead = (state: ReturnType<typeof serviceState>) => knowledgeAvailability(state.capabilities).fullRead;

test("the service counts as readable only with its page index, and a failed reread keeps the old list but not the claim", () => {
  assert.deepEqual(serviceState(q(undefined, true), q(undefined, true)), { standing: "reading", capabilities: null });
  assert.equal(fullRead(serviceState(q(caps), q(pages))), true);
  // While a reread runs, the last answer stays on screen and is marked 正在核对.
  assert.deepEqual(serviceState(q(caps, true), q(pages)), { standing: "checking", capabilities: caps });
  // A failed reread (capabilities or the index beside them) keeps data for reading but no longer counts.
  for (const state of [serviceState(q(caps, false, true), q(pages)), serviceState(q(caps), q(pages, false, true))]) {
    assert.equal(state.standing, "stale");
    assert.equal(fullRead(state), false);
  }
  assert.deepEqual(serviceState(q(undefined, false, true), q(undefined)), { standing: "failed", capabilities: null });
  // Capabilities alone, without the index, are still reading.
  assert.deepEqual(serviceState(q(caps), q(undefined, true)), { standing: "reading", capabilities: null });
});

test("reading several pages stops at the requested depth and refuses a repeated cursor", async () => {
  const book: Record<string, { items: Array<{ id: string }>; nextCursor: string | null }> = {
    "": { items: [{ id: "a" }, { id: "b" }], nextCursor: "2" },
    "2": { items: [{ id: "b" }, { id: "c" }], nextCursor: "3" },
    "3": { items: [{ id: "d" }], nextCursor: null },
  };
  const read = async (cursor?: string) => book[cursor ?? ""]!;
  assert.deepEqual(await readPagesTo(read, 1, item => item.id), { items: [{ id: "a" }, { id: "b" }], nextCursor: "2" });
  assert.deepEqual(await readPagesTo(read, 2, item => item.id), { items: [{ id: "a" }, { id: "b" }, { id: "c" }], nextCursor: "3" });
  assert.deepEqual((await readPagesTo(read, 9, item => item.id)).nextCursor, null);
  await assert.rejects(readPagesTo(async cursor => ({ items: [], nextCursor: cursor ?? "loop" }), 5, () => ""), /分页游标重复/);
});

const projectId = "p1";
const revision = (id: string, rev: string, extra: Partial<KnowledgeRevision> = {}): KnowledgeRevision => ({
  projectId, knowledgeId: id, revision: rev, previousRevision: null, title: `${id} ${rev}`, body: "正文", contentHash: "a".repeat(64),
  pageType: "concept", epistemicStatus: "adopted", validity: "valid", observedValidity: "valid", sources: [], relations: [], createdAt: "2026-11-09T00:00:00Z", ...extra,
});
const edge = (from: string, fromRev: string, to: string, toRev: string, edgeId = `${from}-${to}`) =>
  ({ edgeId, fromKnowledgeId: from, fromRevision: fromRev, toKnowledgeId: to, toRevision: toRev, type: "contradicts" as const, sourceKeys: [], state: "active" as const });

test("a page is read as one unit; only the body is required and missing parts are reported missing", async () => {
  const graph: KnowledgeGraph = { nodes: [{ knowledgeId: "k1", revision: "r2", title: "此页", pageType: "concept", validity: "valid" },
    { knowledgeId: "k3", revision: "x", title: "反例页", pageType: "concept", validity: "valid" }], edges: [edge("k3", "x", "k1", "r2")], status: "complete", watermark: 4 };
  const client = {
    page: async (id: string, rev?: string) => id === "k1" ? revision("k1", rev ?? "r2", { relations: [edge("k1", rev ?? "r2", "k9", "z")] })
      : id === "k9" ? revision("k9", "z", { title: "固定目标标题" }) : Promise.reject(new Error("missing")),
    history: async () => Promise.reject(new Error("history down")),
    graph: async () => graph,
  };
  const current = await readKnowledgePage(client, projectId, "k1");
  assert.equal(current.current, "r2");
  assert.equal(current.history, null, "a failed history read is reported missing, not empty");
  assert.equal(current.titles[titleKey("k9", "z")], "固定目标标题", "a relation target outside the graph is named by its fixed revision");
  assert.equal(current.titles[titleKey("k3", "x")], undefined, "a title the graph already gives is not read again");
  // A fixed link also reads the current version, to say whether the reader is behind.
  const fixed = await readKnowledgePage(client, projectId, "k1", "r1");
  assert.equal(fixed.page.revision, "r1");
  assert.equal(fixed.current, "r2");
  // A body answer for another page or project is refused instead of shown.
  await assert.rejects(readKnowledgePage({ ...client, page: async () => revision("k2", "r2") }, projectId, "k1"), /不符/);
  await assert.rejects(readKnowledgePage({ ...client, page: async () => ({ ...revision("k1", "r2"), projectId: "other" }) }, projectId, "k1"), /不符/);
  // When the current version cannot be read, it is unknown rather than assumed.
  const unknown = await readKnowledgePage({ ...client, page: async (id: string, rev?: string) => rev ? revision(id, rev) : Promise.reject(new Error("down")) }, projectId, "k1", "r1");
  assert.equal(unknown.current, null);
  await assert.rejects(readKnowledgePage({ ...client, page: async () => Promise.reject(new Error("正文读取失败")) }, projectId, "k1"), /正文读取失败/);
});
