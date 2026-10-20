import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import type { BasisSet, Document, DocumentRevision, Operation, Project, Task, TaskRevision } from "@evoloop/contracts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for adapter tests");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1)).toLowerCase();
if (!databaseName.includes("evoloop") || !databaseName.includes("test")) {
  throw new Error("adapter tests require a dedicated database whose name contains evoloop and test");
}
const schema = `el_adapter_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const now = "2026-10-20T00:00:00.000Z";
const actor = "adapter-test";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

before(async () => { await migrate(connectionString, schema); });
after(async () => {
  await pool.end();
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

function project(id = randomUUID()): Project { return { id, title: "Adapter test", createdAt: now }; }
function document(projectId: string, id = randomUUID(), revisionId = randomUUID()): { head: Document; revision: DocumentRevision } {
  return {
    head: { projectId, id, title: "Requirement", version: 1, currentRevisionId: revisionId, adoptedRevisionId: null, kind: "spec", status: "draft" },
    revision: { projectId, documentId: id, id: revisionId, body: "# Requirement", format: "markdown", mediaType: "text/markdown", originalName: `${id}.md`, payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: sha("# Requirement"), author: actor, createdAt: now, previousRevisionId: null, reason: "create" },
  };
}
function readyTask(projectId: string, documentId: string, documentRevisionId: string): { head: Task; revision: TaskRevision; basis: BasisSet; primary: ReturnType<typeof document> } {
  const id = randomUUID();
  const revisionId = randomUUID();
  const basisId = randomUUID();
  const primary = document(projectId);
  primary.head.kind = "task";
  primary.head.status = "draft";
  return {
    head: { projectId, id, version: 1, currentRevisionId: revisionId, title: "Task", content: primary.revision.body!, contentDocumentId: primary.head.id, contentRevisionId: primary.revision.id, kind: null, acceptance: "Check result", owner: actor, state: "in_progress" },
    revision: { projectId, taskId: id, id: revisionId, version: 1, title: "Task", content: primary.revision.body!, contentDocumentId: primary.head.id, contentRevisionId: primary.revision.id, kind: null, acceptance: "Check result", owner: actor, state: "in_progress", basisSetId: basisId, actorId: actor, reason: "accepted", createdAt: now },
    basis: { projectId, taskId: id, taskRevisionId: revisionId, id: basisId, sealed: true, members: [{ documentId, revisionId: documentRevisionId }, { documentId: primary.head.id, revisionId: primary.revision.id }] },
    primary,
  };
}

async function seedDocument(): Promise<{ p: Project; d: ReturnType<typeof document> }> {
  const p = project();
  const d = document(p.id);
  await uow.transaction(p.id, async (tx) => {
    await tx.insertProject(p);
    await tx.insertDocument(d.head);
    await tx.insertDocumentRevision(d.revision);
  });
  return { p, d };
}

test("migration can run twice without changing history", async () => {
  const before = await pool.query("SELECT count(*)::int AS count FROM pgmigrations");
  await migrate(connectionString, schema);
  const result = await pool.query("SELECT count(*)::int AS count FROM pgmigrations");
  assert.ok(before.rows[0].count >= 2);
  assert.equal(result.rows[0].count, before.rows[0].count);
});

test("adopted document pointer requires a decision; revisions and decisions stay immutable", async () => {
  const { p, d } = await seedDocument();
  await assert.rejects(uow.transaction(p.id, (tx) => tx.updateDocument({ ...d.head, version: 2, adoptedRevisionId: d.revision.id }, 1)), /approval decision/);
  const still = await uow.read(p.id, (reader) => reader.getDocument(d.head.id));
  assert.equal(still?.version, 1);
  const decisionId = randomUUID();
  await uow.transaction(p.id, async (tx) => {
    await tx.insertDocumentDecision({ projectId: p.id, id: decisionId, documentId: d.head.id, revisionId: d.revision.id, actorId: actor, reason: "approved", createdAt: now });
    await tx.updateDocument({ ...d.head, version: 2, adoptedRevisionId: d.revision.id }, 1);
  });
  await assert.rejects(pool.query("UPDATE document_revision SET body='changed' WHERE project_id=$1 AND document_id=$2", [p.id, d.head.id]), /immutable/);
  await assert.rejects(pool.query("DELETE FROM document_decision WHERE project_id=$1 AND decision_id=$2", [p.id, decisionId]), /immutable/);
});

test("sealed basis cannot be changed and cross-project references fail", async () => {
  const { p, d } = await seedDocument();
  const task = readyTask(p.id, d.head.id, d.revision.id);
  await uow.transaction(p.id, async (tx) => {
    await tx.insertDocument(task.primary.head);
    await tx.insertDocumentRevision(task.primary.revision);
    await tx.insertTask(task.head);
    await tx.insertTaskRevision(task.revision);
    await tx.insertSealedBasisSet(task.basis);
  });
  const stored = await uow.read(p.id, (reader) => reader.getBasisSet(task.head.id, task.revision.id, task.basis.id));
  assert.deepEqual(stored?.members, [...task.basis.members].sort((a, b) => a.documentId.localeCompare(b.documentId)));
  await assert.rejects(pool.query("DELETE FROM basis_member WHERE project_id=$1 AND task_id=$2", [p.id, task.head.id]), /immutable/);
  await assert.rejects(pool.query("UPDATE basis_member SET document_revision_id=$1 WHERE project_id=$2 AND task_id=$3", [randomUUID(), p.id, task.head.id]), /immutable/);
  await assert.rejects(pool.query("INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [p.id, task.head.id, task.revision.id, task.basis.id, randomUUID(), randomUUID()]), /immutable/);
  await assert.rejects(pool.query("UPDATE basis_set SET sealed=false WHERE project_id=$1 AND task_id=$2", [p.id, task.head.id]), /sealed|only be sealed once/);
  const other = project();
  await uow.transaction(other.id, (tx) => tx.insertProject(other));
  await assert.rejects(uow.transaction(other.id, (tx) => tx.insertLink({ projectId: other.id, id: randomUUID(), taskId: task.head.id, documentId: d.head.id, actorId: actor, createdAt: now })), /foreign key/);
  const using = await uow.read(p.id, (reader) => reader.findTasksUsingDocument(d.head.id));
  assert.deepEqual(using.map((item) => item.id), [task.head.id]);
  assert.equal(using[0]?.content, task.primary.revision.body);
});

test("ready task cannot point to a missing or unsealed basis", async () => {
  const { p, d } = await seedDocument();
  const task = readyTask(p.id, d.head.id, d.revision.id);
  await assert.rejects(uow.transaction(p.id, async (tx) => {
    await tx.insertDocument(task.primary.head);
    await tx.insertDocumentRevision(task.primary.revision);
    await tx.insertTask(task.head);
    await tx.insertTaskRevision(task.revision);
  }), /foreign key|sealed basis/);
  assert.equal(await uow.read(p.id, (reader) => reader.getTask(task.head.id)), null);
});

test("savepoint can roll back effect and retain a rejected journal without outbox", async () => {
  const p = project();
  const d = document(p.id);
  const operationId = randomUUID();
  await uow.transaction(p.id, (tx) => tx.insertProject(p));
  await uow.transaction(p.id, async (tx) => {
    try {
      await tx.savepoint(async () => {
        await tx.insertDocument(d.head);
        await tx.insertDocumentRevision(d.revision);
        throw new Error("domain rejection");
      });
    } catch (error) {
      assert.match(String(error), /domain rejection/);
    }
    await tx.insertOperation({ projectId: p.id, id: operationId, actorId: actor, commandHash: "rejected", commandType: "document.create", result: { status: "rejected", operationId, code: "NO", message: "not accepted" }, createdAt: now });
  });
  assert.equal(await uow.read(p.id, (reader) => reader.getDocument(d.head.id)), null);
  const operation = await uow.read(p.id, (reader) => reader.getOperation(operationId));
  assert.equal(operation?.result.status, "rejected");
  const count = await pool.query("SELECT count(*)::int AS count FROM outbox_event WHERE project_id=$1", [p.id]);
  assert.equal(count.rows[0].count, 0);
});

test("last-step outbox failure rolls back project, journal and preceding writes", async () => {
  const p = project();
  const operationId = randomUUID();
  const operation: Operation = { projectId: p.id, id: operationId, actorId: actor, commandHash: "test", commandType: "project.create", result: { status: "applied", operationId, entityId: p.id }, createdAt: now };
  await assert.rejects(uow.transaction(p.id, async (tx) => {
    await tx.insertProject(p);
    await tx.insertOperation(operation);
    await tx.appendOutbox({ projectId: p.id, id: randomUUID(), operationId: randomUUID(), effectKey: "project", kind: "changed", entityId: p.id, version: 1, createdAt: now });
  }), /foreign key/);
  assert.equal(await uow.read(p.id, (reader) => reader.getProject()), null);
  assert.equal(await uow.read(p.id, (reader) => reader.getOperation(operationId)), null);
});

test("document pagination returns a stable cursor without dropping rows", async () => {
  const p = project();
  const docs = [document(p.id), document(p.id), document(p.id)];
  await uow.transaction(p.id, async (tx) => {
    await tx.insertProject(p);
    for (const d of docs) {
      await tx.insertDocument(d.head);
      await tx.insertDocumentRevision(d.revision);
    }
  });
  const first = await uow.read(p.id, (reader) => reader.listDocuments(2));
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await uow.read(p.id, (reader) => reader.listDocuments(2, first.nextCursor!));
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((d) => d.id)).size, 3);
  assert.ok([...first.items, ...second.items].every((d) => d.primaryTaskId === null));
});

test("task pagination returns every task once", async () => {
  const p = project();
  const tasks = Array.from({ length: 3 }, () => {
    const id = randomUUID();
    const revisionId = randomUUID();
    const primary = document(p.id);
    primary.head.kind = "task";
    const head: Task = { projectId: p.id, id, version: 1, currentRevisionId: revisionId, title: "Todo", content: primary.revision.body!, contentDocumentId: primary.head.id, contentRevisionId: primary.revision.id, kind: null, acceptance: "Answer", owner: actor, state: "todo" };
    const revision: TaskRevision = { projectId: p.id, taskId: id, id: revisionId, version: 1, title: head.title, content: head.content, contentDocumentId: head.contentDocumentId, contentRevisionId: head.contentRevisionId, kind: null, acceptance: head.acceptance, owner: head.owner, state: "todo", basisSetId: null, actorId: actor, reason: "created", createdAt: now };
    return { head, revision, primary };
  });
  await uow.transaction(p.id, async (tx) => {
    await tx.insertProject(p);
    for (const task of tasks) {
      await tx.insertDocument(task.primary.head);
      await tx.insertDocumentRevision(task.primary.revision);
      await tx.insertTask(task.head);
      await tx.insertTaskRevision(task.revision);
    }
  });
  const first = await uow.read(p.id, (reader) => reader.listTasks(2));
  const second = await uow.read(p.id, (reader) => reader.listTasks(2, first.nextCursor!));
  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((task) => task.id)).size, 3);
  assert.equal(first.items.every((task) => task.content === "# Requirement"), true);
  const primary = tasks[0]!.primary.head.id;
  assert.equal((await uow.read(p.id, (reader) => reader.getDocument(primary)))?.primaryTaskId, tasks[0]!.head.id);
  assert.equal((await uow.read(p.id, (reader) => reader.listDocuments(100))).items.find((d) => d.id === primary)?.primaryTaskId, tasks[0]!.head.id);
  assert.equal(await uow.read(randomUUID(), (reader) => reader.getDocument(primary)), null);
  await assert.rejects(pool.query("UPDATE process_document SET version=version+1,status='published' WHERE project_id=$1 AND document_id=$2",
    [p.id, tasks[0]!.primary.head.id]), /Task primary Document must advance with its Task/);
});
