// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { TaskAttentionPump } from "../../apps/coordinator/src/task-attention/pump.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

const hour = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-12T01:00:00.000Z"); // the middle of the night

/**
 * The real path end to end: Tasks made through WorkflowService, the coordinator's own TaskAttentionPump (the one main.ts starts) reading the real
 * leader work projection, and the persistent attention items and Leader notices it writes. Only the clock is ours.
 */
test("a ready Task nobody dispatched reaches the Leader after 2 hours, at night too, once; dispatched, waiting and dependency-blocked Tasks do not", async t => {
  const schema = `ready_reminder_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  let clock = T0;
  const projectId = randomUUID();
  const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date(clock).toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } });
  const applied = async (command: Record<string, unknown>) => { const r = await workflow.execute(lead, { ...command, projectId, operationId: randomUUID() } as never); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  await applied({ type: "project.create", title: "Ready reminder" });
  const owner = fixtureRoleId("ready-owner"); await seedFixtureRole(pool, projectId, owner);
  const errors: unknown[] = [];
  const pump = new TaskAttentionPump({ pool, projects: async () => [projectId], canWrite: () => true, now: () => new Date(clock).toISOString(), onError: error => errors.push(error), pollIntervalMs: 24 * hour });
  const makeTask = async (title: string) => { const taskId = randomUUID(); await applied({ type: "task.create", taskId, title, content: `# ${title}`, acceptance: "Result", owner }); return taskId; };
  const openItems = async () => (await pool.query(`SELECT task_id, phase, signal, severity FROM task_attention_item WHERE project_id=$1 AND state='open' ORDER BY task_id`, [projectId])).rows as Array<{ task_id: string; phase: string; signal: string; severity: string }>;
  const notices = async () => (await pool.query(`SELECT task_id, state FROM leader_result_notice WHERE project_id=$1 AND kind='task_attention'`, [projectId])).rows as Array<{ task_id: string; state: string }>;
  const evaluate = async (at: number) => { clock = at; await pump.tick(); assert.deepEqual(errors, [], "no evaluation error"); };

  const taskOf = async (taskId: string) => { const read = (await workflow.getTask(lead, projectId, taskId)) as unknown as { version?: number; currentRevisionId?: string; task?: { version: number; currentRevisionId: string } }; return (read.task ?? read) as { version: number; currentRevisionId: string }; };
  const stale = await makeTask("Ready and never dispatched");
  const waiting = await makeTask("Waiting for the user");
  const prerequisite = await makeTask("Prerequisite not finished");
  const dependent = await makeTask("Depends on the prerequisite");
  await pool.query(`INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,actor_id,reason,created_at) VALUES($1,$2,$3,'lead','needs the prerequisite',$4)`,
    [projectId, dependent, prerequisite, new Date(clock).toISOString()]);
  await pool.query(`INSERT INTO task_dependency_head(project_id,task_id,version,updated_at) VALUES($1,$2,1,$3)`, [projectId, dependent, new Date(clock).toISOString()]);

  // The Leader explicitly marks one Task as waiting for something, with a checkpoint 12 hours away.
  clock = T0 + 30 * 60_000;
  const waitingTask = await taskOf(waiting);
  await applied({ type: "task.attention.followUp.set", taskId: waiting, expectedTaskVersion: waitingTask.version, expectedTaskRevisionId: waitingTask.currentRevisionId, expectedVersion: 0,
    waitingOn: { kind: "user", id: "the consumer" }, decision: "waiting", actionTaken: "Waiting for the consumer to be free", evidenceRef: null, nextCheckAt: new Date(T0 + 12 * hour).toISOString(), releaseHandoff: null, reason: "Explicit wait" });
  // A Task that only became ready an hour later.
  clock = T0 + hour;
  const late = await makeTask("Became ready an hour later");

  // 1h59 after the first Tasks were ready: nothing has waited 2 hours yet.
  await evaluate(T0 + 2 * hour - 60_000);
  assert.deepEqual(await openItems(), [], "before the threshold nothing is raised");
  assert.deepEqual(await notices(), []);

  // Past 2 hours, at night: the two ready Tasks (the one nobody dispatched and the prerequisite, also ready) are raised; waiting, blocked and the later one are not.
  await evaluate(T0 + 2 * hour + 60_000);
  const raised = await openItems();
  assert.deepEqual(raised.map(item => item.task_id).sort(), [stale, prerequisite].sort(), "only the ready, undispatched, unwaiting, unblocked Tasks");
  for (const item of raised) assert.deepEqual([item.phase, item.signal, item.severity], ["unassigned", "stage_overdue", "watch"]);
  assert.deepEqual((await notices()).map(row => row.task_id).sort(), [stale, prerequisite].sort(), "one Leader notice per Task");
  assert.equal(raised.some(item => [waiting, dependent, late].includes(item.task_id)), false);

  // Evaluating again does not stack a second reminder.
  await evaluate(T0 + 2 * hour + 5 * 60_000);
  await evaluate(T0 + 2 * hour + 10 * 60_000);
  assert.equal((await openItems()).length, 2, "still one open item per Task");
  assert.equal((await notices()).length, 2, "and one notice per Task: no refresh spam");

  // Dispatching the Task (an assignment to a Session) makes its reminder go away.
  const sessionId = randomUUID(), at = new Date(clock).toISOString();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp','project','danger-full-access','never','ready',1,$4,$5,$6,'lead',$7,$7)`, [projectId, sessionId, owner, `thread-${sessionId}`, `native-${sessionId}`, randomUUID(), at]);
  const revision = await taskOf(stale);
  await pool.query(`INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,actor_id,reason,updated_at)
    VALUES($1,$2,1,$3,'owned',$4,'worker','assigned','lead','Dispatch',$5)`, [projectId, stale, revision.currentRevisionId, sessionId, at]);
  await pool.query(`INSERT INTO task_session_assignment_revision SELECT * FROM task_session_assignment WHERE project_id=$1 AND task_id=$2`, [projectId, stale]);
  await evaluate(T0 + 2 * hour + 20 * 60_000);
  assert.deepEqual((await openItems()).map(item => item.task_id), [prerequisite], "the dispatched Task's reminder is resolved; the other stays");

  // The Task that became ready later is reminded once it has waited 2 hours of its own.
  await evaluate(T0 + 3 * hour + 60_000);
  assert.deepEqual((await openItems()).map(item => item.task_id).sort(), [prerequisite, late].sort());
  // The waiting Task is reminded again only once its checkpoint has passed.
  await evaluate(T0 + 11 * hour);
  assert.equal((await openItems()).some(item => item.task_id === waiting), false, "still inside the waiting window");
  await evaluate(T0 + 13 * hour);
  assert.equal((await openItems()).some(item => item.task_id === waiting), true, "past the checkpoint it is raised again");
  assert.equal((await openItems()).some(item => item.task_id === dependent), false, "a Task blocked on its dependency is never raised as ready");
});

// "Ready" starts when the Task can be dispatched, not when it was created: time spent blocked on a dependency is not time spent ready and undispatched.
test("a Task released by its dependency is ready from that moment: creation time and the blocked hours do not count", async t => {
  const schema = `ready_dependency_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  let clock = T0;
  const projectId = randomUUID();
  const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date(clock).toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } });
  const applied = async (command: Record<string, unknown>) => { const r = await workflow.execute(lead, { ...command, projectId, operationId: randomUUID() } as never); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  await applied({ type: "project.create", title: "Ready after dependency" });
  const owner = fixtureRoleId("dependency-owner"); await seedFixtureRole(pool, projectId, owner);
  const errors: unknown[] = [];
  const pump = new TaskAttentionPump({ pool, projects: async () => [projectId], canWrite: () => true, now: () => new Date(clock).toISOString(), onError: error => errors.push(error), pollIntervalMs: 24 * hour });
  const makeTask = async (title: string) => { const taskId = randomUUID(); await applied({ type: "task.create", taskId, title, content: `# ${title}`, acceptance: "Result", owner }); return taskId; };
  const open = async (taskId: string) => (await pool.query(`SELECT 1 FROM task_attention_item WHERE project_id=$1 AND task_id=$2 AND state='open'`, [projectId, taskId])).rowCount;
  const evaluate = async (at: number) => { clock = at; await pump.tick(); assert.deepEqual(errors, [], "no evaluation error"); };

  const prerequisite = await makeTask("Prerequisite");
  const dependent = await makeTask("Waits for the prerequisite");
  await pool.query(`INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,actor_id,reason,created_at) VALUES($1,$2,$3,'lead','needs it',$4)`, [projectId, dependent, prerequisite, new Date(T0).toISOString()]);
  await pool.query(`INSERT INTO task_dependency_head(project_id,task_id,version,updated_at) VALUES($1,$2,1,$3)`, [projectId, dependent, new Date(T0).toISOString()]);
  // Blocked for five hours: never reminded as ready.
  await evaluate(T0 + 5 * hour);
  assert.equal(await open(dependent), 0, "blocked on its dependency, not ready");
  // The dependency is accepted and closed at T0+5h.
  const doneAt = new Date(T0 + 5 * hour).toISOString();
  const revision = (await pool.query("SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2", [projectId, prerequisite])).rows[0].current_revision_id;
  const deliveryId = randomUUID();
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','delivery','author',$6)`, [projectId, deliveryId, prerequisite, revision, "a".repeat(64), doneAt]);
  await pool.query(`INSERT INTO task_closure(project_id,closure_id,task_id,task_revision_id,delivery_id,acceptance_result,acceptance_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'met','evidence','close','lead',$6)`, [projectId, randomUUID(), prerequisite, revision, deliveryId, doneAt]);
  // One minute and just under two hours after it became ready: not yet. (Counted from creation it would be 5 hours: a false reminder.)
  await evaluate(T0 + 5 * hour + 60_000);
  assert.equal(await open(dependent), 0, "ready for one minute: no reminder");
  await evaluate(T0 + 7 * hour - 60_000);
  assert.equal(await open(dependent), 0, "ready for 1h59: no reminder");
  // Two hours after it became ready, still undispatched: now.
  await evaluate(T0 + 7 * hour + 60_000);
  assert.equal(await open(dependent), 1, "ready for 2h01 and still undispatched: reminded");
});
