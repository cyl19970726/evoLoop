import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { WorkflowService } from "../../core/src/index.ts";
import { PostgresUnitOfWork } from "../src/index.ts";
import { PgSchedulingStore } from "../src/scheduling.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !decodeURIComponent(new URL(url).pathname).toLowerCase().includes("evoloop") ||
    !decodeURIComponent(new URL(url).pathname).toLowerCase().includes("test"))
  throw new Error("Dedicated evoloop test database is required");
const schema = `el_c5_migration_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
const ids = Array.from({ length: 10 }, () => randomUUID());
const [projectId, taskId, firstRevisionId, secondRevisionId, basisId, sourceDocumentId, sourceRevisionId, operationId] = ids;
const sessionId = randomUUID();
const runId = randomUUID();
const now = "2026-10-21T00:00:00.000Z";
const firstBody = "\ufeff初稿\r\n**原字节**\n";
const secondBody = "# 修订\r\n验收前内容\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const migrate = (count?: number) => runner({ databaseUrl: url!, dir: directory, migrationsTable: "pgmigrations",
  schema, createSchema: true, createMigrationsSchema: true, direction: "up", singleTransaction: true,
  ...(count ? { count } : {}), log: () => {} });
after(async () => {
  await client.end().catch(() => {});
  const cleanup = new pg.Client({ connectionString: url });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

test("012 backfills nonempty legacy history byte-exactly without rewriting sealed evidence or journal", async () => {
  await migrate(11);
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'legacy',$2)", [projectId, now]);
    await client.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id) VALUES($1,$2,'source',1,$3,$3)", [projectId, sourceDocumentId, sourceRevisionId]);
    await client.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason) VALUES($1,$2,$3,'source','markdown',$4,'legacy',$5,NULL,'original')", [projectId, sourceDocumentId, sourceRevisionId, hash("source"), now]);
    await client.query("INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,'reviewer','legacy adoption',$5)", [projectId, randomUUID(), sourceDocumentId, sourceRevisionId, now]);
    await client.query("INSERT INTO task(project_id,task_id,version,current_revision_id,title,goal,acceptance,owner,state) VALUES($1,$2,2,$3,'legacy task',$4,'old acceptance','owner','ready')", [projectId, taskId, secondRevisionId, secondBody]);
    await client.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,state,basis_set_id,actor_id,reason,created_at) VALUES($1,$2,$3,1,'legacy task',$4,'old acceptance','owner','proposed',NULL,'author','first',$5)", [projectId, taskId, firstRevisionId, firstBody, now]);
    await client.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,state,basis_set_id,actor_id,reason,created_at) VALUES($1,$2,$3,2,'legacy task',$4,'old acceptance','owner','ready',$5,'author','second',$6)", [projectId, taskId, secondRevisionId, secondBody, basisId, now]);
    await client.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)", [projectId, taskId, secondRevisionId, basisId]);
    await client.query("INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [projectId, taskId, secondRevisionId, basisId, sourceDocumentId, sourceRevisionId]);
    await client.query("UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3", [projectId, taskId, secondRevisionId]);
    await client.query("INSERT INTO task_document_link(project_id,link_id,task_id,document_id,actor_id,created_at) VALUES($1,$2,$3,$4,'author',$5)",
      [projectId, randomUUID(), taskId, sourceDocumentId, now]);
    await client.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,'author',$3,'task.accept',$4::jsonb,$5)", [projectId, operationId, "a".repeat(64), JSON.stringify({ status: "applied", operationId, entityId: taskId, revisionId: secondRevisionId }), now]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,'worker','/tmp','fixed',NULL,'workspace-write','on-request','ready',1,'native-thread','native-session',$3,'author',$4,$4)`, [projectId, sessionId, randomUUID(), now]);
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,interrupt_requested,result_summary,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'old fixed input',$8,'completed',1,'old-turn',false,'done','author',$9,$9)`,
      [projectId, runId, taskId, secondRevisionId, basisId, sessionId, randomUUID(), hash("old fixed input"), now]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  await migrate();
  const head = (await client.query("SELECT * FROM task WHERE task_id=$1", [taskId])).rows[0];
  const history = (await client.query("SELECT r.*,d.body,d.content_hash FROM task_revision r JOIN document_revision d ON d.project_id=r.project_id AND d.document_id=r.content_document_id AND d.revision_id=r.content_revision_id WHERE r.task_id=$1 ORDER BY r.version", [taskId])).rows;
  const primary = (await client.query("SELECT * FROM process_document WHERE document_id=$1", [head.content_document_id])).rows[0];
  assert.equal(head.state, "todo");
  assert.equal(head.current_revision_id, secondRevisionId);
  assert.equal(head.acceptance, "old acceptance");
  assert.equal(head.content_revision_id, history[1].content_revision_id);
  assert.deepEqual(history.map(row => row.revision_id), [firstRevisionId, secondRevisionId]);
  assert.deepEqual(history.map(row => row.state), ["proposed", "ready"]);
  assert.deepEqual(history.map(row => row.body), [firstBody, secondBody]);
  assert.deepEqual(history.map(row => row.content_hash), [hash(firstBody), hash(secondBody)]);
  assert.equal(primary.kind, "task");
  assert.equal(primary.status, "published");
  assert.equal(primary.adopted_revision_id, head.content_revision_id);
  const source = (await client.query("SELECT version,status,adopted_revision_id FROM process_document WHERE document_id=$1", [sourceDocumentId])).rows[0];
  assert.equal(source.version, 1);
  assert.equal(source.status, "published");
  assert.equal(source.adopted_revision_id, sourceRevisionId);
  await assert.rejects(client.query("UPDATE process_document SET title='invalid unversioned edit' WHERE project_id=$1 AND document_id=$2",
    [projectId, sourceDocumentId]), /head version must advance exactly once/);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM document_decision WHERE document_id=$1", [primary.document_id])).rows[0].n, 1);
  assert.deepEqual((await client.query("SELECT document_id,document_revision_id FROM basis_member WHERE task_id=$1", [taskId])).rows.map(row => [row.document_id, row.document_revision_id]), [[sourceDocumentId, sourceRevisionId]]);
  const journal = (await client.query("SELECT command_hash,result FROM operation_journal WHERE operation_id=$1", [operationId])).rows[0];
  assert.equal(journal.command_hash, "a".repeat(64));
  assert.equal(journal.result.revisionId, secondRevisionId);
  const run = (await client.query("SELECT task_revision_id,basis_set_id,input,input_hash,state FROM runtime_run WHERE run_id=$1", [runId])).rows[0];
  assert.equal(run.task_revision_id, secondRevisionId);
  assert.equal(run.basis_set_id, basisId);
  assert.equal(run.input, "old fixed input");
  assert.equal(run.input_hash, hash("old fixed input"));
  assert.equal(run.state, "completed");
  assert.equal((await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='task' AND column_name='goal'", [schema])).rows.length, 0);
  await assert.rejects(client.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at) VALUES($1,$2,$3,3,'x','a','o','proposed',NULL,$4,$5,NULL,'actor','bad',$6)", [projectId, taskId, randomUUID(), primary.document_id, head.content_revision_id, now]), /four-state/);

  const workflowPool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(workflowPool),
      clock: { now: () => now }, ids: { next: randomUUID }, hasher: { hash } });
    const started = await workflow.execute({ actorId: "owner", projectIds: [projectId!], permissions: ["read", "write", "review"] },
      { type: "task.start", projectId: projectId!, operationId: randomUUID(), taskId: taskId!, expectedVersion: 2,
        reason: "Resume migrated approved work" });
    assert.equal(started.status, "applied");
    const next = (await client.query("SELECT current_revision_id,state FROM task WHERE task_id=$1", [taskId])).rows[0];
    assert.equal(next.state, "in_progress");
    const nextBasis = (await client.query(`SELECT bm.document_id,bm.document_revision_id FROM task_revision tr
      JOIN basis_member bm ON bm.project_id=tr.project_id AND bm.task_id=tr.task_id AND bm.task_revision_id=tr.revision_id AND bm.basis_set_id=tr.basis_set_id
      WHERE tr.project_id=$1 AND tr.task_id=$2 AND tr.revision_id=$3 ORDER BY bm.document_id`, [projectId, taskId, next.current_revision_id])).rows;
    assert.deepEqual(nextBasis.map(item => [item.document_id, item.document_revision_id]).sort(),
      [[sourceDocumentId, sourceRevisionId], [primary.document_id, head.content_revision_id]].sort());
    assert.deepEqual((await client.query("SELECT document_id,document_revision_id FROM basis_member WHERE task_id=$1 AND task_revision_id=$2", [taskId, secondRevisionId])).rows.map(item => [item.document_id, item.document_revision_id]),
      [[sourceDocumentId, sourceRevisionId]]);
  } finally { await workflowPool.end(); }

  // Old immutable schedule JSON still uses `goal`. The adapter projects it as
  // content and materializes a new draft Task+primary Document without rewriting history.
  const scheduleId = randomUUID();
  const scheduleRevisionId = randomUUID();
  const planned = "2026-10-21T12:00:00.000Z";
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO schedule_definition(project_id,schedule_id,version,current_revision_id,state,watermark_utc) VALUES($1,$2,1,$3,'active',$4)", [projectId, scheduleId, scheduleRevisionId, "2026-10-21T11:00:00.000Z"]);
    await client.query(`INSERT INTO schedule_revision(project_id,schedule_id,revision_id,version,timezone,rule,misfire,overlap_policy,task_template,authorization_scope,actor_id,reason,created_at_utc)
      VALUES($1,$2,$3,1,'UTC','{}'::jsonb,'{}'::jsonb,'skip',$4::jsonb,$5::jsonb,'scheduler','old template',$6)`,
      [projectId, scheduleId, scheduleRevisionId, JSON.stringify({ title: "Scheduled", goal: "Old template body\r\n", acceptance: "Check", owner: "worker" }),
        JSON.stringify({ roleId: "scheduler", expiresAtUtc: null }), now]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    const store = new PgSchedulingStore(pool);
    const definition = await store.get(projectId!, scheduleId);
    assert.equal(definition?.revision.template.content, "Old template body\r\n");
    const occurrence = await store.materialize(definition!, planned, "2026-10-21T13:00:00.000Z", "created", "due");
    assert.equal(occurrence.state, "created");
    const scheduled = (await client.query(`SELECT t.state,dr.body FROM task t JOIN document_revision dr
      ON dr.project_id=t.project_id AND dr.document_id=t.content_document_id AND dr.revision_id=t.content_revision_id
      WHERE t.project_id=$1 AND t.task_id=$2`, [projectId, occurrence.taskId])).rows[0];
    assert.equal(scheduled.state, "todo");
    assert.equal(scheduled.body, "Old template body\r\n");
    const stored = (await client.query("SELECT task_template FROM schedule_revision WHERE revision_id=$1", [scheduleRevisionId])).rows[0].task_template;
    assert.equal(stored.goal, "Old template body\r\n");
    assert.equal(stored.content, undefined);
  } finally { await pool.end(); }
});
