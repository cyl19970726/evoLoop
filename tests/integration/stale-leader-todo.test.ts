// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { disposeStaleTodoMessage } from "@evoloop/adapter-postgres/leader-result-notices";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("stale todo test requires a dedicated evoloop_*_test database");

test("a superseded queued Leader todo preserves history, frees the next message, and refreshes a still-todo revision once", async t => {
  const schema = `el_stale_todo_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: database });
    await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const projectId = randomUUID(), sessionId = randomUUID(), roleId = fixtureRoleId("stale-todo-leader");
  const actorId = "stale-todo-owner";
  const principal = { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as Array<"read"|"write"|"review"> };
  const uow = new PostgresUnitOfWork(pool);
  const service = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } });
  async function apply(command: Record<string, unknown>) {
    const result = await service.execute(principal, { projectId, operationId: randomUUID(), ...command } as never);
    assert.equal(result.status, "applied", JSON.stringify(result));
    return result;
  }
  await apply({ type: "project.create", title: "Stale Leader todo" });
  await seedFixtureRole(pool, projectId, roleId);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/stale-leader-todo','project','danger-full-access','never','ready',1,$4,$4,$5,$6,now(),now())`,
    [projectId, sessionId, roleId, `thread-${sessionId}`, randomUUID(), actorId]);

  async function createTask() {
    const taskId = randomUUID();
    await apply({ type: "task.create", taskId, title: "Current work", content: "# Original work",
      acceptance: "Leader sees the current request", owner: roleId });
    const row = (await pool.query(`SELECT n.notice_id,n.message_id,n.task_revision_id
      FROM leader_result_notice n WHERE n.project_id=$1 AND n.task_id=$2 AND n.kind='task_todo'`,
    [projectId, taskId])).rows[0];
    assert.ok(row);
    return { taskId, noticeId: String(row.notice_id), messageId: String(row.message_id), revisionId: String(row.task_revision_id) };
  }
  async function linkQueued(source: Awaited<ReturnType<typeof createTask>>, createdAt: string) {
    await pool.query(`UPDATE leader_result_notice SET state='linked',recipient_session_id=$3,
      receiver_role_id=$4,receiver_actor_id=$5,sender_actor_id=$5,linked_session_id=$3,updated_at=now()
      WHERE project_id=$1 AND notice_id=$2`, [projectId, source.noticeId, sessionId, roleId, actorId]);
    await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,context_task_id,context_task_revision_id,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,$5,'Old fixed todo',$6,$7,'queued',1,$8,$8)`,
    [projectId, source.messageId, randomUUID(), sessionId, actorId, source.taskId, source.revisionId, createdAt]);
  }
  async function pending() {
    return uow.read(projectId, reader => reader.sessionMessages!.listPendingSessionMessages(10));
  }

  const old = await createTask();
  await linkQueued(old, "2026-11-01T00:00:00Z");
  await apply({ type: "task.start", taskId: old.taskId, expectedVersion: 1, reason: "Already being worked" });
  const successorId = randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,$5,'New valid work','queued',1,'2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')`,
    [projectId, successorId, randomUUID(), sessionId, actorId]);
  assert.equal((await pending())[0]?.id, old.messageId, "the original defect blocks the successor");
  assert.equal(await disposeStaleTodoMessage(pool, projectId, old.noticeId, old.messageId), "disposed");
  assert.equal((await pending())[0]?.id, successorId);
  const oldMessage = await pool.query(`SELECT state,version,blocked_reason FROM session_message
    WHERE project_id=$1 AND message_id=$2`, [projectId, old.messageId]);
  assert.deepEqual(oldMessage.rows[0], { state: "cancelled", version: 2, blocked_reason: "TODO_SOURCE_NOT_TODO" });
  assert.equal((await pool.query(`SELECT state FROM leader_result_notice WHERE project_id=$1 AND notice_id=$2`,
    [projectId, old.noticeId])).rows[0].state, "linked");

  const revised = await createTask();
  await linkQueued(revised, "2026-11-01T01:00:00Z");
  await apply({ type: "task.update", taskId: revised.taskId, expectedVersion: 1, title: "Current work",
    content: "# Revised work", acceptance: "Leader sees the current request", owner: roleId,
    reason: "User clarified the pending work" });
  const current = (await pool.query(`SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2`,
    [projectId, revised.taskId])).rows[0].current_revision_id as string;
  assert.equal(await disposeStaleTodoMessage(pool, projectId, revised.noticeId, revised.messageId), "disposed");
  assert.equal((await pool.query(`SELECT blocked_reason FROM session_message WHERE project_id=$1 AND message_id=$2`,
    [projectId, revised.messageId])).rows[0].blocked_reason, "TODO_SOURCE_SUPERSEDED_REFRESHED");
  const fresh = await pool.query(`SELECT notice_id,state FROM leader_result_notice
    WHERE project_id=$1 AND kind='task_todo' AND task_id=$2 AND task_revision_id=$3`,
    [projectId, revised.taskId, current]);
  assert.equal(fresh.rowCount, 1);
  assert.equal(fresh.rows[0].state, "pending");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM session_message_read_receipt
    WHERE project_id=$1 AND message_id IN ($2,$3)`, [projectId, old.messageId, revised.messageId])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM session_message_processing
    WHERE project_id=$1 AND message_id IN ($2,$3)`, [projectId, old.messageId, revised.messageId])).rows[0].n, 0);

  const planned = await createTask();
  await linkQueued(planned, "2026-11-01T02:00:00Z");
  await apply({ type: "task.update", taskId: planned.taskId, expectedVersion: 1, title: "Current work",
    content: "# Clarified and planned", acceptance: "Leader sees the current request", owner: roleId,
    reason: "Clarify pending work" });
  await pool.query(`INSERT INTO task_work_plan(project_id,task_id,version,actor_id,reason,updated_at)
    VALUES($1,$2,1,$3,'Leader has arranged the current work',now())`, [projectId, planned.taskId, actorId]);
  assert.equal(await disposeStaleTodoMessage(pool, projectId, planned.noticeId, planned.messageId), "disposed");
  assert.equal((await pool.query(`SELECT blocked_reason FROM session_message WHERE project_id=$1 AND message_id=$2`,
    [projectId, planned.messageId])).rows[0].blocked_reason, "TODO_SOURCE_SUPERSEDED_REFRESHED");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM leader_result_notice WHERE project_id=$1
    AND kind='task_todo' AND task_id=$2`, [projectId, planned.taskId])).rows[0].n, 2,
  "a scheduling metadata edit cannot silently consume the current todo");

  const inFlight = await createTask();
  await linkQueued(inFlight, "2026-11-01T03:00:00Z");
  await apply({ type: "task.start", taskId: inFlight.taskId, expectedVersion: 1, reason: "Work already started" });
  const starter = await pool.connect();
  try {
    await starter.query("BEGIN");
    await starter.query(`UPDATE session_message SET state='processing',version=version+1,updated_at=now()
      WHERE project_id=$1 AND message_id=$2`, [projectId, inFlight.messageId]);
    const disposition = disposeStaleTodoMessage(pool, projectId, inFlight.noticeId, inFlight.messageId);
    await starter.query("COMMIT");
    assert.equal(await disposition, "in_flight", "a concurrent start wins over retirement");
  } finally { starter.release(); }
  assert.equal((await pool.query(`SELECT state,blocked_reason FROM session_message WHERE project_id=$1 AND message_id=$2`,
    [projectId, inFlight.messageId])).rows[0].state, "processing");
  assert.equal((await pool.query(`SELECT state FROM leader_result_notice WHERE project_id=$1 AND notice_id=$2`,
    [projectId, inFlight.noticeId])).rows[0].state, "linked");

  const raced = await createTask();
  await linkQueued(raced, "2026-11-01T04:00:00Z");
  await apply({ type: "task.start", taskId: raced.taskId, expectedVersion: 1,
    reason: "The Task changed after the message pump read it" });
  const messages = new SessionMessageService({ uow, clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, grantFor: async () => ({ projectId, sessionId, senderActorId: actorId,
      receiverRoleId: roleId, receiverActorId: "distinct-leader", cwd: "/tmp/stale-leader-todo",
      maxTurns: 10, enabled: true }) });
  await assert.rejects(() => messages.beginDispatch(projectId, raced.messageId, randomUUID(), randomUUID(),
    "a".repeat(64)), error => (error as { code?: string }).code === "TODO_SOURCE_SUPERSEDED");
  assert.equal((await pool.query(`SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2`,
    [projectId, raced.messageId])).rows[0].state, "queued");
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM session_message_processing WHERE project_id=$1
    AND message_id=$2`, [projectId, raced.messageId])).rows[0].n, 0,
  "a changed source cannot reserve a native Turn");
});
