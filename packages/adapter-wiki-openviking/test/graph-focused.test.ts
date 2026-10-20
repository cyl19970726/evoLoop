import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeCandidate } from "@evoloop/contracts/knowledge";
import { OpenVikingKnowledgeRepository } from "../src/index.ts";

const hash = (body: string): string => createHash("sha256").update(body).digest("hex");

test("focused graph keeps self-history endpoints as fixed revision nodes", async () => {
  const bodies = new Map<string, string>();
  const server = createServer(async (req, res) => {
    const send = (status: number, result: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: status < 400 ? "ok" : "error", result }));
    };
    const url = new URL(req.url!, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", healthy: true, version: "fixture" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/content/read") {
      const body = bodies.get(url.searchParams.get("uri")!);
      send(body === undefined ? 404 : 200, body ?? null);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/content/write") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw) as { uri: string; content: string; mode: string };
      if (input.mode !== "create" || bodies.has(input.uri)) { send(409, null); return; }
      bodies.set(input.uri, input.content);
      send(200, { uri: input.uri });
      return;
    }
    send(404, null);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const parent = await mkdtemp(join(tmpdir(), "evoloop-wiki-graph-"));
  let readable = true;
  const repo = new OpenVikingKnowledgeRepository({
    baseUrl: `http://127.0.0.1:${port}/`, manifestRoot: join(parent, "manifest"), maintainerId: "maintainer",
    mayRead: async () => readable, mayPropose: async () => true, mayReview: async () => true,
    mayPublish: async () => true, mayReconcile: async () => true,
  });
  const candidate = (revision: string, body: string, expectedRevision: string | null,
    relations: KnowledgeCandidate["relations"] = []): KnowledgeCandidate => ({
    projectId: "p1", knowledgeId: "topic", candidateId: `candidate_${revision}`, candidateRevision: revision,
    expectedRevision, contentHash: hash(body), title: `Topic ${revision}`, body, pageType: "concept", epistemicStatus: "adopted",
    sources: [], relations, operationId: `operation_${revision}`, actorId: "maintainer",
  });
  const publish = async (item: KnowledgeCandidate): Promise<void> => {
    await repo.propose(item);
    await repo.review("p1", { candidateId: item.candidateId, candidateRevision: item.candidateRevision,
      contentHash: item.contentHash, expectedRevision: item.expectedRevision, decision: "accept",
      reviewerId: "maintainer", reason: "fixture" });
    assert.deepEqual(await repo.publish("p1", item.candidateId, `publish_${item.candidateRevision}`, "maintainer"),
      { status: "published", operationId: `publish_${item.candidateRevision}`, revision: item.candidateRevision });
  };
  try {
    await publish(candidate("rev1", "# Topic first revision", null));
    const selfHistory: KnowledgeCandidate["relations"][number] = {
      edgeId: "supersedes_rev1", fromKnowledgeId: "topic", fromRevision: "rev2",
      toKnowledgeId: "topic", toRevision: "rev1", type: "supersedes", sourceKeys: [], state: "active",
    };
    await publish(candidate("rev2", "# Topic corrected revision", "rev1", [selfHistory]));

    const graph = await repo.graph("p1", "topic", 2);
    assert.equal(graph.status, "complete");
    assert.deepEqual(graph.nodes.map(node => [node.knowledgeId, node.revision, node.title]), [
      ["topic", "rev2", "Topic rev2"],
      ["topic", "rev1", "Topic rev1"],
    ], "focus is first and both immutable revisions remain separate nodes");
    assert.deepEqual(graph.edges, [selfHistory]);

    const limited = await repo.graph("p1", "topic", 1);
    assert.equal(limited.status, "truncated");
    assert.deepEqual(limited.nodes.map(node => node.revision), ["rev2"], "focus consumes the first bounded node slot");
    assert.deepEqual(limited.edges, [], "an edge is omitted when both fixed endpoints cannot fit");

    readable = false;
    const hidden = await repo.graph("p1", "topic", 2);
    assert.equal(hidden.status, "unavailable");
    assert.deepEqual(hidden.nodes, []);
    assert.deepEqual(hidden.edges, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(parent, { recursive: true, force: true });
  }
});
