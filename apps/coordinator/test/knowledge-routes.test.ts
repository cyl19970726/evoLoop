import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { Document, DocumentDetail, Principal } from "@evoloop/contracts";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";
import type { BlobStore } from "@evoloop/contracts/sources";
import { DomainError } from "@evoloop/contracts/ports";
import { OpenVikingKnowledgeRepository } from "@evoloop/adapter-wiki-openviking";
import { registerKnowledgeRoutes } from "../src/knowledge/routes.js";

const hash = (body: string) => createHash("sha256").update(body).digest("hex");
test("knowledge HTTP: fixed source gate, separate review/publish, durable candidate and unknown reconciliation", async (t) => {
  const bodies = new Map<string, string>();
  let failRevisionRead = false;
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    const send = (status: number, result: unknown) => { response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: status < 400 ? "ok" : "error", result })); };
    if (request.method === "GET" && url.pathname === "/health") { response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", healthy: true, version: "fixture-0.5.1" })); return; }
    if (request.method === "GET" && url.pathname === "/api/v1/content/read") {
      const uri = url.searchParams.get("uri")!;
      if (failRevisionRead && uri.includes("/revisions/")) { failRevisionRead = false; send(503, null); return; }
      const body = bodies.get(uri); send(body === undefined ? 404 : 200, body ?? null); return;
    }
    if (request.method === "POST" && url.pathname === "/api/v1/content/write") {
      let raw = ""; for await (const part of request) raw += part;
      const input = JSON.parse(raw) as { uri: string; content: string; mode: string };
      if (input.mode !== "create" || bodies.has(input.uri)) { send(409, null); return; }
      bodies.set(input.uri, input.content); send(200, { uri: input.uri }); return;
    }
    send(404, null);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const root = await mkdtemp(join(tmpdir(), "evoloop-knowledge-route-"));
  const projectId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
  const knowledgeId = randomUUID(), candidateId = randomUUID(), candidateRevision = randomUUID();
  const doc: Document = { projectId, id: documentId, title: "Adopted source", version: 2,
    currentRevisionId: revisionId, adoptedRevisionId: revisionId };
  const fixed: DocumentPayloadRevision = { projectId, documentId, id: revisionId, previousRevisionId: null,
    format: "markdown", mediaType: "text/markdown", originalName: "source.md", body: "# source",
    payloadRef: null, contentHash: hash("# source"), entrypoint: null, assetsManifest: [],
    author: "owner", reason: "fixture", createdAt: new Date().toISOString() };
  const detail: DocumentDetail = { document: doc, current: fixed, adopted: fixed };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] };
  const maintainer: Principal = { actorId: "maintainer", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    request.principal = request.headers.authorization === "Bearer writer" ? writer :
      request.headers.authorization === "Bearer maintainer" ? maintainer : null;
    if (!request.principal) return reply.code(401).send({ code: "UNAUTHENTICATED" });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.code === "FORBIDDEN" ? 403 : 409).send({ code: error.code, message: error.message });
    return reply.code(503).send({ code: "UNAVAILABLE", message: error.message });
  });
  const workflow = {
    async listDocuments() { return { items: [doc], nextCursor: null }; },
    async getDocument(_p: Principal, scope: string, id: string) {
      if (scope !== projectId || id !== documentId) throw new DomainError("NOT_FOUND", "Source not found");
      return detail;
    },
    async getDocumentPayloadRevision(_p: Principal, scope: string, id: string, revision: string) {
      if (scope !== projectId || id !== documentId || revision !== revisionId) throw new DomainError("NOT_FOUND", "Revision not found");
      return fixed;
    },
    async getRegisteredBlob() { throw new DomainError("NOT_FOUND", "No external fixture blobs"); },
  };
  const noBlobs: BlobStore = { prepare: async () => { throw Error("no fixture blob"); },
    verify: async () => false, publish: async () => { throw Error("no fixture blob"); },
    read: async payload => ({ status: "unavailable", payload, reason: "missing" }),
    inspectOrphans: async () => ({ unregisteredIds: [], temporaryIds: [], unreferencedHashes: [] }) };
  const options = { baseUrl: `http://127.0.0.1:${port}/`, manifestRoot: join(root, "manifest"), maintainerId: "maintainer",
    mayRead: async () => true, mayPropose: async () => true,
    mayReview: async (_scope: string, actor: string) => actor === "maintainer",
    mayPublish: async (_scope: string, actor: string) => actor === "maintainer",
    mayReconcile: async (_scope: string, actor: string) => actor === "maintainer" };
  registerKnowledgeRoutes(app, { workflow,
    repositoryForPrincipal: () => new OpenVikingKnowledgeRepository(options), blobsForPrincipal: () => noBlobs });
  t.after(async () => { await app.close(); upstream.close(); await rm(root, { recursive: true, force: true }); });
  const api = `/api/projects/${projectId}/knowledge`;
  const post = (url: string, payload: unknown, actor = "writer") => app.inject({ method: "POST", url: `${api}${url}`,
    headers: { authorization: `Bearer ${actor}` }, payload });
  const get = (url: string, actor = "writer") => app.inject({ method: "GET", url: `${api}${url}`,
    headers: { authorization: `Bearer ${actor}` } });
  const input = { operationId: randomUUID(), knowledgeId, candidateId, candidateRevision,
    expectedRevision: null, title: "Verified topic", body: "# Verified topic", pageType: "concept",
    epistemicStatus: "inference", sources: [{ documentId, revisionId, fragment: null }], relations: [] };
  assert.equal((await post("/candidates", { ...input, sources: [{ documentId, revisionId: randomUUID(), fragment: null }] })).statusCode, 409,
    "unadopted/fake fixed source cannot be proposed");
  const proposed = await post("/candidates", input);
  assert.equal(proposed.statusCode, 200, proposed.body);
  assert.equal(proposed.json().sources[0].contentHash, fixed.contentHash);
  const listed = await get("/candidates");
  assert.equal(listed.json().items[0].status, "pending", "candidate survives a new repository instance");
  assert.equal((await post(`/candidates/${candidateId}/publish`, { operationId: randomUUID() }, "maintainer")).statusCode, 409,
    "publication requires a separate accepted review");
  assert.equal((await post(`/candidates/${candidateId}/review`, { candidateRevision, contentHash: hash(input.body),
    expectedRevision: null, decision: "accept", reason: "source checked" }, "writer")).statusCode, 403);
  const reviewed = await post(`/candidates/${candidateId}/review`, { candidateRevision, contentHash: hash(input.body),
    expectedRevision: null, decision: "accept", reason: "source checked" }, "maintainer");
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal((await get(`/candidates/${candidateId}`)).json().status, "accepted");
  const operationId = randomUUID(); failRevisionRead = true;
  const unknown = await post(`/candidates/${candidateId}/publish`, { operationId }, "maintainer");
  assert.equal(unknown.json().status, "unknown");
  const noReplay = await post(`/candidates/${candidateId}/publish`, { operationId }, "maintainer");
  assert.equal(noReplay.json().status, "unknown", "same operation does not blindly repeat external write");
  const reconciled = await post(`/operations/${operationId}/reconcile`, {}, "maintainer");
  assert.equal(reconciled.json().result.status, "published");
  assert.equal((await get(`/pages/${knowledgeId}`)).json().body, input.body);
  assert.equal((await get(`/candidates/${candidateId}`)).json().status, "published");
  const originalBody = fixed.body, originalRef = fixed.payloadRef, originalHash = fixed.contentHash;
  fixed.body = null; fixed.payloadRef = randomUUID(); fixed.contentHash = hash("missing external original");
  const missingOriginal = await post("/candidates", { ...input, operationId: randomUUID(), candidateId: randomUUID(),
    candidateRevision: randomUUID(), knowledgeId: randomUUID(), expectedRevision: null });
  assert.equal(missingOriginal.statusCode, 409, "registered metadata alone cannot claim an unavailable blob source");
  fixed.body = originalBody; fixed.payloadRef = originalRef; fixed.contentHash = originalHash;
  const withdrawn = await post(`/sources/${documentId}/retract`, { operationId: randomUUID() }, "maintainer");
  assert.deepEqual(withdrawn.json().affected, [knowledgeId]);
  assert.equal((await get(`/pages/${knowledgeId}`)).json().observedValidity, "needs_review");
});
