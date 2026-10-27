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

/** Per-server, short-lived cache of bytes already checked against the immutable registration. */
export class FixedBodyCache {
  private entries = new Map<string, { bytes: Buffer; expiresAt: number }>();
  private used = 0;
  constructor(readonly maxBytes = 24 * 1024 * 1024, private readonly ttlMs = 60_000) {}
  get bytesUsed() { return this.used; }
  get(key: string): Buffer | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.used -= entry.bytes.length;
    if (entry.expiresAt <= Date.now()) return null;
    this.entries.set(key, entry);
    this.used += entry.bytes.length;
    return entry.bytes;
  }
  set(key: string, bytes: Buffer): void {
    if (bytes.length > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing) { this.used -= existing.bytes.length; this.entries.delete(key); }
    while (this.used + bytes.length > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.used -= this.entries.get(oldest)!.bytes.length;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { bytes, expiresAt: Date.now() + this.ttlMs });
    this.used += bytes.length;
  }
}

/** Verify a single registered blob and its fixed manifest entry before disclosing bytes. */
export async function fixedPart(options: OriginalReaderOptions, principal: Principal, revision: DocumentPayloadRevision,
  blobId?: string, cache?: FixedBodyCache): Promise<Buffer> {
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
  const blobStore = await options.blobsForPrincipal(principal);
  // Authorization and the current registration are checked on every page; only a verified main body is cached.
  const cacheKey = blobId === undefined ? JSON.stringify([principal.actorId, revision.projectId,
    revision.documentId, revision.id, registered.id, registered.contentHash, registered.size]) : null;
  const cached = cacheKey ? cache?.get(cacheKey) : null;
  if (cached) return cached;
  const read = await blobStore.read(registered);
  if (read.status !== "available") return fail("Fixed resource is unavailable");
  if (read.bytes.length !== registered.size || sha(read.bytes) !== registered.contentHash) return fail("Fixed resource hash mismatch");
  const verified = Buffer.from(read.bytes);
  if (cacheKey) { utf8(verified); cache?.set(cacheKey, verified); }
  return verified;
}

export function bodyPage(bytes: Buffer, cursor: number, limit: number) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > bytes.length ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 8192)
    throw new DomainError("INVALID_CURSOR", "Body cursor or page size is invalid");
  // Reject a cursor inside a UTF-8 code point. End boundaries retreat to a complete point.
  if (cursor > 0 && cursor < bytes.length && (bytes[cursor]! & 0xc0) === 0x80)
    throw new DomainError("INVALID_CURSOR", "Body cursor splits a UTF-8 character");
  let end = Math.min(cursor + limit, bytes.length);
  while (end > cursor && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  if (end === cursor && cursor < bytes.length) {
    end = Math.min(cursor + 4, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end++;
  }
  return { body: utf8(bytes.subarray(cursor, end)), startByte: cursor, endByte: end,
    totalBytes: bytes.length, nextCursor: end < bytes.length ? String(end) : null, truncated: end < bytes.length };
}
