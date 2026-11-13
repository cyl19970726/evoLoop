// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { getLeaderNotice } from "../src/leader-result-notices.ts";
import { LeaderResultNoticePump, type LeaderResultNoticeConfig } from "../../../apps/coordinator/src/leader-results/pump.ts";
import { pgLeaderPacketPorts, type LeaderPacketPorts } from "../../../apps/coordinator/src/leader-results/packet-ports.ts";
import { SessionMessagePump } from "../../../apps/coordinator/src/session-messages/pump.ts";
import { createLeaderWorkIndexReader } from "../../../apps/coordinator/src/work-management/work-index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_packet_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID(), sessionA = randomUUID(), sessionB = randomUUID();
const receiver: Principal = { actorId: "leader-actor", projectIds: [p], permissions: ["read", "write", "review"] };
const sender: Principal = { actorId: "notice-sender", projectIds: [p], permissions: ["read", "write"] };
const author: Principal = { actorId: "author", projectIds: [p], permissions: ["read", "write", "review"] };
const human: Principal = { actorId: "human-actor", projectIds: [p], permissions: ["read", "write"] };
// Only the configured notice sender may run the packet's own steps.
const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash }, leaderNoticeServiceActor: async () => sender.actorId };
const workflow = new WorkflowService(deps);
const runtime = new RuntimeWorkflowService(deps);
const sessionTarget = (sessionId: string) => ({ projectId: p, sessionId, receiverRoleId: role, receiverActorId: receiver.actorId, senderActorId: sender.actorId });
let config: LeaderResultNoticeConfig = { enabled: true, packets: true, targets: [sessionTarget(sessionA)] };

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
  for (const session of [sessionA, sessionB]) {
    await apply(author, { type: "runtime.session.reserve", sessionId: session, roleId: role, cwd: "/tmp/packets", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
    await runtime.beginSessionCreate(p, session);
    const saved = (await uow.read(p, r => r.getRuntimeSession(session)))!;
    await runtime.bindSession(p, session, { owner: "evoloop-codex-app-server", projectId: p, sessionId: session, roleId: role, cwd: "/tmp/packets", authorizationScope: "project",
      nativeThreadId: `thread-${session}`, nativeSessionId: `native-${session}`, resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy,
        executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  }
  // The packet switch is on for this project: new notices travel in packets.
  await pool.query("INSERT INTO leader_notice_packet_mode(project_id,enabled) VALUES($1,true)", [p]);
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
const noticeOf = async (taskId: string) => String((await pool.query("SELECT notice_id FROM leader_result_notice WHERE project_id=$1 AND task_id=$2 ORDER BY occurred_at DESC LIMIT 1", [p, taskId])).rows[0].notice_id);

// ---- the real session message pump over the real message service, with a scripted native runtime ----
const messageService = new SessionMessageService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
  grantFor: async (message, session) => ({ enabled: true, projectId: p, sessionId: session.id, senderActorId: message.senderActorId, receiverActorId: receiver.actorId,
    receiverRoleId: session.roleId, cwd: session.cwd, maxTurns: 1000 }) as never });
const turns = new Map<string, { id: string; status: string; completedAtUtc: string | null }>();
const started: string[] = [];
const fakeRuntime = {
  isReady: () => true, registerBinding: async () => undefined, markReadOnlyThread: () => undefined,
  qualifyConversationThread: async () => ({ available: true, reason: "ok", fingerprint: "a".repeat(64) }),
  startConversationTurn: async (_binding: unknown, input: string) => { const id = `turn-${turns.size + 1}`; turns.set(id, { id, status: "inProgress", completedAtUtc: null }); started.push(input); return turns.get(id)!; },
  listTurns: async () => ({ data: [...turns.values()].reverse(), nextCursor: null }),
  listItems: async (_binding: unknown, turnId: string) => ({ data: turns.get(turnId)?.completedAtUtc ? [{ id: `a-${turnId}`, type: "agentMessage", phase: "final_answer", text: "done" }] : [], nextCursor: null }),
};
const finishTurn = (id: string, status = "completed") => { const t = turns.get(id)!; t.status = status; t.completedAtUtc = new Date().toISOString(); };
const errors: unknown[] = [];
let overrides: Partial<LeaderPacketPorts> = {};
const realPorts = pgLeaderPacketPorts(pool, uow);
const ports: LeaderPacketPorts = new Proxy(realPorts, { get: (t, k) => (overrides as Record<string | symbol, unknown>)[k] ?? (t as never)[k] }) as LeaderPacketPorts;
let beforeExecute: ((command: Record<string, unknown>) => Promise<void>) | null = null;
const currentSession = () => config.targets[0]!.sessionId;
const leaderSessionRecord = (id: string) => ({ projectId: p, id, roleId: role, state: "ready", nativeThreadId: "t", nativeSessionId: "n" }) as never;
const leaderRole = { id: role, state: "active", proposal: { templateKey: "lead", roleClass: "system" } } as never;
const principals = [sender, receiver];
const makePump = (debounce: number) => new LeaderResultNoticePump({
  store: { listPending: async () => ({ items: [], nextCursor: null }), getByMessageId: async () => null, disposeStalePendingTodo: async () => "current", disposeStaleTodo: async () => "current",
    attentionSourceCurrent: async () => "current", disposeStaleAttention: async () => "current", hasInFlightOnOtherSession: async () => false, notePendingReason: async () => undefined,
    block: async () => undefined, pinRecipient: async () => null, markPosted: async () => undefined } as never,
  workflow: { listRoles: async () => ({ items: [leaderRole], nextCursor: null }), listRuntimeSessions: async () => [leaderSessionRecord(currentSession())],
    execute: async (who: Principal, command: never) => { await beforeExecute?.(command as Record<string, unknown>); return workflow.execute(who, command); },
    getOperation: (who: Principal, project: string, id: string) => workflow.getOperation(who, project, id) } as never,
  messages: { get: async () => { throw new Error("not used"); } } as never,
  configuration: async () => config, principals: async () => principals, canExecuteSession: async () => true, hasMessageGrant: async () => true,
  readTaskFacts: async (project: string, taskId: string) => uow.read(project, async r => { const t = await r.getTask(taskId); return t ? { currentRevisionId: t.currentRevisionId, state: t.state, assigned: false } : null; }),
  canWrite: () => true, canStartNative: () => true, pollIntervalMs: 1000, onError: error => errors.push(error), packets: ports, packetDebounceSeconds: debounce });
const noticePump = makePump(0);
// The same wiring main.ts gives the message pump: the notice pump decides whether a queued message may start.
const messagePump = new SessionMessagePump({ service: messageService, runtime: () => fakeRuntime as never, projects: async () => [p],
  beforePreflight: async message => { const a = await noticePump.messageAdmission(message); if (!a.allowed && a.reason) await messageService.noteBlocked(message.projectId, message.id, a.reason); return a.allowed; },
  canStart: async message => { const a = await noticePump.messageAdmission(message); if (!a.allowed && a.reason) await messageService.noteBlocked(message.projectId, message.id, a.reason); return a.allowed; },
  canWrite: () => true, pollIntervalMs: 1000, onError: error => errors.push(error) });
const settleAndPump = async () => { await messagePump.tick(); await noticePump.tick(); };

const packets = async () => (await pool.query("SELECT * FROM leader_notice_packet WHERE project_id=$1 ORDER BY created_at, packet_id", [p])).rows;
const lastPacket = async () => (await packets()).at(-1)!;
const packetRow = async (id: string) => (await pool.query("SELECT * FROM leader_notice_packet WHERE packet_id=$1", [id])).rows[0];
const items = async (packetId: string) => (await pool.query("SELECT * FROM leader_notice_packet_item WHERE project_id=$1 AND packet_id=$2 ORDER BY position", [p, packetId])).rows;
const attemptMessage = async (packetId: string) => String((await pool.query("SELECT message_id FROM leader_notice_packet_attempt WHERE packet_id=$1", [packetId])).rows[0].message_id);
const messageRow = async (id: string) => (await pool.query("SELECT state,blocked_reason,version FROM session_message WHERE message_id=$1", [id])).rows[0];
const humanPost = async (text: string, sessionId = currentSession()) => {
  const messageId = randomUUID();
  await apply(human, { type: "session.message.post", messageId, target: { kind: "owned", sessionId }, content: text });
  return messageId;
};
/** Every step starts from an empty line: open packets settled, notices handled, queued messages cancelled, the Leader idle. */
const reset = async () => {
  config = { enabled: true, packets: true, targets: [sessionTarget(sessionA)] };
  overrides = {}; beforeExecute = null; errors.length = 0;
  await pool.query("UPDATE leader_notice_packet SET state='seen',ended_at=COALESCE(ended_at,now()) WHERE project_id=$1 AND state IN ('building','sent','delivered','unknown','blocked')", [p]);
  await pool.query(`UPDATE leader_notice_packet_item SET state='handled',disposition='handled',handled_by='reset',version=version+1 WHERE project_id=$1 AND state IN ('pending','delivered','seen','unknown')`, [p]);
  await pool.query("UPDATE leader_result_notice SET state='blocked',blocked_reason='reset' WHERE project_id=$1 AND state='pending'", [p]);
  await pool.query("ALTER TABLE session_message DISABLE TRIGGER USER");
  await pool.query("UPDATE session_message SET state='cancelled',version=version+1 WHERE project_id=$1 AND state='queued'", [p]);
  await pool.query("ALTER TABLE session_message ENABLE TRIGGER USER");
  await pool.query("UPDATE session_message_processing SET state='completed' WHERE project_id=$1 AND state IN ('dispatching','running','unknown')", [p]);
  await pool.query("DELETE FROM session_recovery_gate WHERE project_id=$1", [p]).catch(() => undefined);
  await pool.query("INSERT INTO session_recovery_gate(project_id,session_id,version,phase,updated_at) SELECT $1,session_id,1,'open',now() FROM runtime_session WHERE project_id=$1 ON CONFLICT DO NOTHING", [p]).catch(() => undefined);
};

test("notices wait for the debounce; a running Leader Turn collects them; then one packet with per-item rows and one message; the real message pump starts it and the item states follow", async () => {
  await reset();
  const a = await newTask("Packet A"), b = await newTask("Packet B"), c = await newTask("Packet C");
  void a; void b; void c;
  const tooSoon = makePump(3600);
  await tooSoon.tick();
  assert.equal((await packets()).length, 0, "nothing is built before the earliest notice has waited");
  // The Leader is busy with a person's message (a real Turn the real pump started): the notices are collected until it ends.
  const h1 = await humanPost("Leader, a question");
  await messagePump.tick();
  assert.equal(started.length, 1, "the person's message started a Turn");
  assert.equal((await messageRow(h1)).state, "processing");
  await noticePump.tick();
  assert.equal((await packets()).length, 0, "a running Turn collects, it does not receive");
  // Recovery gate closed: nothing is sent.
  overrides = { leaderState: async () => ({ busy: false, humanMessageQueued: false, gateOpen: false, gateBlocked: true }) };
  await noticePump.tick();
  assert.equal((await packets()).length, 0);
  overrides = {};
  finishTurn("turn-1");
  await messagePump.tick();
  assert.equal((await messageRow(h1)).state, "replied");
  await noticePump.tick();
  const packet = await lastPacket();
  assert.equal(packet.state, "sent"); assert.equal(packet.item_count, 3);
  assert.deepEqual((await items(packet.packet_id)).map(r => r.state), ["pending", "pending", "pending"], "each item has its own state");
  const attempts = (await pool.query("SELECT * FROM leader_notice_packet_attempt WHERE packet_id=$1", [packet.packet_id])).rows;
  assert.equal(attempts.length, 1); assert.equal(attempts[0].method, "new_turn"); assert.ok(attempts[0].message_id && !attempts[0].direct_input_id);
  const message = (await pool.query("SELECT content,state FROM session_message WHERE message_id=$1", [attempts[0].message_id])).rows[0];
  assert.equal(message.state, "queued"); assert.match(message.content, /Leader 通知包/);
  assert.ok(Buffer.byteLength(message.content, "utf8") <= 8192);
  assert.equal(Buffer.byteLength(message.content, "utf8"), packet.byte_count);
  await noticePump.tick();
  assert.equal((await packets()).length, 1, "the Session takes one packet at a time");
  // The real pump starts the packet message; the Turn that reads it is "delivered", its normal end is only "seen".
  await messagePump.tick();
  assert.equal(started.length, 2);
  await noticePump.tick();
  assert.deepEqual((await items(packet.packet_id)).map(r => r.state), ["delivered", "delivered", "delivered"]);
  finishTurn("turn-2");
  await settleAndPump();
  assert.deepEqual((await items(packet.packet_id)).map(r => r.state), ["seen", "seen", "seen"], "a Turn that ended normally only means seen");
  assert.equal((await packetRow(packet.packet_id)).state, "seen");
  assert.deepEqual(errors, []);
});

test("a person's message goes first: the real pump will not start the packet message, the packet pump cancels it for real and withdraws the packet; the person's message then starts", async () => {
  await reset();
  const t = await newTask("Gives way");
  await noticePump.tick();
  const packet = await lastPacket();
  assert.equal(packet.state, "sent");
  const messageId = await attemptMessage(packet.packet_id);
  const h = await humanPost("A person writes after the packet message was queued");
  const before = started.length;
  await messagePump.tick();
  assert.equal(started.length, before, "the packet message waits for the person's message, and the person's message waits behind it in the queue");
  assert.equal((await messageRow(messageId)).state, "queued");
  await noticePump.tick();
  assert.equal((await messageRow(messageId)).state, "cancelled", "the packet message was really cancelled");
  assert.equal((await packetRow(packet.packet_id)).state, "withdrawn");
  const rows = await items(packet.packet_id);
  assert.equal(rows[0]!.state, "unknown"); assert.equal(rows[0]!.requeue, true); assert.equal(rows[0]!.read_before, false, "nothing was read");
  await messagePump.tick();
  assert.equal(started.length, before + 1, "the person's message now starts");
  assert.equal((await messageRow(h)).state, "processing");
  finishTurn(`turn-${turns.size}`);
  await settleAndPump();
  // The withdrawn item comes back in the next packet.
  const next = await lastPacket();
  assert.notEqual(next.packet_id, packet.packet_id);
  assert.ok((await items(next.packet_id)).some(r => r.notice_id === rows[0]!.notice_id), "the withdrawn notice travels in the next packet");
  assert.deepEqual(errors, [], "no error was filtered out");
  void t;
});

test("a refused cancel does not withdraw the packet: the message's own state decides, and a packet whose message really started keeps its read mark", async () => {
  await reset();
  await newTask("Cancel race");
  await noticePump.tick();
  const packet = await lastPacket();
  const messageId = await attemptMessage(packet.packet_id);
  const h = await humanPost("A person writes");
  // Between the pump's read and its cancel the message starts (the person's message is gone), so the cancel is refused for real.
  beforeExecute = async command => {
    if (command.type !== "session.message.cancel") return;
    beforeExecute = null;
    await workflow.execute(human, { type: "session.message.cancel", projectId: p, operationId: randomUUID(), messageId: h, expectedVersion: (await messageRow(h)).version, reason: "the person withdrew it" } as never);
    await messagePump.tick();
  };
  await noticePump.tick();
  assert.notEqual((await packetRow(packet.packet_id)).state, "withdrawn", "a refused cancel is not a withdrawal");
  assert.equal((await messageRow(messageId)).state, "processing");
  assert.deepEqual((await items(packet.packet_id)).map(r => r.state), ["pending"]);
  await noticePump.tick();
  assert.deepEqual((await items(packet.packet_id)).map(r => r.state), ["delivered"], "the actual state of the message decides");
  // Its Turn fails: the item may have been read.
  finishTurn(`turn-${turns.size}`, "failed");
  await settleAndPump();
  const row = (await items(packet.packet_id))[0]!;
  assert.equal(row.state, "unknown"); assert.equal(row.read_before, true);
  assert.deepEqual(errors.filter(e => !/cancel|MESSAGE_NOT_PENDING|VERSION_CONFLICT/i.test(String(e))), []);
});

test("20 items at most and 8 KB at most: more candidates wait for the next packet; stale items in front never hide later ones; all stale ones are withdrawn", async () => {
  await reset();
  const stale: string[] = [], fresh: string[] = [];
  for (let i = 0; i < 55; i++) stale.push(await newTask(`Stale ${i}`));
  for (let i = 0; i < 25; i++) fresh.push(await newTask(`Fresh ${i}`));
  for (const taskId of stale) await apply(author, { type: "task.start", taskId, expectedVersion: 1, reason: "started elsewhere" });
  await noticePump.tick();
  const withdrawn = (await pool.query(`SELECT count(*)::int AS n FROM leader_notice_packet_item i JOIN leader_result_notice n ON n.project_id=i.project_id AND n.notice_id=i.notice_id
    WHERE i.project_id=$1 AND i.state='withdrawn' AND n.task_id = ANY($2)`, [p, stale])).rows[0].n;
  assert.equal(withdrawn, 55, "stale notices in front of the line were all withdrawn, even though more than one page of them came first");
  const packet = (await packets()).filter(x => x.state === "sent").at(-1)!;
  assert.equal(packet.item_count, 20, "at most 20 items");
  assert.ok(packet.byte_count <= 8192, `at most 8 KB: ${packet.byte_count}`);
  const content = String(packet.content);
  for (const row of await items(packet.packet_id)) assert.ok(content.includes(row.notice_id), "every item is named at least by its id");
  // The other five go in the next packet.
  await pool.query("UPDATE leader_notice_packet SET state='seen',ended_at=now() WHERE packet_id=$1", [packet.packet_id]);
  await pool.query("UPDATE leader_notice_packet_item SET state='handled',disposition='handled',handled_by='t',version=version+1 WHERE packet_id=$1", [packet.packet_id]);
  await pool.query("ALTER TABLE session_message DISABLE TRIGGER USER");
  await pool.query("UPDATE session_message SET state='cancelled',version=version+1 WHERE project_id=$1 AND state='queued'", [p]);
  await pool.query("ALTER TABLE session_message ENABLE TRIGGER USER");
  await noticePump.tick();
  const next = (await packets()).filter(x => x.state === "sent").at(-1)!;
  assert.equal(next.item_count, 5);
  assert.equal(new Set([...(await items(packet.packet_id)), ...(await items(next.packet_id))].map(r => r.notice_id)).size, 25);
  assert.deepEqual(errors, []);
});

test("a todo withdrawn as out of date is replaced by a notice for the current revision, which then travels in a packet", async () => {
  await reset();
  const taskId = await newTask("Revised before it is read");
  const first = await noticeOf(taskId);
  await apply(author, { type: "task.update", taskId, expectedVersion: 1, title: "Revised", content: "# Revised", acceptance: "ok", owner: role, reason: "clarified" });
  await noticePump.tick();
  const old = (await pool.query("SELECT * FROM leader_notice_packet_item WHERE project_id=$1 AND notice_id=$2", [p, first])).rows[0];
  assert.equal(old.state, "withdrawn"); assert.match(old.withdrawn_reason, /SUPERSEDED_REFRESHED/);
  const second = await noticeOf(taskId);
  assert.notEqual(second, first, "a notice for the current revision was queued");
  assert.equal((await pool.query("SELECT via_packet FROM leader_result_notice WHERE notice_id=$1", [second])).rows[0].via_packet, true);
  await noticePump.tick();
  const packet = await lastPacket();
  assert.ok((await items(packet.packet_id)).some(r => r.notice_id === second && r.state === "pending"), "the current notice is sent");
  assert.deepEqual(errors, []);
});

test("one that cannot start never stops the packets: a message blocked for want of its sender's grant, or superseded and unconfirmed, is not waiting", async () => {
  await reset();
  await newTask("Not held back");
  const grantless = await humanPost("No grant for this sender");
  await pool.query("UPDATE session_message SET blocked_reason='MESSAGE_GRANT_MISSING: exact grant unavailable',version=version+1 WHERE message_id=$1", [grantless]);
  const superseded = await humanPost("Superseded by a Run stop");
  await pool.query("UPDATE session_message SET superseded_at=now(),superseded_by_run=$2,blocked_reason='SUPERSEDED: stopped',version=version+1 WHERE message_id=$1", [superseded, randomUUID()]);
  assert.equal((await realPorts.leaderState(p, sessionA)).humanMessageQueued, false, "both are skipped by the message pump, so neither is waiting");
  await noticePump.tick();
  assert.equal((await lastPacket()).state, "sent", "the packet was built");
  // A person's message that can start does hold it back.
  await reset();
  await newTask("Held back");
  await humanPost("This one can start");
  const count = (await packets()).length;
  await noticePump.tick();
  assert.equal((await packets()).length, count);
  assert.deepEqual(errors, []);
});

test("restart in the middle: a built packet whose message was never posted is posted once with the same ids; a posted one whose record is missing is only recorded", async () => {
  await reset();
  await newTask("Crash before post");
  beforeExecute = async command => { if (command.type === "session.message.post") { beforeExecute = null; throw new Error("crash before the post"); } };
  await noticePump.tick();
  const building = await lastPacket();
  assert.equal(building.state, "building");
  assert.equal((await pool.query("SELECT 1 FROM session_message WHERE message_id=$1", [building.message_id])).rowCount, 0);
  errors.length = 0;
  await makePump(0).tick();
  assert.equal((await packetRow(building.packet_id)).state, "sent", "the fresh pump finished the post");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_message WHERE message_id=$1", [building.message_id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM leader_notice_packet_attempt WHERE packet_id=$1", [building.packet_id])).rows[0].n, 1);
  await reset();
  await newTask("Crash after post");
  beforeExecute = async command => { if (command.type === "leader.noticePacket.sent") { beforeExecute = null; throw new Error("crash before the record"); } };
  await noticePump.tick();
  const half = await lastPacket();
  assert.equal(half.state, "building");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_message WHERE message_id=$1", [half.message_id])).rows[0].n, 1, "the message exists");
  errors.length = 0;
  await makePump(0).tick();
  assert.equal((await packetRow(half.packet_id)).state, "sent");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_message WHERE message_id=$1", [half.message_id])).rows[0].n, 1, "not posted twice");
  assert.deepEqual(errors, []);
});

test("a result that is unknown is only read back: the packet waits, its items stay, and nothing is resent", async () => {
  await reset();
  await newTask("Unknown result");
  await noticePump.tick();
  const packet = await lastPacket();
  const messageId = await attemptMessage(packet.packet_id);
  await pool.query("ALTER TABLE session_message DISABLE TRIGGER USER");
  await pool.query("UPDATE session_message SET state='unknown',version=version+1 WHERE message_id=$1", [messageId]);
  await pool.query("ALTER TABLE session_message ENABLE TRIGGER USER");
  const messagesBefore = (await pool.query("SELECT count(*)::int AS n FROM session_message WHERE project_id=$1", [p])).rows[0].n;
  const packetsBefore = (await packets()).length;
  await noticePump.tick(); await noticePump.tick();
  assert.equal((await packetRow(packet.packet_id)).state, "unknown");
  assert.deepEqual((await items(packet.packet_id)).map(r => r.state), ["pending"], "items are not returned on an unknown result");
  assert.equal((await packets()).length, packetsBefore, "no further packet");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_message WHERE project_id=$1", [p])).rows[0].n, messagesBefore, "no message was resent");
  assert.deepEqual(errors, []);
});

test("a failed read behind a closed gate blocks the packet until it is recovered; once the gate is open the items are resent with the read mark and the Leader's decision counts once", async () => {
  await reset();
  await newTask("Fails once");
  await noticePump.tick();
  const packet = await lastPacket();
  await messagePump.tick();
  await noticePump.tick();
  assert.equal((await packetRow(packet.packet_id)).state, "delivered");
  finishTurn(`turn-${turns.size}`, "failed");
  await messagePump.tick();
  assert.equal((await pool.query("SELECT phase FROM session_recovery_gate WHERE session_id=$1", [sessionA])).rows[0].phase, "blocked", "the failed Turn closed the recovery gate");
  await noticePump.tick();
  assert.equal((await packetRow(packet.packet_id)).state, "blocked");
  const held = (await items(packet.packet_id))[0]!;
  assert.equal(held.state, "unknown"); assert.equal(held.read_before, true, "a Turn had started: it may already have been read");
  const count = (await packets()).length;
  await noticePump.tick();
  assert.equal((await packets()).length, count, "a blocked packet is not retried by itself");
  // It is visible to the Leader, with what to do.
  const blocked = await createLeaderWorkIndexReader(pool).blockedNoticePackets!(p);
  assert.deepEqual(blocked.map(x => x.packetId), [packet.packet_id]);
  assert.match(blocked[0]!.hint, /leader\.notice\.recover/);
  // The gate is open again and the packet is recovered (a reviewer): the item goes out again, marked as possibly read before.
  await pool.query("UPDATE session_recovery_gate SET phase='open',cause_kind=NULL,cause_id=NULL,cause_state=NULL,version=version+1 WHERE session_id=$1", [sessionA]);
  const recovered = await workflow.execute(receiver, { type: "leader.noticePacket.recover", projectId: p, operationId: randomUUID(), packetId: packet.packet_id, reason: "gate reviewed" } as never);
  assert.equal(recovered.status, "applied", JSON.stringify(recovered));
  assert.deepEqual((await createLeaderWorkIndexReader(pool).blockedNoticePackets!(p)), []);
  await noticePump.tick();
  const next = await lastPacket();
  assert.notEqual(next.packet_id, packet.packet_id, "fresh ids for the resend");
  assert.match(next.content, /上一轮已读到过/);
  assert.equal((await items(next.packet_id))[0]!.read_before, true);
  // Delivered and seen again; then the Leader decides, naming the version.
  await messagePump.tick(); await noticePump.tick();
  finishTurn(`turn-${turns.size}`);
  await settleAndPump();
  const seen = (await items(next.packet_id))[0]!;
  assert.equal(seen.state, "seen");
  const decide = (who: Principal, command: Record<string, unknown>) => workflow.execute(who, { projectId: p, ...command } as never);
  const old = await decide(receiver, { type: "leader.notice.handle", operationId: randomUUID(), noticeId: seen.notice_id, expectedVersion: seen.version - 1, disposition: "handled", reason: "old view" });
  assert.equal(old.status, "rejected"); assert.equal((old as { code: string }).code, "VERSION_CONFLICT");
  const operationId = randomUUID();
  const notBefore = new Date(Date.now() + 1500).toISOString();
  const first = await decide(receiver, { type: "leader.notice.handle", operationId, noticeId: seen.notice_id, expectedVersion: seen.version, disposition: "deferred", reason: "after the release", notBefore });
  assert.equal(first.status, "applied", JSON.stringify(first));
  const again = await decide(receiver, { type: "leader.notice.handle", operationId, noticeId: seen.notice_id, expectedVersion: seen.version, disposition: "deferred", reason: "after the release", notBefore });
  assert.equal(again.status, "applied", "a repeat of the same decision is harmless");
  const other = await decide(receiver, { type: "leader.notice.handle", operationId: randomUUID(), noticeId: seen.notice_id, expectedVersion: seen.version, disposition: "handled", reason: "second thought" });
  assert.equal(other.status, "rejected", "a second decision on the old version is refused");
  const done = (await items(next.packet_id))[0]!;
  assert.equal(done.state, "handled"); assert.equal(done.version, seen.version + 1, "the decision took effect once");
  const packetsNow = (await packets()).length;
  await noticePump.tick();
  assert.equal((await packets()).length, packetsNow, "deferred: not before its time");
  await new Promise(resolve => setTimeout(resolve, 1700));
  await noticePump.tick();
  assert.equal((await packets()).length, packetsNow + 1, "after the time it is sent again");
});

test("when the Leader's Session changes, open packets of the old Session are reconciled: an unstarted one is withdrawn, one whose Turn failed returns its items with the read mark", async () => {
  await reset();
  await newTask("Moves house, unstarted");
  await noticePump.tick();
  const unstarted = await lastPacket();
  const unstartedMessage = await attemptMessage(unstarted.packet_id);
  config = { enabled: true, packets: true, targets: [sessionTarget(sessionB)] };
  await messagePump.tick();
  assert.equal((await messageRow(unstartedMessage)).state, "queued", "the old Session's packet message is not started for a Leader that moved");
  await noticePump.tick();
  assert.equal((await messageRow(unstartedMessage)).state, "cancelled");
  assert.equal((await packetRow(unstarted.packet_id)).state, "withdrawn");
  const moved = (await items(unstarted.packet_id))[0]!;
  assert.equal(moved.state, "unknown"); assert.equal(moved.read_before, false);
  await noticePump.tick();
  const onB = await lastPacket();
  assert.equal(onB.session_id, sessionB, "the item came back and goes to the new Leader Session");
  assert.ok((await items(onB.packet_id)).some(r => r.notice_id === moved.notice_id));
  // A packet on the old Session whose Turn had started and failed after the move.
  await reset();
  await newTask("Moves house, read");
  await noticePump.tick();
  const read = await lastPacket();
  await messagePump.tick(); await noticePump.tick();
  assert.equal((await packetRow(read.packet_id)).state, "delivered");
  config = { enabled: true, packets: true, targets: [sessionTarget(sessionB)] };
  finishTurn(`turn-${turns.size}`, "failed");
  await messagePump.tick();
  await noticePump.tick();
  assert.equal((await packetRow(read.packet_id)).state, "returned");
  assert.equal((await items(read.packet_id))[0]!.read_before, true);
  await noticePump.tick();
  const again = await lastPacket();
  assert.equal(again.session_id, sessionB);
  assert.match(again.content, /上一轮已读到过/);
  assert.deepEqual(errors, []);
});

test("notices switched off, or a recipient that is no longer usable, withdraw an unstarted packet so it does not hold the line behind a person's message", async () => {
  await reset();
  await newTask("Switched off");
  await noticePump.tick();
  const packet = await lastPacket();
  const messageId = await attemptMessage(packet.packet_id);
  const h = await humanPost("Behind the packet message");
  config = { enabled: false, packets: true, targets: [sessionTarget(sessionA)] };
  await noticePump.tick();
  assert.equal((await messageRow(messageId)).state, "cancelled");
  assert.equal((await packetRow(packet.packet_id)).state, "withdrawn");
  await messagePump.tick();
  assert.equal((await messageRow(h)).state, "processing", "the person's message started");
  finishTurn(`turn-${turns.size}`);
  await messagePump.tick();
  // The target is lost for good (no usable Session): the same.
  await reset();
  await newTask("Recipient lost");
  await noticePump.tick();
  const second = await lastPacket();
  const secondMessage = await attemptMessage(second.packet_id);
  const original = config.targets[0]!;
  config = { enabled: true, packets: true, targets: [{ ...original, receiverRoleId: randomUUID() }] };
  await noticePump.tick();
  assert.equal((await messageRow(secondMessage)).state, "cancelled");
  assert.equal((await packetRow(second.packet_id)).state, "withdrawn");
  assert.deepEqual(errors, []);
});

test("the switch: with it off new notices keep the one-notice-one-message path, and notices no packet has touched return to it; on, new notices go by packet", async () => {
  await reset();
  config = { enabled: true, packets: false, targets: [sessionTarget(sessionA)] };
  await makePump(0).tick();
  const off = await newTask("Created with the switch off");
  assert.equal((await pool.query("SELECT via_packet FROM leader_result_notice WHERE notice_id=$1", [await noticeOf(off)])).rows[0].via_packet, false);
  config = { enabled: true, packets: true, targets: [sessionTarget(sessionA)] };
  await makePump(3600).tick();
  const on = await newTask("Created with the switch on");
  assert.equal((await pool.query("SELECT via_packet FROM leader_result_notice WHERE notice_id=$1", [await noticeOf(on)])).rows[0].via_packet, true);
  // Rolled back: the untouched packet notice returns to the old path; an off switch builds no new packet for it.
  config = { enabled: true, packets: false, targets: [sessionTarget(sessionA)] };
  const count = (await packets()).length;
  await makePump(0).tick();
  assert.equal((await pool.query("SELECT via_packet FROM leader_result_notice WHERE notice_id=$1", [await noticeOf(on)])).rows[0].via_packet, false);
  assert.equal((await packets()).length, count);
  await pool.query("UPDATE leader_notice_packet_mode SET enabled=true WHERE project_id=$1", [p]);
  assert.deepEqual(errors, []);
});

test("only the configured notice sender runs the packet's own steps: not the Leader, not another reviewer, and nobody when none is configured", async () => {
  await reset();
  await newTask("Identity");
  // A missing permission throws; a refused identity comes back as a rejection. Both mean "not allowed".
  const run = async (who: Principal, command: Record<string, unknown>, service = workflow): Promise<{ status: string; code?: string }> => {
    try { return await service.execute(who, { projectId: p, operationId: randomUUID(), ...command } as never) as never; }
    catch (error) { return { status: "rejected", code: (error as { code?: string }).code ?? "ERROR" }; }
  };
  const build = { type: "leader.noticePacket.build", sessionId: sessionA, packetId: randomUUID(), messageId: randomUUID(), messageOperationId: randomUUID(), content: "x",
    recipient: { receiverRoleId: role, receiverActorId: receiver.actorId, senderActorId: sender.actorId }, noticeIds: [], debounceSeconds: 0, withdraw: [] };
  const packetId = randomUUID();
  for (const who of [receiver, author]) {
    for (const command of [{ ...build, noticeIds: [randomUUID()] }, { type: "leader.noticePacket.sent", packetId }, { type: "leader.noticePacket.observe", packetId, outcome: "seen" }]) {
      const result = await run(who, command);
      assert.equal(result.status, "rejected", `${who.actorId} ${command.type}`); assert.equal(result.code, "FORBIDDEN");
    }
  }
  const noService = new WorkflowService({ ...deps, leaderNoticeServiceActor: async () => null });
  const none = await run(sender, { type: "leader.noticePacket.sent", packetId }, noService);
  assert.equal(none.status, "rejected"); assert.equal(none.code, "FORBIDDEN");
  // The sender passes the identity check (and is then refused for what is wrong with this packet id, not for who it is).
  const known = await run(sender, { type: "leader.noticePacket.sent", packetId });
  assert.notEqual(known.code, "FORBIDDEN");
  // The Leader's own decision and recovery need review; the notice sender has none.
  const decision = await run(sender, { type: "leader.notice.handle", noticeId: randomUUID(), expectedVersion: 1, disposition: "handled", reason: "x" });
  assert.equal(decision.status, "rejected");
});

test("the notice shows where it is in its packet, for a packet notice and a withdrawn one", async () => {
  await reset();
  const taskId = await newTask("Readable status");
  const noticeId = await noticeOf(taskId);
  assert.equal((await getLeaderNotice(pool, p, noticeId)).packet, null, "not packed yet");
  assert.equal((await getLeaderNotice(pool, p, noticeId)).viaPacket, true);
  await noticePump.tick();
  const sent = await getLeaderNotice(pool, p, noticeId);
  assert.equal(sent.packet?.itemState, "pending"); assert.equal(sent.packet?.packetState, "sent");
  await apply(author, { type: "task.start", taskId: await newTask("To be stale"), expectedVersion: 1, reason: "started elsewhere" });
  await noticePump.tick();
  const stale = (await pool.query("SELECT notice_id FROM leader_notice_packet_item WHERE project_id=$1 AND state='withdrawn' ORDER BY created_at DESC LIMIT 1", [p])).rows[0];
  const withdrawn = await getLeaderNotice(pool, p, stale.notice_id);
  assert.equal(withdrawn.packet?.itemState, "withdrawn"); assert.match(withdrawn.packet?.withdrawnReason ?? "", /TODO_SOURCE/);
});

test("notices that existed before the migration keep the one-notice-one-message path", async () => {
  await reset();
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
});

// ---- W5: levels. An immediate notice does not wait out the debounce and is first in line; it is still held by a busy Leader, a closed gate and
// the packet's own limits (20 items, 8 KB), and a backlog of digest notices never holds it back. ----
const raise = async (kind: string, taskId: string, label: string) => {
  const revision = (await pool.query("SELECT current_revision_id FROM task WHERE project_id=$1 AND task_id=$2", [p, taskId])).rows[0].current_revision_id;
  await pool.query("SELECT enqueue_leader_result_notice($1,$2,$3,$4,$5,NULL,'worker',$6,now())", [p, kind, randomUUID(), taskId, revision, `test:${label}`]);
  return String((await pool.query("SELECT notice_id FROM leader_result_notice WHERE project_id=$1 AND task_id=$2 AND kind=$3 ORDER BY occurred_at DESC LIMIT 1", [p, taskId, kind])).rows[0].notice_id);
};
const settlePacket = async (packetId: string) => {
  await pool.query("UPDATE leader_notice_packet SET state='seen',ended_at=now() WHERE packet_id=$1", [packetId]);
  await pool.query("UPDATE leader_notice_packet_item SET state='handled',disposition='handled',handled_by='t',version=version+1 WHERE packet_id=$1", [packetId]);
  await pool.query("ALTER TABLE session_message DISABLE TRIGGER USER");
  await pool.query("UPDATE session_message SET state='cancelled',version=version+1 WHERE project_id=$1 AND state='queued'", [p]);
  await pool.query("ALTER TABLE session_message ENABLE TRIGGER USER");
};

test("W5: digest notices wait for the debounce, an immediate one does not, and it takes the waiting digest notices along", async () => {
  await reset();
  const slow = makePump(3600);
  const before = (await packets()).length;
  await newTask("Digest one"); await newTask("Digest two");
  await slow.tick();
  assert.equal((await packets()).length, before, "digest notices alone wait for the debounce");
  const blocked = await newTask("Blocked");
  const immediate = await raise("task_blocker", blocked, "blocked");
  await slow.tick();
  const packet = await lastPacket();
  assert.equal(packet.state, "sent", "the immediate notice was sent at once, without waiting 3600 seconds");
  const rows = await items(packet.packet_id);
  assert.equal(rows[0]!.notice_id, immediate, "the immediate notice is first in line");
  assert.ok(rows.length >= 3, "the digest notices waiting at that moment travel with it");
  assert.deepEqual(errors, []);
});

test("W5: an immediate notice is still held by a Leader that is busy or behind a closed recovery gate, and goes at the next moment it can be delivered", async () => {
  await reset();
  const slow = makePump(3600);
  const before = (await packets()).length;
  await raise("task_question", await newTask("Asked"), "asked");
  overrides = { leaderState: async () => ({ busy: true, humanMessageQueued: false, gateOpen: true, gateBlocked: false }) };
  await slow.tick();
  assert.equal((await packets()).length, before, "a busy Leader is not interrupted");
  overrides = { leaderState: async () => ({ busy: false, humanMessageQueued: false, gateOpen: false, gateBlocked: true }) };
  await slow.tick();
  assert.equal((await packets()).length, before, "a closed recovery gate holds it");
  overrides = { leaderState: async () => ({ busy: false, humanMessageQueued: true, gateOpen: true, gateBlocked: false }) };
  await slow.tick();
  assert.equal((await packets()).length, before, "a person's message goes first");
  overrides = {};
  await slow.tick();
  assert.equal((await lastPacket()).state, "sent", "at the next deliverable moment it goes, with no debounce");
  assert.deepEqual(errors, []);
});

test("W5: a backlog of digest notices never holds an immediate one back, and more immediate notices than a packet holds go in packets one after another", async () => {
  await reset();
  const slow = makePump(3600);
  for (let i = 0; i < 25; i++) await newTask(`Backlog ${i}`);
  const urgent = await raise("run_submission_blocked", await newTask("Urgent"), "urgent");
  await slow.tick();
  const first = await lastPacket();
  const firstRows = await items(first.packet_id);
  assert.equal(first.item_count, 20, "the packet limit still applies");
  assert.equal(firstRows[0]!.notice_id, urgent, "yet the newest immediate notice is ahead of 25 digest notices that were queued before it");
  await settlePacket(first.packet_id);
  await reset();
  const many: string[] = [];
  for (let i = 0; i < 22; i++) many.push(await raise("acceptance_blocked", await newTask(`Blocked acceptance ${i}`), `many-${i}`));
  await slow.tick();
  const one = await lastPacket();
  assert.equal(one.item_count, 20);
  await settlePacket(one.packet_id);
  await slow.tick();
  const two = await lastPacket();
  assert.notEqual(two.packet_id, one.packet_id);
  const sent = new Set([...(await items(one.packet_id)), ...(await items(two.packet_id))].map(row => row.notice_id));
  for (const id of many) assert.ok(sent.has(id), "every immediate notice went out, in the next packet when the first was full");
  assert.deepEqual(errors, []);
});

test("W5: a withdrawn notice is a record: it wakes no one, and the record view lists it with its reason", async () => {
  await reset();
  const stale = await newTask("Withdrawn in the record");
  const noticeId = await noticeOf(stale);
  await apply(author, { type: "task.start", taskId: stale, expectedVersion: 1, reason: "started elsewhere" });
  await noticePump.tick();
  const { listLeaderEventRecords } = await import("../src/leader-event-records.ts");
  const records = (await listLeaderEventRecords(pool, p, { taskId: stale, limit: 10 })).items;
  assert.deepEqual(records.map(row => row.kind), ["notice_withdrawn"]);
  assert.match(records[0]!.sourceRef, new RegExp(`^notice:${noticeId}:TODO_SOURCE`));
  assert.equal((await pool.query("SELECT 1 FROM leader_result_notice WHERE project_id=$1 AND task_id=$2 AND state='linked' AND level='immediate'", [p, stale])).rowCount, 0, "it never became an immediate notice");
  const page = await listLeaderEventRecords(pool, p, { kind: "notice_withdrawn", limit: 1 });
  assert.equal(page.items.length, 1);
  const rest = await listLeaderEventRecords(pool, p, { kind: "notice_withdrawn", limit: 5, ...(page.nextCursor ? { cursor: page.nextCursor } : {}) });
  assert.ok(!rest.items.some(row => row.sourceEventId === page.items[0]!.sourceEventId), "a cursor continues after the last record read");
  assert.deepEqual(errors, []);
});

// ---- Q2: the scheduling event stream and the work board, over the real flows above ----
test("Q2: the stream records a packet's whole way in order (notice, built, packed, sent by a new Turn, delivered, seen) and the metrics follow from it", async () => {
  await reset();
  const { readSchedEvents, readWorkBoard } = await import("../src/work-board.ts");
  const { computeBoardMetrics } = await import("../../../apps/coordinator/src/work-board/metrics.ts");
  const startSeq = (await readSchedEvents(pool, p, { limit: 1 })).head;
  await humanPost("Leader, a question");
  await messagePump.tick();
  const first = `turn-${turns.size}`;
  await newTask("Stream A");
  await noticePump.tick();                       // the Leader is busy: the notice only waits
  finishTurn(first);
  await messagePump.tick(); await noticePump.tick();   // the packet message is posted
  await messagePump.tick();                      // and started: its Turn runs
  await noticePump.tick();
  const during = await readWorkBoard(pool, p);
  const leader = during.sessions.find(s => s.sessionId === sessionA)!;
  assert.equal(leader.current?.kind, "message", "the Leader's running Turn is a message");
  assert.ok(leader.current!.elapsedSeconds! >= 0);
  assert.ok(during.awaitingLeader.some(i => i.kind === "notice" && i.state === "delivered"), "a delivered notice waits for the Leader's decision");
  assert.ok(during.eventSeq > startSeq);
  assert.ok(during.graph.nodes.some(n => n.kind === "leader") && during.graph.nodes.some(n => n.id === sessionA));
  assert.ok(during.graph.inFlight.some(f => f.kind === "packet"));
  finishTurn(`turn-${turns.size}`); await settleAndPump();
  const page = await readSchedEvents(pool, p, { after: startSeq, limit: 500 });
  const kinds = page.items.map(e => e.kind);
  const order = ["message.queued", "message.processing", "notice.created", "notice.packet_built", "notice.packed", "notice.sent", "notice.delivered", "notice.seen"];
  let at = -1;
  for (const kind of order) { const next = kinds.indexOf(kind, at + 1); assert.ok(next > at, `${kind} after ${order[order.indexOf(kind) - 1] ?? "start"} in ${kinds.join(",")}`); at = next; }
  const sent = page.items.find(e => e.kind === "notice.sent")!;
  assert.equal(sent.next, "new_turn"); assert.equal(sent.subject.kind, "packet");
  const packed = page.items.find(e => e.kind === "notice.packed")!;
  assert.equal(packed.to, sent.subject.id, "a notice names its packet");
  assert.ok(page.items.every((e, i) => i === 0 || e.seq > page.items[i - 1]!.seq), "strictly increasing");
  assert.ok(page.items.every(e => !("content" in e)), "metadata only");
  const m = computeBoardMetrics(page.items, page.items[0]!.at, new Date(Date.now() + 1000).toISOString());
  assert.ok(m.noticeIntake.count >= 1 && m.noticeIntake.medianSeconds !== null);
  // The time read returns the same events as the cursor read.
  const timed = await readSchedEvents(pool, p, { from: page.items[0]!.at, to: new Date(Date.now() + 1000).toISOString(), limit: 500 });
  assert.deepEqual(timed.items.filter(e => e.seq > startSeq).map(e => e.seq), page.items.map(e => e.seq));
});

test("Q2: retention removes only what is older than the window, a cursor behind it is told resetRequired, and one ahead of the head too", async () => {
  const { readSchedEvents, purgeSchedEvents, headSeq } = await import("../src/work-board.ts");
  await reset();
  await newTask("Retention");
  const head = await headSeq(pool, p);
  const old = (await pool.query(`INSERT INTO sched_event(project_id,at,category,kind,subject_kind,subject_id) SELECT $1,now()-interval '31 days','task','task.created','task',$2 RETURNING seq`, [p, randomUUID()])).rows[0].seq as number;
  const kept = (await pool.query(`INSERT INTO sched_event(project_id,at,category,kind,subject_kind,subject_id) SELECT $1,now()-interval '29 days','task','task.created','task',$2 RETURNING seq`, [p, randomUUID()])).rows[0].seq as number;
  assert.ok(Number(old) > head);
  const before = await readSchedEvents(pool, p, { after: head, limit: 10 });
  assert.equal(before.resetRequired, false);
  assert.equal(await purgeSchedEvents(pool, 30, 1), 1, "batches of one: the loop continues until nothing is left to purge");
  assert.equal((await pool.query("SELECT 1 FROM sched_event WHERE seq=$1", [kept])).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM sched_event WHERE seq=$1", [old])).rowCount, 0);
  const behind = await readSchedEvents(pool, p, { after: Number(old) - 1, limit: 10 });
  assert.equal(behind.resetRequired, true, "events the cursor had not seen are gone");
  const at = await readSchedEvents(pool, p, { after: Number(old), limit: 10 });
  assert.equal(at.resetRequired, false); assert.ok(at.items.some(e => e.seq === Number(kept)));
  assert.equal((await readSchedEvents(pool, p, { after: Number(kept) + 100000, limit: 10 })).resetRequired, true);
  assert.equal(await purgeSchedEvents(pool, 30), 0, "nothing more to purge");
});

test("Q2: the triggers add little to a write: a message insert with and without its event trigger", async () => {
  await reset();
  const n = 200;
  const run = async () => {
    const started = process.hrtime.bigint();
    for (let i = 0; i < n; i++) await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'perf','x','cancelled',1,now(),now())`, [p, randomUUID(), randomUUID(), sessionB]);
    return Number(process.hrtime.bigint() - started) / 1e6 / n;
  };
  const withTrigger = await run();
  await pool.query("ALTER TABLE session_message DISABLE TRIGGER sched_event_message_ins");
  const without = await run();
  await pool.query("ALTER TABLE session_message ENABLE TRIGGER sched_event_message_ins");
  console.log(`Q2 write cost per message insert: ${withTrigger.toFixed(2)} ms with the event trigger, ${without.toFixed(2)} ms without (${n} rows, one connection)`);
  assert.ok(withTrigger - without < 5, `the trigger adds ${(withTrigger - without).toFixed(2)} ms per insert`);
});

test("Q2 defect 52eb5ecf: after retention removed every event the head is the purge floor, so a reader that re-reads the snapshot is not told resetRequired again", async () => {
  const { readSchedEvents, readWorkBoard, headSeq, purgeSchedEvents } = await import("../src/work-board.ts");
  await pool.query("UPDATE sched_event SET at=now()-interval '40 days' WHERE project_id=$1", [p]);
  await purgeSchedEvents(pool, 30);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sched_event WHERE project_id=$1", [p])).rows[0].n, 0, "nothing left");
  const floor = Number((await pool.query("SELECT floor_seq FROM sched_event_floor WHERE project_id=$1", [p])).rows[0].floor_seq);
  assert.equal(await headSeq(pool, p), floor, "the head is the floor, not 0");
  const snapshot = await readWorkBoard(pool, p);
  assert.equal(snapshot.eventSeq, floor);
  const page = await readSchedEvents(pool, p, { after: snapshot.eventSeq, limit: 10 });
  assert.equal(page.resetRequired, false, "continuing from the snapshot's eventSeq is current, not a reset");
  assert.equal((await readSchedEvents(pool, p, { after: 0, limit: 10 })).resetRequired, true, "a cursor below the floor still is");
});

test("Q2 defect 52eb5ecf: a Session that is not ready (unknown, creating) stays on the board with its state", async () => {
  const { readWorkBoard } = await import("../src/work-board.ts");
  await pool.query("ALTER TABLE runtime_session DISABLE TRIGGER USER");
  await pool.query("UPDATE runtime_session SET state='unknown' WHERE project_id=$1 AND session_id=$2", [p, sessionB]);
  try {
    const board = await readWorkBoard(pool, p);
    assert.equal(board.sessions.find(s => s.sessionId === sessionB)?.state, "unknown");
  } finally {
    await pool.query("UPDATE runtime_session SET state='ready' WHERE project_id=$1 AND session_id=$2", [p, sessionB]);
    await pool.query("ALTER TABLE runtime_session ENABLE TRIGGER USER");
  }
});

test("Q2 defect 52eb5ecf: write latency under concurrent writers — the per-project advisory lock held to commit, measured with and without the event trigger", async () => {
  await reset();
  const writers = 8, each = 40;
  const run = async () => {
    const latencies: number[] = [];
    const started = process.hrtime.bigint();
    await Promise.all(Array.from({ length: writers }, async () => {
      for (let i = 0; i < each; i++) {
        const c = await pool.connect();
        const t = process.hrtime.bigint();
        try {
          await c.query("BEGIN");
          await c.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
            VALUES($1,$2,$3,'owned',$4,'perf','x','cancelled',1,now(),now())`, [p, randomUUID(), randomUUID(), sessionB]);
          await c.query("COMMIT");
        } finally { c.release(); }
        latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }));
    const sorted = latencies.sort((a, b) => a - b);
    return { p50: sorted[sorted.length >> 1]!, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, perSecond: latencies.length / (Number(process.hrtime.bigint() - started) / 1e9) };
  };
  const withTrigger = await run();
  await pool.query("ALTER TABLE session_message DISABLE TRIGGER sched_event_message_ins");
  const without = await run();
  await pool.query("ALTER TABLE session_message ENABLE TRIGGER sched_event_message_ins");
  const line = (r: typeof withTrigger) => `p50 ${r.p50.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, ${r.perSecond.toFixed(0)} commits/s`;
  console.log(`Q2 concurrent writes (${writers} writers x ${each}, one transaction per insert): with the event trigger and its project lock: ${line(withTrigger)}; without: ${line(without)}`);
  assert.ok(withTrigger.p95 < 250, `p95 with the lock ${withTrigger.p95.toFixed(1)} ms`);

// ---- defect d6dd0a1e: the message pump's log and the closed recovery gate ----
test("d6dd0a1e: a message queued behind a running Turn is not an error: the pump logs nothing for it while the first Turn runs", async () => {
  await reset();
  const first = await humanPost("Runs for a while");
  await messagePump.tick();
  assert.equal((await messageRow(first)).state, "processing");
  await humanPost("Queued behind the running Turn");
  for (let i = 0; i < 6; i++) await messagePump.tick();
  assert.deepEqual(errors, [], "the pump's onError is never called for a message that only waits");
  finishTurn(`turn-${turns.size}`); await messagePump.tick(); await messagePump.tick();
  finishTurn(`turn-${turns.size}`); await messagePump.tick();
});

test("d6dd0a1e: a recovery gate closed 30 minutes with a message behind it is an attention item with who can resume it; it goes when the gate opens or nothing waits", async () => {
  const { readWorkBoard } = await import("../src/work-board.ts");
  await reset();
  const itemOf = async () => (await readWorkBoard(pool, p)).awaitingLeader.filter(i => i.kind === "recovery_gate" && i.id === sessionA);
  const close = (minutesAgo: number) => pool.query(`UPDATE session_recovery_gate SET phase='blocked',updated_at=now()-make_interval(mins=>$2),version=version+1 WHERE project_id=$1 AND session_id=$3`, [p, minutesAgo, sessionA]);
  await close(31);
  assert.deepEqual(await itemOf(), [], "a closed gate with nothing queued behind it is not an item");
  const queued = await humanPost("Waits behind the closed gate");
  let items = await itemOf();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.state, "blocked"); assert.match(items[0]!.title ?? "", /超过 30 分钟，1 条消息排在后面/);
  assert.deepEqual(items[0]!.waitingOn, { kind: "reviewer", id: null }, "nobody has decided for this gate yet: any reviewer can resume it");
  await pool.query(`INSERT INTO session_recovery_decision(project_id,decision_id,session_id,kind,expected_gate_version,cause_id,evidence_ref,actor_id,reason,created_at)
    VALUES($1,$2,$3,'resume',1,gen_random_uuid(),'test:evidence','requirements-claude-agent','earlier decision',now()-interval '2 hours')`, [p, randomUUID(), sessionA]);
  items = await itemOf();
  assert.deepEqual(items[0]!.waitingOn, { kind: "actor", id: "requirements-claude-agent" }, "waiting on the identity that last decided for this gate");
  await close(5);
  assert.deepEqual(await itemOf(), [], "a gate closed only 5 minutes is not yet an item");
  await close(45);
  assert.equal((await itemOf()).length, 1);
  await pool.query("UPDATE session_recovery_gate SET phase='open',version=version+1 WHERE project_id=$1 AND session_id=$2", [p, sessionA]);
  assert.deepEqual(await itemOf(), [], "the gate reopened: the item is gone");
  await close(45);
  await pool.query("ALTER TABLE session_message DISABLE TRIGGER USER");
  await pool.query("UPDATE session_message SET state='cancelled',version=version+1 WHERE project_id=$1 AND message_id=$2", [p, queued]);
  await pool.query("ALTER TABLE session_message ENABLE TRIGGER USER");
  assert.deepEqual(await itemOf(), [], "nothing waits behind the gate any more");
  await pool.query("UPDATE session_recovery_gate SET phase='open',version=version+1 WHERE project_id=$1 AND session_id=$2", [p, sessionA]);

});
