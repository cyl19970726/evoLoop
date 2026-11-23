// The document list (Task afe7e585): newest current revision first with a (time, id) cursor, server-side type, relation and
// title filters, the brief kind, and the migration that moves only 每日简报 reports. Needs a dedicated evoloop_*_test database.
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { Document, Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_doclist_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } });
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID();
const lead: Principal = { actorId: "lead", projectIds: [p], permissions: ["task", "document", "session", "management"], decisions: true };

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(lead, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Document list" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [p, role, roleRev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [p, role, roleRev]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

async function apply(command: Record<string, unknown>) {
  const result = await workflow.execute(lead, { projectId: p, operationId: randomUUID(), ...command } as never);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result as typeof result & { revisionId?: string };
}
const list = (...args: Parameters<WorkflowService["listDocuments"]> extends [unknown, unknown, ...infer rest] ? rest : never) =>
  workflow.listDocuments(lead, p, ...args);
async function save(title: string, kind: string | null, extra: Record<string, unknown> = {}) {
  const documentId = randomUUID();
  const created = await apply({ type: "document.create", documentId, title, body: `# ${title}`, kind, ...extra });
  return { documentId, revisionId: created.revisionId! };
}
/** Pin each document's current revision to a distinct instant, so the order under test does not depend on the clock. */
async function stamp(entries: Array<{ documentId: string; at: string }>) {
  const c = await pool.connect();
  try {
    await c.query("ALTER TABLE document_revision DISABLE TRIGGER immutable_document_revision");
    for (const { documentId, at } of entries)
      await c.query("UPDATE document_revision SET created_at=$3::timestamptz WHERE project_id=$1 AND document_id=$2", [p, documentId, at]);
    await c.query("ALTER TABLE document_revision ENABLE TRIGGER immutable_document_revision");
  } finally { c.release(); }
}
async function readAll(...args: Parameters<typeof list>): Promise<Document[]> {
  const out: Document[] = []; let cursor: string | undefined;
  do {
    const page = await workflow.listDocuments(lead, p, 3, cursor, ...args);
    out.push(...page.items); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

test("the default order is the newest current revision first; pages neither repeat nor skip; a new revision moves a document to the front", async () => {
  const docs = [];
  for (let i = 0; i < 8; i += 1) docs.push(await save(`列表文档 ${i}`, "spec"));
  // Two documents share one instant: the id breaks the tie, and the cursor still never repeats or skips.
  await stamp(docs.map((d, i) => ({ documentId: d.documentId, at: `2026-01-0${i < 6 ? i + 1 : 5}T00:00:00.123456Z` })));
  const all = await readAll(undefined, undefined);
  const ours = all.filter(d => d.title.startsWith("列表文档"));
  assert.equal(ours.length, 8);
  assert.equal(new Set(all.map(d => d.id)).size, all.length, "no document twice");
  const times = ours.map(d => d.updatedAt!);
  assert.deepEqual([...times].sort().reverse(), times, "newest first");
  // Move the oldest forward with a real revision.
  const oldest = docs[0]!;
  await apply({ type: "document.revise", documentId: oldest.documentId, expectedVersion: 1, body: "# 新的修订", reason: "更新" });
  const first = await list(3);
  assert.equal(first.items[0]!.id, oldest.documentId);
  assert.ok(first.items[0]!.updatedAt, "every row carries its time");
});

test("a cursor from before the time-ordered list is refused instead of read as something else", async () => {
  await assert.rejects(() => list(3, randomUUID()), /游标无效|INVALID_CURSOR/);
});

test("the brief kind: saved through the command with an origin; an unknown kind is refused", async () => {
  const brief = await save("每日简报 2026-11-20", "brief");
  assert.equal((await workflow.getDocument(lead, p, brief.documentId)).document.kind, "brief");
  await assert.rejects(() => apply({ type: "document.create", documentId: randomUUID(), title: "x", body: "# x", kind: "digest" }), /kind|Invalid/);
});

test("type filters: 简报, 交付报告 (a Delivery names it) and 其他报告 (a report that is not), counted by the server", async () => {
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title: "交付的工作", content: "# Work", acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  const delivered = await save("交付报告甲", "report", { origin: { taskId } });
  const plain = await save("没有被交付的报告", "report");
  const task = (await uow.read(p, r => r.getTask(taskId)))!;
  await apply({ type: "delivery.record", taskId, expectedVersion: task.version, artifactRef: `document:${delivered.documentId}@${delivered.revisionId}`,
    artifactRevision: delivered.revisionId, contentHash: hash("# 交付报告甲"), technicalResult: "passed", technicalEvidence: "ok", reason: "deliver" });
  const ids = async (kind: string) => (await readAll(kind as never, undefined)).map(d => d.id);
  assert.ok((await ids("delivery_report")).includes(delivered.documentId));
  assert.ok(!(await ids("delivery_report")).includes(plain.documentId));
  assert.ok((await ids("other_report")).includes(plain.documentId));
  assert.ok(!(await ids("other_report")).includes(delivered.documentId), "a delivered report is not an 其他报告");
  assert.ok((await readAll("brief" as never, undefined)).every(d => d.kind === "brief"));
  // The count the table shows is the server's: the sum over delivery_report + other_report covers every report, with no overlap.
  const reports = await ids("report"), delivery = await ids("delivery_report"), other = await ids("other_report");
  assert.equal(other.length, reports.filter(id => !delivery.includes(id)).length);
});

test("search covers every document by title, combines with a type as an intersection, and treats % and _ as plain text", async () => {
  const oldest = await save("只在最旧一页的独特标题", "spec");
  await stamp([{ documentId: oldest.documentId, at: "2001-01-01T00:00:00Z" }]);
  for (let i = 0; i < 4; i += 1) await save(`填充 ${i}`, "spec");
  const found = await readAll(undefined, undefined, "独特标题");
  assert.deepEqual(found.map(d => d.id), [oldest.documentId]);
  assert.deepEqual((await readAll("report" as never, undefined, "独特标题")), [], "search and type intersect");
  assert.equal((await readAll(undefined, undefined, "独特标题")).length, 1);
  await save("百分之100%完成", "spec"); await save("百分之100X完成", "spec");
  assert.deepEqual((await readAll(undefined, undefined, "100%")).map(d => d.title), ["百分之100%完成"]);
  assert.equal((await readAll(undefined, undefined, "ＤＯＥＳ不存在")).length, 0);
});

test("the references the list shows are the ones the document page shows (delivery and origin included)", async () => {
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title: "产出文档的任务", content: "# Work", acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  const made = await save("只有产出关系的报告", "report", { origin: { taskId } });
  const alone = await save("没有任何关系的文档", "spec");
  const { readLeaderWorkDocuments } = await import("../src/work-index.ts");
  const pageRefs = async (documentId: string) => (await workflow.listDocumentTaskReferences(lead, p, documentId, 50)).items.map(i => ({ id: i.id, relations: i.relations }));
  const indexRefs = async (documentId: string) => {
    const client = await pool.connect();
    try {
      let cursor: string | undefined;
      for (;;) {
        const result = await readLeaderWorkDocuments(client as never, p, { limit: 100, cursor, includeClosed: true } as never);
        const hit = result.items.find(item => item.documentId === documentId);
        if (hit) return hit.references.map(r => ({ id: r.taskId, relations: r.relations }));
        if (!result.nextCursor) return [];
        cursor = result.nextCursor;
      }
    } finally { client.release(); }
  };
  assert.deepEqual(await indexRefs(made.documentId), await pageRefs(made.documentId));
  assert.deepEqual(await indexRefs(made.documentId), [{ id: taskId, relations: ["origin"] }]);
  assert.deepEqual(await indexRefs(alone.documentId), []);
  assert.deepEqual(await pageRefs(alone.documentId), []);
});
