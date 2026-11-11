// A Leader who sends the arrangement's message itself, with the IDs the arrangement reserved, must not strand the
// relay in MESSAGE_BINDING_CHANGED. The saved message binds by sender, Session and Task revision, not by wording.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate } from "../src/index.ts";
import { AcceptanceRelayService } from "../../../apps/coordinator/src/acceptance-relay/service.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Acceptance relay binding tests require a dedicated evoloop test database");
const schema = `el_relay_binding_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), roleId = randomUUID(), at = "2026-11-06T00:00:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const executed: unknown[] = [];

type Message = { state: string; operationId: string; senderActorId: string; target: { kind: "owned"; sessionId: string };
  context: { taskId: string; taskRevisionId: string } | null; content: string };
const service = new AcceptanceRelayService({ pool, canWrite: () => true, leaderSession: async () => null, qualify: async () => null, capabilities: async () => [],
  principals: async () => [{ actorId: "leader", projectIds: [projectId], permissions: ["read", "write", "review"] }],
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
/** A Task with one current Delivery, a ready Session, a relay, and the message saved under the relay's reserved IDs. */
async function arrangement(over: { state?: "pending" | "blocked"; blockedReason?: string | null; content?: string; sender?: string; contextRevision?: "other" | null } = {}) {
  const taskId = randomUUID(), revisionId = randomUUID(), documentId = randomUUID(), contentId = randomUUID(), deliveryId = randomUUID();
  const sessionId = randomUUID(), messageId = randomUUID(), messageOperationId = randomUUID(), relayId = randomUUID();
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
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/relay-binding','project','danger-full-access','never','ready',1,$4,$5,$6,'agent',now(),now())`,
      [projectId, sessionId, roleId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID()]);
    // The message exists first, as when the Leader posts it with the reserved IDs before the relay's own dispatch.
    const otherRevision = over.contextRevision === "other" ? randomUUID() : revisionId;
    if (over.contextRevision === "other") await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,content_document_id,content_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,2,'Delivered','accept',$4,'todo',$5,$6,'author','test',$7)`, [projectId, taskId, otherRevision, roleId, documentId, contentId, at]);
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,context_task_id,context_task_revision_id,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,$5,$6,$7,$8,'queued',1,now(),now())`,
      [projectId, messageId, messageOperationId, sessionId, over.sender ?? "leader", over.content ?? "【验收交接】详细说明：先读固定 Delivery，再按声明范围使用。", taskId, otherRevision]);
    await client.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,task_revision_id,delivery_id,stage,scope_key,scope_description,reason,mode,
      recipient_actor_id,session_id,native_thread_id,role_id,sender_actor_id,message_id,message_operation_id,state,blocked_reason,arranged_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'candidate','agent-use','Use the fixed report','Task policy','session','agent',$8,$9,$10,'leader',$11,$12,$13,$14,'leader',now(),now())`,
      [projectId, relayId, randomUUID(), "b".repeat(64), taskId, revisionId, deliveryId, sessionId, `thread-${sessionId}`, roleId, messageId, messageOperationId,
        over.state ?? "pending", over.blockedReason ?? null]);
  });
  return { relayId, messageId, taskId };
}
const relayRow = async (relayId: string) => (await pool.query(`SELECT state,blocked_reason,version FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2`, [projectId, relayId])).rows[0] as
  { state: string; blocked_reason: string | null; version: number };

before(async () => {
  await migrate(url!, schema);
  await inTransaction(async client => {
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Relay binding',$2)`, [projectId, at]);
    const roleRevision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',$4,'2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, at]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',$4,'2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, at]);
  });
});
after(async () => {
  await pool.end(); const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("a message the arranger wrote with the reserved IDs links the arrangement, is admitted, and is never rewritten", async () => {
  const item = await arrangement();
  executed.length = 0;
  assert.equal(await service.messageAdmission(projectId, item.messageId), true, "the saved message is admitted for delivery as written");
  await service.tick([projectId]);
  const after = await relayRow(item.relayId);
  assert.deepEqual([after.state, after.blocked_reason], ["linked", null]);
  assert.equal(executed.length, 0, "the relay did not post a second message with the reserved IDs");
  const saved = (await pool.query(`SELECT content FROM session_message WHERE project_id=$1 AND message_id=$2`, [projectId, item.messageId])).rows[0];
  assert.match(saved.content, /^【验收交接】/, "the arranger's text is kept");
});

test("a relay already blocked as MESSAGE_BINDING_CHANGED by wording alone is linked again by the next tick", async () => {
  const item = await arrangement({ state: "blocked", blockedReason: "MESSAGE_BINDING_CHANGED" });
  await service.tick([projectId]);
  assert.deepEqual(Object.values({ ...await relayRow(item.relayId), version: 0 }).slice(0, 2), ["linked", null]);
  // A linked arrangement is left alone afterwards.
  const linked = await relayRow(item.relayId);
  await service.tick([projectId]);
  assert.equal((await relayRow(item.relayId)).version, linked.version);
});

test("the template's own message still links; a message from another sender or for another Task revision still blocks, once, without churn", async () => {
  const own = await arrangement({ content: "验收接力 candidate / agent-use" });
  await service.tick([projectId]);
  assert.equal((await relayRow(own.relayId)).state, "linked");

  const wrongSender = await arrangement({ sender: "someone-else" });
  await service.tick([projectId]);
  const blocked = await relayRow(wrongSender.relayId);
  assert.deepEqual([blocked.state, blocked.blocked_reason], ["blocked", "MESSAGE_BINDING_CHANGED"]);
  for (let round = 0; round < 3; round++) await service.tick([projectId]);
  assert.deepEqual(await relayRow(wrongSender.relayId), blocked, "a relay that still cannot link is not rewritten on every tick");
  assert.equal(await service.messageAdmission(projectId, wrongSender.messageId), false);

  const otherRevision = await arrangement({ contextRevision: "other" });
  await service.tick([projectId]);
  const stale = await relayRow(otherRevision.relayId);
  assert.deepEqual([stale.state, stale.blocked_reason], ["blocked", "MESSAGE_BINDING_CHANGED"]);

  // A blocked relay of another kind is not picked up by the retry.
  const failed = await arrangement({ state: "blocked", blockedReason: "MESSAGE_POST_REJECTED" });
  const before = await relayRow(failed.relayId);
  await service.tick([projectId]);
  assert.deepEqual(await relayRow(failed.relayId), before);
});
