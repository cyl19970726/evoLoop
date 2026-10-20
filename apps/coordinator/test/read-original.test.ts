import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { DocumentPayloadRevision, DocumentPayloadUnitOfWork, RegisteredDocumentBlob } from "@evoloop/contracts/process-documents";
import type { BlobStore } from "@evoloop/contracts/sources";
import { readDocumentOriginal } from "../src/documents/read-original.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const projectId = randomUUID();
const principal: Principal = { actorId: "reader", projectIds: [projectId], permissions: ["read"] };
const originalBytes = Buffer.from("\ufeff<!doctype html>\r\n<p>繁體字 café</p>\r\n", "utf8");
const assetBytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' />\n", "utf8");
const revision: DocumentPayloadRevision = {
  projectId, documentId: randomUUID(), id: randomUUID(), previousRevisionId: null,
  format: "html", mediaType: "text/html", originalName: "原件.html", body: null,
  payloadRef: randomUUID(), contentHash: sha256(originalBytes), entrypoint: "原件.html",
  assetsManifest: [{ path: "图.svg", blobId: randomUUID(), contentHash: sha256(assetBytes),
    size: assetBytes.length, mediaType: "image/svg+xml" }],
  author: "writer", reason: "test", createdAt: new Date().toISOString(),
};
const mainRegistration: RegisteredDocumentBlob = {
  id: revision.payloadRef!, projectId, documentId: revision.documentId, revisionId: revision.id,
  role: "main", relativePath: null, contentHash: revision.contentHash,
  mediaType: revision.mediaType, size: originalBytes.length,
};
const assetRegistration: RegisteredDocumentBlob = {
  id: revision.assetsManifest[0]!.blobId, projectId, documentId: revision.documentId, revisionId: revision.id,
  role: "asset", relativePath: revision.assetsManifest[0]!.path,
  contentHash: revision.assetsManifest[0]!.contentHash,
  mediaType: revision.assetsManifest[0]!.mediaType, size: assetBytes.length,
};

function fixture(overrides: { main?: Uint8Array; asset?: Uint8Array; mainRegistration?: RegisteredDocumentBlob | null;
  assetRegistration?: RegisteredDocumentBlob | null } = {}) {
  let blobReads = 0;
  let registryReads = 0;
  const registrations = new Map<string, RegisteredDocumentBlob>();
  if (overrides.mainRegistration !== null) registrations.set(mainRegistration.id, overrides.mainRegistration ?? mainRegistration);
  if (overrides.assetRegistration !== null) registrations.set(assetRegistration.id, overrides.assetRegistration ?? assetRegistration);
  const uow = {
    read: async (_scope: string, callback: (reader: { getRegisteredBlob(id: string): Promise<RegisteredDocumentBlob | null> }) => Promise<unknown>) =>
      callback({ getRegisteredBlob: async (id: string) => { registryReads++; return registrations.get(id) ?? null; } }),
  } as unknown as DocumentPayloadUnitOfWork;
  const blobs = {
    read: async (payload: { id: string }) => {
      blobReads++;
      return { status: "available" as const, payload,
        bytes: payload.id === mainRegistration.id ? overrides.main ?? originalBytes : overrides.asset ?? assetBytes };
    },
  } as unknown as BlobStore;
  return { options: { uow, blobsForPrincipal: async () => blobs }, counts: () => ({ blobReads, registryReads }) };
}

test("blob original preserves UTF-8 BOM, non-ASCII text, and CRLF byte-for-byte", async () => {
  const { options, counts } = fixture();
  const result = await readDocumentOriginal(options, principal, revision);
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.body.codePointAt(0), 0xfeff);
  assert.deepEqual(Buffer.from(new TextEncoder().encode(result.body)), originalBytes);
  assert.equal(sha256(new TextEncoder().encode(result.body)), revision.contentHash);
  assert.deepEqual(Buffer.from(result.assets[0]!.base64, "base64"), assetBytes);
  assert.deepEqual(counts(), { blobReads: 2, registryReads: 2 });
});

test("unregistered, tampered, invalid UTF-8, and oversized originals stay unavailable", async () => {
  const unregistered = fixture({ mainRegistration: null });
  assert.deepEqual(await readDocumentOriginal(unregistered.options, principal, revision),
    { status: "unavailable", reason: "unregistered_resource" });
  assert.deepEqual(unregistered.counts(), { blobReads: 0, registryReads: 1 });

  const tamperedAsset = fixture({ asset: Buffer.from("tampered") });
  assert.deepEqual(await readDocumentOriginal(tamperedAsset.options, principal, revision),
    { status: "unavailable", reason: "hash_mismatch" });

  const invalidBytes = Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]);
  const invalidRevision = { ...revision, assetsManifest: [], contentHash: sha256(invalidBytes) };
  const invalidRegistration = { ...mainRegistration, contentHash: invalidRevision.contentHash, size: invalidBytes.length };
  assert.deepEqual(await readDocumentOriginal(fixture({ main: invalidBytes, mainRegistration: invalidRegistration }).options,
    principal, invalidRevision), { status: "unavailable", reason: "invalid_utf8" });

  const tooLargeRegistration = { ...mainRegistration, size: 16 * 1024 * 1024 + 1 };
  const oversized = fixture({ mainRegistration: tooLargeRegistration });
  assert.deepEqual(await readDocumentOriginal(oversized.options, principal, revision),
    { status: "unavailable", reason: "bundle_too_large" });
  assert.deepEqual(oversized.counts(), { blobReads: 0, registryReads: 1 });
});

test("permission is checked before touching the registry or Blob store", async () => {
  const denied = { ...principal, permissions: [] };
  const { options, counts } = fixture();
  assert.deepEqual(await readDocumentOriginal(options, denied, revision),
    { status: "unavailable", reason: "forbidden" });
  assert.deepEqual(counts(), { blobReads: 0, registryReads: 0 });
});
