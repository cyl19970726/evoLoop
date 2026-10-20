import { createHash } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { DocumentPayloadRevision, DocumentPayloadUnitOfWork, RegisteredDocumentBlob } from "@evoloop/contracts/process-documents";
import type { BlobPayload, BlobStore } from "@evoloop/contracts/sources";
import type { DocumentOriginalRead } from "../runtime/materials.js";

const maxBundleBytes = 16 * 1024 * 1024;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export interface OriginalReaderOptions {
  uow: DocumentPayloadUnitOfWork;
  blobsForPrincipal(principal: Principal): BlobStore | Promise<BlobStore>;
}

/** Reads every registered resource under the caller's authority before claiming availability. */
export async function readDocumentOriginal(
  options: OriginalReaderOptions, principal: Principal, revision: DocumentPayloadRevision,
): Promise<DocumentOriginalRead> {
  if (!principal.permissions.includes("read") || !principal.projectIds.includes(revision.projectId))
    return { status: "unavailable", reason: "forbidden" };
  if (revision.body !== null) {
    if (revision.payloadRef !== null || revision.assetsManifest.length ||
        Buffer.byteLength(revision.body, "utf8") > maxBundleBytes || hash(revision.body) !== revision.contentHash)
      return { status: "unavailable", reason: "inline_hash_mismatch" };
    return { status: "available", body: revision.body, assets: [] };
  }
  if (!revision.payloadRef) return { status: "unavailable", reason: "missing_payload_ref" };
  const blobs = await options.blobsForPrincipal(principal);
  const expected: Array<{ payload: BlobPayload; role: "main" | "asset"; path: string | null }> = [
    { payload: { id: revision.payloadRef, projectId: revision.projectId, contentHash: revision.contentHash,
      mediaType: revision.mediaType, size: 0 }, role: "main", path: null },
    ...revision.assetsManifest.map(asset => ({ payload: { id: asset.blobId, projectId: revision.projectId,
      contentHash: asset.contentHash, mediaType: asset.mediaType, size: asset.size },
      role: "asset" as const, path: asset.path })),
  ];
  let total = 0;
  const assets: Array<{ path: string; mediaType: string; base64: string }> = [];
  let body: string | null = null;
  for (const part of expected) {
    const registered = await options.uow.read(revision.projectId, reader => reader.getRegisteredBlob(part.payload.id));
    if (!registered || !matches(registered, revision, part.role, part.path))
      return { status: "unavailable", reason: "unregistered_resource" };
    const payload = { ...part.payload, size: registered.size };
    total += payload.size;
    if (total > maxBundleBytes) return { status: "unavailable", reason: "bundle_too_large" };
    const read = await blobs.read(payload);
    if (read.status !== "available") return { status: "unavailable", reason: read.reason };
    if (read.bytes.length !== payload.size || hash(read.bytes) !== payload.contentHash)
      return { status: "unavailable", reason: "hash_mismatch" };
    if (part.role === "main") {
      try { body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes); }
      catch { return { status: "unavailable", reason: "invalid_utf8" }; }
    } else assets.push({ path: part.path!, mediaType: payload.mediaType, base64: Buffer.from(read.bytes).toString("base64") });
  }
  return body === null ? { status: "unavailable", reason: "missing_payload" } :
    { status: "available", body, assets };
}

function matches(blob: RegisteredDocumentBlob, revision: DocumentPayloadRevision,
  role: "main" | "asset", path: string | null): boolean {
  return blob.projectId === revision.projectId && blob.documentId === revision.documentId &&
    blob.revisionId === revision.id && blob.role === role && blob.relativePath === path &&
    (role === "main" ? blob.contentHash === revision.contentHash && blob.mediaType === revision.mediaType :
      revision.assetsManifest.some(asset => asset.blobId === blob.id && asset.path === path &&
        asset.contentHash === blob.contentHash && asset.mediaType === blob.mediaType && asset.size === blob.size));
}
