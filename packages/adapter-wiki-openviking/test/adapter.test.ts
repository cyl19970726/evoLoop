import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KnowledgeCandidate } from "@evoloop/contracts/knowledge";
import { OpenVikingKnowledgeRepository } from "../src/index.ts";

const hash = (body: string): string => createHash("sha256").update(body).digest("hex");
const source = { sourceKey: "doc:d1@r1", originRevision: "r1", contentHash: "a".repeat(64), fragment: null, state: "reachable" as const };

test("external bodies, immutable history, CAS, withdrawal, restart and uncertain write recovery", async () => {
  const bodies = new Map<string, string>();
  let failNextRead = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, result: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ status: status < 400 ? "ok" : "error", result })); };
    const url = new URL(req.url!, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok", healthy: true, version: "fixture" })); return; }
    if (req.method === "GET" && url.pathname === "/api/v1/content/read") {
      if (failNextRead > 0 && url.searchParams.get("uri")?.includes("/revisions/rc1.md")) { failNextRead--; send(503, null); return; }
      const value = bodies.get(url.searchParams.get("uri")!);
      send(value === undefined ? 404 : 200, value ?? null); return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/content/write") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw) as { uri: string; content: string; mode: string };
      if (input.mode !== "create" || bodies.has(input.uri)) { send(409, null); return; }
      bodies.set(input.uri, input.content); send(200, { uri: input.uri }); return;
    }
    send(404, null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const parent = await mkdtemp(join(tmpdir(), "evoloop-wiki-"));
  const options = {
    baseUrl: `http://127.0.0.1:${port}/`, manifestRoot: join(parent, "manifest"), maintainerId: "maintainer",
    mayRead: async () => true, mayPropose: async () => true, mayReview: async () => true, mayPublish: async () => true, mayReconcile: async () => true,
  };
  const repo = new OpenVikingKnowledgeRepository(options);
  assert.equal((await repo.capabilities()).backendVersion, "fixture");
  const candidate = (id: string, revision: string, text: string, expectedRevision: string | null = null): KnowledgeCandidate => ({
    projectId: "p1", knowledgeId: id, candidateId: `c_${revision}`, candidateRevision: revision, expectedRevision,
    contentHash: hash(text), title: id, body: text, pageType: "concept", epistemicStatus: "inference",
    sources: [source], relations: [], operationId: `op_${revision}`, actorId: "maintainer",
  });
  const accept = async (item: KnowledgeCandidate): Promise<void> => repo.review(item.projectId, {
    candidateId: item.candidateId, candidateRevision: item.candidateRevision, contentHash: item.contentHash,
    expectedRevision: item.expectedRevision, decision: "accept", reviewerId: "maintainer", reason: "reviewed",
  });
  try {
    const first = candidate("a", "r1", "# First");
    await repo.propose(first);
    assert.equal((await repo.getCandidate("p1", first.candidateId))?.body, "# First");
    assert.equal((await new OpenVikingKnowledgeRepository(options).listCandidates("p1", 10)).items[0]?.status, "pending");
    await accept(first);
    assert.equal((await repo.listCandidates("p1", 10)).items[0]?.status, "accepted");
    assert.deepEqual(await repo.publish("p1", first.candidateId, "publish1", "maintainer"), { status: "published", operationId: "publish1", revision: "r1" });
    assert.equal((await new OpenVikingKnowledgeRepository(options).getCandidate("p1", first.candidateId))?.status, "published");
    assert.equal((await repo.get("p1", "a"))?.body, "# First");
    const next = candidate("a", "r2", "# Second", "r1");
    await repo.propose(next); await accept(next);
    assert.equal((await repo.publish("p1", next.candidateId, "publish2", "maintainer")).status, "published");
    assert.equal((await repo.get("p1", "a", "r1"))?.body, "# First");
    assert.equal((await repo.history("p1", "a", 10)).items.length, 2);
    const stale = candidate("a", "r3", "# Stale", "r1");
    await repo.propose(stale); await accept(stale);
    assert.deepEqual(await repo.publish("p1", stale.candidateId, "publish3", "maintainer"), { status: "conflict", operationId: "publish3", currentRevision: "r2" });
    const dependent = candidate("b", "rb1", "# B");
    dependent.sources = [];
    dependent.relations = [{ edgeId: "e1", fromKnowledgeId: "b", fromRevision: "rb1", toKnowledgeId: "a", toRevision: "r2", type: "supports", sourceKeys: [], state: "active" }];
    await repo.propose(dependent); await accept(dependent); await repo.publish("p1", dependent.candidateId, "publishB", "maintainer");
    assert.equal((await repo.graph("p1", "b", 2)).edges.length, 1);
    assert.deepEqual(await repo.retractSource("p1", source.sourceKey, "withdraw1", "maintainer"), ["a", "b"]);
    assert.equal((await repo.get("p1", "a"))?.observedValidity, "needs_review");
    assert.equal((await repo.get("p1", "b"))?.observedValidity, "needs_review");
    assert.equal((await repo.graph("p1", "b", 2)).edges[0]?.state, "needs_review");
    assert.equal((await repo.get("p1", "a", "r1"))?.validity, "valid");
    const restarted = new OpenVikingKnowledgeRepository(options);
    assert.equal((await restarted.get("p1", "a", "r1"))?.body, "# First");
    const uncertain = candidate("c", "rc1", "# C"); uncertain.sources = [];
    await repo.propose(uncertain); await accept(uncertain);
    failNextRead = 1;
    assert.equal((await repo.publish("p1", uncertain.candidateId, "publishC", "maintainer")).status, "unknown");
    assert.deepEqual(await restarted.reconcile("p1", "publishC", "maintainer"), { status: "published", operationId: "publishC", revision: "rc1" });
    assert.equal((await restarted.get("p1", "c"))?.body, "# C");
    bodies.set("viking://resources/evoloop/p1/knowledge/a/revisions/r1.md", "tampered");
    await assert.rejects(() => restarted.get("p1", "a", "r1"));
  } finally { server.close(); await rm(parent, { recursive: true, force: true }); }
});
