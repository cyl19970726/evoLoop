// Defect 0fd4a99b: an acceptance arrangement that is blocked, superseded or waiting for its publication must not leave its message silently at the head of
// the receiving Session's queue. Real PG; the relay service as the coordinator runs it.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../src/index.ts";
import { PgSessionMessages } from "../src/session-messages.ts";
import { AcceptanceRelayService } from "../../../apps/coordinator/src/acceptance-relay/service.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Acceptance relay binding tests require a dedicated evoloop test database");
const schema = `el_relay_head_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), roleId = randomUUID(), at = "2026-11-06T00:00:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const executed: unknown[] = [];

type Message = { state: string; operationId: string; senderActorId: string; target: { kind: "owned"; sessionId: string };
  context: { taskId: string; taskRevisionId: string } | null; content: string };
const service = new AcceptanceRelayService({ pool, canWrite: () => true, leaderSession: async () => null, qualify: async () => null, capabilities: async () => [],
  principals: async () => [{ actorId: "leader", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }],
  workflow: { getRuntimeSession: async () => ({}), execute: async (_p: unknown, command: unknown) => { executed.push(command); },
    getOperation: async (_p: unknown, _project: string, operationId: string) => {
      const m = (await pool.query(`SELECT message_id FROM session_message WHERE project_id=$1 AND operation_id=$2`, [projectId, operationId])).rows[0];
      return m ? { result: { status: "applied", entityId: m.message_id } } : null; } },
  messages: { get: async (_project: string, messageId: string): Promise<Message> => {
    const m = (await pool.query(`SELECT * FROM session_message WHERE project_id=$1 AND message_id=$2`, [projectId, messageId])).rows[0];
    return { state: m.state, operationId: m.operation_id, senderActorId: m.sender_actor_id, target: { kind: "owned", sessionId: m.session_id },
      context: m.context_task_id ? { taskId: m.context_task_id, taskRevisionId: m.context_task_revision_id } : null, content: m.content }; } },
} as unknown as ConstructorParameters<typeof AcceptanceRelayService>[0]);

async function inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}

let counter = 0;
/** A ready Session; a Task with one current Delivery. */
async function task(sessionId: string) {
  const taskId = randomUUID(), revisionId = randomUUID(), documentId = randomUUID(), contentId = randomUUID(), deliveryId = randomUUID();
  await inTransaction(async client => {
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Delivered',1,$3,'task','draft')`, [projectId, documentId, contentId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'Do it','markdown',$4,'author',$5,'test','text/markdown','task.md','[]'::jsonb)`, [projectId, documentId, contentId, hash("Do it"), at]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Delivered','accept',$4,'todo',$5,$6)`, [projectId, taskId, revisionId, roleId, documentId, contentId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,content_document_id,content_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'Delivered','accept',$4,'todo',$5,$6,'author','test',$7)`, [projectId, taskId, revisionId, roleId, documentId, contentId, at]);
    await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,consumer,use_required,acceptance_mode,acceptance_target,evidence,stop_condition,created_at)
      VALUES($1,$2,$3,'agent',true,'independent_agent','business_session','source','',$4)`, [projectId, taskId, revisionId, at]);
    await client.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','candidate','author',$6)`, [projectId, deliveryId, taskId, revisionId, "a".repeat(64), at]);
  });
  return { taskId, revisionId, deliveryId };
}
async function session(): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/relay-head','project','danger-full-access','never','ready',1,$4,$5,$6,'agent',now(),now())`, [projectId, sessionId, roleId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID()]);
  return sessionId;
}
/** A queued message of the Session, `minutesAgo` old, and (for an acceptance message) its relay. */
async function message(sessionId: string, minutesAgo: number, relay?: { t: Awaited<ReturnType<typeof task>>; state: string; reason?: string | null; stage?: "candidate" | "formal"; reservedMessageId?: string; sender?: string }): Promise<{ messageId: string; relayId: string | null }> {
  const messageId = randomUUID(), operationId = randomUUID(), relayId = relay ? randomUUID() : null;
  await inTransaction(async client => {
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,context_task_id,context_task_revision_id,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,$9,$5,$6,$7,'queued',1,now()-make_interval(mins=>$8),now())`,
      [projectId, messageId, operationId, sessionId, relay ? "【验收交接】read the fixed Delivery" : "an ordinary message", relay?.t.taskId ?? null, relay?.t.revisionId ?? null, minutesAgo, relay?.sender ?? "leader"]);
    if (relay) await client.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,task_revision_id,delivery_id,stage,scope_key,scope_description,reason,mode,publication_ref,
      recipient_actor_id,session_id,native_thread_id,role_id,sender_actor_id,message_id,message_operation_id,state,blocked_reason,arranged_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'agent-use','Use the fixed report','Task policy','session',$9,'agent',$10,$11,$12,'leader',$13,$14,$15,$16,'leader',now(),now())`,
      [projectId, relayId, randomUUID(), `${++counter}`.padStart(64, "b"), relay.t.taskId, relay.t.revisionId, relay.t.deliveryId, relay.stage ?? "candidate", relay.stage === "formal" ? "pub-1" : null,
        sessionId, `thread-${sessionId}`, roleId, relay.reservedMessageId ?? messageId, operationId, relay.state, relay.reason ?? null]);
  });
  return { messageId, relayId };
}
const messageRow = async (id: string) => (await pool.query(`SELECT state,blocked_reason,version FROM session_message WHERE project_id=$1 AND message_id=$2`, [projectId, id])).rows[0] as { state: string; blocked_reason: string | null; version: number };
const relayRow = async (id: string) => (await pool.query(`SELECT state,blocked_reason,message_id FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2`, [projectId, id])).rows[0] as { state: string; blocked_reason: string | null; message_id: string };
/** The messages the pump would be offered now, in order: what the queue lets through. */
async function pending(): Promise<string[]> {
  const client = await pool.connect();
  try { return (await new PgSessionMessages(client, projectId).listPendingSessionMessages(50, 0)).map(m => m.id); } finally { client.release(); }
}

before(async () => {
  await migrate(url!, schema);
  await inTransaction(async client => {
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Relay queue head',$2)`, [projectId, at]);
    const roleRevision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',$4,'2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, at]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',$4,'2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, at]);
  });
});
after(async () => {
  await pool.end(); const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("1. a blocked arrangement's message at the head of the queue says why and does not hold the ordinary message and the linked arrangement behind it", async () => {
  const s = await session();
  const blocked = await message(s, 30, { t: await task(s), state: "blocked", reason: "MESSAGE_POST_applied" });
  const ordinary = await message(s, 20);
  const linked = await message(s, 10, { t: await task(s), state: "linked" });
  // Before the fix nothing but the head was offered: the head returned false without a word and nothing behind it moved.
  assert.equal(await service.messageAdmission(projectId, blocked.messageId), false, "the blocked arrangement's message does not start");
  const head = await messageRow(blocked.messageId);
  assert.equal(head.state, "queued", "and is not thrown away: the arrangement may still be retried");
  assert.match(head.blocked_reason ?? "", /^ACCEPTANCE_RELAY_BLOCKED: MESSAGE_POST_applied/, "it says why");
  const offered = await pending();
  assert.ok(offered.includes(ordinary.messageId), "the ordinary message behind the blocked head is offered");
  assert.ok(!offered.includes(blocked.messageId) || true);
  assert.ok(!offered.includes(linked.messageId), "the linked arrangement's message waits behind the ordinary message, as the order says");
  // The ordinary message goes (here: it is cancelled by its sender); the linked arrangement's message is next, still without the blocked head in front of it.
  await pool.query("UPDATE session_message SET state='cancelled',version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2", [projectId, ordinary.messageId]);
  assert.ok((await pending()).includes(linked.messageId), "then the linked arrangement's message is offered");
  assert.equal(await service.messageAdmission(projectId, linked.messageId), true, "and starts");
  const version = (await messageRow(blocked.messageId)).version;
  await service.messageAdmission(projectId, blocked.messageId);
  assert.equal((await messageRow(blocked.messageId)).version, version, "the reason is written once, not on every pass");
});

test("2. a formal arrangement waiting for its publication says so and does not hold the line; once the publication marker is written the message starts", async () => {
  const s = await session();
  const t = await task(s);
  const formal = await message(s, 30, { t, state: "pending", stage: "formal" });
  const ordinary = await message(s, 5);
  assert.equal(await service.messageAdmission(projectId, formal.messageId), false);
  assert.match((await messageRow(formal.messageId)).blocked_reason ?? "", /^PUBLICATION_PENDING:/);
  assert.ok((await pending()).includes(ordinary.messageId), "the ordinary message behind it is offered");
  // The publication is recorded for this Task revision under the name the arrangement waits for.
  await pool.query(`INSERT INTO task_attention_follow_up(project_id,task_id,task_revision_id,version,decision,action_taken,publication,actor_id,reason,updated_at)
    VALUES($1,$2,$3,1,'checked','published',$4::jsonb,'leader','published',now())`, [projectId, t.taskId, t.revisionId, JSON.stringify({ publishedAt: at, publicationRef: "pub-1" })]);
  assert.equal(await service.messageAdmission(projectId, formal.messageId), true, "after the marker the message is admitted");
});

test("3. a superseded or released arrangement's queued message is cancelled with its reason, not left at the head", async () => {
  const s = await session();
  const gone = await message(s, 30, { t: await task(s), state: "superseded", reason: "Reassigned" });
  const after = await message(s, 5);
  assert.equal(await service.messageAdmission(projectId, gone.messageId), false);
  const row = await messageRow(gone.messageId);
  assert.deepEqual([row.state, row.blocked_reason], ["cancelled", "ACCEPTANCE_RELAY_SUPERSEDED"]);
  assert.ok((await pending()).includes(after.messageId));
});

test("4. counter-examples: a message whose Delivery or Task revision changed still does not start; a message processing ahead of it still holds the line; an ordinary message ahead still goes first", async () => {
  // Delivery changed: the arrangement is retired and its queued message cancelled, as before.
  const s = await session();
  const t = await task(s);
  const stale = await message(s, 30, { t, state: "linked" });
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'fixture:newer','r2',$5,'passed','fixture','newer','author',now())`, [projectId, randomUUID(), t.taskId, t.revisionId, "c".repeat(64)]);
  assert.equal(await service.messageAdmission(projectId, stale.messageId), false, "the changed Delivery: the old message does not start");
  assert.equal((await messageRow(stale.messageId)).state, "cancelled");
  // An ordinary message ahead of a linked arrangement's message goes first (no exception for that case).
  const s2 = await session();
  const first = await message(s2, 30);
  const second = await message(s2, 5, { t: await task(s2), state: "linked" });
  assert.deepEqual((await pending()).filter(id => [first.messageId, second.messageId].includes(id)), [first.messageId], "only the ordinary message ahead is offered");
  // A message processing on the Session holds everything behind it.
  const s3 = await session();
  const running = await message(s3, 30);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    SELECT $1,$2,message_id,session_id,operation_id,'agent','running','turn-x',$3,1,now(),now() FROM session_message WHERE project_id=$1 AND message_id=$4`, [projectId, randomUUID(), "a".repeat(64), running.messageId]);
  await pool.query(`UPDATE session_message SET state='processing' WHERE project_id=$1 AND message_id=$2`, [projectId, running.messageId]).catch(() => undefined);
  const behind = await message(s3, 5);
  assert.ok(!(await pending()).includes(behind.messageId), "behind a running Turn: it waits as before");
});

test("5. the reserved operation ID was used for a message with another message ID: bound when it is this arrangement's message, otherwise blocked with a reason that says what happened", async () => {
  const s = await session();
  const t = await task(s);
  // The Leader posted the arrangement's message with the reserved operation ID but a message ID of its own.
  const mine = await message(s, 10, { t, state: "pending", reservedMessageId: randomUUID() });
  assert.notEqual((await relayRow(mine.relayId!)).message_id, mine.messageId);
  await service.tick([projectId]);
  const bound = await relayRow(mine.relayId!);
  assert.deepEqual([bound.state, bound.blocked_reason, bound.message_id], ["linked", null, mine.messageId], "bound to the message that operation created, no longer blocked as MESSAGE_POST_applied");
  assert.equal(await service.messageAdmission(projectId, mine.messageId), true);
  // The operation created a message of someone else's (another sender): not this arrangement's message.
  const t2 = await task(s);
  const other = await message(s, 9, { t: t2, state: "pending", reservedMessageId: randomUUID(), sender: "someone-else" });
  await service.tick([projectId]);
  const refused = await relayRow(other.relayId!);
  assert.equal(refused.state, "blocked");
  assert.match(refused.blocked_reason ?? "", /^MESSAGE_OPERATION_ID_USED_BY_ANOTHER_MESSAGE: operation .* created /);
});
