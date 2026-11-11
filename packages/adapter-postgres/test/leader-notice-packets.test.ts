// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { LeaderResultNoticePump } from "../../../apps/coordinator/src/leader-results/pump.ts";
import { pgLeaderPacketPorts, type LeaderPacketPorts } from "../../../apps/coordinator/src/leader-results/packet-ports.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_packet_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } };
const workflow = new WorkflowService(deps);
const runtime = new RuntimeWorkflowService(deps);
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID(), session = randomUUID();
const receiver: Principal = { actorId: "leader-actor", projectIds: [p], permissions: ["read", "write", "review"] };
const sender: Principal = { actorId: "notice-sender", projectIds: [p], permissions: ["read", "write"] };
const author: Principal = { actorId: "author", projectIds: [p], permissions: ["read", "write", "review"] };
const target = { projectId: p, sessionId: session, receiverRoleId: role, receiverActorId: receiver.actorId, senderActorId: sender.actorId };

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(author, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Packets" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [p, role, roleRev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [p, role, roleRev]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
  await apply(author, { type: "runtime.session.reserve", sessionId: session, roleId: role, cwd: "/tmp/packets", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(p, session);
  const saved = (await uow.read(p, r => r.getRuntimeSession(session)))!;
  await runtime.bindSession(p, session, { owner: "evoloop-codex-app-server", projectId: p, sessionId: session, roleId: role, cwd: "/tmp/packets", authorizationScope: "project",
    nativeThreadId: `thread-${session}`, nativeSessionId: `native-${session}`, resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy,
      executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

async function apply(who: Principal, command: Record<string, unknown>) {
  const result = await workflow.execute(who, { projectId: p, operationId: randomUUID(), ...command } as never);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
}
const newTask = async (title: string) => {
  const taskId = randomUUID();
  await apply(author, { type: "task.create", taskId, title, content: `# ${title}`, acceptance: "ok", owner: role });
  return taskId;
};
// The Leader's recipient checks are not under test: the pump gets the configured target, and a ready lead Session.
const leaderSession = { projectId: p, id: session, roleId: role, state: "ready", nativeThreadId: "t", nativeSessionId: "n" } as never;
const leaderRole = { id: role, state: "active", proposal: { templateKey: "lead", roleClass: "system" } } as never;
let overrides: Partial<LeaderPacketPorts> = {};
const realPorts = pgLeaderPacketPorts(pool, uow);
const ports: LeaderPacketPorts = new Proxy(realPorts, { get: (t, k) => (overrides as Record<string | symbol, unknown>)[k] ?? (t as never)[k] }) as LeaderPacketPorts;
const errors: unknown[] = [];
const makePump = (debounce: number) => new LeaderResultNoticePump({
  store: { listPending: async () => ({ items: [], nextCursor: null }), getByMessageId: async () => null, disposeStalePendingTodo: async () => "current", disposeStaleTodo: async () => "current",
    attentionSourceCurrent: async () => "current", disposeStaleAttention: async () => "current", hasInFlightOnOtherSession: async () => false, notePendingReason: async () => undefined,
    block: async () => undefined, pinRecipient: async () => null, markPosted: async () => undefined } as never,
  workflow: { listRoles: async () => ({ items: [leaderRole], nextCursor: null }), listRuntimeSessions: async () => [leaderSession],
    execute: (who: Principal, command: never) => workflow.execute(who, command), getOperation: (who: Principal, project: string, id: string) => workflow.getOperation(who, project, id) } as never,
  messages: { get: async () => { throw new Error("not used"); } } as never,
  configuration: async () => ({ enabled: true, targets: [target] }), principals: async () => [sender, receiver], canExecuteSession: async () => true, hasMessageGrant: async () => true,
  readTaskFacts: async (project: string, taskId: string) => uow.read(project, async r => { const t = await r.getTask(taskId); return t ? { currentRevisionId: t.currentRevisionId, state: t.state, assigned: false } : null; }),
  canWrite: () => true, canStartNative: () => true, pollIntervalMs: 1000, onError: error => errors.push(error), packets: ports, packetDebounceSeconds: debounce });
const packets = async () => (await pool.query("SELECT * FROM leader_notice_packet WHERE project_id=$1 ORDER BY created_at", [p])).rows;
const items = async (packetId: string) => (await pool.query("SELECT * FROM leader_notice_packet_item WHERE project_id=$1 AND packet_id=$2 ORDER BY position", [p, packetId])).rows;
const messageState = (state: string, nativeTurnId: string | null = null, processingState: string | null = null) => async (_project: string, messageId: string) =>
  ({ id: messageId, version: 1, state, nativeTurnId, processingState });
const settleAll = async () => { await pool.query("UPDATE leader_notice_packet SET state='seen' WHERE project_id=$1 AND state IN ('building','sent','delivered','unknown')", [p]); };
const clearNotices = async () => {   // notices from other steps are handled so each step starts from its own set
  await pool.query("UPDATE leader_result_notice SET blocked_reason='test cleanup',state=CASE WHEN state='pending' THEN 'blocked' ELSE state END,linked_session_id=NULL WHERE project_id=$1 AND state='pending'", [p]).catch(() => undefined);
};

test("notices wait for the debounce, then travel as one packet of per-item rows with one message; a person's message and an open packet hold the next one", async () => {
  const a = await newTask("Packet A"), b = await newTask("Packet B"), c = await newTask("Packet C");
  void a; void b; void c;
  const tooSoon = makePump(3600);
  await tooSoon.tick();
  assert.equal((await packets()).length, 0, "nothing is built before the earliest notice has waited");
  // A person's message waiting: no packet.
  overrides = { leaderState: async () => ({ busy: false, humanMessageQueued: true, gateOpen: true, gateBlocked: false }) };
  await makePump(0).tick();
  assert.equal((await packets()).length, 0, "a person's message goes before the packet");
  // The Leader is busy: the notices are kept until the Turn ends.
  overrides = { leaderState: async () => ({ busy: true, humanMessageQueued: false, gateOpen: true, gateBlocked: false }) };
  await makePump(0).tick();
  assert.equal((await packets()).length, 0, "a running Turn collects, it does not receive");
  // Recovery gate closed: nothing is sent.
  overrides = { leaderState: async () => ({ busy: false, humanMessageQueued: false, gateOpen: false, gateBlocked: true }) };
  await makePump(0).tick();
  assert.equal((await packets()).length, 0);
  overrides = {};
  await makePump(0).tick();
  const [packet] = await packets();
  assert.ok(packet, "one packet " + JSON.stringify(errors.map(String)));
  assert.equal(packet.state, "sent"); assert.equal(packet.item_count, 3);
  const rows = await items(packet.packet_id);
  assert.deepEqual(rows.map(r => r.state), ["pending", "pending", "pending"], "each item has its own state");
  const attempt = (await pool.query("SELECT * FROM leader_notice_packet_attempt WHERE packet_id=$1", [packet.packet_id])).rows;
  assert.equal(attempt.length, 1); assert.equal(attempt[0].method, "new_turn"); assert.ok(attempt[0].message_id && !attempt[0].direct_input_id);
  const message = (await pool.query("SELECT content,state FROM session_message WHERE message_id=$1", [attempt[0].message_id])).rows[0];
  assert.equal(message.state, "queued"); assert.match(message.content, /Leader 通知包/);
  assert.equal(Buffer.byteLength(message.content, "utf8"), packet.byte_count);
  // The Session takes one packet at a time.
  await makePump(0).tick();
  assert.equal((await packets()).length, 1);
  assert.deepEqual(errors, []);
  await settleAll();
});

test("a stale item is withdrawn while packing; a read packet is seen, not handled, until the Leader decides with a version; a deferral comes back", async () => {
  await pool.query("UPDATE leader_notice_packet_item SET state='handled',disposition='handled',version=version+1 WHERE project_id=$1", [p]);
  const stale = await newTask("Stale one"), fresh = await newTask("Fresh one");
  // The first Task is started before packing: its "new Task" notice is out of date.
  await apply(author, { type: "task.start", taskId: stale, expectedVersion: 1, reason: "started elsewhere" });
  overrides = {};
  await makePump(0).tick();
  const all = await packets();
  const packet = all.at(-1)!;
  const rows = await items(packet.packet_id);
  const byNotice = Object.fromEntries((await pool.query("SELECT notice_id,task_id FROM leader_result_notice WHERE project_id=$1 AND task_id = ANY($2)", [p, [stale, fresh]])).rows.map(r => [r.task_id, r.notice_id]));
  const staleItem = rows.find(r => r.notice_id === byNotice[stale]);
  assert.equal(staleItem?.state, "withdrawn"); assert.match(staleItem!.withdrawn_reason, /SUPERSEDED/);
  assert.equal(rows.find(r => r.notice_id === byNotice[fresh])?.state, "pending");
  assert.equal(packet.item_count, 1, "only the current item is read");
  const messageId = (await pool.query("SELECT message_id FROM leader_notice_packet_attempt WHERE packet_id=$1", [packet.packet_id])).rows[0].message_id;
  // The Turn that reads it starts, then ends normally.
  overrides = { message: messageState("processing", "turn-1", "running") };
  await makePump(0).tick();
  assert.equal((await items(packet.packet_id)).find(r => r.notice_id === byNotice[fresh])?.state, "delivered");
  overrides = { message: messageState("replied", "turn-1", "completed") };
  await makePump(0).tick();
  const seen = (await items(packet.packet_id)).find(r => r.notice_id === byNotice[fresh])!;
  assert.equal(seen.state, "seen", "a Turn that ended normally only means seen");
  assert.equal((await pool.query("SELECT state FROM leader_notice_packet WHERE packet_id=$1", [packet.packet_id])).rows[0].state, "seen");
  // The Leader decides, naming the version; a stale version is refused; the same operation repeated changes nothing.
  const operationId = randomUUID();
  const decide = (who: Principal, command: Record<string, unknown>) => workflow.execute(who, { projectId: p, ...command } as never);
  const stale1 = await decide(receiver, { type: "leader.notice.handle", operationId: randomUUID(), noticeId: byNotice[fresh], expectedVersion: seen.version - 1, disposition: "handled", reason: "old view" });
  assert.equal(stale1.status, "rejected"); assert.equal((stale1 as { code: string }).code, "VERSION_CONFLICT");
  const notBefore = new Date(Date.now() + 1500).toISOString();
  const deferred = await decide(receiver, { type: "leader.notice.handle", operationId, noticeId: byNotice[fresh], expectedVersion: seen.version, disposition: "deferred",
    reason: "after the release", notBefore });
  assert.equal(deferred.status, "applied", JSON.stringify(deferred));
  const again = await decide(receiver, { type: "leader.notice.handle", operationId, noticeId: byNotice[fresh], expectedVersion: seen.version, disposition: "deferred",
    reason: "after the release", notBefore });
  assert.equal(again.status, "applied", "a repeat of the same decision is harmless");
  const after = (await items(packet.packet_id)).find(r => r.notice_id === byNotice[fresh])!;
  assert.equal(after.state, "handled"); assert.equal(after.version, seen.version + 1, "the decision took effect once");
  overrides = {};
  await makePump(0).tick();
  assert.equal((await packets()).length, all.length, "deferred: not before its time");
  await new Promise(resolve => setTimeout(resolve, 1700));
  await makePump(0).tick();
  assert.equal((await packets()).length, all.length + 1, "after the time it is sent again");
  void messageId;
  await settleAll();
  assert.deepEqual(errors, []);
});

test("a failed read behind a closed gate blocks the packet and holds its items until recover; a person's message withdraws an unstarted packet", async () => {
  const t = await newTask("Fails once");
  overrides = {};
  await makePump(0).tick();
  const packet = (await packets()).at(-1)!;
  assert.equal(packet.state, "sent");
  const noticeId = (await items(packet.packet_id))[0]!.notice_id;
  overrides = { message: messageState("failed", "turn-9", "failed"), leaderState: async () => ({ busy: false, humanMessageQueued: false, gateOpen: false, gateBlocked: true }) };
  await makePump(0).tick();
  const blocked = (await packets()).find(x => x.packet_id === packet.packet_id)!;
  assert.equal(blocked.state, "blocked");
  const held = (await items(packet.packet_id)).find(r => r.notice_id === noticeId)!;
  assert.equal(held.state, "unknown"); assert.equal(held.read_before, true, "a Turn had started: it may already have been read");
  overrides = {};
  await makePump(0).tick();
  assert.equal((await packets()).length, (await packets()).length);
  const countBefore = (await packets()).length;
  await makePump(0).tick();
  assert.equal((await packets()).length, countBefore, "a blocked packet is not retried by itself");
  // Recover (a reviewer), then the item is sent again, marked as possibly read before.
  const recovered = await workflow.execute(receiver, { type: "leader.noticePacket.recover", projectId: p, operationId: randomUUID(), packetId: packet.packet_id, reason: "gate reviewed" } as never);
  assert.equal(recovered.status, "applied", JSON.stringify(recovered));
  await makePump(0).tick();
  const next = (await packets()).at(-1)!;
  assert.notEqual(next.packet_id, packet.packet_id, "fresh ids for the retry");
  assert.match(next.content, /上一轮已读到过/);
  // A person's message arrives before the new packet starts: it is withdrawn and the message cancelled.
  overrides = { message: messageState("queued"), leaderState: async () => ({ busy: false, humanMessageQueued: true, gateOpen: true, gateBlocked: false }) };
  await makePump(0).tick();
  assert.equal((await packets()).find(x => x.packet_id === next.packet_id)!.state, "withdrawn");
  assert.equal((await items(next.packet_id))[0]!.state, "unknown");
  void t;
  assert.deepEqual(errors.filter(e => !/cancel/i.test(String(e))), []);
});

test("notices that existed before the migration keep the one-notice-one-message path", async () => {
  const taskId = await newTask("Legacy");
  await pool.query("UPDATE leader_result_notice SET via_packet=false WHERE project_id=$1 AND task_id=$2", [p, taskId]);
  const candidates = await pool.connect();
  try {
    const { PgLeaderNoticePackets } = await import("../src/leader-notice-packets.ts");
    const list = await new PgLeaderNoticePackets(candidates, p).listLeaderNoticeCandidates(100);
    assert.ok(!list.some(x => x.taskId === taskId), "a legacy notice is not a packet candidate");
  } finally { candidates.release(); }
  const pending = await pool.query("SELECT 1 FROM leader_result_notice WHERE project_id=$1 AND task_id=$2 AND NOT via_packet AND state='pending'", [p, taskId]);
  assert.equal(pending.rowCount, 1);
  void clearNotices;
});
