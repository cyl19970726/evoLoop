// Lock order between the task-timing tick and a core write on the same project. The core write
// takes the project advisory lock first, then row locks and the trigger-held leader-work lock;
// the tick must take the same project lock first, or the two interleave into a deadlock (40P01).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgTaskTimingQueries, PgTaskTimingStore, type TaskTimingTickResult } from "../src/task-timing.ts";
import { taskTimingScopeId } from "@evoloop/contracts/task-timing";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Task timing lock tests require a dedicated evoloop test database");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const schema = `el_timing_lock_${suffix}`;
// lock_timeout turns a lost wake-up into a test failure instead of a hang.
const options = `-c search_path=${schema} -c lock_timeout=20000`;
const coreApplication = `el_timing_lock_core_${suffix}`;
const pool = new pg.Pool({ connectionString: url, options });
const corePool = new pg.Pool({ connectionString: url, options, application_name: coreApplication });
const core = new PostgresUnitOfWork(corePool);
const projectId = randomUUID(), roleId = randomUUID();
const first = "2026-11-07T00:00:00.000Z", second = "2026-11-08T00:00:00.000Z";
const setupAt = "2026-11-06T00:00:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

async function inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
async function adoptedDocument(): Promise<{ documentId: string; revisionId: string }> {
  const documentId = randomUUID(), revisionId = randomUUID();
  await inTransaction(async client => {
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,
      adopted_revision_id,kind,status) VALUES($1,$2,'Reference',1,$3,$3,'spec','published')`,
      [projectId, documentId, revisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'Reference body','markdown',$4,'author',$5,'fixed','text/markdown','reference.md','[]'::jsonb)`,
      [projectId, documentId, revisionId, hash("Reference body"), setupAt]);
    await client.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,
      actor_id,reason,created_at) VALUES($1,$2,$3,$4,'author','adopt',$5)`,
      [projectId, randomUUID(), documentId, revisionId, setupAt]);
  });
  return { documentId, revisionId };
}
async function task(title: string): Promise<string> {
  const taskId = randomUUID(), revisionId = randomUUID(), documentId = randomUUID(), contentId = randomUUID();
  await inTransaction(async client => {
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,$3,1,$4,'task','draft')`, [projectId, documentId, title, contentId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,$4,'markdown',$5,'author',$6,'test','text/markdown','task.md','[]'::jsonb)`,
      [projectId, documentId, contentId, `Do ${title}`, hash(`Do ${title}`), setupAt]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
      content_document_id,content_revision_id) VALUES($1,$2,1,$3,$4,'accept',$5,'todo',$6,$7)`,
      [projectId, taskId, revisionId, title, roleId, documentId, contentId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,content_document_id,content_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,$4,'accept',$5,'todo',$6,$7,'author','test',$8)`,
      [projectId, taskId, revisionId, title, roleId, documentId, contentId, setupAt]);
    await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,consumer,use_required,
      acceptance_mode,evidence,stop_condition,created_at)
      VALUES($1,$2,$3,'consumer',true,'independent_agent','source','',$4)`, [projectId, taskId, revisionId, setupAt]);
  });
  return taskId;
}
const link = (taskId: string, documentId: string) => pool.query(`INSERT INTO task_document_link(project_id,link_id,
  task_id,document_id,actor_id,created_at) VALUES($1,$2,$3,$4,'author',$5)`, [projectId, randomUUID(), taskId, documentId, setupAt]);
const queries = <T>(run: (q: PgTaskTimingQueries) => Promise<T>) =>
  inTransaction(client => run(new PgTaskTimingQueries(client, projectId)));
const daily = { executeAtUtc: first, timezone: "Asia/Taipei", repeat: "daily" as const };

/** A tick pool whose connection stops before the first matching statement until resumed. */
function gatedTickPool(stopBefore: (text: string, values: unknown[]) => boolean) {
  const tickPool = new pg.Pool({ connectionString: url, options, max: 1 });
  let reached!: () => void, resume!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  let stopped = false;
  const facade = {
    connect: async () => {
      const client = await tickPool.connect();
      const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
      Object.assign(client, { query: async (text: string, values?: unknown[]) => {
        if (!stopped && stopBefore(text, values ?? [])) { stopped = true; reached(); await resumed; }
        return query(text, values);
      } });
      return client;
    },
  };
  return { pool: facade as unknown as pg.Pool, paused, resume, end: () => tickPool.end() };
}
async function coreWaitsOnLock(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'`, [coreApplication]);
    if (waiting.rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("core write never waited on a lock");
}
/** Core revision of a linked document through the real unit of work: project lock, revision, head CAS. */
function reviseDocument(documentId: string, previousRevisionId: string): Promise<void> {
  const revisionId = randomUUID(), body = "# core revision";
  return core.transaction(projectId, async tx => {
    await tx.insertDocumentRevision({ projectId, documentId, id: revisionId, body, format: "markdown",
      mediaType: "text/markdown", originalName: "reference.md", payloadRef: null, entrypoint: null, assetsManifest: [],
      contentHash: hash(body), author: "core", createdAt: second, previousRevisionId, reason: "core revise" });
    await tx.updateDocument({ projectId, id: documentId, title: "Reference", version: 2, currentRevisionId: revisionId,
      adoptedRevisionId: previousRevisionId, kind: "spec", status: "published" }, 1);
  });
}
/** Stop the tick at one point, start the core write, let it block, then let the tick continue. */
async function interleave(stopBefore: (text: string, values: unknown[]) => boolean,
  tick: (store: PgTaskTimingStore) => Promise<TaskTimingTickResult[]>, documentId: string, previousRevisionId: string) {
  const gate = gatedTickPool(stopBefore);
  try {
    const ticking = tick(new PgTaskTimingStore(gate.pool));
    ticking.catch(() => {});
    await Promise.race([gate.paused, ticking.then(() => { throw new Error("tick finished before the interleaving point"); })]);
    const writing = reviseDocument(documentId, previousRevisionId);
    writing.catch(() => {});
    await coreWaitsOnLock();
    gate.resume();
    const [tickOutcome, writeOutcome] = await Promise.allSettled([ticking, writing]);
    const describe = (outcome: PromiseSettledResult<unknown>) => outcome.status === "fulfilled" ? "ok" :
      `${(outcome.reason as { code?: string }).code ?? ""} ${String((outcome.reason as Error).message ?? outcome.reason)}`;
    assert.equal(writeOutcome.status, "fulfilled", `core write: ${describe(writeOutcome)}`);
    assert.equal(tickOutcome.status, "fulfilled", `tick: ${describe(tickOutcome)}`);
    const head = await pool.query(`SELECT version FROM process_document WHERE project_id=$1 AND document_id=$2`,
      [projectId, documentId]);
    assert.equal(head.rows[0].version, 2, "core revision committed");
    return (tickOutcome as PromiseFulfilledResult<TaskTimingTickResult[]>).value;
  } finally { gate.resume(); await gate.end(); }
}

before(async () => {
  await migrate(url!, schema);
  await inTransaction(async client => {
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Timing lock',$2)`, [projectId, setupAt]);
    const roleRevision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,
      proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',$4,'2026-12-06T00:00:00.000Z')`,
      [projectId, roleId, roleRevision, setupAt]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,
      actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',$4,
      '2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, setupAt]);
  });
});
after(async () => {
  await pool.end(); await corePool.end();
  const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("tick validating a linked document before writing does not deadlock a core revision (X)", async () => {
  const actorId = "lock-order-x", reference = await adoptedDocument(), root = await task("Linked daily");
  await link(root, reference.documentId);
  await queries(q => q.create(root, daily, actorId, setupAt));
  const store = (s: PgTaskTimingStore, at: string) => s.tick(projectId, at, actorId, roleId, taskTimingScopeId(root));
  await store(new PgTaskTimingStore(pool), first);
  // Stopped after FOR SHARE on the linked document, before the first trigger-locked insert.
  const created = await interleave(text => /INSERT INTO process_document/.test(text),
    s => store(s, second), reference.documentId, reference.revisionId);
  assert.deepEqual(created.map(item => [item.plannedAtUtc, item.created]), [[second, true]]);
});

test("tick validating a linked document after writing another series does not deadlock (Y)", async () => {
  // Until migration 069 (PR #285) lands, simulate its BEFORE INSERT trigger that locks the document
  // row when a revision is inserted. With 069 present, rely on the real trigger.
  const native = await pool.query(`SELECT 1 FROM pg_trigger
    WHERE tgrelid='document_revision'::regclass AND tgname='document_revision_number'`);
  if (!native.rows.length) await pool.query(`
    CREATE FUNCTION test_lock_document_for_revision() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM process_document WHERE project_id=NEW.project_id AND document_id=NEW.document_id FOR NO KEY UPDATE;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_lock_document_for_revision BEFORE INSERT ON document_revision
      FOR EACH ROW EXECUTE FUNCTION test_lock_document_for_revision();`);
  try {
    const actorId = "lock-order-y", reference = await adoptedDocument();
    const a = await task("Unlinked daily"), b = await task("Linked daily");
    const sa = (await queries(q => q.set({ type: "task.timing.set", projectId, operationId: randomUUID(), taskId: a,
      expectedTaskVersion: 1, expectedTimingVersion: 0, scope: "this", ...daily, reason: "daily" }, actorId, setupAt))).seriesId;
    const sb = (await queries(q => q.set({ type: "task.timing.set", projectId, operationId: randomUUID(), taskId: b,
      expectedTaskVersion: 1, expectedTimingVersion: 0, scope: "this", ...daily, reason: "daily" }, actorId, setupAt))).seriesId;
    // The tick visits series by id; link the document to whichever series it visits second, so the
    // first series has already inserted rows (and holds leader-work) when the linked one is validated.
    const [, later] = sa < sb ? [a, b] : [b, a];
    await link(later, reference.documentId);
    await queries(q => q.updateFuture(later, { title: "Linked daily", content: "Do Linked daily", acceptance: "accept" },
      1, actorId, "2026-11-06T01:00:00.000Z"));
    const store = (s: PgTaskTimingStore, at: string) => s.tick(projectId, at, actorId, roleId, "task-timing:*");
    await store(new PgTaskTimingStore(pool), first);
    const created = await interleave((text, values) => /FROM process_document[\s\S]*FOR SHARE/.test(text) &&
      values[1] === reference.documentId, s => store(s, second), reference.documentId, reference.revisionId);
    assert.deepEqual(created.map(item => item.created), [true, true]);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS test_lock_document_for_revision ON document_revision;
      DROP FUNCTION IF EXISTS test_lock_document_for_revision();`);
  }
});
