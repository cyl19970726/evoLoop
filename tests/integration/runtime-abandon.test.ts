import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import { runner } from "node-pg-migrate";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal, RuntimeBinding } from "@evoloop/contracts";


function withPersistedResumeProfile(runtime: RuntimeWorkflowService, uow: PostgresUnitOfWork): RuntimeWorkflowService {
  const bind = runtime.bindSession.bind(runtime);
  runtime.bindSession = async (projectId, sessionId, binding) => {
    const saved = await uow.read(projectId, reader => reader.getRuntimeSession(sessionId));
    const profile = saved?.executionProfile;
    if (!saved || !profile) throw new Error("fixture Session execution profile unavailable");
    return bind(projectId, sessionId, { ...binding, resumeProfile: { actorId: saved.actorId, model: saved.model,
      sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: profile.revision.revisionId } });
  };
  return runtime;
}
const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z0-9_]*test$/.test(new URL(url).pathname)) {
  throw new Error("dedicated evoloop_runtime_abandon_test database required");
}
const schema = `el_runtime_abandon_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const deps = {
  uow,
  clock: { now: () => new Date().toISOString() },
  ids: { next: randomUUID },
  hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") },
};
const workflow = new WorkflowService(deps);
const runtime = new RuntimeWorkflowService(deps);
withPersistedResumeProfile(runtime,uow);
const projectId = randomUUID();
const reviewer: Principal = { actorId: "runtime-reviewer", projectIds: [projectId], permissions: ["read", "review"] };
const writer: Principal = { actorId: "runtime-writer", projectIds: [projectId], permissions: ["read", "write"] };
const issue = async (principal: Principal, data: Record<string, unknown>, operationId = randomUUID()): Promise<CommandResult> =>
  workflow.execute(principal, { ...data, projectId, operationId } as Command);
const applied = (result: CommandResult) => {
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result as Extract<CommandResult, { status: "applied" }>;
};
const rejected = (result: CommandResult, code: string) => {
  assert.equal(result.status, "rejected", JSON.stringify(result));
  if (result.status === "rejected") assert.equal(result.code, code);
};

test("reviewers can abandon only uncertain unbound read-only runs while preserving the record", async t => {
  const migrations=fileURLToPath(new URL("../../packages/adapter-postgres/migrations/",import.meta.url));
  await runner({databaseUrl:url,dir:migrations,migrationsTable:"pgmigrations",schema,
    createSchema:true,createMigrationsSchema:true,direction:"up",singleTransaction:true,count:34,log:()=>{}});
  await pool.query("ALTER TABLE task_proposal ADD COLUMN acceptance_mode text; ALTER TABLE delivery ADD COLUMN submitted_by_actor_id text");
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: url });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });

  const owner: Principal = { actorId: "runtime-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const create = async (principal: Principal, data: Record<string, unknown>) => applied(await issue(principal, data));
  const own = (data: Record<string, unknown>) => create(owner, data);
  await own({ type: "project.create", title: "Runtime abandon integration" });
  const ownerRoleId=fixtureRoleId("runtime-owner");
  await seedFixtureRole(pool,projectId,ownerRoleId);
  const documentId = randomUUID();
  const document = await own({ type: "document.create", documentId, title: "Runtime requirement", body: "Accepted basis" });
  await own({ type: "document.adopt", documentId, expectedVersion: 1, revisionId: document.revisionId, reason: "Initial basis" });

  const readyTask = async (title: string) => {
    const taskId = randomUUID();
    await own({ type: "task.create", taskId, title, content: "# Produce one result", acceptance: "Inspect the result", owner: ownerRoleId, documentIds: [documentId], evidence: "Accepted requirement" });
    const ready = await own({ type: "task.start", taskId, expectedVersion: 1, basis: [{ documentId, revisionId: document.revisionId }], reason: "Begin work" });
    return { taskId, version: ready.version! };
  };

  const session = async (label: string, bind = true) => {
    const sessionId = randomUUID();
    const cwd = `/tmp/evoloop-runtime-abandon/${label}`;
    const authorizationScope = `project-workspace:${label}`;
    await own({ type: "runtime.session.reserve", sessionId, roleId: ownerRoleId, cwd, authorizationScope,
      sandbox: "danger-full-access", approvalPolicy: "never" });
    await runtime.beginSessionCreate(projectId, sessionId);
    if (bind) {
      const binding: RuntimeBinding = { owner: "evoloop-codex-app-server", projectId, sessionId, roleId: ownerRoleId, cwd, authorizationScope,
        nativeThreadId: `thread-${label}`, nativeSessionId: `session-${label}` };
      await runtime.bindSession(projectId, sessionId, binding);
    }
    return sessionId;
  };

  const historicalUncertainRun = async (sandbox: "read-only" | "workspace-write", label: string, bindNativeTurn = false) => {
    const task = await readyTask(`Run ${label}`);
    const sessionId=randomUUID(),runId=randomUUID(),operationId=randomUUID();
    const cwd=`/tmp/evoloop-runtime-abandon/${label}`,authorizationScope=`project-workspace:${label}`;
    const fixed=await workflow.getTask(owner,projectId,task.taskId);
    assert.ok(fixed.basis?.id);
    const now=new Date().toISOString(),input=`Run ${label}`,nativeTurnId=bindNativeTurn?`turn-${label}`:null;
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,'runtime-owner',$3,$4,$5,'on-request','ready',3,$6,$7,$8,'runtime-owner',$9,$9)`,
      [projectId,sessionId,cwd,authorizationScope,sandbox,`thread-${label}`,`session-${label}`,randomUUID(),now]);
    await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
      operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unknown',$10,$11,'runtime-owner',$12,$12)`,
      [projectId,runId,task.taskId,fixed.revision.id,fixed.basis.id,sessionId,operationId,input,deps.hasher.hash(input),
        bindNativeTurn?4:3,nativeTurnId,now]);
    await pool.query(`INSERT INTO runtime_record_event(project_id,event_id,run_id,session_id,kind,detail,native_turn_id,
      actor_id,created_at) VALUES($1,$2,$3,$4,'run.unknown',$5,$6,'runtime-coordinator',$7)`,
      [projectId,randomUUID(),runId,sessionId,`Coordinator lost the start result for ${label}`,nativeTurnId,now]);
    return {task,sessionId,runId};
  };

  // These three historical operations were persisted before the full-policy
  // migration; current commands must never manufacture a new read-only Run.
  const eligible=await historicalUncertainRun("read-only","eligible");
  const writable=await historicalUncertainRun("workspace-write","workspace-write");
  const knownTurn=await historicalUncertainRun("read-only","known-turn",true);
  await pool.query("ALTER TABLE task_proposal DROP COLUMN acceptance_mode; ALTER TABLE delivery DROP COLUMN submitted_by_actor_id");
  await migrate(url,schema);
  assert.equal((await workflow.getRuntimeRun(owner,projectId,eligible.runId)).executionProfile?.sandbox,"read-only");
  const beforeRunEvents = await workflow.listRuntimeEvents(owner, projectId, eligible.runId);
  const beforeSessionEvents = await workflow.listRuntimeSessionEvents(owner, projectId, eligible.sessionId);
  const stale = { type: "runtime.run.abandonReadOnly", runId: eligible.runId, expectedVersion: 2, reason: "Reviewed", evidence: "Start response unavailable" };
  rejected(await issue(reviewer, stale), "VERSION_CONFLICT");
  assert.equal((await workflow.getRuntimeRun(owner, projectId, eligible.runId)).state, "unknown", "version conflict leaves the run untouched");

  const command = { type: "runtime.run.abandonReadOnly", runId: eligible.runId, expectedVersion: 3,
    reason: "Reviewed the unresolved read-only dispatch", evidence: "No owned native turn ID was recorded" };
  await assert.rejects(() => issue(writer, command), error => (error as { code?: string }).code === "FORBIDDEN");
  await assert.rejects(() => issue({ ...reviewer, projectIds: [randomUUID()] }, command), error => (error as { code?: string }).code === "FORBIDDEN");
  const reviewOperationId = randomUUID();
  const appliedResult = applied(await issue(reviewer, command, reviewOperationId));
  assert.equal(appliedResult.entityId, eligible.runId);
  assert.equal(appliedResult.version, 4);

  const runAfter = await workflow.getRuntimeRun(owner, projectId, eligible.runId);
  const sessionAfter = await workflow.getRuntimeSession(owner, projectId, eligible.sessionId);
  assert.equal(runAfter.state, "failed");
  assert.equal(runAfter.version, 4);
  assert.equal(runAfter.nativeTurnId, null);
  assert.match(runAfter.resultSummary ?? "", /not proof of external completion or non-execution/i);
  assert.match(runAfter.resultSummary ?? "", /Reviewed the unresolved read-only dispatch/);
  assert.match(runAfter.resultSummary ?? "", /No owned native turn ID was recorded/);
  assert.equal(sessionAfter.state, "closed", "the uncertain native session cannot dispatch again");
  assert.equal(sessionAfter.version, 4);

  const afterRunEvents = await workflow.listRuntimeEvents(owner, projectId, eligible.runId);
  const afterSessionEvents = await workflow.listRuntimeSessionEvents(owner, projectId, eligible.sessionId);
  assert.deepEqual(afterRunEvents.slice(0, beforeRunEvents.length), beforeRunEvents, "earlier run records remain immutable");
  assert.deepEqual(afterSessionEvents.slice(0, beforeSessionEvents.length), beforeSessionEvents, "earlier session records remain immutable");
  const reviewed = afterRunEvents.filter(event => event.kind === "run.reviewed");
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0]?.actorId, reviewer.actorId);
  assert.equal(reviewed[0]?.nativeTurnId, null);
  assert.match(reviewed[0]?.detail ?? "", /not proof of external completion or non-execution/i);
  assert.match(reviewed[0]?.detail ?? "", /Reason: Reviewed the unresolved read-only dispatch/);
  assert.match(reviewed[0]?.detail ?? "", /Evidence: No owned native turn ID was recorded/);
  assert.ok(afterRunEvents.some(event => event.kind === "run.unknown" && /lost the start result/.test(event.detail)),
    "the original uncertainty evidence is retained");

  const replay = applied(await issue(reviewer, command, reviewOperationId));
  assert.deepEqual(replay, appliedResult, "replaying the review returns its original receipt");
  assert.equal((await workflow.listRuntimeEvents(owner, projectId, eligible.runId)).filter(event => event.kind === "run.reviewed").length, 1,
    "replay does not rewrite or duplicate the immutable review event");
  await assert.rejects(runtime.recordTurn(projectId, eligible.runId, "unrecorded-turn", "completed"), /does not match/);
  assert.equal((await workflow.getRuntimeRun(owner, projectId, eligible.runId)).state, "failed",
    "a coordinator callback cannot rewrite a reviewed run without a matching native turn");

  const closedSessionRun = randomUUID();
  rejected(await issue(owner, { type: "runtime.run.reserve", runId: closedSessionRun, taskId: eligible.task.taskId,
    sessionId: eligible.sessionId, expectedVersion: eligible.task.version + 1, input: "Must require a fresh session" }), "SESSION_NOT_READY");
  const unboundSessionId = await session("unbound", false);
  rejected(await issue(owner, { type: "runtime.run.reserve", runId: randomUUID(), taskId: eligible.task.taskId,
    sessionId: unboundSessionId, expectedVersion: eligible.task.version + 1, input: "Reserved session is insufficient" }), "SESSION_NOT_READY");
  const freshSessionId = await session("fresh-ready");
  applied(await issue(owner, { type: "runtime.run.reserve", runId: randomUUID(), taskId: eligible.task.taskId,
    sessionId: freshSessionId, expectedVersion: eligible.task.version, input: "A new run needs a ready authorized session" }));

  const pendingTask = await readyTask("Run not yet dispatched");
  const pendingSessionId = await session("not-dispatched");
  const pendingRunId = randomUUID();
  await issue(owner, { type: "runtime.run.reserve", runId: pendingRunId, taskId: pendingTask.taskId,
    sessionId: pendingSessionId, expectedVersion: pendingTask.version, input: "Still only requested" });
  rejected(await issue(reviewer, { type: "runtime.run.abandonReadOnly", runId: pendingRunId, expectedVersion: 1,
    reason: "Review", evidence: "Run has not become uncertain" }), "RUN_NOT_ABANDONABLE");
  assert.equal((await workflow.getRuntimeRun(owner, projectId, pendingRunId)).state, "requested");
  assert.equal((await workflow.getRuntimeSession(owner, projectId, pendingSessionId)).state, "ready");

  rejected(await issue(reviewer, { type: "runtime.run.abandonReadOnly", runId: writable.runId, expectedVersion: 3,
    reason: "Review", evidence: "Must not abandon writable session" }), "RUN_NOT_ABANDONABLE");
  assert.equal((await workflow.getRuntimeRun(owner, projectId, writable.runId)).state, "unknown");
  assert.equal((await workflow.getRuntimeSession(owner, projectId, writable.sessionId)).state, "ready");

  assert.equal((await workflow.getRuntimeRun(owner, projectId, knownTurn.runId)).nativeTurnId, "turn-known-turn");
  rejected(await issue(reviewer, { type: "runtime.run.abandonReadOnly", runId: knownTurn.runId, expectedVersion: 4,
    reason: "Review", evidence: "A native turn is known" }), "RUN_NOT_ABANDONABLE");
  assert.equal((await workflow.getRuntimeRun(owner, projectId, knownTurn.runId)).state, "unknown");
  assert.equal((await workflow.getRuntimeSession(owner, projectId, knownTurn.sessionId)).state, "ready");
});
