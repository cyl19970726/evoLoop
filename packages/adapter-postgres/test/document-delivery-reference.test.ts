// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_docref_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } });
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID();
const lead: Principal = { actorId: "lead", projectIds: [p], permissions: ["read", "write", "review"] };

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(lead, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Document references" });
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
const references = async (documentId: string) => (await workflow.listDocumentTaskReferences(lead, p, documentId, 50)).items.map(item => ({ id: item.id, relations: item.relations }));

test("a delivery report is referenced by the Task that delivered it (and by the Task it was created under), not 'no Task references it'", async () => {
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title: "Delivered work", content: "# Work", acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  const documentId = randomUUID();
  const created = await apply({ type: "document.create", documentId, title: "Delivery report", body: "# Report\n\nResult", kind: "report", origin: { taskId } });
  // Before any delivery the Task still references it as the Document it produced.
  assert.deepEqual(await references(documentId), [{ id: taskId, relations: ["origin"] }]);
  const task = (await uow.read(p, r => r.getTask(taskId)))!;
  await apply({ type: "delivery.record", taskId, expectedVersion: task.version, artifactRef: `document:${documentId}@${created.revisionId}`, artifactRevision: created.revisionId,
    contentHash: hash("# Report\n\nResult"), technicalResult: "passed", technicalEvidence: "tests passed", reason: "deliver" });
  assert.deepEqual(await references(documentId), [{ id: taskId, relations: ["delivery", "origin"] }], "delivered: the delivering Task shows");
});

test("a Document delivered without an origin still shows the delivering Task; an unrelated Document shows none; another Document's delivery is not matched by prefix", async () => {
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title: "Delivers a plain document", content: "# W", acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  const delivered = randomUUID(), unrelated = randomUUID();
  const created = await apply({ type: "document.create", documentId: delivered, title: "Plain artifact", body: "artifact" });
  await apply({ type: "document.create", documentId: unrelated, title: "Unrelated", body: "other" });
  const task = (await uow.read(p, r => r.getTask(taskId)))!;
  await apply({ type: "delivery.record", taskId, expectedVersion: task.version, artifactRef: `document:${delivered}@${created.revisionId}`, artifactRevision: created.revisionId,
    contentHash: hash("artifact"), technicalResult: "passed", technicalEvidence: "ok", reason: "deliver" });
  assert.deepEqual(await references(delivered), [{ id: taskId, relations: ["delivery"] }]);
  assert.deepEqual(await references(unrelated), []);
});
