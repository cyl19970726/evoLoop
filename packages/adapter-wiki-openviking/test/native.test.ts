import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { KnowledgeCandidate, KnowledgeIngestRequest } from "@evoloop/contracts/knowledge";
import { OpenVikingKnowledgeRepository } from "../src/index.ts";

const hash = (body: string): string => createHash("sha256").update(body).digest("hex");
const documentId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const source = { sourceKey: `document:${documentId}`, originRevision: revisionId, contentHash: hash("source body"), fragment: null, state: "reachable" as const };

test("native ingestion persists intent, polls tasks, and searches only permitted fixed targets", async () => {
  const bodies = new Map<string, string>();
  const calls: Array<{ path: string; body: unknown }> = [];
  let loseAddResponse = false;
  let taskStatus = "running";
  let denied = false;
  let leaseDenied = false;
  let searchHits: unknown[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    const send = (status: number, result: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ status: status < 400 ? "ok" : "error", result })); };
    if (path === "/api/v1/resources/temp_upload") {
      assert.match(req.headers["content-type"] ?? "", /^multipart\/form-data;/);
      let raw = ""; for await (const part of req) raw += part;
      assert.match(raw, /source.md/); assert.match(raw, /source body/);
      calls.push({ path, body: null }); send(200, { temp_file_id: "temp-1" }); return;
    }
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
    calls.push({ path, body });
    if (path === "/api/v1/resources") {
      assert.equal(body?.temp_file_id, "temp-1"); assert.equal(body?.source_name, "source.md");
      assert.equal(body?.wait, false); assert.equal(body?.strict, true);
      assert.match(String(body?.to), /^viking:\/\/resources\/evoloop\/p1\/sources\/[a-f0-9]{64}$/);
      if (loseAddResponse) { req.socket.destroy(); return; }
      send(200, { status: "success", task_id: "task-1" }); return;
    }
    if (path === "/api/v1/tasks/task-1") { send(200, { task_id: "task-1", status: taskStatus }); return; }
    if (path === "/api/v1/search/find") { assert.equal(body?.read_content, false); send(200, { resources: searchHits }); return; }
    if (path === "/api/v1/content/write") { bodies.set(String(body?.uri), String(body?.content)); send(200, {}); return; }
    if (path === "/api/v1/content/read") {
      const uri = new URL(req.url!, "http://localhost").searchParams.get("uri")!;
      send(bodies.has(uri) ? 200 : 404, bodies.get(uri) ?? null); return;
    }
    send(404, null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const parent = await mkdtemp(join(tmpdir(), "evoloop-native-wiki-"));
  const options = { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, manifestRoot: join(parent, "manifest"),
    maintainerId: "maintainer", mayRead: async () => !denied, mayIngest: async () => !leaseDenied,
    mayPropose: async () => true, mayReview: async () => true, mayPublish: async () => true, mayReconcile: async () => true };
  const repo = new OpenVikingKnowledgeRepository(options);
  const ingestion: KnowledgeIngestRequest = { projectId: "p1", operationId: "ingest1", actorId: "writer", source, title: "Source", body: "source body" };
  try {
    assert.equal((await repo.ingestSource(ingestion)).status, "submitted");
    const restarted = new OpenVikingKnowledgeRepository(options);
    assert.equal((await restarted.getIngestion("p1", "ingest1"))?.status, "submitted");
    taskStatus = "completed";
    assert.equal((await restarted.getIngestion("p1", "ingest1"))?.status, "completed");
    assert.equal((await restarted.getIngestion("p1", "ingest1"))?.indexStatus, "unverified");
    const target = String((calls.find((item) => item.path === "/api/v1/resources")?.body as { to: string }).to);
    searchHits = [{ uri: target + "/source.md", score: 0.9 }, { uri: target + "/child.md", score: 0.85 }, { uri: target + "-other/source.md", score: 0.8 },
      { uri: "viking://resources/evoloop/p2/sources/other", score: 0.7 }];
    const sources = await restarted.query("p1", { query: "source", scope: "sources", limit: 10 });
    assert.deepEqual(sources.items.map((item) => [item.kind, item.id, item.revision]), [["document", documentId, revisionId]]);
    assert.equal(sources.excluded, 3);
    assert.deepEqual((calls.find((item) => item.path === "/api/v1/search/find")?.body as { target_uri: string[] }).target_uri, [target]);
    await assert.rejects(() => restarted.ingestSource({ ...ingestion, body: "different" }), /invalid/);
    const uploadsBeforeMismatch = calls.filter((item) => item.path === "/api/v1/resources/temp_upload").length;
    await assert.rejects(() => restarted.ingestSource({ ...ingestion, operationId: "badHash", body: "changed" }), /invalid/);
    assert.equal(calls.filter((item) => item.path === "/api/v1/resources/temp_upload").length, uploadsBeforeMismatch);
    await assert.rejects(() => restarted.ingestSource({ ...ingestion, operationId: "ingest2" }), /already submitted/);
    const failing = { ...ingestion, operationId: "ingestFailed", source: { ...source, originRevision: "55555555-5555-4555-8555-555555555555" } };
    assert.equal((await restarted.ingestSource(failing)).status, "submitted");
    taskStatus = "malformed";
    assert.equal((await restarted.getIngestion("p1", "ingestFailed"))?.status, "submitted");
    taskStatus = "failed";
    leaseDenied = true;
    assert.equal((await restarted.getIngestion("p1", "ingestFailed"))?.status, "submitted");
    leaseDenied = false;
    assert.equal((await restarted.getIngestion("p1", "ingestFailed"))?.status, "failed");
    assert.equal((await new OpenVikingKnowledgeRepository(options).getIngestion("p1", "ingestFailed"))?.status, "failed");
    denied = true;
    await assert.rejects(() => restarted.getIngestion("p1", "ingest1"), /denied/);
    assert.equal((await restarted.query("p1", { query: "source", scope: "sources", limit: 10 })).items.length, 0);
    denied = false;
    loseAddResponse = true;
    const unknown = { ...ingestion, operationId: "ingestUnknown", source: { ...source, originRevision: "33333333-3333-4333-8333-333333333333" } };
    assert.equal((await restarted.ingestSource(unknown)).status, "unknown");
    const adds = calls.filter((item) => item.path === "/api/v1/resources").length;
    assert.equal((await new OpenVikingKnowledgeRepository(options).ingestSource(unknown)).status, "unknown");
    assert.equal(calls.filter((item) => item.path === "/api/v1/resources").length, adds);

    const candidate: KnowledgeCandidate = { projectId: "p1", knowledgeId: "wiki1", candidateId: "candidate1", candidateRevision: "rev1",
      expectedRevision: null, contentHash: hash("# Published"), title: "Published", body: "# Published", pageType: "topic",
      epistemicStatus: "observation", sources: [source], relations: [], operationId: "candidateOp", actorId: "writer" };
    await repo.propose(candidate);
    searchHits = [{ uri: `viking://resources/evoloop/p1/knowledge/wiki1/candidates/candidate1.md`, score: 1 },
      { uri: `viking://resources/evoloop/p1/knowledge/wiki1/revisions/rev1.md`, score: 0.8 }];
    assert.equal((await repo.query("p1", { query: "published", scope: "published", limit: 10 })).items.length, 0);
    await repo.review("p1", { candidateId: "candidate1", candidateRevision: "rev1", contentHash: candidate.contentHash,
      expectedRevision: null, decision: "accept", reviewerId: "maintainer", reason: "accepted" });
    await repo.publish("p1", "candidate1", "publish1", "maintainer");
    const published = await repo.query("p1", { query: "published", scope: "published", limit: 10 });
    assert.deepEqual(published.items.map((item) => [item.kind, item.id, item.revision]), [["wiki", "wiki1", "rev1"]]);
    assert.equal(published.excluded, 1);
    const dependent: KnowledgeCandidate = { ...candidate, knowledgeId: "dependent", candidateId: "dependent1", candidateRevision: "dependentRev1",
      operationId: "dependentOp1", sources: [], relations: [{ edgeId: "edge1", fromKnowledgeId: "dependent", fromRevision: "dependentRev1",
        toKnowledgeId: "wiki1", toRevision: "rev1", type: "supports", sourceKeys: [], state: "active" }] };
    await repo.propose(dependent);
    await repo.review("p1", { candidateId: dependent.candidateId, candidateRevision: dependent.candidateRevision, contentHash: dependent.contentHash,
      expectedRevision: null, decision: "accept", reviewerId: "maintainer", reason: "accepted" });
    await repo.publish("p1", dependent.candidateId, "publishDependent1", "maintainer");
    await repo.retractSource("p1", source.sourceKey, "withdraw1", "maintainer");
    assert.equal((await repo.query("p1", { query: "published", scope: "published", limit: 10 })).items.length, 0);
    assert.equal((await repo.get("p1", "wiki1", "rev1"))?.observedValidity, "needs_review");
    assert.equal((await repo.get("p1", "dependent", "dependentRev1"))?.observedValidity, "needs_review");
    const revised: KnowledgeCandidate = { ...candidate, candidateId: "candidate2", candidateRevision: "rev2",
      expectedRevision: "rev1", operationId: "candidateOp2", body: "# Revised", contentHash: hash("# Revised"),
      sources: [{ ...source, sourceKey: "document:44444444-4444-4444-8444-444444444444" }] };
    await repo.propose(revised);
    await repo.review("p1", { candidateId: "candidate2", candidateRevision: "rev2", contentHash: revised.contentHash,
      expectedRevision: "rev1", decision: "accept", reviewerId: "maintainer", reason: "replaced source" });
    await repo.publish("p1", "candidate2", "publish2", "maintainer");
    assert.equal((await repo.get("p1", "wiki1"))?.observedValidity, "valid");
    assert.equal((await repo.get("p1", "wiki1", "rev1"))?.observedValidity, "needs_review");
    assert.equal((await repo.history("p1", "wiki1", 10)).items.find((item) => item.revision === "rev1")?.validity, "valid");
    const dependentHealthy: KnowledgeCandidate = { ...dependent, candidateId: "dependent2", candidateRevision: "dependentRev2",
      expectedRevision: "dependentRev1", operationId: "dependentOp2", relations: [] };
    await repo.propose(dependentHealthy);
    await repo.review("p1", { candidateId: dependentHealthy.candidateId, candidateRevision: dependentHealthy.candidateRevision,
      contentHash: dependentHealthy.contentHash, expectedRevision: "dependentRev1", decision: "accept", reviewerId: "maintainer", reason: "revised dependency" });
    await repo.publish("p1", dependentHealthy.candidateId, "publishDependent2", "maintainer");
    assert.equal((await repo.get("p1", "dependent"))?.observedValidity, "valid");
    assert.equal((await repo.get("p1", "dependent", "dependentRev1"))?.observedValidity, "needs_review");
    assert.equal((await repo.history("p1", "dependent", 10)).items.find((item) => item.revision === "dependentRev1")?.validity, "valid");
  } finally { server.closeAllConnections(); server.close(); await rm(parent, { recursive: true, force: true }); }
});
