import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "../src/client.js";
import { materialAsset, materialBody, materialCatalog } from "../src/lightweight-materials.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [projectId, taskId, taskRevisionId, documentId, revisionId, blobId] = [1, 2, 3, 4, 5, 6].map(id);
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const body = "中文内容", asset = Buffer.from([0, 255, 33]);
const client = (reply: unknown): ApiClient => ({ get: async () => reply }) as ApiClient;

test("CLI checks fixed catalog scope, body byte page and both asset hashes", async () => {
  const catalog = { projectId, taskId, taskRevisionId, basisSetId: id(7), title: "Task", acceptance: "Read",
    documents: [{ documentId, revisionId, contentHash: digest(body), sizeBytes: Buffer.byteLength(body), assets: [
      { blobId, contentHash: digest(asset), sizeBytes: asset.length }] }], externalReferences: [] };
  assert.equal((await materialCatalog(client(catalog), projectId, taskId, taskRevisionId)).documents.length, 1);
  await assert.rejects(materialCatalog(client({ ...catalog, taskRevisionId: id(8) }), projectId, taskId, taskRevisionId), /Task revision/);
  const page = { projectId, documentId, revisionId, contentHash: digest(body), body, startByte: 0,
    endByte: Buffer.byteLength(body), totalBytes: Buffer.byteLength(body), nextCursor: null, truncated: false };
  assert.equal((await materialBody(client(page), projectId, documentId, revisionId, digest(body), 0, 4096)).body, body);
  await assert.rejects(materialBody(client({ ...page, body: "篡改" }), projectId, documentId, revisionId, digest(body), 0, 4096), /inconsistent|hash/);
  const reply = { projectId, documentId, revisionId, documentContentHash: digest(body), blobId,
    contentHash: digest(asset), size: asset.length, base64: asset.toString("base64") };
  const directory = await mkdtemp(join(tmpdir(), "evoloop-single-asset-"));
  try {
    const out = join(directory, "asset.bin");
    assert.equal((await materialAsset(client(reply), projectId, documentId, revisionId, blobId,
      digest(body), digest(asset), out)).status, "exported");
    assert.deepEqual(await readFile(out), asset);
    await assert.rejects(materialAsset(client(reply), projectId, documentId, revisionId, blobId,
      digest(body), digest(asset), out), /EEXIST/);
    await assert.rejects(materialAsset(client({ ...reply, base64: Buffer.from("tampered").toString("base64") }),
      projectId, documentId, revisionId, blobId, digest(body), digest(asset)), /hash mismatch/);
    await assert.rejects(materialAsset(client(reply), projectId, documentId, revisionId, blobId,
      digest("changed"), digest(asset)), /Document hash/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
