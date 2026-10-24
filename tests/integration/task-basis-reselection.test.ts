import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { CommandResult, Principal } from "@evoloop/contracts";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("Use an isolated evoloop_*_test database");

test("a reviewed todo update seals a replacement basis and preserves old receipts", async t => {
  const schema = `basis_reselect_${randomUUID().replaceAll("-", "")}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID(), taskId = randomUUID(), oldDocId = randomUUID(), newDocId = randomUUID();
  const outsiderDocId = randomUUID(), draftDocId = randomUUID();
  const owner: Principal = { actorId: "fixture-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const writer: Principal = { ...owner, actorId: "fixture-writer", permissions: ["read", "write"] };
  const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => "2026-10-24T04:00:00.000Z" },
    ids: { next: randomUUID }, hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const send = (principal: Principal, body: Record<string, unknown>, operationId = randomUUID()) =>
    service.execute(principal, { projectId, operationId, ...body } as never);
  const applied = (value: CommandResult) => { assert.equal(value.status, "applied", JSON.stringify(value));
    return value as Extract<CommandResult, { status: "applied" }>; };
  const rejected = (value: CommandResult, code: string) => { assert.equal(value.status, "rejected", JSON.stringify(value));
    if (value.status === "rejected") assert.equal(value.code, code); };
  applied(await send(owner, { type: "project.create", title: "Basis reselection" }));
  const document = async (documentId: string, published = true) => {
    const created = applied(await send(owner, { type: "document.create", documentId, kind: "report",
      title: "Fixed report", body: `Original ${documentId}` }));
    if (published) applied(await send(owner, { type: "document.publish", documentId, expectedVersion: 1,
      revisionId: created.revisionId, reason: "Review original" }));
    return created.revisionId!;
  };
  const oldRevision = await document(oldDocId), newRevision = await document(newDocId);
  const outsiderRevision = await document(outsiderDocId), draftRevision = await document(draftDocId, false);
  applied(await send(owner, { type: "task.create", taskId, title: "Reuse report", content: "# Exact existing work",
    acceptance: "Reviewed output", owner: owner.actorId, documentIds: [oldDocId, newDocId, draftDocId] }));
  const started = applied(await send(owner, { type: "task.start", taskId, expectedVersion: 1,
    basis: [{ documentId: oldDocId, revisionId: oldRevision }], reason: "Initial input" }));
  const old = await service.getTask(owner, projectId, taskId);
  const members = (value: typeof old.basis) => value?.members.map(item => item.documentId).sort();
  assert.deepEqual(members(old.basis), [old.task.contentDocumentId, oldDocId].sort());
  const reopened = applied(await send(owner, { type: "task.reopen", taskId, expectedVersion: started.version,
    reason: "Use the checked report instead" }));
  const before = await service.getTask(owner, projectId, taskId);
  const update = (fields: Record<string, unknown> = {}) => ({ type: "task.update", taskId,
    expectedVersion: reopened.version, title: before.task.title, content: before.task.content,
    acceptance: before.task.acceptance, owner: before.task.owner, reason: "Select exact report", ...fields });
  await assert.rejects(() => send(writer, update({ basis: [] })), (e: unknown) => (e as {code?: string}).code === "FORBIDDEN");
  await assert.rejects(() => send({ ...owner, permissions: ["write", "review"] }, update({ basis: [] })),
    (e: unknown) => (e as {code?: string}).code === "FORBIDDEN");
  rejected(await send(owner, update({ retentions: [] })), "INVALID_RETENTION");
  rejected(await send(owner, update({ basis: [{ documentId: outsiderDocId, revisionId: outsiderRevision }] })), "UNLINKED_DOCUMENT");
  rejected(await send(owner, update({ basis: [{ documentId: draftDocId, revisionId: draftRevision }] })), "UNPUBLISHED_BASIS");
  rejected(await send(owner, update({ basis: [{ documentId: newDocId, revisionId: randomUUID() }] })), "NOT_FOUND");
  const foreignProjectId = randomUUID(), foreignDocumentId = randomUUID();
  applied(await service.execute({ ...owner, projectIds: [foreignProjectId] }, { type: "project.create",
    projectId: foreignProjectId, operationId: randomUUID(), title: "Other project" }));
  applied(await service.execute({ ...owner, projectIds: [foreignProjectId] }, { type: "document.create",
    projectId: foreignProjectId, operationId: randomUUID(), documentId: foreignDocumentId,
    kind: "report", title: "Foreign original", body: "Other project" }));
  rejected(await send(owner, update({ documentIds: [oldDocId, newDocId, draftDocId, foreignDocumentId],
    basis: [{ documentId: foreignDocumentId, revisionId: randomUUID() }] })), "NOT_FOUND");
  rejected(await send(owner, update({ basis: [{ documentId: oldDocId, revisionId: oldRevision }],
    expectedVersion: 1 })), "VERSION_CONFLICT");
  const selectedBody = update({ basis: [{ documentId: newDocId, revisionId: newRevision }] });
  const operationId = randomUUID();
  const selected = applied(await send(owner, selectedBody, operationId));
  assert.deepEqual(applied(await send(owner, selectedBody, operationId)), selected,
    "a lost response replays the same Task revision and receipt");
  await assert.rejects(() => send(owner, { ...selectedBody, basis: [] }, operationId),
    (e: unknown) => (e as {code?: string}).code === "OPERATION_REUSED");
  const changed = await service.getTask(owner, projectId, taskId);
  assert.equal(changed.task.contentRevisionId, old.task.contentRevisionId, "same content reuses its original revision");
  assert.deepEqual(members(changed.basis), [changed.task.contentDocumentId, newDocId].sort());
  assert.deepEqual((await service.getTaskRevision(owner, projectId, taskId, old.revision.id)).basis?.members,
    old.basis?.members, "prior sealed evidence remains unchanged");
  const later = applied(await send(owner, { type: "task.start", taskId, expectedVersion: selected.version,
    reason: "Start with selected source" }));
  const active = await service.getTask(owner, projectId, taskId);
  assert.deepEqual(members(active.basis), [active.task.contentDocumentId, newDocId].sort());
  rejected(await send(owner, { ...update({ basis: [] }), expectedVersion: later.version }), "REOPEN_REQUIRED");
  const secondReopen = applied(await send(owner, { type: "task.reopen", taskId, expectedVersion: later.version,
    reason: "Only primary is needed" }));
  const ordinary = applied(await send(writer, { ...update(), expectedVersion: secondReopen.version }));
  assert.deepEqual(members((await service.getTask(owner, projectId, taskId)).basis),
    [active.task.contentDocumentId, newDocId].sort(), "omitted selection keeps old writer authority and basis");
  const empty = applied(await send(owner, { ...update({ basis: [] }), expectedVersion: ordinary.version }));
  assert.deepEqual((await service.getTask(owner, projectId, taskId)).basis?.members.map(item => item.documentId),
    [active.task.contentDocumentId]);
  assert.equal((await service.getTask(owner, projectId, taskId)).task.version, empty.version);
  const changedContent = applied(await send(owner, { ...update({ basis: [{ documentId: newDocId, revisionId: newRevision }],
    content: "# Revised content using report" }), expectedVersion: empty.version }));
  const final = await service.getTask(owner, projectId, taskId);
  assert.equal(final.task.version, changedContent.version);
  assert.notEqual(final.task.contentRevisionId, old.task.contentRevisionId);
  assert.equal(final.basis?.members.find(item => item.documentId === final.task.contentDocumentId)?.revisionId,
    final.task.contentRevisionId, "content and basis may change in the same reviewed update");
  const nextSource = applied(await send(owner, { type: "document.revise", documentId: newDocId,
    expectedVersion: 2, body: "New accepted original", reason: "New report" }));
  applied(await send(owner, { type: "document.publish", documentId: newDocId,
    expectedVersion: 3, revisionId: nextSource.revisionId, reason: "Publish replacement" }));
  const retainUpdate = { ...update({ basis: [{ documentId: newDocId, revisionId: newRevision }] }),
    expectedVersion: final.task.version, content: final.task.content };
  rejected(await send(owner, retainUpdate), "BASIS_CHANGED");
  rejected(await send(owner, { ...retainUpdate, retentions: [{ documentId: newDocId, revisionId: newRevision,
    observedAdoptedRevisionId: randomUUID(), reason: "Observed prior report" }] }), "BASIS_CHANGED");
  const retained = applied(await send(owner, { ...retainUpdate, retentions: [{ documentId: newDocId,
    revisionId: newRevision, observedAdoptedRevisionId: nextSource.revisionId,
    reason: "Prior original still fits this Task" }] }));
  const retainedTask = await service.getTask(owner, projectId, taskId);
  assert.equal(retainedTask.basis?.retentions?.[0]?.actorId, owner.actorId);
  assert.equal(retainedTask.basis?.retentions?.[0]?.observedAdoptedRevisionId, nextSource.revisionId);
  const nextAgain = applied(await send(owner, { type: "document.revise", documentId: newDocId,
    expectedVersion: 4, body: "Later accepted original", reason: "Changed again" }));
  applied(await send(owner, { type: "document.publish", documentId: newDocId,
    expectedVersion: 5, revisionId: nextAgain.revisionId, reason: "Republish" }));
  rejected(await send(owner, { type: "task.start", taskId, expectedVersion: retained.version,
    reason: "Stale retention cannot start" }), "BASIS_CHANGED");
});
