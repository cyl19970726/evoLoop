// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import type { Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { configuredCliActorId, createRunRecipientGuard } from "../../apps/coordinator/src/runtime/recipient-preflight.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(database).pathname.slice(1))))
  throw new Error("run reserve real-entry test requires an isolated evoloop_*_test database");

/**
 * The real entry a Leader uses: HTTP POST /api/commands with a bearer token, the coordinator's own authorization and model checks, the
 * real guard factory the coordinator wires into the route (createRunRecipientGuard, fed by the real PostgreSQL unit of work and the real
 * material-CLI selection), and the real command path to the database. Only the two lookups that read the machine's private files
 * (the runtime grants and the model list) are fixed.
 */
async function setup(t: import("node:test").TestContext, cliActorId: string | null = null, runtimeGrant = true) {
  const schema = `el_reserve_entry_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const uow = new PostgresUnitOfWork(pool);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } };
  const service = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
  const projectId = randomUUID(), roleId = randomUUID(), roleRev = randomUUID(), sessionId = randomUUID();
  const token = randomUUID() + randomUUID();
  const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const run = async (command: Parameters<WorkflowService["execute"]>[1]) => {
    const result = await service.execute(lead, command); assert.equal(result.status, "applied", JSON.stringify(result)); return result;
  };
  await run({ type: "project.create", projectId, operationId: randomUUID(), title: "Reserve recipient real entry" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [projectId, roleId, roleRev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [projectId, roleId, roleRev]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
  await run({ type: "runtime.session.reserve", projectId, operationId: randomUUID(), sessionId, roleId, cwd: "/tmp/reserve-entry",
    authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(projectId, sessionId);
  const saved = (await uow.read(projectId, reader => reader.getRuntimeSession(sessionId)))!;
  await runtime.bindSession(projectId, sessionId, { owner: "evoloop-codex-app-server", projectId, sessionId, roleId, cwd: "/tmp/reserve-entry", authorizationScope: "project",
    nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`,
    resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  const model = saved.executionProfile?.revision.model ?? saved.model;

  // The private configuration's material-CLI entry for this Session, when the case has one (a brokered Session has none before its Run starts).
  const materialCli = cliActorId ? [{ projectId, sessionId, sessionActorId: saved.actorId, cliActorId }] : [];
  let guarded = 0;
  const guard = createRunRecipientGuard({ read: (project, fn) => uow.read(project, reader => fn(reader as never)),
    cliActorId: configuredCliActorId(async () => ({ runtime: { enabled: true, materialCli: materialCli as never } })) });
  const app = await buildServer({ service, credentials: [{ token, ...lead }], runtime: { status: () => ({ available: true, error: null, faults: [] }) } as never,
    listRuntimeModels: async () => ({ status: "available", models: model ? [model] : [], error: null, observedAtUtc: new Date().toISOString() }) as never,
    hasRuntimeGrant: () => runtimeGrant, requireRunRecipient: async (_principal, command, session) => { guarded++; return guard(command, session); } } as never);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  const reserve = async (taskId: string, expectedVersion: number) => {
    const runId = randomUUID();
    const response = await app.inject({ method: "POST", url: "/api/commands", headers, payload: { type: "runtime.run.reserve", projectId, operationId: randomUUID(),
      runId, taskId, sessionId, expectedVersion, input: "fixed input" } });
    return { response, runId, body: response.body };
  };
  const runRows = async () => Number((await pool.query("SELECT count(*)::int AS n FROM runtime_run WHERE project_id=$1", [projectId])).rows[0].n);
  const newTask = async (title: string, independent: boolean) => {
    const taskId = randomUUID();
    await run({ type: "task.create", projectId, operationId: randomUUID(), taskId, title, content: `# ${title}`, acceptance: "Result", owner: roleId,
      ...(independent ? { acceptanceMode: "independent_agent", consumer: "verifier", useRequired: true } : {}) } as never);
    return taskId;
  };
  const version = async (taskId: string) => (await uow.read(projectId, reader => reader.getTask(taskId)))!.version;
  const start = async (taskId: string) => run({ type: "task.start", projectId, operationId: randomUUID(), taskId, expectedVersion: await version(taskId), reason: "start" });
  const assign = async (taskId: string, recipient: string | null) => {
    const current = await service.getTaskAssignment(lead, projectId, taskId);
    return run({ type: "task.assignment.set", projectId, operationId: randomUUID(), taskId, expectedTaskVersion: await version(taskId),
      target: { kind: "owned", sessionId }, recipientActorId: recipient, expectedVersion: current?.version ?? 0, reason: "assign" } as never);
  };
  return { guardCalls: () => guarded, reserve, runRows, newTask, start, assign, version, projectId, sessionId };
}

test("a Run reserve for an independent-acceptance Task is refused at the real HTTP entry, naming the missing item and creating no Run", async t => {
  const rig = await setup(t, null);
  const task = await rig.newTask("Needs a fixed recipient", true);
  await rig.start(task);
  // 1. No assignment at all.
  let before = await rig.runRows();
  let attempt = await rig.reserve(task, await rig.version(task));
  assert.notEqual(attempt.response.statusCode, 200, attempt.body);
  assert.match(attempt.body, /ASSIGNMENT_MISSING/);
  assert.equal(await rig.runRows(), before, "no Run row was created");
  // 2. An assignment with no recipient.
  await rig.assign(task, null);
  attempt = await rig.reserve(task, await rig.version(task));
  assert.match(attempt.body, /RECIPIENT_UNBOUND/); assert.match(attempt.body, /没有固定执行接收者/);
  assert.equal(await rig.runRows(), before);
  // 3. The assignment goes stale when the Task moves on; the message says to assign again.
  await rig.assign(task, "worker");
  const second = await rig.newTask("Stale assignment", true);
  await rig.assign(second, "worker");
  await rig.start(second);
  attempt = await rig.reserve(second, await rig.version(second));
  assert.match(attempt.body, /ASSIGNMENT_STALE/); assert.match(attempt.body, /task\.assignment\.set/);
  assert.equal(await rig.runRows(), before);
  // 4. Assigned on the started revision with a recipient: the Run is reserved.
  attempt = await rig.reserve(task, await rig.version(task));
  assert.equal(attempt.response.statusCode, 200, attempt.body);
  assert.equal(await rig.runRows(), before + 1, "exactly one Run was reserved");
});

test("with a configured business CLI identity, an assignment to any other identity is refused; the matching one is accepted", async t => {
  const rig = await setup(t, "dev-claude-agent");
  const task = await rig.newTask("Signer must match", true);
  await rig.start(task);
  // The assignment names the Session creator's identity, not the identity that signs deliveries.
  await rig.assign(task, "target-owner");
  const before = await rig.runRows();
  const refused = await rig.reserve(task, await rig.version(task));
  assert.notEqual(refused.response.statusCode, 200, refused.body);
  assert.match(refused.body, /RECIPIENT_UNBOUND/); assert.match(refused.body, /target-owner/); assert.match(refused.body, /dev-claude-agent/);
  assert.equal(await rig.runRows(), before, "no Run row was created");
  await rig.assign(task, "dev-claude-agent");
  const accepted = await rig.reserve(task, await rig.version(task));
  assert.equal(accepted.response.statusCode, 200, accepted.body);
  assert.equal(await rig.runRows(), before + 1);
});

test("a Task created without naming an acceptance mode is independent acceptance by default, so the guard applies", async t => {
  const rig = await setup(t, null);
  const created = await rig.newTask("Default mode", false);
  await rig.start(created);
  const before = await rig.runRows();
  const guarded = await rig.reserve(created, await rig.version(created));
  assert.match(guarded.body, /ASSIGNMENT_MISSING/, "the default mode is independent_agent");
  assert.equal(await rig.runRows(), before);
  // A Task with no recorded mode (older data; workflow history is append-only, so it cannot be made here) is exempt: see recipient-preflight.test.ts.
});

test("a caller without the runtime execution grant is stopped by authorization first: 403, the recipient guard is not consulted, no Run", async t => {
  const rig = await setup(t, null, false);
  const task = await rig.newTask("Not authorized", true);
  await rig.start(task);
  const before = await rig.runRows();
  const attempt = await rig.reserve(task, await rig.version(task));
  assert.equal(attempt.response.statusCode, 403, attempt.body);
  assert.match(attempt.body, /FORBIDDEN/);
  assert.equal(rig.guardCalls(), 0, "the recipient check runs after authorization, never instead of it");
  assert.equal(await rig.runRows(), before);
});
