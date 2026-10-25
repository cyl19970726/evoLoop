import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { CommandResult, Principal } from "@evoloop/contracts";
import type { Reader, UnitOfWork } from "@evoloop/contracts/ports";
import { buildServer } from "../../apps/coordinator/src/server.js";

const database = process.env.TEST_DATABASE_URL;
let databaseName = "";
try {
  const parsed = new URL(database ?? "");
  if (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") databaseName = decodeURIComponent(parsed.pathname.slice(1));
} catch { /* An invalid URL cannot pass the dedicated test database check. */ }
if (!/^evoloop(?:_[a-z0-9]+)*_test$/.test(databaseName))
  throw new Error("Use a dedicated evoloop_*_test database");

test("document reverse Task lookup returns current exact references in UUID pages", async t => {
  const schema = `document_task_refs_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const projectId = randomUUID(), sourceDocumentId = randomUUID();
  const owner: Principal = { actorId: "document-reference-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const readOnly: Principal = { actorId: "document-reference-reader", projectIds: [projectId], permissions: ["read"] };
  const writer: Principal = { actorId: "document-reference-writer", projectIds: [projectId], permissions: ["write"] };
  const ownerToken = randomUUID() + randomUUID(), readerToken = randomUUID() + randomUUID(), writerToken = randomUUID() + randomUUID();
  const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool),
    clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const app = await buildServer({ service, credentials: [{ token: ownerToken, ...owner }, { token: readerToken, ...readOnly },
    { token: writerToken, ...writer }] });
  t.after(async () => {
    await app.close(); await pool.end();
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const send = async (command: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${ownerToken}` },
      payload: { projectId, operationId: randomUUID(), ...command } });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json() as CommandResult;
    assert.equal(result.status, "applied", JSON.stringify(result));
    return result as Extract<CommandResult, { status: "applied" }>;
  };
  await send({ type: "project.create", title: "Document task references" });
  const source = await send({ type: "document.create", documentId: sourceDocumentId, title: "Shared source", body: "private source body" });
  await send({ type: "document.adopt", documentId: sourceDocumentId, expectedVersion: 1,
    revisionId: source.revisionId, reason: "Publish the fixed source for basis use" });

  const ids: string[] = [];
  for (let index = 0; index < 51; index++) {
    const taskId = randomUUID(); ids.push(taskId);
    await send({ type: "task.create", taskId, title: `Reference ${index}`, content: `task body ${index}`,
      acceptance: "Current reference appears", owner: owner.actorId, documentIds: [sourceDocumentId] });
    if (index === 0) {
      await send({ type: "task.start", taskId, expectedVersion: 1,
        basis: [{ documentId: sourceDocumentId, revisionId: source.revisionId }], reason: "Set current fixed basis" });
    }
  }

  const historyOnlyBasisTaskId = randomUUID();
  ids.push(historyOnlyBasisTaskId);
  await send({ type: "task.create", taskId: historyOnlyBasisTaskId, title: "Historical basis only", content: "history body",
    acceptance: "Historical basis is excluded", owner: owner.actorId, documentIds: [sourceDocumentId] });
  await send({ type: "task.start", taskId: historyOnlyBasisTaskId, expectedVersion: 1,
    basis: [{ documentId: sourceDocumentId, revisionId: source.revisionId }], reason: "Set historical basis" });
  await send({ type: "task.cancel", taskId: historyOnlyBasisTaskId, expectedVersion: 2, reason: "End old revision" });
  await send({ type: "task.reopen", taskId: historyOnlyBasisTaskId, expectedVersion: 3, reason: "Return to todo" });
  await send({ type: "task.update", taskId: historyOnlyBasisTaskId, expectedVersion: 4, title: "Historical basis only",
    content: "history body", acceptance: "Historical basis is excluded", owner: owner.actorId,
    basis: [], reason: "Drop old source from current revision" });

  const contentTaskId = randomUUID();
  await send({ type: "task.create", taskId: contentTaskId, title: "Primary content match", content: "unique private task body",
    acceptance: "Primary document is discoverable", owner: owner.actorId });
  const contentTask = await service.getTask(owner, projectId, contentTaskId);
  const endpoint = (documentId: string) => `/api/projects/${projectId}/documents/${documentId}/tasks`;
  const headers = { authorization: `Bearer ${readerToken}` };

  const first = await app.inject({ url: `${endpoint(sourceDocumentId)}?limit=50`, headers });
  assert.equal(first.statusCode, 200, first.body);
  const firstPage = first.json() as { items: Array<Record<string, unknown>>; nextCursor: string | null };
  assert.equal(firstPage.items.length, 50);
  assert.ok(firstPage.nextCursor);
  assert.deepEqual(firstPage.items.map(item => item.id), [...ids].sort().slice(0, 50));
  for (const item of firstPage.items) assert.equal("content" in item, false);

  const second = await app.inject({ url: `${endpoint(sourceDocumentId)}?limit=50&cursor=${firstPage.nextCursor}`, headers });
  assert.equal(second.statusCode, 200, second.body);
  const secondPage = second.json() as { items: Array<Record<string, unknown>>; nextCursor: string | null };
  assert.equal(secondPage.items.length, 2);
  assert.equal(secondPage.nextCursor, null);
  const allItems = [...firstPage.items, ...secondPage.items];
  assert.deepEqual(allItems.map(item => item.id), [...ids].sort());
  assert.equal(new Set(allItems.map(item => item.id)).size, 52);
  assert.deepEqual(allItems.find(item => item.id === ids[0])?.relations, ["basis", "link"]);
  assert.deepEqual(allItems.find(item => item.id === historyOnlyBasisTaskId)?.relations, ["link"]);

  const content = await app.inject({ url: endpoint(contentTask.task.contentDocumentId), headers });
  assert.equal(content.statusCode, 200, content.body);
  assert.deepEqual(content.json(), { items: [{ projectId, id: contentTaskId, title: "Primary content match",
    state: "todo", owner: owner.actorId, kind: null, version: 1, currentRevisionId: contentTask.task.currentRevisionId,
    relations: ["content"] }], nextCursor: null });
  assert.equal(JSON.stringify(content.json()).includes("unique private task body"), false);

  for (const url of [`${endpoint(sourceDocumentId)}?limit=0`, `${endpoint(sourceDocumentId)}?limit=101`,
    `${endpoint(sourceDocumentId)}?cursor=not-a-uuid`]) {
    assert.equal((await app.inject({ url, headers })).statusCode, 400, url);
  }
  const wrongProject = await app.inject({ url: `/api/projects/${randomUUID()}/documents/${sourceDocumentId}/tasks`, headers });
  assert.equal(wrongProject.statusCode, 403);
  const missingDocument = await app.inject({ url: endpoint(randomUUID()), headers });
  assert.equal(missingDocument.statusCode, 404);
  const noRead = await app.inject({ url: endpoint(sourceDocumentId), headers: { authorization: `Bearer ${writerToken}` } });
  assert.equal(noRead.statusCode, 403);
  const isolatedService = new WorkflowService({
    uow: { read: (id, action) => new PostgresUnitOfWork(pool).read(id, reader => action(new Proxy(reader, {
      get(target, key, receiver) { return key === "listDocumentTaskReferences" ? undefined : Reflect.get(target, key, receiver); },
    }) as Reader)) } as UnitOfWork,
    clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: value => createHash("sha256").update(value).digest("hex") },
  });
  await assert.rejects(() => isolatedService.listDocumentTaskReferences(owner, projectId, sourceDocumentId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_QUERY");
});
