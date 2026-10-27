import { createHash } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";
import { DomainError } from "@evoloop/contracts/ports";
import { matches, type OriginalReaderOptions } from "./read-original.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (reason: string): never => { throw new DomainError("ORIGINAL_UNAVAILABLE", reason); };
const utf8 = (bytes: Uint8Array): string => {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail("Fixed original is not valid UTF-8"); }
};

/** Verify a single registered blob and its fixed manifest entry before disclosing bytes. */
export async function fixedPart(options: OriginalReaderOptions, principal: Principal, revision: DocumentPayloadRevision,
  blobId?: string): Promise<Buffer> {
  if (!principal.permissions.includes("read") || !principal.projectIds.includes(revision.projectId))
    throw new DomainError("FORBIDDEN", "Project read permission is required");
  if (blobId === undefined && revision.body !== null) {
    if (revision.payloadRef !== null || revision.assetsManifest.length) return fail("Invalid inline original metadata");
    const bytes = Buffer.from(revision.body, "utf8");
    if (bytes.length > 16 * 1024 * 1024 || sha(bytes) !== revision.contentHash) return fail("Inline original hash mismatch");
    return bytes;
  }
  if (revision.body !== null || !revision.payloadRef) return fail("Fixed blob original is unavailable");
  const asset = blobId === undefined ? undefined : revision.assetsManifest.find(item => item.blobId === blobId);
  if (blobId !== undefined && !asset) throw new DomainError("NOT_FOUND", "Asset is not in the fixed manifest");
  const id = asset?.blobId ?? revision.payloadRef;
  const role = asset ? "asset" : "main";
  const registered = await options.uow.read(revision.projectId, reader => reader.getRegisteredBlob(id));
  if (!registered || !matches(registered, revision, role, asset?.path ?? null)) return fail("Fixed resource registration is unavailable");
  if (registered.size > 16 * 1024 * 1024 || registered.size < 0) return fail("Fixed resource exceeds size limit");
  const read = await (await options.blobsForPrincipal(principal)).read(registered);
  if (read.status !== "available") return fail("Fixed resource is unavailable");
  if (read.bytes.length !== registered.size || sha(read.bytes) !== registered.contentHash) return fail("Fixed resource hash mismatch");
  return Buffer.from(read.bytes);
}

export function bodyPage(bytes: Buffer, cursor: number, limit: number) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > bytes.length ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 8192)
    throw new DomainError("INVALID_CURSOR", "Body cursor or page size is invalid");
  // Reject a cursor inside a UTF-8 code point. End boundaries retreat to a complete point.
  if (cursor > 0 && cursor < bytes.length && (bytes[cursor]! & 0xc0) === 0x80)
    throw new DomainError("INVALID_CURSOR", "Body cursor splits a UTF-8 character");
  utf8(bytes);
  let end = Math.min(cursor + limit, bytes.length);
  while (end > cursor && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  if (end === cursor && cursor < bytes.length) {
    end = Math.min(cursor + 4, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
  }
  return { body: utf8(bytes.subarray(cursor, end)), startByte: cursor, endByte: end,
    totalBytes: bytes.length, nextCursor: end < bytes.length ? String(end) : null, truncated: end < bytes.length };
}
