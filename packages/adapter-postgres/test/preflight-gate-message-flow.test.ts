// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import type { Principal } from "@evoloop/contracts";
import type { NativeResumeRejection } from "@evoloop/contracts/runtime";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { SessionMessagePump } from "../../../apps/coordinator/src/session-messages/pump.ts";

/**
 * Task 94a753a6 (11-12 rework): the queued-message flow after a failed Run, end to end through the real message pump.
 * A preflight failure (requested -> failed, no native Turn, the model never started) leaves an open recovery gate open, so the
 * Session's queued message starts and the next Run reserves without `runtime.session.recovery.resume`. A real failure
 * (native rejection after dispatch, unknown outcome, a Run that had a native Turn) still blocks both until an explicit resume.
 * Only the native runtime is scripted; the services, the message pump, the triggers and PostgreSQL are real.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_pfgate_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID();
const lead: Principal = { actorId: "lead", projectIds: [p], permissions: ["read", "write", "review"] };
const human: Principal = { actorId: "human-actor", projectIds: [p], permissions: ["read", "write"] };
const clock = { now: () => new Date().toISOString() };
const deps = { uow, clock, ids: { next: randomUUID }, hasher: { hash } };
const workflow = new WorkflowService(deps);
const runtime = new RuntimeWorkflowService(deps);

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(lead, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Preflight gate flow" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [p, role, roleRev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [p, role, roleRev]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

async function apply(command: Record<string, unknown>, who: Principal = lead) {
  const result = await workflow.execute(who, { projectId: p, operationId: randomUUID(), ...command } as never);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
}
const rejection = async (command: Record<string, unknown>, who: Principal = lead) =>
  workflow.execute(who, { projectId: p, operationId: randomUUID(), ...command } as never).catch(error => ({ status: "rejected" as const, code: (error as { code: string }).code }));

/** A ready, bound Session of the Role, with its (open) recovery gate. */
async function newSession(): Promise<string> {
  const sessionId = randomUUID();
  await apply({ type: "runtime.session.reserve", sessionId, roleId: role, cwd: "/tmp/pfgate", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(p, sessionId);
  const saved = (await uow.read(p, r => r.getRuntimeSession(sessionId)))!;
  await runtime.bindSession(p, sessionId, { owner: "evoloop-codex-app-server", projectId: p, sessionId, roleId: role, cwd: "/tmp/pfgate", authorizationScope: "project",
    nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`, resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox,
      approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  return sessionId;
}
const startedTask = async (title: string) => {
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title, content: `# ${title}`, acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  return taskId;
};
const reserveRun = async (sessionId: string, taskId: string) => {
  const runId = randomUUID();
  const task = (await uow.read(p, r => r.getTask(taskId)))!;
  const result = await workflow.execute(lead, { type: "runtime.run.reserve", projectId: p, operationId: randomUUID(), runId, taskId, sessionId, expectedVersion: task.version, input: "fixed input" });
  return { runId, result, operationId: (await uow.read(p, r => r.getRuntimeRun(runId)))?.operationId ?? null };
};
const gate = async (sessionId: string) => (await pool.query("SELECT phase,version,cause_id,resume_message_id FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2", [p, sessionId])).rows[0];
const run = (runId: string) => uow.read(p, r => r.getRuntimeRun(runId)).then(x => x!);

// ---- the real session message pump over the real message service, with a scripted native runtime ----
const messageService = new SessionMessageService({ uow, clock, ids: { next: randomUUID },
  grantFor: async (message, session) => ({ enabled: true, projectId: p, sessionId: session.id, senderActorId: message.senderActorId, receiverActorId: "receiver",
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
const finishTurns = () => { for (const t of turns.values()) if (!t.completedAtUtc) { t.status = "completed"; t.completedAtUtc = new Date().toISOString(); } };
const errors: unknown[] = [];
const messagePump = new SessionMessagePump({ service: messageService, runtime: () => fakeRuntime as never, projects: async () => [p], canStart: async () => true, canWrite: () => true, pollIntervalMs: 1000, onError: error => errors.push(error) });
/** The pump tried and was refused by the recovery gate itself (not by some other fault); the refusals are consumed here. */
const assertHeldByGate = () => {
  assert.ok(errors.length > 0, "the pump did try to start the message");
  assert.ok(errors.every(error => (error as { code?: string }).code === "RECOVERY_BLOCKED"), `held by the gate: ${errors.map(String).join("; ")}`);
  errors.length = 0;
};
const pumpTicks = async (n = 4) => { for (let i = 0; i < n; i++) await messagePump.tick(); };
const queueMessage = async (sessionId: string, text: string) => {
  const messageId = randomUUID();
  await apply({ type: "session.message.post", messageId, target: { kind: "owned", sessionId }, content: text }, human);
  return messageId;
};
const messageState = async (id: string) => (await pool.query("SELECT state,blocked_reason FROM session_message WHERE message_id=$1", [id])).rows[0] as { state: string; blocked_reason: string | null };
/** The explicit decision a real failure needs: the Session's gate is resumed with the cause it names. */
const resume = async (sessionId: string, reason: string) => {
  const g = await gate(sessionId);
  return workflow.execute(lead, { type: "runtime.session.recovery.resume", projectId: p, operationId: randomUUID(), sessionId, expectedVersion: g.version,
    expectedCauseId: g.cause_id, resumeMessageId: g.resume_message_id, evidenceRef: "test:explicit-resume", reason } as never);
};
const proof = (operationId: string): NativeResumeRejection => ({ kind: "native_resume_rejected", operationId, code: -32603, category: "thread_unavailable" });

test("a preflight failure leaves the gate open: the queued message starts through the real pump and the next Run reserves, with no recovery.resume", async () => {
  const sessionId = await newSession();
  assert.equal((await gate(sessionId)).phase, "open");
  const messageId = await queueMessage(sessionId, "queued before the failure");
  const task = await startedTask("Preflight fails");
  // The first reserve is refused later by the preflight: the Run goes requested -> failed with no native Turn (the model never started).
  const first = await reserveRun(sessionId, task);
  assert.equal(first.result.status, "applied");
  const before = await gate(sessionId);
  const failed = await runtime.rejectDispatch(p, first.runId, "Preflight failed: fixed source unavailable");
  assert.equal(failed.state, "failed"); assert.equal(failed.nativeTurnId ?? null, null, "no native Turn");
  const after = await gate(sessionId);
  assert.deepEqual([after.phase, after.cause_id], ["open", null], "the gate stays open");
  assert.equal(after.version, before.version, "the gate record was not even touched");
  // The queued message was waiting; the real pump now starts it.
  const count = started.length;
  await pumpTicks();
  assert.ok(started.length > count && started.some(text => text.includes("queued before the failure")), "the queued message started without any resume");
  assert.notEqual((await messageState(messageId)).state, "queued");
  assert.deepEqual(errors, []);
  finishTurns(); await pumpTicks();
  // And a new Run reserves at once (no gate refusal).
  const second = await reserveRun(sessionId, await startedTask("Next Run"));
  assert.equal(second.result.status, "applied", JSON.stringify(second.result));
  assert.equal((await gate(sessionId)).phase, "open");
});

test("a real failure still blocks the queued message and the next Run: native rejection after dispatch", async () => {
  const sessionId = await newSession();
  const messageId = await queueMessage(sessionId, "must wait for an explicit resume (rejection)");
  const first = await reserveRun(sessionId, await startedTask("Native rejection"));
  await runtime.beginDispatch(p, first.runId);
  await runtime.rejectDispatch(p, first.runId, "x", proof(first.operationId!));
  assert.equal((await run(first.runId)).state, "failed");
  assert.deepEqual([(await gate(sessionId)).phase, (await gate(sessionId)).cause_id], ["blocked", first.runId]);
  const count = started.length;
  await pumpTicks();
  assert.equal(started.length, count, "the queued message did not start");
  assert.equal((await messageState(messageId)).state, "queued");
  assertHeldByGate();
  const refused = await rejection({ type: "runtime.run.reserve", runId: randomUUID(), taskId: await startedTask("Blocked next"), sessionId,
    expectedVersion: 2, input: "fixed input" });
  assert.equal(refused.status, "rejected");
  // Only the explicit resume lets it go: the same pump then starts the message.
  const resumed = await resume(sessionId, "operator decision after a real failure");
  assert.equal(resumed.status, "applied", JSON.stringify(resumed));
  await pumpTicks();
  assert.ok(started.length > count, "after the explicit resume the message starts");
  assert.deepEqual(errors, [], "no more refusals once resumed");
});

test("a real failure still blocks: an unknown outcome and a failed Run that had a native Turn", async () => {
  const unknownSession = await newSession();
  const unknownMessage = await queueMessage(unknownSession, "must wait (unknown)");
  const unknown = await reserveRun(unknownSession, await startedTask("Unknown outcome"));
  await runtime.beginDispatch(p, unknown.runId);
  await runtime.markRunUnknown(p, unknown.runId, "Lost start reply");
  assert.deepEqual([(await gate(unknownSession)).phase, (await gate(unknownSession)).cause_id], ["blocked", unknown.runId]);
  const turnSession = await newSession();
  const turnMessage = await queueMessage(turnSession, "must wait (failed with a native Turn)");
  const withTurn = await reserveRun(turnSession, await startedTask("Failed after a Turn"));
  await runtime.beginDispatch(p, withTurn.runId);
  await runtime.bindTurn(p, withTurn.runId, { id: `turn-${withTurn.runId}`, status: "running" }, { kind: "startReply", operationId: withTurn.operationId! });
  await uow.transaction(p, async tx => { const current = (await tx.getRuntimeRun(withTurn.runId))!;
    await tx.updateRuntimeRun({ ...current, state: "failed", version: current.version + 1, updatedAt: new Date().toISOString() }, current.version); });
  assert.deepEqual([(await gate(turnSession)).phase, (await gate(turnSession)).cause_id], ["blocked", withTurn.runId]);
  const count = started.length;
  await pumpTicks();
  assert.equal(started.length, count, "neither queued message started");
  assert.equal((await messageState(unknownMessage)).state, "queued"); assert.equal((await messageState(turnMessage)).state, "queued");
  assertHeldByGate();
});
