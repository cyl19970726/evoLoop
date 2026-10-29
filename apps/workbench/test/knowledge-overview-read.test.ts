import test from "node:test";
import assert from "node:assert/strict";
import { currentKnowledgeCapabilities, readKnowledgeOverview, type KnowledgeOverviewRead } from "../src/knowledge/overviewRead.ts";
import { knowledgeAvailability } from "../src/knowledge/availability.ts";

type Client = Parameters<typeof readKnowledgeOverview>[0];
const caps = { backendVersion: null, backendReachable: true, fixedRevisionRead: "adapter_verified", conditionalPublish: "unavailable",
  boundedRelations: "unavailable", migration: "unsupported", semanticIndex: "unverified" } as const;
const pages = { items: [], nextCursor: "retained-range" };
const client = (): Client => ({ capabilities: async () => caps, pages: async () => pages,
  candidates: async () => ({ items: [], nextCursor: null }), sources: async () => ({ items: [], nextCursor: null }) });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("successful knowledge read becomes unverified while refreshing and stays unverified after capability failure", async () => {
  let state: KnowledgeOverviewRead = { key: "", status: "reading" };
  let lastPages: typeof pages | null = null;
  const apply = (next: KnowledgeOverviewRead) => { state = next; if (next.status === "complete") lastPages = next.pages; };
  await readKnowledgeOverview(client(), "first", apply, () => true);
  assert.equal(knowledgeAvailability(currentKnowledgeCapabilities(state, "first")).fullRead, true);
  assert.equal(lastPages, pages);
  assert.equal(currentKnowledgeCapabilities(state, "refresh"), null, "old success cannot appear current before the effect starts");
  const failed = deferred<typeof caps>();
  const reading = readKnowledgeOverview({ ...client(), capabilities: () => failed.promise }, "refresh", apply, () => true);
  assert.equal(currentKnowledgeCapabilities(state, "refresh"), null);
  failed.reject(new Error("能力接口暂不可读"));
  await reading;
  assert.equal(state.status, "failed");
  assert.equal(knowledgeAvailability(currentKnowledgeCapabilities(state, "refresh")).fullRead, false);
  assert.equal(lastPages, pages, "failure keeps the previous complete index instead of publishing an empty replacement");
  await readKnowledgeOverview(client(), "recovered", apply, () => true);
  assert.equal(knowledgeAvailability(currentKnowledgeCapabilities(state, "recovered")).fullRead, true);
});

test("capability success plus a failed accompanying request cannot revive the old connected state", async () => {
  for (const field of ["pages", "candidates", "sources"] as const) {
    let state: KnowledgeOverviewRead = { key: "", status: "reading" };
    let completeReads = 0;
    const apply = (next: KnowledgeOverviewRead) => { state = next; if (next.status === "complete") completeReads++; };
    await readKnowledgeOverview(client(), "first", apply, () => true);
    await readKnowledgeOverview({ ...client(), [field]: async () => { throw new Error(`${field} failed`); } }, "partial", apply, () => true);
    assert.equal(state.status, "failed");
    assert.equal(currentKnowledgeCapabilities(state, "partial"), null, field);
    assert.equal(completeReads, 1, "partial data never replaces the last complete read");
  }
});

test("a cancelled old knowledge read cannot overwrite a newer scope", async () => {
  let current = "old";
  let state: KnowledgeOverviewRead = { key: "", status: "reading" };
  const apply = (next: KnowledgeOverviewRead) => { state = next; };
  const held = deferred<typeof caps>();
  const old = readKnowledgeOverview({ ...client(), capabilities: () => held.promise }, "old", apply, () => current === "old");
  current = "new";
  await readKnowledgeOverview(client(), "new", apply, () => current === "new");
  held.resolve(caps); await old;
  assert.equal(state.key, "new");
  assert.equal(knowledgeAvailability(currentKnowledgeCapabilities(state, "new")).fullRead, true);
});
