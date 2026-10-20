import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalBlobStore } from "../src/index.ts";

test("prepare, publish, registration, tamper detection and orphan inspection", async () => {
  const parent = await mkdtemp(join(tmpdir(), "evoloop-blobs-"));
  const root = join(parent, "store");
  let allowed = true;
  let registered = false;
  try {
    const store = new LocalBlobStore(root, async () => allowed, async () => registered);
    const bytes = Buffer.from("<html><script>throw Error('must not run')</script></html>");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const payload = { id: "blob_1", projectId: "project_1", contentHash, size: bytes.length, mediaType: "text/html" };
    await assert.rejects(() => store.prepare({ ...payload, contentHash: "0".repeat(64) }, bytes));
    const prepared = await store.prepare(payload, bytes);
    assert.equal(await store.verify(prepared), true);
    assert.equal((await store.read(payload)).status, "unavailable");
    await store.publish(prepared);
    assert.deepEqual(await store.publish(prepared), payload); // Recovery after temp cleanup.
    assert.deepEqual(await store.inspectOrphans(new Set()), { unregisteredIds: [payload.id], temporaryIds: [], unreferencedHashes: [contentHash] });
    registered = true;
    const read = await store.read(payload);
    assert.equal(read.status, "available");
    if (read.status === "available") assert.deepEqual(Buffer.from(read.bytes), bytes);
    allowed = false;
    assert.equal((await store.read(payload)).status, "unavailable");
    allowed = true;
    const duplicate = await store.prepare(payload, bytes);
    await store.publish(duplicate);
    const collision = await store.prepare({ ...payload, id: "blob_1", mediaType: "text/plain" }, bytes);
    await assert.rejects(() => store.publish(collision));
    await writeFile(join(root, "objects", contentHash), "tampered");
    assert.equal((await store.read(payload)).status, "unavailable");
    assert.deepEqual(await store.inspectOrphans(new Set([payload.id])), { unregisteredIds: [], temporaryIds: [collision.preparationId], unreferencedHashes: [] });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
