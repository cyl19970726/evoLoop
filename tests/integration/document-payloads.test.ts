import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "@evoloop/adapter-postgres";
import { PgDocumentPayloadStore } from "@evoloop/adapter-postgres/documents";
import { LocalBlobStore } from "@evoloop/adapter-local-blobs";
import { importDocumentPayload } from "@evoloop/core/documents";
import type { Document, DocumentDecision, Operation, OutboxEvent, Principal } from "@evoloop/contracts";
import type { DocumentPayloadTransaction, DocumentPayloadUnitOfWork } from "@evoloop/contracts/process-documents";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_document_test(?:\?|$)/.test(url)) throw new Error("Use dedicated evoloop_document_test database");
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

test("real PostgreSQL and BlobStore: immutable inline and bundle revisions, ownership and completeness", async (t) => {
  await migrate(url);
  const pool = new pg.Pool({ connectionString: url });
  const root = await mkdtemp(join(tmpdir(), "evoloop-document-blobs-"));
  t.after(async () => { await pool.end(); await rm(root, { recursive: true, force: true }); });
  const projectId = randomUUID(), documentId = randomUUID();
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Document payload test',now())", [projectId]);
  const uow: DocumentPayloadUnitOfWork = {
    async transaction<T>(scope: string, action: (tx: DocumentPayloadTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scope]);
        const store = new PgDocumentPayloadStore(client, scope);
        const tx: DocumentPayloadTransaction = {
          ...{
            getOperation: store.getOperation.bind(store),
            getDocumentPayloadRevision: store.getDocumentPayloadRevision.bind(store),
            listDocumentAssets: store.listDocumentAssets.bind(store),
            getRegisteredBlob: store.getRegisteredBlob.bind(store),
            getGitSourceRef: store.getGitSourceRef.bind(store),
            insertDocumentPayloadRevision: store.insertDocumentPayloadRevision.bind(store),
            registerDocumentBlob: store.registerDocumentBlob.bind(store),
          },
          async getDocument(id: string) {
            const r = await client.query("SELECT * FROM process_document WHERE project_id=$1 AND document_id=$2", [scope,id]);
            const x = r.rows[0];
            return x ? { projectId: x.project_id, id: x.document_id, title: x.title, version: x.version,
              currentRevisionId: x.current_revision_id, adoptedRevisionId: x.adopted_revision_id } as Document : null;
          },
          async insertDocument(d: Document) {
            await client.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [scope,d.id,d.title,d.version,d.currentRevisionId,d.adoptedRevisionId]);
          },
          async updateDocument(d: Document, expected: number) {
            const r = await client.query("UPDATE process_document SET version=$3,current_revision_id=$4 WHERE project_id=$1 AND document_id=$2 AND version=$5", [scope,d.id,d.version,d.currentRevisionId,expected]);
            if (r.rowCount !== 1) throw new Error("version conflict");
          },
          async insertDocumentDecision(_d: DocumentDecision) { throw new Error("not exercised"); },
          async savepoint<T>(body: () => Promise<T>): Promise<T> {
            await client.query("SAVEPOINT document_effect");
            try { const result = await body(); await client.query("RELEASE SAVEPOINT document_effect"); return result; }
            catch (error) { await client.query("ROLLBACK TO SAVEPOINT document_effect"); throw error; }
          },
          async insertOperation(o: Operation) {
            await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
              VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [scope,o.id,o.actorId,o.commandHash,o.commandType,JSON.stringify(o.result),o.createdAt]);
          },
          async appendOutbox(e: OutboxEvent) {
            await client.query(`INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [scope,e.id,e.operationId,e.effectKey,e.kind,e.entityId,e.version,e.createdAt]);
          },
        };
        const result = await action(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async read<T>(scope: string, action: (reader: PgDocumentPayloadStore) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try { return await action(new PgDocumentPayloadStore(client, scope)); } finally { client.release(); }
    },
  };
  const blobs = new LocalBlobStore(root, async () => true, async (payload) =>
    !!await uow.read(payload.projectId, reader => reader.getRegisteredBlob(payload.id)));
  const deps = { uow, blobs, hashText: (text: string) => hash(text), nextId: randomUUID,
    now: () => new Date().toISOString() };
  const principal: Principal = { actorId: "test", projectIds: [projectId], permissions: ["read", "write"] };
  const common = { projectId, operationId: randomUUID(), documentId, author: "test", reason: "test", originalName: "report.md" };
  const first = randomUUID();
  const gitId = randomUUID();
  const gitClient = await pool.connect();
  try {
    await new PgDocumentPayloadStore(gitClient, projectId).insertGitSourceRef(gitId,
      { projectId, repositoryId: "product", path: "docs/fixed.md", commit: "a".repeat(40), contentHash: hash("source") },
      "reachable", new Date().toISOString());
  } finally { gitClient.release(); }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM process_document WHERE project_id=$1", [projectId])).rows[0].n, 0,
    "a formal Git source does not create a process Document");
  const createCommand = { ...common, mode: "create", title: "Report", revisionId: first,
    format: "markdown", mediaType: "text/markdown", source: { storage: "inline", body: "# first" } };
  const created = await importDocumentPayload(deps, principal, createCommand);
  assert.equal(created.status, "applied");
  assert.deepEqual(await importDocumentPayload(deps, principal, createCommand), created, "same operation replays receipt");
  await assert.rejects(importDocumentPayload(deps, principal, { ...createCommand,
    source: { storage: "inline", body: "different" } }), /different command/);
  await assert.rejects(importDocumentPayload(deps,
    { ...principal, actorId: "other" }, { ...createCommand, author: "other" }), /different command/);
  await assert.rejects(importDocumentPayload(deps, { ...principal, permissions: ["read"] },
    { ...createCommand, operationId: randomUUID(), format: "html", mediaType: "text/html",
      source: { storage: "blob", payloadRef: randomUUID(), contentHash: hash("unprovided"), size: 10,
        entrypoint: "index.html", assets: [] } }), /write permission/);
  await assert.rejects(importDocumentPayload(deps, principal,
    { ...createCommand, operationId: randomUUID(), author: "self-reported-other" }), /matching author/);
  assert.equal((await uow.read(projectId, r => r.getDocumentPayloadRevision(documentId, first)))?.body, "# first");
  const mainId = randomUUID(), assetId = randomUUID(), second = randomUUID();
  const main = Buffer.from("<html><body><img src='images/chart.svg'></body></html>");
  const asset = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  const bundleCommand = { ...common, operationId: randomUUID(), mode: "revise", expectedVersion: 1,
    revisionId: second, format: "html", mediaType: "text/html", originalName: "index.html",
    source: { storage: "blob", payloadRef: mainId, contentHash: hash(main), size: main.length,
      entrypoint: "index.html", assets: [{ path: "images/chart.svg", blobId: assetId,
        contentHash: hash(asset), size: asset.length, mediaType: "image/svg+xml" }] } };
  const bundled = await importDocumentPayload(deps, principal, bundleCommand, new Map([[mainId, main], [assetId, asset]]));
  assert.equal(bundled.status, "applied");
  assert.deepEqual(await importDocumentPayload(deps, principal, bundleCommand), bundled,
    "replay returns receipt before requiring upload bytes again");
  const fixed = await uow.read(projectId, r => r.getDocumentPayloadRevision(documentId, second));
  assert.equal(fixed?.body, null);
  assert.equal(fixed?.payloadRef, mainId);
  assert.equal(fixed?.previousRevisionId, first);
  assert.equal((await blobs.read({ id: assetId, projectId, contentHash: hash(asset), size: asset.length,
    mediaType: "image/svg+xml" })).status, "available");
  const unsafe = await importDocumentPayload(deps, principal, { ...common, operationId: randomUUID(), mode: "revise", expectedVersion: 2,
    revisionId: randomUUID(), format: "html", mediaType: "text/html", originalName: "index.html",
    source: { storage: "blob", payloadRef: randomUUID(), contentHash: hash(main), size: main.length,
      entrypoint: "index.html", assets: [{ path: "../escape", blobId: randomUUID(), contentHash: hash(asset),
        size: asset.length, mediaType: "image/svg+xml" }] } }, new Map());
  assert.equal(unsafe.status, "rejected");
  const missing = randomUUID();
  const missingResult = await importDocumentPayload(deps, principal, { ...common, operationId: randomUUID(), mode: "revise", expectedVersion: 2,
    revisionId: missing, format: "html", mediaType: "text/html", originalName: "index.html",
    source: { storage: "blob", payloadRef: randomUUID(), contentHash: hash(main), size: main.length,
      entrypoint: "index.html", assets: [] } }, new Map());
  assert.equal(missingResult.status, "rejected");
  await assert.rejects(pool.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,payload_ref)
    VALUES($1,$2,$3,'bad','markdown',$4,'test',now(),'bad',$5)`, [projectId,documentId,randomUUID(),hash("bad"),randomUUID()]), /document_revision_payload_xor/);
  await assert.rejects(pool.query("UPDATE document_blob_ref SET content_hash=$4 WHERE project_id=$1 AND blob_id=$2 AND document_id=$3", [projectId,mainId,documentId,hash("tampered")]), /immutable/);
  const stale = await importDocumentPayload(deps, principal, { ...common, operationId: randomUUID(), mode: "revise", expectedVersion: 1,
    revisionId: randomUUID(), format: "markdown", mediaType: "text/markdown",
    source: { storage: "inline", body: "stale" } });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.status === "rejected" ? stale.code : "", "VERSION_CONFLICT");
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM operation_journal WHERE project_id=$1) AS operations,
    (SELECT count(*)::int FROM outbox_event WHERE project_id=$1) AS events,
    (SELECT count(*)::int FROM document_revision WHERE project_id=$1) AS revisions`, [projectId]);
  assert.deepEqual(counts.rows[0], { operations: 5, events: 2, revisions: 2 });
  const concurrent = { ...common, operationId: randomUUID(), mode: "revise", expectedVersion: 2,
    revisionId: randomUUID(), format: "markdown", mediaType: "text/markdown",
    source: { storage: "inline", body: "# concurrent" } };
  const twins = await Promise.all([
    importDocumentPayload(deps, principal, concurrent), importDocumentPayload(deps, principal, concurrent),
  ]);
  assert.deepEqual(twins[0], twins[1], "concurrent same-ID commands share a receipt");
  assert.equal(twins[0]?.status, "applied");
  const rollbackOperationId = randomUUID(), rollbackRevisionId = randomUUID();
  const failingUow: DocumentPayloadUnitOfWork = { ...uow,
    transaction: (scope, action) => uow.transaction(scope, tx => action({ ...tx,
      appendOutbox: async () => { throw new Error("simulated outbox failure"); } })) };
  await assert.rejects(importDocumentPayload({ ...deps, uow: failingUow }, principal,
    { ...common, operationId: rollbackOperationId, mode: "revise", expectedVersion: 3,
      revisionId: rollbackRevisionId, format: "markdown", mediaType: "text/markdown",
      source: { storage: "inline", body: "must roll back" } }), /simulated outbox failure/);
  assert.equal((await uow.read(projectId, r => r.getOperation(rollbackOperationId))), null);
  assert.equal((await uow.read(projectId, r => r.getDocumentPayloadRevision(documentId, rollbackRevisionId))), null);
  const oversizedUtf8 = await importDocumentPayload(deps, principal,
    { ...common, operationId: randomUUID(), mode: "revise", expectedVersion: 3,
      revisionId: randomUUID(), format: "markdown", mediaType: "text/markdown",
      source: { storage: "inline", body: "汉".repeat(22000) } });
  assert.equal(oversizedUtf8.status, "rejected");
  assert.match(oversizedUtf8.status === "rejected" ? oversizedUtf8.message : "", /UTF-8 bytes/);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO document_revision
      (project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,payload_ref,entrypoint,assets_manifest)
      VALUES($1,$2,$3,NULL,'html',$4,'test',now(),'missing resource','text/html',$5,'index.html','[]')`,
      [projectId,documentId,randomUUID(),hash(main),randomUUID()]);
    await assert.rejects(client.query("COMMIT"), /document main payload|document_revision_payload_owner_fk/);
  } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
});
