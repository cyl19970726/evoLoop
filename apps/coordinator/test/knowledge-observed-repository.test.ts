import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeRepository, KnowledgeRevision } from "@evoloop/contracts/knowledge";
import { withObservedSources } from "../src/knowledge/observed-repository.js";

const projectId = randomUUID(), knowledgeId = randomUUID(), revisionId = randomUUID();
const body = "# fixed Wiki original";
const fixed: KnowledgeRevision = {
  projectId,knowledgeId,revision:revisionId,previousRevision:null,title:"Wiki",body,
  contentHash:createHash("sha256").update(body).digest("hex"),pageType:"analysis",
  epistemicStatus:"adopted",validity:"valid",observedValidity:"valid",
  sources:[{ sourceKey:`document:${randomUUID()}`,originRevision:randomUUID(),contentHash:"a".repeat(64),fragment:null,state:"reachable" }],
  relations:[],createdAt:new Date().toISOString(),
};
const item = { knowledgeId,revision:revisionId,title:"Wiki",pageType:"analysis" as const,validity:"valid" as const };
class RawRepository {
  readonly privateMarker = Symbol("bound instance");
  page: KnowledgeRevision = fixed;
  failRead = false;
  writes = 0;
  assertThis() { assert.ok(this.privateMarker); }
  async get(_projectId: string, _knowledgeId: string, _revision?: string) { this.assertThis(); if (this.failRead) throw Error("fixed original unreadable"); return this.page; }
  async list() { this.assertThis(); return { items:[item],nextCursor:"next",watermark:17 }; }
  async history() { this.assertThis(); return { items:[item],nextCursor:"older",watermark:17 }; }
  async graph() { this.assertThis(); return { nodes:[item],edges:[{ edgeId:"existing",fromKnowledgeId:knowledgeId,
    fromRevision:revisionId,toKnowledgeId:knowledgeId,toRevision:revisionId,type:"related" as const,
    sourceKeys:[],state:"active" as const }],status:"complete" as const,watermark:17 }; }
  async capabilities() { this.assertThis(); return { backendVersion:"fixture" }; }
  async sourceState() { this.assertThis(); return "reachable" as const; }
  async listCandidates() { this.assertThis(); return { items:[],nextCursor:null,watermark:17 }; }
  async getCandidate() { this.assertThis(); return null; }
  async propose(value: unknown) { this.assertThis(); this.writes++; return value; }
  async review() { this.assertThis(); this.writes++; }
  async publish() { this.assertThis(); this.writes++; return { status:"published",operationId:"op",revision:revisionId }; }
  async reconcile() { this.assertThis(); return null; }
  async retractSource() { this.assertThis(); this.writes++; return []; }
}

test("dynamic source observations affect reads/list/graph without rewriting fixed history or publishing", async () => {
  const raw = new RawRepository();
  let reachable = true;
  const decorated = withObservedSources(raw as unknown as KnowledgeRepository, async () => reachable);
  assert.equal((await decorated.get(projectId,knowledgeId,revisionId))?.observedValidity,"valid");
  reachable = false;
  const observed = await decorated.get(projectId,knowledgeId,revisionId);
  assert.equal(observed?.validity,"valid");
  assert.equal(observed?.observedValidity,"needs_review");
  assert.equal(raw.page.validity,"valid");
  const listing = await decorated.list(projectId,20);
  assert.equal(listing.items[0]?.validity,"needs_review");
  assert.equal(listing.nextCursor,"next"); assert.equal(listing.watermark,17);
  const graph = await decorated.graph(projectId,knowledgeId,20);
  assert.equal(graph.nodes[0]?.validity,"needs_review"); assert.equal(graph.watermark,17);
  assert.equal(graph.edges.length,1); assert.equal(graph.edges[0]?.edgeId,"existing");
  assert.equal(graph.edges[0]?.state,"needs_review");
  const history = await decorated.history(projectId,knowledgeId,20);
  assert.equal(history.items[0]?.validity,"valid"); assert.equal(history.nextCursor,"older");
  assert.equal(raw.writes,0);
});

test("withdrawn state is never restored, and source checker errors fail closed", async () => {
  const raw = new RawRepository();
  raw.page = { ...fixed,validity:"withdrawn",observedValidity:"withdrawn" };
  const withdrawn = withObservedSources(raw as unknown as KnowledgeRepository, async () => true);
  assert.equal((await withdrawn.get(projectId,knowledgeId))?.observedValidity,"withdrawn");
  assert.equal((await withdrawn.list(projectId,20)).items[0]?.validity,"withdrawn");
  raw.page = { ...fixed,validity:"needs_review",observedValidity:"valid" };
  assert.equal((await withdrawn.get(projectId,knowledgeId))?.observedValidity,"needs_review");
  raw.page = fixed;
  const failed = withObservedSources(raw as unknown as KnowledgeRepository, async () => { throw Error("source unavailable"); });
  assert.equal((await failed.get(projectId,knowledgeId))?.observedValidity,"needs_review");
  raw.failRead = true;
  assert.equal((await failed.list(projectId,20)).items[0]?.validity,"needs_review");
  await assert.rejects(failed.get(projectId,knowledgeId),/unreadable/);
  assert.equal(raw.writes,0);
});
