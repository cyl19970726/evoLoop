import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import type { Principal, TaskRevision, BasisSet } from "@evoloop/contracts";
import type { DocumentPayloadRevision, DocumentPayloadUnitOfWork, RegisteredDocumentBlob } from "@evoloop/contracts/process-documents";
import type { BlobStore } from "@evoloop/contracts/sources";
import { registerDocumentRoutes } from "../src/documents/routes.js";
import { registerTaskMaterialRoutes } from "../src/documents/task-materials.js";
import { FixedBodyCache } from "../src/documents/fixed-reads.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [projectId, taskId, taskRevisionId, documentId, revisionId, payloadId, assetId, otherDocumentId, otherRevisionId] =
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const body = "第一段中文内容。\n".repeat(2000), bytes = Buffer.from(body, "utf8"), assetBytes = Buffer.from([0, 255, 1, 2]);
const fixed: DocumentPayloadRevision = { projectId, documentId, id: revisionId, previousRevisionId: null,
  format: "html", mediaType: "text/html", originalName: "index.html", body: null, payloadRef: payloadId,
  contentHash: digest(bytes), entrypoint: "index.html", assetsManifest: [
    { blobId: assetId, path: "images/pic.bin", contentHash: digest(assetBytes), size: assetBytes.length, mediaType: "application/octet-stream" }],
  author: "owner", reason: "fixed", createdAt: "2026-01-01T00:00:00Z" };
const other: DocumentPayloadRevision = { ...fixed, documentId: otherDocumentId, id: otherRevisionId, body: "背景", payloadRef: null,
  assetsManifest: [], contentHash: digest("背景"), originalName: "background.md", format: "markdown", mediaType: "text/markdown" };
const principal: Principal = { actorId: "reader", projectIds: [projectId], permissions: ["read"] };
const revision: TaskRevision = { projectId, taskId, id: taskRevisionId, version: 1, title: "Pinned task", content: "task",
  contentDocumentId: documentId, contentRevisionId: revisionId, kind: "research", acceptance: "验收内容".repeat(1000), owner: "reader",
  state: "in_progress", basisSetId: id(10), actorId: "reader", reason: "fixed", createdAt: "2026-01-01T00:00:00Z" };
const basis: BasisSet = { projectId, taskId, taskRevisionId, id: id(10), sealed: true,
  members: [{ documentId, revisionId }, { documentId: otherDocumentId, revisionId: otherRevisionId }] };

test("fixed catalog, UTF-8 pages and one asset stay pinned, bounded and verified", async () => {
  let registrationReads = 0, bodyReads = 0;
  const registrations = new Map<string, RegisteredDocumentBlob>([
    [payloadId, { id: payloadId, projectId, documentId, revisionId, role: "main", relativePath: null,
      contentHash: fixed.contentHash, mediaType: fixed.mediaType, size: bytes.length }],
    [assetId, { id: assetId, projectId, documentId, revisionId, role: "asset", relativePath: "images/pic.bin",
      contentHash: digest(assetBytes), mediaType: "application/octet-stream", size: assetBytes.length }],
  ]);
  const content = new Map([[payloadId, bytes], [assetId, assetBytes]]);
  const uow = { read: async (_project: string, fn: (reader: { getRegisteredBlob(id: string): Promise<RegisteredDocumentBlob | null> }) => Promise<unknown>) =>
    fn({ getRegisteredBlob: async blobId => { registrationReads++; return registrations.get(blobId) ?? null; } }) } as DocumentPayloadUnitOfWork;
  const blobs = { read: async (payload: { id: string }) => {
    if (payload.id === payloadId) bodyReads++;
    const found = content.get(payload.id);
    return found ? { status: "available", bytes: found, payload } : { status: "unavailable", reason: "missing", payload };
  } } as BlobStore;
  const workflow = {
    getDocumentPayloadRevision: async (_actor: Principal, _project: string, doc: string, rev: string) => {
      const found = [fixed, other].find(item => item.documentId === doc && item.id === rev);
      if (!found) throw Error("missing");
      return found;
    },
    getTaskRevision: async () => ({ revision, basis }),
  };
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = request.headers.authorization === "Bearer read" ? principal : null; });
  registerDocumentRoutes(app, { workflow, uow, blobsForPrincipal: async () => blobs });
  registerTaskMaterialRoutes(app, { workflow, documents: uow });
  const get = (path: string, authorized = true) => app.inject({ method: "GET", url: path,
    headers: authorized ? { authorization: "Bearer read" } : {} });
  const prefix = `/api/projects/${projectId}`;
  try {
    const catalog = await get(`${prefix}/tasks/${taskId}/revisions/${taskRevisionId}/materials`);
    assert.equal(catalog.statusCode, 200);
    const manifest = catalog.json();
    assert.equal(manifest.documents.length, 2);
    assert.equal(manifest.acceptanceBytes, Buffer.byteLength(revision.acceptance, "utf8"));
    assert.equal(manifest.acceptance, undefined);
    assert.ok(!catalog.body.includes(revision.acceptance.slice(0, 30)));
    assert.equal(manifest.documents[0].contentHash, digest(bytes));
    assert.equal(manifest.documents[1].background, true);
    assert.equal(manifest.documents[0].assets[0].contentHash, digest(assetBytes));
    assert.ok(!catalog.body.includes("base64") && !catalog.body.includes(body.slice(0, 30)));
    const path = `${prefix}/documents/${documentId}/revisions/${revisionId}`;
    const first = (await get(`${path}/body?limit=5`)).json();
    assert.equal(first.body, "第"); assert.equal(first.startByte, 0); assert.equal(first.endByte, 3);
    assert.equal(first.nextCursor, "3"); assert.equal(first.truncated, true);
    const second = (await get(`${path}/body?cursor=3&limit=5`)).json();
    assert.equal(second.body, "一");
    assert.equal(bodyReads, 1, "adjacent pages reuse the verified immutable body");
    assert.ok(registrationReads >= 2, "each page checks its current registration");
    assert.equal((await get(`${path}/body?cursor=1`)).statusCode, 500);
    const resource = (await get(`${path}/assets/${assetId}`)).json();
    assert.equal(resource.base64, assetBytes.toString("base64"));
    assert.equal(resource.documentContentHash, digest(bytes));
    assert.equal((await get(`${path}/assets/${assetId}`, false)).statusCode, 500);
    content.delete(assetId);
    assert.equal((await get(`${path}/assets/${assetId}`)).statusCode, 500);
    content.set(assetId, Buffer.from("tampered"));
    assert.equal((await get(`${path}/assets/${assetId}`)).statusCode, 500);
    // A newer current revision is irrelevant; every URL above retains its chosen revision.
    assert.equal((await get(`${path}/body?cursor=0&limit=10`)).json().revisionId, revisionId);
    assert.equal(bodyReads, 1);
    registrations.delete(payloadId);
    assert.equal((await get(`${path}/body?cursor=3`)).statusCode, 500,
      "removing the registration denies even a cached body");
  } finally { await app.close(); }
});

test("verified body cache is bounded and evicts least recently used bytes", () => {
  const cache = new FixedBodyCache(10, 60_000);
  cache.set("a", Buffer.alloc(6));
  cache.set("b", Buffer.alloc(6));
  assert.equal(cache.get("a"), null);
  assert.equal(cache.bytesUsed, 6);
  cache.set("oversize", Buffer.alloc(11));
  assert.equal(cache.get("oversize"), null);
  assert.ok(cache.bytesUsed <= 10);
});
