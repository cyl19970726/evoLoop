import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, link, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { BlobOrphanReport, BlobPayload, BlobRead, BlobStore, PreparedBlob } from "@evoloop/contracts/sources";

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const limit = 16 * 1024 * 1024;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: BlobPayload, b: BlobPayload): boolean => a.id === b.id && a.projectId === b.projectId && a.contentHash === b.contentHash && a.size === b.size && a.mediaType === b.mediaType;
async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("unsafe or oversized blob file");
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error("unsafe or oversized blob file");
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string,
    private readonly mayRead: (payload: BlobPayload) => Promise<boolean>,
    private readonly isRegistered: (payload: BlobPayload) => Promise<boolean>) {
    if (!isAbsolute(root)) throw new Error("blob root must be absolute");
  }
  private async dirs(): Promise<{ temp: string; objects: string; refs: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error("blob root cannot be a symlink");
    const result = { temp: join(this.root, "temp"), objects: join(this.root, "objects"), refs: join(this.root, "refs") };
    for (const dir of Object.values(result)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!(await lstat(dir)).isDirectory()) throw new Error("blob directory is unsafe");
    }
    return result;
  }
  private valid(payload: BlobPayload): void {
    if (!idPattern.test(payload.id) || !idPattern.test(payload.projectId) || !hashPattern.test(payload.contentHash) ||
      !Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > limit || !payload.mediaType || payload.mediaType.length > 255) throw new Error("invalid blob metadata");
  }
  async prepare(payload: BlobPayload, bytes: Uint8Array): Promise<PreparedBlob> {
    this.valid(payload);
    if (bytes.length !== payload.size || digest(bytes) !== payload.contentHash) throw new Error("blob hash or size mismatch");
    const { temp } = await this.dirs();
    const preparationId = randomUUID();
    const handle = await open(join(temp, preparationId), "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    return { payload, preparationId };
  }
  async verify(prepared: PreparedBlob): Promise<boolean> {
    this.valid(prepared.payload);
    if (!/^[a-f0-9-]{36}$/.test(prepared.preparationId)) return false;
    const { temp } = await this.dirs();
    try {
      const path = join(temp, prepared.preparationId);
      const bytes = await readBounded(path);
      return bytes.length === prepared.payload.size && digest(bytes) === prepared.payload.contentHash;
    } catch { return false; }
  }
  async publish(prepared: PreparedBlob): Promise<BlobPayload> {
    this.valid(prepared.payload);
    const { temp, objects, refs } = await this.dirs();
    const object = join(objects, prepared.payload.contentHash);
    const temporary = join(temp, prepared.preparationId);
    const ref = join(refs, prepared.payload.id);
    try {
      const existing = JSON.parse((await readBounded(ref)).toString("utf8")) as BlobPayload;
      if (!same(existing, prepared.payload)) throw new Error("blob ID already belongs to another payload");
      const stored = await readBounded(object);
      if (stored.length !== prepared.payload.size || digest(stored) !== prepared.payload.contentHash) throw new Error("existing blob failed verification");
      await unlink(temporary).catch(() => undefined);
      return prepared.payload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!(await this.verify(prepared))) throw new Error("unverified blob preparation");
    try { await link(temporary, object); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readBounded(object);
      if (existing.length !== prepared.payload.size || digest(existing) !== prepared.payload.contentHash) throw new Error("existing blob failed verification");
    }
    // Metadata is immutable; an ID may only be published once for the same payload.
    const data = Buffer.from(JSON.stringify(prepared.payload));
    const metadataTemp = join(temp, `${randomUUID()}.meta`);
    const metadataHandle = await open(metadataTemp, "wx", 0o600);
    try {
      await metadataHandle.writeFile(data);
      await metadataHandle.sync();
    } finally { await metadataHandle.close(); }
    try {
      try { await link(metadataTemp, ref); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = JSON.parse((await readBounded(ref)).toString("utf8")) as BlobPayload;
        if (!same(existing, prepared.payload)) throw new Error("blob ID already belongs to another payload");
      }
    } finally {
      await unlink(metadataTemp).catch(() => undefined);
    }
    for (const dir of [objects, refs]) {
      const handle = await open(dir, constants.O_RDONLY);
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await unlink(temporary).catch(() => undefined);
    return prepared.payload;
  }
  async read(payload: BlobPayload): Promise<BlobRead> {
    this.valid(payload);
    const unavailable = (reason: "permission" | "unregistered" | "missing" | "hash_mismatch" | "too_large"): BlobRead => ({ status: "unavailable", payload, reason });
    if (!(await this.mayRead(payload))) return unavailable("permission");
    if (!(await this.isRegistered(payload))) return unavailable("unregistered");
    const { objects, refs } = await this.dirs();
    try {
      const recorded = JSON.parse((await readBounded(join(refs, payload.id))).toString("utf8")) as BlobPayload;
      if (!same(recorded, payload)) return unavailable("hash_mismatch");
      const path = join(objects, payload.contentHash);
      const stat = await lstat(path);
      if (!stat.isFile()) return unavailable("missing");
      if (stat.size > limit) return unavailable("too_large");
      const bytes = await readBounded(path);
      if (bytes.length !== payload.size || digest(bytes) !== payload.contentHash) return unavailable("hash_mismatch");
      return { status: "available", payload, bytes };
    } catch { return unavailable("missing"); }
  }
  async inspectOrphans(registeredIds: ReadonlySet<string>): Promise<BlobOrphanReport> {
    const { refs, temp, objects } = await this.dirs();
    const ids = (await readdir(refs)).filter((id) => idPattern.test(id));
    const hashes = new Set<string>();
    for (const id of ids) {
      if (!registeredIds.has(id)) continue;
      try {
        const payload = JSON.parse((await readBounded(join(refs, id))).toString("utf8")) as BlobPayload;
        if (payload.id === id && hashPattern.test(payload.contentHash)) hashes.add(payload.contentHash);
      } catch { /* malformed metadata remains visible to a separate integrity check */ }
    }
    return {
      unregisteredIds: ids.filter((id) => !registeredIds.has(id)).sort(),
      temporaryIds: (await readdir(temp)).sort(),
      unreferencedHashes: (await readdir(objects)).filter((hash) => !hashes.has(hash)).sort(),
    };
  }
}
