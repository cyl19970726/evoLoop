// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_effort_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const base = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } };
let nextTurnRuntime = true;
// One authority whose runtime capability can be switched: Codex 0.167 has no thread/settings/update, 0.166-alpha.6 has.
let allowedEfforts: readonly string[] | null = null;
const workflow = new WorkflowService({ ...base, recoveryAuthority: { canRevise: async () => true, effortAppliesNextTurn: () => nextTurnRuntime, allowedEfforts: () => allowedEfforts } });
const runtime = new RuntimeWorkflowService(base);
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID();
const lead: Principal = { actorId: "lead", projectIds: [p], permissions: ["read", "write", "review"] };

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(lead, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Effort" });
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

async function apply(command: Record<string, unknown>) {
  const result = await workflow.execute(lead, { projectId: p, operationId: randomUUID(), ...command } as never);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result as { revisionId?: string };
}
async function newSession() {
  const sessionId = randomUUID();
  await apply({ type: "runtime.session.reserve", sessionId, roleId: role, cwd: "/tmp/effort", authorizationScope: "project", model: "deepseek/deepseek-flash", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(p, sessionId);
  const saved = (await uow.read(p, r => r.getRuntimeSession(sessionId)))!;
  const thread = randomUUID();
  await runtime.bindSession(p, sessionId, { owner: "evoloop-codex-app-server", projectId: p, sessionId, roleId: role, cwd: "/tmp/effort", authorizationScope: "project",
    nativeThreadId: thread, nativeSessionId: `native-${sessionId}`,
    resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  return sessionId;
}
const profileOf = async (sessionId: string) => (await uow.read(p, r => r.getRuntimeSession(sessionId)))!;
const revise = async (sessionId: string, model: string, effort: string) => {
  const s = await profileOf(sessionId);
  return apply({ type: "runtime.session.executionProfile.revise", sessionId, expectedVersion: s.version, expectedExecutionProfileRevisionId: s.executionProfile!.revision.revisionId,
    model, reasoningEffort: effort, sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: "fixture://grant", reason: "set the thinking effort" });
};
const gate = async (sessionId: string) => (await pool.query("SELECT phase FROM session_recovery_gate WHERE session_id=$1", [sessionId])).rows[0].phase;

test("an effort-only change on a runtime without thread/settings/update is active at once and needs no native activation", async () => {
  nextTurnRuntime = true;
  const sessionId = await newSession();
  const revised = await revise(sessionId, "deepseek/deepseek-flash", "max");
  const s = await profileOf(sessionId);
  assert.equal(s.executionProfile!.activationState, "active", "nothing to activate natively");
  assert.equal(s.executionProfile!.revision.reasoningEffort, "max");
  assert.equal(s.executionProfile!.activeRevisionId, revised.revisionId);
  assert.equal(await gate(sessionId), "open", "the Session can take its next Run at once");
  // The next Run carries it: the Run's frozen profile is what turn/start sends.
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title: "Effort run", content: "# t", acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  const runId = randomUUID();
  await apply({ type: "runtime.run.reserve", runId, taskId, sessionId, expectedVersion: (await workflow.getTask(lead, p, taskId)).task.version, input: "go" });
  const run = (await uow.read(p, r => r.getRuntimeRun(runId)))!;
  assert.equal(run.executionProfile?.reasoningEffort, "max");
  // Reading it back: the event records the requested effort beside what the Thread reported.
  await runtime.beginDispatch(p, runId);
  const stored = (await uow.read(p, r => r.getRuntimeRun(runId)))!;
  await runtime.bindTurn(p, runId, { id: `turn-${runId}`, status: "inProgress", observedReasoningEffort: "max" }, { kind: "startReply", operationId: stored.operationId });
  const events = await workflow.listRuntimeEvents(lead, p, runId);
  assert.ok(events.some(e => e.kind === "run.bound" && /effort requested=max observed=max/.test(e.detail) && !/MISMATCH/.test(e.detail)));
  // A second change keeps working the same way.
  await runtime.recordTurn(p, runId, `turn-${runId}`, "completed", "done", { completedAtUtc: new Date().toISOString() });
  await revise(sessionId, "deepseek/deepseek-flash", "low");
  assert.equal((await profileOf(sessionId)).executionProfile!.revision.reasoningEffort, "low");
  assert.equal((await profileOf(sessionId)).executionProfile!.activationState, "active");
});

test("a mismatch between requested and reported effort is flagged in the Run's event", async () => {
  nextTurnRuntime = true;
  const sessionId = await newSession();
  await revise(sessionId, "deepseek/deepseek-flash", "max");
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title: "Mismatch run", content: "# t", acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  const runId = randomUUID();
  await apply({ type: "runtime.run.reserve", runId, taskId, sessionId, expectedVersion: (await workflow.getTask(lead, p, taskId)).task.version, input: "go" });
  await runtime.beginDispatch(p, runId);
  const stored = (await uow.read(p, r => r.getRuntimeRun(runId)))!;
  await runtime.bindTurn(p, runId, { id: `turn-${runId}`, status: "inProgress", observedReasoningEffort: "high" }, { kind: "startReply", operationId: stored.operationId });
  assert.ok((await workflow.listRuntimeEvents(lead, p, runId)).some(e => e.kind === "run.bound" && /requested=max observed=high MISMATCH/.test(e.detail)));
});

test("a model change that carries an effort is refused and nothing is saved where the runtime cannot switch in place; a runtime that can keeps the native activation path", async () => {
  nextTurnRuntime = true;
  const modelChange = await newSession();
  const before = await profileOf(modelChange);
  const refused = await workflow.execute(lead, { type: "runtime.session.executionProfile.revise", projectId: p, operationId: randomUUID(), sessionId: modelChange,
    expectedVersion: before.version, expectedExecutionProfileRevisionId: before.executionProfile!.revision.revisionId, model: "deepseek/deepseek-v4-pro",
    reasoningEffort: before.executionProfile!.revision.reasoningEffort ?? "high", sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: "fixture://grant", reason: "model only" } as never)
    .catch(error => ({ status: "rejected", code: (error as { code: string }).code }));
  assert.equal(refused.status, "rejected"); assert.equal((refused as { code: string }).code, "EXECUTION_PROFILE_MODEL_CHANGE_UNSUPPORTED");
  const after = await profileOf(modelChange);
  assert.equal(after.executionProfile!.revision.revisionId, before.executionProfile!.revision.revisionId, "no revision was saved");
  assert.equal(after.version, before.version);
  assert.equal(await gate(modelChange), "open", "the recovery gate stays open");
  // Model and effort together: the same refusal.
  const both = await workflow.execute(lead, { type: "runtime.session.executionProfile.revise", projectId: p, operationId: randomUUID(), sessionId: modelChange,
    expectedVersion: before.version, expectedExecutionProfileRevisionId: before.executionProfile!.revision.revisionId, model: "deepseek/deepseek-v4-pro", reasoningEffort: "max",
    sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: "fixture://grant", reason: "both" } as never).catch(error => ({ status: "rejected", code: (error as { code: string }).code }));
  assert.equal((both as { code: string }).code, "EXECUTION_PROFILE_MODEL_CHANGE_UNSUPPORTED");
  nextTurnRuntime = false;
  const native = await newSession();
  await revise(native, "deepseek/deepseek-v4-pro", "max");
  assert.equal((await profileOf(native)).executionProfile!.activationState, "pending", "a runtime with thread/settings/update activates a model change natively");
  const effortOnly = await newSession();
  await revise(effortOnly, "deepseek/deepseek-flash", "max");
  assert.equal((await profileOf(effortOnly)).executionProfile!.activationState, "pending", "and an effort change too");
  nextTurnRuntime = true;
});

test("effort is checked against the Session's own runtime: a Claude Session never stores none or minimal, a Codex Session may", async () => {
  nextTurnRuntime = true;
  const claude = await newSession();
  allowedEfforts = ["low", "medium", "high", "xhigh", "max"];
  for (const bad of ["minimal"]) {
    const s = await profileOf(claude);
    const refused = await workflow.execute(lead, { type: "runtime.session.executionProfile.revise", projectId: p, operationId: randomUUID(), sessionId: claude,
      expectedVersion: s.version, expectedExecutionProfileRevisionId: s.executionProfile!.revision.revisionId, model: s.executionProfile!.revision.model ?? "deepseek/deepseek-flash",
      reasoningEffort: bad, sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: "fixture://grant", reason: "not a Claude level" } as never)
      .catch(error => ({ status: "rejected", code: (error as { code: string }).code }));
    assert.equal(refused.status, "rejected"); assert.equal((refused as { code: string }).code, "REASONING_EFFORT_UNSUPPORTED", bad);
    assert.equal((await profileOf(claude)).executionProfile!.revision.revisionId, s.executionProfile!.revision.revisionId, "nothing was saved");
  }
  const s = await profileOf(claude);
  await revise(claude, s.executionProfile!.revision.model ?? "deepseek/deepseek-flash", "xhigh");
  assert.equal((await profileOf(claude)).executionProfile!.revision.reasoningEffort, "xhigh");
  // `none` is not storable at all (the profile table has no such level), so it is an unknown level everywhere, not a storage error.
  const n = await profileOf(claude);
  const none = await workflow.execute(lead, { type: "runtime.session.executionProfile.revise", projectId: p, operationId: randomUUID(), sessionId: claude,
    expectedVersion: n.version, expectedExecutionProfileRevisionId: n.executionProfile!.revision.revisionId, model: n.executionProfile!.revision.model ?? "deepseek/deepseek-flash",
    reasoningEffort: "none", sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: "fixture://grant", reason: "none" } as never).catch(error => ({ status: "rejected", code: (error as { code: string }).code }));
  assert.equal((none as { code: string }).code, "REASONING_EFFORT_UNKNOWN");
  allowedEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const codex = await newSession();
  const c = await profileOf(codex);
  await revise(codex, c.executionProfile!.revision.model ?? "deepseek/deepseek-flash", "minimal");
  assert.equal((await profileOf(codex)).executionProfile!.revision.reasoningEffort, "minimal");
  allowedEfforts = null;
});

test("the shortcut compares with the profile in force: a pending model change blocks it; an unknown effort is refused", async () => {
  nextTurnRuntime = true;
  const sessionId = await newSession();
  nextTurnRuntime = false;
  await revise(sessionId, "deepseek/deepseek-v4-pro", "high");           // model change: pending, not yet confirmed natively
  nextTurnRuntime = true;
  assert.equal((await profileOf(sessionId)).executionProfile!.activationState, "pending");
  const s = await profileOf(sessionId);
  const effortOnlyOnPending = await workflow.execute(lead, { type: "runtime.session.executionProfile.revise", projectId: p, operationId: randomUUID(), sessionId,
    expectedVersion: s.version, expectedExecutionProfileRevisionId: s.executionProfile!.revision.revisionId, model: "deepseek/deepseek-v4-pro", reasoningEffort: "max",
    sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: "fixture://grant", reason: "effort on an unconfirmed model" } as never);
  assert.equal(effortOnlyOnPending.status, "rejected", JSON.stringify(effortOnlyOnPending));
  assert.equal((effortOnlyOnPending as { code: string }).code, "PROFILE_NOT_ACTIVE");
  assert.equal((await profileOf(sessionId)).executionProfile!.activationState, "pending", "the unconfirmed profile was not made active");
  // Effort strings: only the known levels, exactly spelled.
  const fresh = await newSession();
  for (const bad of ["MAX", "Hihg", "maximum", ""]) {
    const f = await profileOf(fresh);
    const refused = await workflow.execute(lead, { type: "runtime.session.executionProfile.revise", projectId: p, operationId: randomUUID(), sessionId: fresh,
      expectedVersion: f.version, expectedExecutionProfileRevisionId: f.executionProfile!.revision.revisionId, model: "deepseek/deepseek-flash", reasoningEffort: bad,
      sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: "fixture://grant", reason: "typo" } as never).catch(error => ({ status: "rejected", code: (error as { code: string }).code }));
    assert.equal(refused.status, "rejected", `${bad} is refused`);
    assert.equal((refused as { code: string }).code, bad === "" ? "INVALID_COMMAND" : "REASONING_EFFORT_UNKNOWN", `${JSON.stringify(bad)} is refused as an unknown level, not for some other reason`);
  }
  await revise(fresh, "deepseek/deepseek-flash", "low");                  // a spelled level is accepted
  assert.equal((await profileOf(fresh)).executionProfile!.revision.reasoningEffort, "low");
});
