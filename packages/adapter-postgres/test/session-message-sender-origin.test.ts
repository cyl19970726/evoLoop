// Task db48f6cd: a message keeps the origin of its sender as verified when it was posted, and the dispatcher is handed that origin, so a Hub-signed sender is judged the way
// it was at send time and a local identity with the same actor ID is not (#485). Real PostgreSQL, real WorkflowService, real SessionMessageService.
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1))) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_msg_origin_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const projectId = randomUUID(), roleId = randomUUID(), sessionId = randomUUID(), cwd = "/tmp/evoloop-origin-test", now = "2026-11-17T00:00:00.000Z";
type Permission = "task" | "document" | "session" | "management";
const principal = (origin?: "hub") => ({ actorId: "acct_alice", projectIds: [projectId], permissions: ["task", "document", "session"] as Permission[], ...(origin ? { origin } : {}) });
const workflow = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID }, hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
// The dispatcher's grant lookup as the coordinator builds it, reduced to the one fact under test: only a message stored with origin "hub" may use the hub grant.
const seen: Array<{ id: string; origin: unknown }> = [];
const service = new SessionMessageService({ uow, clock: { now: () => now }, ids: { next: randomUUID }, grantFor: async message => {
  seen.push({ id: message.id, origin: message.senderOrigin });
  return message.senderOrigin === "hub" ? { projectId, sessionId, senderActorId: message.senderActorId, receiverRoleId: roleId, receiverActorId: "receiver", cwd, maxTurns: 3, enabled: true } : null;
} });
async function post(who: ReturnType<typeof principal>): Promise<string> {
  const messageId = randomUUID();
  const result = await workflow.execute(who, { type: "session.message.post", projectId, operationId: randomUUID(), messageId, target: { kind: "owned", sessionId }, content: "hello from the Hub" });
  assert.equal(result.status, "applied");
  return messageId;
}
const originOf = async (messageId: string) => (await pool.query(`SELECT sender_origin FROM session_message WHERE project_id=$1 AND message_id=$2`, [projectId, messageId])).rows[0].sender_origin;

before(async () => {
  await migrate(url!, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)", [projectId, "Origin test", now]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'project','danger-full-access','never','ready',1,$5,$6,$7,'receiver',$8,$8)`, [projectId, sessionId, roleId, cwd, `thread-${sessionId}`, `native-${sessionId}`, randomUUID(), now]);
});
after(async () => {
  await pool.end(); const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("a Hub-signed post stores origin hub, a local post stores none, and the dispatcher is handed exactly that", async () => {
  const fromHub = await post(principal("hub"));
  assert.equal(await originOf(fromHub), "hub");
  const readBack = await uow.read(projectId, async reader => reader.sessionMessages!.getSessionMessage(fromHub));
  assert.equal(readBack?.senderOrigin, "hub");
  await service.beginDispatch(projectId, fromHub, randomUUID(), randomUUID(), "a".repeat(64));
  assert.deepEqual(seen.at(-1), { id: fromHub, origin: "hub" });
  assert.equal((await pool.query(`SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2`, [projectId, fromHub])).rows[0].state, "processing", "the Hub message started");
});

test("#485: a local identity with the same actor ID stores no origin and the dispatcher refuses it with the missing-grant code", async () => {
  // Queue behind nothing: free the Session first (the earlier message is processing).
  await pool.query(`UPDATE session_message_processing SET state='failed',version=version+1,updated_at=now() WHERE project_id=$1`, [projectId]);
  await pool.query(`UPDATE session_message SET state='failed',version=version+1,updated_at=now() WHERE project_id=$1 AND state='processing'`, [projectId]);
  const fromLocal = await post(principal());
  assert.equal(await originOf(fromLocal), null);
  await assert.rejects(() => service.beginDispatch(projectId, fromLocal, randomUUID(), randomUUID(), "a".repeat(64)), (error: { code?: string }) => error.code === "MESSAGE_GRANT_MISSING");
  assert.deepEqual(seen.at(-1), { id: fromLocal, origin: undefined });
});

test("the stored origin cannot be changed afterwards, and only hub or nothing is accepted", async () => {
  const id = await post(principal("hub"));
  await assert.rejects(() => pool.query(`UPDATE session_message SET sender_origin=NULL,version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2`, [projectId, id]), /origin is immutable|immutable/);
  const local = await post(principal());
  await assert.rejects(() => pool.query(`UPDATE session_message SET sender_origin='hub',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2`, [projectId, local]), /origin is immutable|immutable/);
  await assert.rejects(() => pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,sender_origin,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'x','local','c','queued',1,now(),now())`, [projectId, randomUUID(), randomUUID(), sessionId]), /check/i);
  assert.equal(await originOf(id), "hub", "unchanged");
});

test("messages stored before the column existed read back as local (no senderOrigin): no origin is inferred", async () => {
  const id = randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'acct_alice','old','queued',1,now(),now())`, [projectId, id, randomUUID(), sessionId]);
  const old = await uow.read(projectId, async reader => reader.sessionMessages!.getSessionMessage(id));
  assert.equal(old?.senderOrigin, undefined);
});
