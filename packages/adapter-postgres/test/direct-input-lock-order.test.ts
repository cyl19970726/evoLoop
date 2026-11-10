// Lock order between a direct input reservation (PgDirectInputs, its own transaction) and core
// writes. The reservation locks the Session row and then inserts a message whose project foreign
// key waits on a project row lock; queue creation holds that project row and then references the
// same Session.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgDirectInputs } from "../src/direct-input.ts";
import type { PgResidentQueue } from "../src/queues.ts";
import { interleave } from "./lock-order-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Direct input lock tests require a dedicated evoloop test database");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const schema = `el_direct_lock_${suffix}`;
const options = `-c search_path=${schema} -c lock_timeout=20000`;
const otherApplication = `el_direct_lock_other_${suffix}`;
const pool = new pg.Pool({ connectionString: url, options });
const otherPool = new pg.Pool({ connectionString: url, options, application_name: otherApplication });
const core = new PostgresUnitOfWork(otherPool, { lead: async () => true });
const projectId = randomUUID(), roleId = randomUUID(), at = "2026-11-06T00:00:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

async function inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
async function readySession(): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,
    approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/direct-lock','project','danger-full-access','never','ready',1,$4,$5,$6,'agent',now(),now())`,
    [projectId, sessionId, roleId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID()]);
  return sessionId;
}
/** A Task revision for the queue entry's foreign key; the queue's state rules live in core, not here. */
async function queuedTask(): Promise<{ taskId: string; revisionId: string }> {
  const taskId = randomUUID(), revisionId = randomUUID(), documentId = randomUUID(), contentId = randomUUID();
  await inTransaction(async client => {
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Queued',1,$3,'task','draft')`, [projectId, documentId, contentId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'Do it','markdown',$4,'author',$5,'test','text/markdown','task.md','[]'::jsonb)`,
      [projectId, documentId, contentId, hash("Do it"), at]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
      content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Queued','accept',$4,'todo',$5,$6)`,
      [projectId, taskId, revisionId, roleId, documentId, contentId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,content_document_id,content_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'Queued','accept',$4,'todo',$5,$6,'author','test',$7)`,
      [projectId, taskId, revisionId, roleId, documentId, contentId, at]);
  });
  return { taskId, revisionId };
}

before(async () => {
  await migrate(url!, schema);
  await inTransaction(async client => {
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Direct lock',$2)`, [projectId, at]);
    const roleRevision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,
      proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',$4,'2026-12-06T00:00:00.000Z')`,
      [projectId, roleId, roleRevision, at]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,
      actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',$4,
      '2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, at]);
  });
});
after(async () => {
  await pool.end(); await otherPool.end();
  const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("direct input start holding the Session row does not deadlock queue creation for that Session", async () => {
  const sessionId = await readySession(), task = await queuedTask(), queueId = randomUUID();
  const command = { inputId: randomUUID(), operationId: randomUUID(), content: "Additional detail", expectedTurnId: null };
  const grant = { projectId, sessionId, senderActorId: "user", receiverRoleId: roleId, receiverActorId: "agent",
    cwd: "/tmp/direct-lock", maxTurns: 2, enabled: true, canSteer: true, canStart: true };
  // Stopped after the Session row lock, before the message insert that key-shares the project row.
  const [reserved] = await interleave({ connectionString: url!, options, observer: pool, otherApplication, projectId,
    labels: ["direct input reserve", "queue creation"], stopBefore: text => /INSERT INTO session_message\(/.test(text),
    stopped: gated => new PgDirectInputs(gated).reserve(projectId, sessionId, "user", command, grant, "a".repeat(64)),
    // Queue creation runs in the core transaction: project lock, project row FOR UPDATE, then entries.
    other: () => core.transaction(projectId, async tx => {
      await (tx as unknown as { queue: PgResidentQueue }).queue.createResidentQueue({ projectId, id: queueId, version: 1,
        adoptedVersion: null, maxRuns: 1, reason: "queue", actorId: "lead", entries: [{ projectId, queueId, id: randomUUID(),
          taskId: task.taskId, taskRevisionId: task.revisionId, sourceInputJson: "{}", sessionId, roleId, position: 0,
          dependsOn: [], consumerId: "consumer", useRequired: false, releaseRule: "bounded_decision", state: "queued",
          holdCode: null, holdReason: null, claimId: null, version: 1 } as never] });
    }) });
  assert.equal(reserved.created, true);
  const queued = await pool.query(`SELECT count(*)::int AS n FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2`,
    [projectId, queueId]);
  assert.equal(queued.rows[0].n, 1);
});
