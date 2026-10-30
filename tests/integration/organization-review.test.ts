import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { LocalBlobStore } from "@evoloop/adapter-local-blobs";
import { WorkflowService } from "@evoloop/core";
import { importDocumentPayload } from "@evoloop/core/documents";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import type { Document, Principal } from "@evoloop/contracts";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("Organization review tests need an isolated evoloop_*_test database");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

test("organization reviews are ordinary fixed Documents with native type, period, original bytes and references", async t => {
  const schema = `el_review_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const uow = new PostgresUnitOfWork(pool);
  const root = await mkdtemp(join(tmpdir(), "evoloop-review-original-"));
  t.after(async () => {
    await pool.end(); await rm(root, { recursive: true, force: true });
    const cleanup = new pg.Client({ connectionString: database }); await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
  });
  const projectId = randomUUID(), principal: Principal = { actorId: "review-author", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } });
  await workflow.execute(principal, { type: "project.create", projectId, operationId: randomUUID(), title: "Review test" });
  const blobs = new LocalBlobStore(root, async () => true, payload => uow.read(payload.projectId, async reader => !!await reader.getRegisteredBlob(payload.id)));
  const deps = { uow, blobs, hashText: hash, nextId: randomUUID, now: () => new Date().toISOString() };
  const documentId = randomUUID(), revisionId = randomUUID(), mainId = randomUUID(), imageId = randomUUID();
  const html = '<!doctype html><html><body><h1>自由编写的完整复盘</h1><p>没有固定章节或字段模板。</p><img src="assets/diagram.png"></body></html>';
  const body = Buffer.from(html), image = Buffer.from("real resource bytes");
  const period = { observedFrom: "2026-10-29T10:00:00+08:00", observedTo: "2026-10-30T10:00:00+08:00", timeZone: "Asia/Taipei" };
  const command = { projectId, operationId: randomUUID(), documentId, revisionId, mode: "create", title: "本轮组织复盘", kind: "organization_review", organizationReview: period,
    author: principal.actorId, reason: "保存本轮原件", format: "html", mediaType: "text/html", originalName: "report.html",
    source: { storage: "blob", payloadRef: mainId, contentHash: hash(body), size: body.length, entrypoint: "report.html",
      assets: [{ path: "assets/diagram.png", blobId: imageId, contentHash: hash(image), size: image.length, mediaType: "image/png" }] } };
  const saved = await importDocumentPayload(deps, principal, command, new Map([[mainId, body], [imageId, image]]));
  assert.equal(saved.status, "applied");
  assert.deepEqual(await importDocumentPayload(deps, principal, command), saved);
  const document = await workflow.getDocument(principal, projectId, documentId);
  assert.equal(document.document.kind, "organization_review");
  assert.deepEqual(document.current.organizationReview, period);
  assert.equal(document.current.contentHash, hash(html));
  const original = await blobs.read({ id: mainId, projectId, contentHash: hash(body), size: body.length, mediaType: "text/html" });
  assert.equal(original.status, "available");
  if (original.status === "available") assert.equal(Buffer.from(original.bytes).toString(), html);
  const plainId = randomUUID();
  await workflow.execute(principal, { type: "document.create", projectId, operationId: randomUUID(), documentId: plainId, title: "普通报告", kind: "report", body: "# 普通报告" });
  const listed = await workflow.listDocuments(principal, projectId, 50, undefined, "organization_review");
  assert.deepEqual(listed.items.map(item => item.id), [documentId]);
  assert.deepEqual(listed.items[0]!.organizationReview, period);
  assert.ok(listed.items[0]!.createdAt);
  assert.ok((await workflow.listDocuments(principal, projectId)).items.some(item => item.id === documentId), "same Document is also in the ordinary document library");

  const nextId = randomUUID();
  const nextPeriod = { ...period, observedFrom: period.observedTo, observedTo: "2026-10-31T10:00:00+08:00", previous: { documentId, revisionId } };
  const next = await workflow.execute(principal, { type: "document.create", projectId, operationId: randomUUID(), documentId: nextId, title: "下一轮", kind: "organization_review", organizationReview: nextPeriod, body: "# 下一轮的自由正文" });
  assert.equal(next.status, "applied");
  const incomplete = await workflow.execute(principal, { type: "document.create", projectId, operationId: randomUUID(), documentId: randomUUID(), title: "缺区间", kind: "organization_review", body: "# 内容" });
  assert.equal(incomplete.status, "rejected");
  const wrongPrevious = await workflow.execute(principal, { type: "document.create", projectId, operationId: randomUUID(), documentId: randomUUID(), title: "错误引用", kind: "organization_review", organizationReview: { ...period, previous: { documentId: plainId, revisionId } }, body: "# 内容" });
  assert.equal(wrongPrevious.status, "rejected");
  await assert.rejects(workflow.getDocument({ ...principal, projectIds: [] }, projectId, documentId));

  const oldPlain = await workflow.getDocument(principal, projectId, plainId);
  const reclassified = await importDocumentPayload(deps, principal, { projectId, operationId: randomUUID(), documentId: plainId, revisionId: randomUUID(), mode: "revise", expectedVersion: 1,
    kind: "organization_review", organizationReview: period, author: principal.actorId, reason: "把早期报告归为组织复盘", format: "markdown", mediaType: "text/markdown", originalName: "legacy.md", source: { storage: "inline", body: "# 普通报告" } });
  assert.equal(reclassified.status, "applied");
  const upgraded = await workflow.getDocument(principal, projectId, plainId);
  assert.equal(upgraded.document.id, plainId);
  assert.equal(upgraded.document.kind, "organization_review");
  assert.deepEqual(upgraded.current.organizationReview, period);
  assert.equal((await workflow.getDocumentRevision(principal, projectId, plainId, oldPlain.current.id)).organizationReview, undefined);
  assert.equal((await workflow.getDocumentRevision(principal, projectId, plainId, oldPlain.current.id)).body, "# 普通报告");
  const changedPeriod = { ...period, observedTo: "2026-10-30T11:00:00+08:00" };
  await workflow.execute(principal, { type: "document.revise", projectId, operationId: randomUUID(), documentId: plainId, expectedVersion: 2, body: "# 修订后的正文", reason: "补查后修订", organizationReview: changedPeriod });
  assert.deepEqual((await workflow.getDocumentRevision(principal, projectId, plainId, upgraded.current.id)).organizationReview, period, "a fixed old period does not follow the current revision");
  assert.deepEqual((await workflow.getDocument(principal, projectId, plainId)).current.organizationReview, changedPeriod);

  const roleId = fixtureRoleId("review-origin-author");
  await seedFixtureRole(pool, projectId, roleId);
  const taskId = randomUUID();
  const task = await workflow.execute(principal, { type: "task.create", projectId, operationId: randomUUID(), taskId, title: "有界复盘工作", content: "调查并形成报告", acceptance: "成果可回读", owner: roleId });
  assert.equal(task.status, "applied");
  const originatedId = randomUUID();
  const originated = await workflow.execute(principal, { type: "document.create", projectId, operationId: randomUUID(), documentId: originatedId, title: "有真实来源的复盘", kind: "organization_review", organizationReview: period, origin: { taskId }, body: "# 原件" });
  assert.equal(originated.status, "applied", "native review accepts the same valid origin as a report");
  assert.equal((await workflow.getDocument(principal, projectId, originatedId)).document.origin?.taskId, taskId);
  const legacyOriginId = randomUUID();
  await workflow.execute(principal, { type: "document.create", projectId, operationId: randomUUID(), documentId: legacyOriginId, title: "早期有来源的报告", kind: "report", origin: { taskId }, body: "# 原件" });
  const legacyOrigin = (await workflow.getDocument(principal, projectId, legacyOriginId)).document.origin;
  const classifyOrigin = await importDocumentPayload(deps, principal, { projectId, operationId: randomUUID(), documentId: legacyOriginId, revisionId: randomUUID(), mode: "revise", expectedVersion: 1, kind: "organization_review", organizationReview: period, author: principal.actorId, reason: "明确原生类型，保留来源", format: "markdown", mediaType: "text/markdown", originalName: "origin.md", source: { storage: "inline", body: "# 原件" } });
  assert.equal(classifyOrigin.status, "applied");
  assert.deepEqual((await workflow.getDocument(principal, projectId, legacyOriginId)).document.origin, legacyOrigin);

  const token = randomUUID(), otherToken = randomUUID();
  const app = await buildServer({ service: workflow, credentials: [
    { token, actorId: principal.actorId, projectIds: [projectId], permissions: ["read"] },
    { token: otherToken, actorId: "other-project-reader", projectIds: [randomUUID()], permissions: ["read"] },
  ], documents: { uow, blobsForPrincipal: () => blobs } });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  const listing = await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents?kind=organization_review`, headers });
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.json().items.every((item: Document) => item.kind === "organization_review"), true);
  const fromLibrary = await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents/${documentId}`, headers });
  assert.equal(fromLibrary.json().document.id, listing.json().items.find((item: Document) => item.id === documentId).id);
  const originalResponse = await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}/original`, headers });
  assert.equal(originalResponse.json().body, html);
  assert.equal(originalResponse.json().assets[0].base64, image.toString("base64"));
  assert.equal((await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents?kind=not_a_type`, headers })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/api/projects/${projectId}/documents?kind=organization_review`, headers: { authorization: `Bearer ${otherToken}` } })).statusCode, 403);
});
