// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService, mergeRunActual } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { describeRunActual } from "@evoloop/contracts/run-actual";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

/**
 * Task f9e0fd58: what the runtime reported about a Run's Turn (the model that answered, the effort in force, the subagents' models) is
 * recorded beside the configured profile and read back; a value that was not observed is null ("未记录"), never the configured one.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_actual_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } };
const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID();
const lead: Principal = { actorId: "lead", projectIds: [p], permissions: ["read", "write", "review"] };

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(lead, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Run actual model" });
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
}
/** A ready Session configured with `model` (an alias, as a Claude Session is), one started Task and a requested Run on it. */
async function fixture(model: string) {
  const sessionId = randomUUID(), taskId = randomUUID(), runId = randomUUID();
  await apply({ type: "runtime.session.reserve", sessionId, roleId: role, cwd: "/tmp/actual", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never", model });
  await runtime.beginSessionCreate(p, sessionId);
  const saved = (await uow.read(p, r => r.getRuntimeSession(sessionId)))!;
  await runtime.bindSession(p, sessionId, { owner: "evoloop-codex-app-server", projectId: p, sessionId, roleId: role, cwd: "/tmp/actual", authorizationScope: "project",
    nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`, resumeProfile: { actorId: saved.actorId, model: saved.executionProfile!.revision.model, sandbox: saved.sandbox,
      approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  await apply({ type: "task.create", taskId, title: "Actual model", content: "# T", acceptance: "ok", owner: role });
  await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
  const task = (await uow.read(p, r => r.getTask(taskId)))!;
  await apply({ type: "runtime.run.reserve", runId, taskId, sessionId, expectedVersion: task.version, input: "fixed input" });
  const run = (await uow.read(p, r => r.getRuntimeRun(runId)))!;
  return { sessionId, runId, operationId: run.operationId };
}
const runOf = (id: string) => uow.read(p, r => r.getRuntimeRun(id)).then(x => x!);
const sessionOf = (id: string) => uow.read(p, r => r.getRuntimeSession(id)).then(x => x!);

test("a Claude-style Run learns its exact model only at the terminal Turn; the configured alias is never shown as actual", async () => {
  const f = await fixture("opus");
  await runtime.beginDispatch(p, f.runId);
  await runtime.bindTurn(p, f.runId, { id: `turn-${f.runId}`, status: "inProgress" }, { kind: "startReply", operationId: f.operationId });
  let run = await runOf(f.runId);
  assert.equal(run.actual ?? null, null, "bound, nothing observed yet");
  assert.deepEqual(describeRunActual(run), { model: "未记录", reasoningEffort: "未记录", subagentModels: [], configuredModel: "opus", configuredEffort: null, recorded: false });
  assert.equal((await sessionOf(f.sessionId)).actualModel ?? null, null, "the Session has no actual model either");
  await runtime.recordTurn(p, f.runId, `turn-${f.runId}`, "completed", "done", { completedAtUtc: new Date().toISOString(),
    observedModel: "claude-opus-5-5", subagentModels: ["claude-haiku-4-5", "claude-haiku-4-5"] });
  run = await runOf(f.runId);
  assert.deepEqual(run.actual, { model: "claude-opus-5-5", reasoningEffort: null, subagentModels: ["claude-haiku-4-5"] });
  const view = describeRunActual(run);
  assert.equal(view.model, "claude-opus-5-5"); assert.equal(view.reasoningEffort, "未记录", "an effort nobody reported is not filled in");
  assert.equal(view.configuredModel, "opus", "the configured alias stays beside it, labelled as configured");
  const session = await sessionOf(f.sessionId);
  assert.equal(session.actualModel, "claude-opus-5-5"); assert.ok(session.actualModelAt);
  assert.equal(session.model, "opus", "the configuration is untouched");
});

test("a Codex-style Run records the model and effort the Thread reported at the start; a failed read stays null and keeps an earlier value", async () => {
  const f = await fixture("deepseek/deepseek-flash");
  await runtime.beginDispatch(p, f.runId);
  await runtime.bindTurn(p, f.runId, { id: `turn-${f.runId}`, status: "inProgress", observedModel: "deepseek/deepseek-flash-0610", observedReasoningEffort: "max" },
    { kind: "startReply", operationId: f.operationId });
  let run = await runOf(f.runId);
  assert.deepEqual(run.actual, { model: "deepseek/deepseek-flash-0610", reasoningEffort: "max", subagentModels: [] });
  // The terminal record says nothing about the model (Codex reports it at the start): what was recorded stays.
  await runtime.recordTurn(p, f.runId, `turn-${f.runId}`, "completed", "done", { completedAtUtc: new Date().toISOString() });
  run = await runOf(f.runId);
  assert.equal(run.actual?.model, "deepseek/deepseek-flash-0610");
  // A readback that failed reports null for both: nothing is invented, and the view says 未记录.
  const g = await fixture("deepseek/deepseek-flash");
  await runtime.beginDispatch(p, g.runId);
  await runtime.bindTurn(p, g.runId, { id: `turn-${g.runId}`, status: "inProgress", observedModel: null, observedReasoningEffort: null }, { kind: "startReply", operationId: g.operationId });
  const unread = await runOf(g.runId);
  assert.deepEqual(unread.actual, { model: null, reasoningEffort: null, subagentModels: [] });
  assert.equal(describeRunActual(unread).recorded, false);
  assert.equal(describeRunActual(unread).model, "未记录");
  assert.equal((await sessionOf(g.sessionId)).actualModel ?? null, null);
});

test("mergeRunActual: a reported value replaces, an unreported or unread one keeps the record, nothing comes from elsewhere", () => {
  assert.equal(mergeRunActual(null, {}), null);
  const first = mergeRunActual(null, { model: "m1", subagentModels: ["b", "a"] })!;
  assert.deepEqual(first, { model: "m1", reasoningEffort: null, subagentModels: ["a", "b"] });
  assert.deepEqual(mergeRunActual(first, { model: null, reasoningEffort: "high" }), { model: "m1", reasoningEffort: "high", subagentModels: ["a", "b"] });
  assert.deepEqual(mergeRunActual(first, { model: "m2" }), { model: "m2", reasoningEffort: null, subagentModels: ["a", "b"] });
  assert.equal(mergeRunActual(first, {}), first);
});

test("migration 099: historical Runs have no actual record and the shape is enforced", async () => {
  const f = await fixture("opus");
  assert.equal((await pool.query("SELECT actual FROM runtime_run WHERE run_id=$1", [f.runId])).rows[0].actual, null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM runtime_session_actual_model WHERE session_id=$1", [f.sessionId])).rows[0].n, 0, "no Session model recorded for a historical Session");
  // A shape that leaves a field out cannot be stored through the service path either (the column check rejects it).
  await assert.rejects(pool.query("ALTER TABLE runtime_run DISABLE TRIGGER USER").then(() => pool.query("UPDATE runtime_run SET actual='{\"model\":\"x\"}'::jsonb WHERE run_id=$1", [f.runId])).finally(() => pool.query("ALTER TABLE runtime_run ENABLE TRIGGER USER")), /check/i);
});

test("the Session snapshot reads the actual model from what a Turn reported, not from the configuration", async () => {
  const { SessionObservationService } = await import("@evoloop/core/session-observation");
  const service = new SessionObservationService({ uow });
  const reader: Principal = { actorId: "lead", projectIds: [p], permissions: ["read", "write", "review"] };
  const f = await fixture("opus");
  const before = (await service.snapshot(reader, p, `owned:${f.sessionId}`)).resources;
  assert.equal(before.configuredModel.value, "opus");
  assert.equal(before.actualModel.value, null, "nothing reported yet: not the configured alias");
  assert.match(before.actualModel.unavailableReason ?? "", /不用配置值代替/);
  await runtime.beginDispatch(p, f.runId);
  await runtime.bindTurn(p, f.runId, { id: `turn-${f.runId}`, status: "inProgress" }, { kind: "startReply", operationId: f.operationId });
  await runtime.recordTurn(p, f.runId, `turn-${f.runId}`, "completed", "done", { completedAtUtc: new Date().toISOString(), observedModel: "claude-opus-5-5" });
  const after = (await service.snapshot(reader, p, `owned:${f.sessionId}`)).resources;
  assert.equal(after.actualModel.value, "claude-opus-5-5"); assert.equal(after.actualModel.source, "runtime_session.actual_model");
  assert.equal(after.configuredModel.value, "opus", "the configured alias is still shown as configured");
  assert.ok(after.actualModel.observedAt);
});
