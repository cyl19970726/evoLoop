import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { LocalBlobStore } from "@evoloop/adapter-local-blobs";
import { registerDocumentRoutes } from "../../apps/coordinator/src/documents/routes.js";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_document_test(?:\?|$)/.test(url)) throw new Error("Use dedicated evoloop_document_test database");
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

test("authenticated document route uploads fixed bytes and reports damaged originals", async (t) => {
  await migrate(url!);
  const pool = new pg.Pool({ connectionString: url });
  const uow = new PostgresUnitOfWork(pool);
  const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, hasher: { hash } });
  const projectId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID(), mainId = randomUUID();
  const principal: Principal = { actorId: "route-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const token = "route-token-".padEnd(40, "x");
  const root = await mkdtemp(join(tmpdir(), "evoloop-route-blobs-"));
  const blobs = new LocalBlobStore(root, async payload => payload.projectId === projectId,
    async payload => !!await uow.read(payload.projectId, reader => reader.getRegisteredBlob(payload.id)));
  const app = Fastify({ bodyLimit: 128 * 1024 });
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    request.principal = request.headers.authorization === `Bearer ${token}` ? principal : null;
    if (!request.principal) return reply.code(401).send({ code: "UNAUTHENTICATED" });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.code === "FORBIDDEN" ? 403 : 409).send({ code: error.code, message: error.message });
    return reply.code(400).send({ code: "INVALID_INPUT", message: error.message });
  });
  registerDocumentRoutes(app, { workflow, uow, blobsForPrincipal: () => blobs });
  t.after(async () => { await app.close(); await pool.end(); await rm(root, { recursive: true, force: true }); });
  await workflow.execute(principal, { type: "project.create", projectId, operationId: randomUUID(), title: "Route test" });
  const bytes = Buffer.from("# complete document\n", "utf8");
  const command = { projectId, operationId: randomUUID(), documentId, revisionId, mode: "create", title: "Original",
    format: "markdown", mediaType: "text/markdown", originalName: "original.md", author: "forged",
    reason: "first import", source: { storage: "blob", payloadRef: mainId, contentHash: hash(bytes),
      size: bytes.length, entrypoint: null, assets: [] } };
  const endpoint = `/api/projects/${projectId}/documents/import`;
  const unauthorized = await app.inject({ method: "POST", url: endpoint, payload: { command, uploads: [] } });
  assert.equal(unauthorized.statusCode, 401);
  const mismatch = await app.inject({ method: "POST", url: endpoint, headers: { authorization: `Bearer ${token}` },
    payload: { command: { ...command, projectId: randomUUID() }, uploads: [] } });
  assert.equal(mismatch.statusCode, 409);
  const invalidBase64 = await app.inject({ method: "POST", url: endpoint, headers: { authorization: `Bearer ${token}` },
    payload: { command, uploads: [{ blobId: mainId, base64: "YQ==\n" }] } });
  assert.equal(invalidBase64.statusCode, 409);
  const sent = await app.inject({ method: "POST", url: endpoint, headers: { authorization: `Bearer ${token}` },
    payload: { command, uploads: [{ blobId: mainId, base64: bytes.toString("base64") }] } });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().status, "applied");
  const replay = await app.inject({ method: "POST", url: endpoint, headers: { authorization: `Bearer ${token}` },
    payload: { command, uploads: [] } });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), sent.json(), "committed operation replays without uploading bytes again");
  const fixed = await workflow.getDocumentPayloadRevision(principal, projectId, documentId, revisionId);
  assert.equal(fixed.author, principal.actorId, "request author cannot override authenticated actor");
  const originalUrl = `/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}/original`;
  const read = await app.inject({ method: "GET", url: originalUrl, headers: { authorization: `Bearer ${token}` } });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().body, bytes.toString("utf8"));
  await writeFile(join(root, "objects", hash(bytes)), "corrupted");
  const damaged = await app.inject({ method: "GET", url: originalUrl, headers: { authorization: `Bearer ${token}` } });
  assert.equal(damaged.statusCode, 200);
  assert.equal(damaged.json().status, "unavailable");
});
