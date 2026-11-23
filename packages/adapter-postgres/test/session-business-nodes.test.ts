// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { SessionObservationReader } from "@evoloop/contracts/session-observation";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

// Task 13518ac6: the business steps of the Tasks a Session accepted, newest first, paged by time, only for that Session.
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session business nodes require a dedicated evoLoop test database");
const schema = `el_nodes_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const id = randomUUID;
const project = id(), role = id(), roleRevision = id(), sessionX = id(), sessionY = id();
const taskB = id(), taskC = id(), taskD = id();
const t = (minute: number) => new Date(Date.UTC(2026, 9, 26, 0, minute)).toISOString();
const scope = JSON.stringify({ actorId: "reader", permissions: [] });
const q = (client: pg.PoolClient, sql: string, values: unknown[] = []) => client.query(sql, values);
const observe = <T>(fn: (reader: SessionObservationReader) => Promise<T>) => uow.read(project, async reader => fn(reader.sessionObservation!(scope)));
const documentB = id();

before(async () => {
  await migrate(url!, schema);
  const client = await pool.connect();
  try {
    await q(client, "BEGIN");
    await q(client, "INSERT INTO project(project_id,title,created_at) VALUES($1,'Business nodes',$2)", [project, t(0)]);
    await q(client, `INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [project, role, roleRevision, t(0)]);
    await q(client, `INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active','{"title":"Role"}'::jsonb,'lead','fixture',$4,$4)`, [project, role, roleRevision, t(0)]);
    for (const session of [sessionX, sessionY]) await q(client, `INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp','fixture','danger-full-access','never','ready',1,$4,$4,$5,'lead',$6,$6)`, [project, session, role, `native-${session}`, id(), t(0)]);
    // Task documents (the Task row needs one) and one report Document a delivery points at.
    for (const [task, title] of [[taskB, "Task B"], [taskC, "Task C"], [taskD, "Task D"]] as const) {
      const document = id(), documentRevision = id(), revision = id();
      await q(client, `INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,$3,1,$4,'task','draft')`, [project, document, title, documentRevision]);
      await q(client, `INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
        VALUES($1,$2,$3,'body','markdown',$4,'lead',$5,'fixture')`, [project, document, documentRevision, "0".repeat(64), t(0)]);
      await q(client, `INSERT INTO task(project_id,task_id,version,current_revision_id,title,content_document_id,content_revision_id,acceptance,owner,state)
        VALUES($1,$2,1,$3,$4,$5,$6,'Result',$7,'todo')`, [project, task, revision, title, document, documentRevision, role]);
      await q(client, `INSERT INTO task_revision(project_id,task_id,revision_id,version,title,content_document_id,content_revision_id,acceptance,owner,state,actor_id,reason,created_at)
        VALUES($1,$2,$3,1,$4,$5,$6,'Result',$7,'todo','lead','fixture',$8)`, [project, task, revision, title, document, documentRevision, role, t(0)]);
      // Dispatch (assigned, by "lead") at minute 1, then accepted by the Session at minute 2 (B and D by X, C by Y).
      const session = task === taskC ? sessionY : sessionX;
      const assigned = () => q(client, `INSERT INTO task_session_assignment_revision(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,actor_id,reason,updated_at)
        VALUES($1,$2,1,$3,'owned',$4,'worker','assigned','lead-dispatcher','fixture',$5)`, [project, task, revision, session, t(1)]);
      await q(client, `INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,ack_method,ack_actor_id,
        ack_observer_actor_id,ack_evidence,ack_at,actor_id,reason,updated_at) VALUES($1,$2,2,$3,'owned',$4,'worker','accepted','direct','worker','worker','ok',$5,'worker','fixture',$5)`,
        [project, task, revision, session, t(2)]);
      await assigned();
      await q(client, `INSERT INTO task_session_assignment_revision(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,ack_method,ack_actor_id,
        ack_observer_actor_id,ack_evidence,ack_at,actor_id,reason,updated_at) VALUES($1,$2,2,$3,'owned',$4,'worker','accepted','direct','worker','worker','ok',$5,'worker','fixture',$5)`,
        [project, task, revision, session, t(2)]);
    }
    const reportRevision = id();
    await q(client, `INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Report one',1,$3,'report','draft')`, [project, documentB, reportRevision]);
    await q(client, `INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'body','markdown',$4,'lead',$5,'fixture')`, [project, documentB, reportRevision, "1".repeat(64), t(0)]);
    const taskRevision = async (task: string) => (await q(client, "SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2", [project, task])).rows[0].current_revision_id as string;
    const delivery = async (task: string, ref: string, minute: number, result = "passed") => {
      const deliveryId = id();
      await q(client, `INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,$5,'rev',$6,$7,'ev','why','worker',$8)`, [project, deliveryId, task, await taskRevision(task), ref, "a".repeat(64), result, t(minute)]);
      return deliveryId;
    };
    const observation = (task: string, deliveryId: string, result: string, reason: string, minute: number) => q(client, `INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'acceptor','agent',$5,'ev',$6,'acceptor',$7)`, [project, id(), task, deliveryId, result, reason, t(minute)]);
    // B: PR delivery #1 (minute 3), failed with a reason (minute 10), a document delivery #2 (minute 11), used (12), closed (13).
    const first = await delivery(taskB, "https://github.com/o/r/pull/537", 3);
    await observation(taskB, first, "failed", "第一句原因。第二句不显示。", 10);
    const second = await delivery(taskB, `#/p/${project}/documents/${documentB}?revision=${reportRevision}`, 11);
    await observation(taskB, second, "used", "", 12);
    await q(client, `INSERT INTO task_closure(project_id,closure_id,task_id,task_revision_id,delivery_id,acceptance_result,acceptance_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,'met','ev','done','closer',$6)`, [project, id(), taskB, await taskRevision(taskB), second, t(13)]);
    // C belongs to the other Session; D (X) is cancelled at minute 20.
    await delivery(taskC, "https://github.com/o/r/pull/9", 4);
    await q(client, `INSERT INTO task_revision(project_id,task_id,revision_id,version,title,content_document_id,content_revision_id,acceptance,owner,state,actor_id,reason,created_at,basis_set_id)
      SELECT project_id,task_id,$3,2,title,content_document_id,content_revision_id,acceptance,owner,'cancelled','canceller','stop',$4,NULL FROM task_revision WHERE project_id=$1 AND task_id=$2 AND version=1`,
      [project, taskD, id(), t(20)]);
    await q(client, "COMMIT");
  } catch (error) { await q(client, "ROLLBACK"); throw error; } finally { client.release(); }
});
after(async () => { await pool.end(); const client = new pg.Client({ connectionString: url }); await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); } });

const brief = (item: { node?: { kind: string } & Record<string, unknown> }) => item.node!;

test("business nodes: this Session's accepted Tasks, newest first, with number, artifact, reason and who", async () => {
  const page = await observe(reader => reader.history(`owned:${sessionX}`, { limit: 50, business: true }));
  assert.ok(page);
  assert.equal(page.nextCursor, null);
  const nodes = page.items.map(brief);
  assert.deepEqual(nodes.map(node => node.kind), ["closed", "closed", "observed", "delivered", "observed", "delivered", "accepted", "accepted"]);
  assert.deepEqual(page.items.map(item => item.occurredAt), [20, 13, 12, 11, 10, 3, 2, 2].map(t));
  assert.deepEqual(nodes[0], { kind: "closed", taskId: taskD, title: "Task D", cancelled: true, by: "canceller" });
  assert.deepEqual(nodes[1], { kind: "closed", taskId: taskB, title: "Task B", cancelled: false, by: "closer" });
  assert.deepEqual(nodes[2], { kind: "observed", taskId: taskB, title: "Task B", deliveryId: nodes[3]!.deliveryId, deliveryNumber: 2, result: "used", observer: "acceptor", reason: null });
  assert.deepEqual({ number: nodes[3]!.number, artifact: nodes[3]!.artifact }, { number: 2, artifact: { kind: "document", label: "Report one" } });
  assert.deepEqual({ result: nodes[4]!.result, number: nodes[4]!.deliveryNumber, reason: nodes[4]!.reason }, { result: "failed", number: 1, reason: "第一句原因。" });
  assert.deepEqual({ number: nodes[5]!.number, artifact: nodes[5]!.artifact, by: nodes[5]!.by }, { number: 1, artifact: { kind: "pr", label: "PR #537" }, by: "worker" });
  assert.equal(nodes[6]!.by, "lead-dispatcher");
  assert.ok(!page.items.some(item => item.taskId === taskC), "another Session's Task has no node here");
  assert.ok(page.items.every(item => item.source.href.includes(`tasks/${item.taskId}`)));
});

test("business nodes page by time and stop at `since`", async () => {
  const key = `owned:${sessionX}`;
  const first = await observe(reader => reader.history(key, { limit: 3, business: true }));
  assert.equal(first!.items.length, 3); assert.ok(first!.nextCursor);
  const second = await observe(reader => reader.history(key, { limit: 3, business: true, cursor: first!.nextCursor! }));
  const third = await observe(reader => reader.history(key, { limit: 3, business: true, cursor: second!.nextCursor! }));
  const all = [...first!.items, ...second!.items, ...third!.items];
  assert.equal(new Set(all.map(item => item.id)).size, 8, "no node twice, none lost");
  assert.equal(third!.nextCursor, null);
  const recent = await observe(reader => reader.history(key, { limit: 50, business: true, since: t(11) }));
  assert.deepEqual(recent!.items.map(item => item.occurredAt), [20, 13, 12, 11].map(t));
  await assert.rejects(observe(reader => reader.history(key, { limit: 3, business: true, since: t(11), cursor: first!.nextCursor! })), /读取位置/, "a cursor belongs to its own filter");
  const other = await observe(reader => reader.history(`owned:${sessionY}`, { limit: 50, business: true }));
  assert.deepEqual(other!.items.map(item => item.node!.kind), ["delivered", "accepted"]);
});
