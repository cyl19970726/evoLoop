// Controlled, repeatable acceptance path for "a preflight failure leaves no blocked recovery gate" (Task 94a753a6).
//
//   TEST_DATABASE_URL=postgres://…/evoloop_<name>_test node --import tsx scripts/ops/preflight-gate-acceptance.ts [--out FILE]
//
// It runs against a one-off PostgreSQL database (see `npm run test-pg`; the database-target guard refuses a live or shared server and the
// run uses its own schema, dropped at the end). Nothing here touches the formal instance, adds a test hook to production code, or needs a
// reviewer identity on a live project: the services, the SQL migrations (including the recovery trigger) and the real session message
// pump are the production ones; only the native runtime is scripted.
//
// Scenario A (the fix): gate open, the Session has a queued message, the first runtime.run.reserve fails its preflight (requested -> failed,
//   no native Turn), then the queued message starts and the next Run reserves with no runtime.session.recovery.resume.
// Scenario B (the protection that stays): a real failure (native rejection after dispatch) blocks the gate, the queued message and the next Run
//   are held until the explicit resume.
// The output is JSON: for each scenario the before/after versions of the Run, the message and the gate, and each command's receipt.
import "../test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { SessionMessagePump } from "../../apps/coordinator/src/session-messages/pump.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("TEST_DATABASE_URL must name a dedicated evoloop_*_test database");
const outIndex = process.argv.indexOf("--out");
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : null;

const schema = `el_pfacc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
await migrate(url, schema);
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const clock = { now: () => new Date().toISOString() };
const deps = { uow, clock, ids: { next: randomUUID }, hasher: { hash } };
const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID();
const lead: Principal = { actorId: "lead", projectIds: [p], permissions: ["read", "write", "review"] };
const human: Principal = { actorId: "human-actor", projectIds: [p], permissions: ["read", "write"] };
const receipts: Array<Record<string, unknown>> = [];

async function command(label: string, body: Record<string, unknown>, who: Principal = lead) {
  const operationId = randomUUID();
  const result = await workflow.execute(who, { projectId: p, operationId, ...body } as never).catch(error => ({ status: "rejected", code: (error as { code?: string }).code ?? "ERROR" }));
  receipts.push({ label, type: body.type, operationId, ...Object.fromEntries(Object.entries(result as Record<string, unknown>).filter(([key]) => ["status", "code", "version", "entityId"].includes(key))) });
  return result as Record<string, unknown>;
}
const must = async (label: string, body: Record<string, unknown>, who?: Principal) => {
  const result = await command(label, body, who); assert.equal(result.status, "applied", `${label}: ${JSON.stringify(result)}`); return result;
};

await must("project.create", { type: "project.create", title: "Preflight gate acceptance" });
const c = await pool.connect();
try {
  await c.query("BEGIN");
  await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
    VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [p, role, roleRev]);
  await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
    VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [p, role, roleRev]);
  await c.query("COMMIT");
} catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }

async function newSession(): Promise<string> {
  const sessionId = randomUUID();
  await must("runtime.session.reserve", { type: "runtime.session.reserve", sessionId, roleId: role, cwd: "/tmp/pfacc", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(p, sessionId);
  const saved = (await uow.read(p, r => r.getRuntimeSession(sessionId)))!;
  await runtime.bindSession(p, sessionId, { owner: "evoloop-codex-app-server", projectId: p, sessionId, roleId: role, cwd: "/tmp/pfacc", authorizationScope: "project",
    nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`, resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox,
      approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  return sessionId;
}
const startedTask = async (title: string) => {
  const taskId = randomUUID();
  await must("task.create", { type: "task.create", taskId, title, content: `# ${title}`, acceptance: "ok", owner: role });
  await must("task.start", { type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  return taskId;
};
const reserve = async (label: string, sessionId: string, taskId: string) => {
  const runId = randomUUID();
  const task = (await uow.read(p, r => r.getTask(taskId)))!;
  const result = await command(label, { type: "runtime.run.reserve", runId, taskId, sessionId, expectedVersion: task.version, input: "fixed input" });
  return { runId, result, operationId: (await uow.read(p, r => r.getRuntimeRun(runId)))?.operationId ?? null };
};
const gateOf = async (sessionId: string) => (await pool.query("SELECT phase,version,cause_id,resume_message_id FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2", [p, sessionId])).rows[0];
const runOf = async (runId: string) => { const x = await uow.read(p, r => r.getRuntimeRun(runId)); return x ? { state: x.state, version: x.version, nativeTurnId: x.nativeTurnId ?? null } : null; };
const messageOf = async (id: string) => (await pool.query("SELECT state,version,blocked_reason FROM session_message WHERE message_id=$1", [id])).rows[0];

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
const pumpErrors: string[] = [];
const pump = new SessionMessagePump({ service: messageService, runtime: () => fakeRuntime as never, projects: async () => [p], canStart: async () => true, canWrite: () => true,
  pollIntervalMs: 1000, onError: error => pumpErrors.push(`${(error as { code?: string }).code ?? "ERROR"}: ${error instanceof Error ? error.message : String(error)}`) });
const finishTurns = () => { for (const t of turns.values()) if (!t.completedAtUtc) { t.status = "completed"; t.completedAtUtc = new Date().toISOString(); } };
const ticks = async (n = 4) => { for (let i = 0; i < n; i++) await pump.tick(); };
const queueMessage = async (sessionId: string, text: string) => {
  const messageId = randomUUID();
  await must("session.message.post", { type: "session.message.post", messageId, target: { kind: "owned", sessionId }, content: text }, human);
  return messageId;
};

const report: Record<string, unknown> = { schema, startedAt: new Date().toISOString(), scenarios: {} as Record<string, unknown> };
let failed: unknown = null;
try {
  // ---- Scenario A ----
  {
    const sessionId = await newSession();
    const messageId = await queueMessage(sessionId, "queued message A");
    const first = await reserve("runtime.run.reserve (will fail its preflight)", sessionId, await startedTask("Scenario A"));
    assert.equal(first.result.status, "applied");
    const before = { run: await runOf(first.runId), message: await messageOf(messageId), gate: await gateOf(sessionId) };
    const failedRun = await runtime.rejectDispatch(p, first.runId, "Preflight failed: fixed source unavailable");
    receipts.push({ label: "runtime.rejectDispatch (preflight failure, the runner's own call)", runId: first.runId, state: failedRun.state, version: failedRun.version });
    const afterFailure = { run: await runOf(first.runId), message: await messageOf(messageId), gate: await gateOf(sessionId) };
    await ticks();
    const afterPump = { run: await runOf(first.runId), message: await messageOf(messageId), gate: await gateOf(sessionId), startedInputs: [...started] };
    finishTurns(); await ticks(); // the message's own Turn ends, so the Session is free for the next Run
    const second = await reserve("runtime.run.reserve (next Run, no resume)", sessionId, await startedTask("Scenario A next"));
    assert.equal(afterFailure.run?.state, "failed"); assert.equal(afterFailure.run?.nativeTurnId, null);
    assert.equal(afterFailure.gate.phase, "open"); assert.equal(afterFailure.gate.version, before.gate.version);
    assert.ok(started.some(text => text.includes("queued message A")), "the queued message started with no resume");
    assert.notEqual(afterPump.message.state, "queued");
    assert.equal(second.result.status, "applied", "the next Run reserved with no resume");
    assert.ok(!receipts.some(receipt => receipt.type === "runtime.session.recovery.resume"), "no resume command was issued");
    (report.scenarios as Record<string, unknown>).A_preflight_failure = { before, afterFailure, afterPump, nextRunReserve: second.result, resumeIssued: false, pumpErrors: [...pumpErrors] };
  }
  // ---- Scenario B ----
  pumpErrors.length = 0;
  {
    const sessionId = await newSession();
    const messageId = await queueMessage(sessionId, "queued message B");
    const first = await reserve("runtime.run.reserve (will fail after dispatch)", sessionId, await startedTask("Scenario B"));
    const dispatching = await runtime.beginDispatch(p, first.runId);
    const before = { run: await runOf(first.runId), message: await messageOf(messageId), gate: await gateOf(sessionId) };
    await runtime.rejectDispatch(p, first.runId, "native rejection", { kind: "native_resume_rejected", operationId: first.operationId!, code: -32603, category: "thread_unavailable" });
    const blocked = { run: await runOf(first.runId), message: await messageOf(messageId), gate: await gateOf(sessionId) };
    const count = started.length;
    await ticks();
    const held = { startedMore: started.length > count, message: await messageOf(messageId), pumpErrors: [...pumpErrors] };
    const refusedNext = await command("runtime.run.reserve (blocked gate)", { type: "runtime.run.reserve", runId: randomUUID(), taskId: await startedTask("Scenario B blocked next"), sessionId, expectedVersion: 2, input: "fixed input" });
    assert.equal(blocked.run?.state, "failed"); assert.equal(blocked.gate.phase, "blocked"); assert.equal(blocked.gate.cause_id, first.runId);
    assert.equal(held.startedMore, false); assert.equal(held.message.state, "queued");
    assert.ok(pumpErrors.length > 0 && pumpErrors.every(text => text.startsWith("RECOVERY_BLOCKED")), "held by the recovery gate itself");
    assert.equal(refusedNext.status, "rejected");
    const g = blocked.gate;
    const resumed = await command("runtime.session.recovery.resume (explicit)", { type: "runtime.session.recovery.resume", sessionId, expectedVersion: g.version, expectedCauseId: g.cause_id,
      resumeMessageId: g.resume_message_id, evidenceRef: "acceptance:explicit-resume", reason: "operator decision after a real failure" });
    assert.equal(resumed.status, "applied", JSON.stringify(resumed));
    pumpErrors.length = 0; await ticks();
    const afterResume = { gate: await gateOf(sessionId), message: await messageOf(messageId), startedMore: started.length > count, pumpErrors: [...pumpErrors] };
    assert.equal(afterResume.startedMore, true);
    (report.scenarios as Record<string, unknown>).B_real_failure = { dispatchingRunVersion: dispatching.version, before, blocked, held, nextRunReserve: refusedNext, resume: resumed, afterResume };
  }
  report.result = "passed";
} catch (error) {
  failed = error; report.result = "failed"; report.error = error instanceof Error ? error.message : String(error);
} finally {
  report.receipts = receipts; report.endedAt = new Date().toISOString();
  await pool.end();
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
}
const text = JSON.stringify(report, null, 2);
if (outFile) writeFileSync(outFile, text + "\n");
process.stdout.write(text + "\n");
process.exit(failed ? 1 : 0);
