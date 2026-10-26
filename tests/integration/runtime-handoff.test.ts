import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal } from "@evoloop/contracts";


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
if (!url || !/evoloop_runtime_handoff_test/.test(new URL(url).pathname)) {
  throw new Error("dedicated evoloop_runtime_handoff_test database required");
}
const schema = `el_runtime_handoff_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
const owner: Principal = { actorId: "handoff-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
const firstObserver: Principal = { actorId: "consumer-alpha", projectIds: [projectId], permissions: ["read", "write"] };
const secondObserver: Principal = { actorId: "consumer-beta", projectIds: [projectId], permissions: ["read", "write"] };
const readOnlyObserver: Principal = { actorId: "consumer-readonly", projectIds: [projectId], permissions: ["read"] };
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
const forbidden = (action: () => Promise<unknown>) =>
  assert.rejects(action, error => (error as { code?: string }).code === "FORBIDDEN");

test("runtime handoff receipts are ordered, actor-attributed observations", async t => {
  await migrate(url, schema);
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: url });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });

  applied(await issue(owner, { type: "project.create", title: "Runtime handoff integration" }));
  const documentId = randomUUID();
  const document = applied(await issue(owner, { type: "document.create", documentId, title: "Handoff requirement", body: "Accepted basis" }));
  applied(await issue(owner, { type: "document.adopt", documentId, expectedVersion: 1,
    revisionId: document.revisionId, reason: "Initial basis" }));
  const taskId = randomUUID();
  applied(await issue(owner, { type: "task.create", taskId, title: "Produce output", content: "# One result",
    acceptance: "Inspect the result", owner: owner.actorId, documentIds: [documentId], evidence: "Accepted requirement" }));
  const taskReady = applied(await issue(owner, { type: "task.start", taskId, expectedVersion: 1,
    basis: [{ documentId, revisionId: document.revisionId }], reason: "Begin work" }));

  const sessionId = randomUUID();
  const cwd = "/tmp/evoloop-runtime-handoff";
  const authorizationScope = "project-workspace:handoff-test";
  applied(await issue(owner, { type: "runtime.session.reserve", sessionId, roleId: owner.actorId, cwd,
    authorizationScope, sandbox: "workspace-write", approvalPolicy: "on-request" }));
  await runtime.beginSessionCreate(projectId, sessionId);
  await runtime.bindSession(projectId, sessionId, { owner: "evoloop-codex-app-server", projectId, sessionId,
    roleId: owner.actorId, cwd, authorizationScope, nativeThreadId: "handoff-thread", nativeSessionId: "handoff-session" });

  const runId = randomUUID();
  const runReceipt = applied(await issue(owner, { type: "runtime.run.reserve", runId, taskId, sessionId,
    expectedVersion: taskReady.version, input: "Produce the result from the accepted basis" }));
  await runtime.beginDispatch(projectId, runId);
  rejected(await issue(firstObserver, { type: "runtime.handoff.record", runId,
    stage: "received", evidence: "Too early" }), "RUN_NOT_COMPLETED");
  await runtime.bindTurn(projectId, runId, { id: "handoff-turn", status: "running" },
    { kind: "startReply", operationId: runReceipt.operationId });
  assert.equal((await runtime.recordTurn(projectId, runId, "handoff-turn", "completed", "Run completed")).state, "completed");

  const foreignProject: Principal = { ...firstObserver, projectIds: [randomUUID()] };
  await forbidden(() => issue(foreignProject, { type: "runtime.handoff.record", runId,
    stage: "received", evidence: "Wrong project" }));
  await forbidden(() => issue(readOnlyObserver, { type: "runtime.handoff.record", runId,
    stage: "received", evidence: "Read-only role" }));

  const eventRows = () => workflow.listRuntimeEvents(owner, projectId, runId);
  const firstReceipt = { type: "runtime.handoff.record", runId, stage: "received", evidence: "Alpha received the native result" };
  const firstOperation = randomUUID();
  const received = applied(await issue(firstObserver, firstReceipt, firstOperation));
  assert.equal(received.entityId, runId);
  assert.deepEqual(await issue(firstObserver, firstReceipt, firstOperation), received, "same-operation replay is idempotent");
  assert.equal((await eventRows()).filter(event => event.kind === "handoff.received").length, 1,
    "same-operation replay does not append another observation");
  rejected(await issue(firstObserver, firstReceipt), "HANDOFF_ALREADY_RECORDED");
  rejected(await issue(firstObserver, { type: "runtime.handoff.record", runId, stage: "adopted",
    evidence: "Alpha skips the read stage" }), "HANDOFF_ORDER");

  rejected(await issue(secondObserver, { type: "runtime.handoff.record", runId, stage: "read",
    evidence: "Beta tries to borrow Alpha's receipt" }), "HANDOFF_ORDER");

  const stages = [
    ["read", "Alpha read the result"],
    ["adopted", "Alpha adopted the result"],
    ["effect", "Alpha recorded the downstream effect"],
  ] as const;
  for (const [stage, evidence] of stages) {
    applied(await issue(firstObserver, { type: "runtime.handoff.record", runId, stage, evidence }));
  }

  const betaReceived = applied(await issue(secondObserver, { type: "runtime.handoff.record", runId,
    stage: "received", evidence: "Beta independently received the result" }));
  const betaRead = applied(await issue(secondObserver, { type: "runtime.handoff.record", runId,
    stage: "read", evidence: "Beta independently read the result" }));
  assert.equal(betaReceived.entityId, runId);
  assert.equal(betaRead.entityId, runId);

  const events = await eventRows();
  const handoffEvents = events.filter(event => event.kind.startsWith("handoff."));
  assert.equal(handoffEvents.length, 6, "rejected order attempts append no observations");
  const details = new Map(handoffEvents.map(event => [`${event.actorId}:${event.kind}`, event.detail]));
  assert.deepEqual([...details.entries()].sort(), [
    [`${firstObserver.actorId}:handoff.adopted`, "Attributed adopted receipt: Alpha adopted the result"],
    [`${firstObserver.actorId}:handoff.effect`, "Attributed effect receipt: Alpha recorded the downstream effect"],
    [`${firstObserver.actorId}:handoff.read`, "Attributed read receipt: Alpha read the result"],
    [`${firstObserver.actorId}:handoff.received`, "Attributed received receipt: Alpha received the native result"],
    [`${secondObserver.actorId}:handoff.read`, "Attributed read receipt: Beta independently read the result"],
    [`${secondObserver.actorId}:handoff.received`, "Attributed received receipt: Beta independently received the result"],
  ]);
  assert.ok(handoffEvents.every(event => event.nativeTurnId === "handoff-turn"));

  const task = await workflow.getTask(owner, projectId, taskId);
  assert.equal(task.task.state, "in_progress", "handoff receipts do not close the Task");
  assert.deepEqual(task.observations, [], "handoff receipts are not consumer observations");
  assert.equal((await workflow.getRuntimeRun(owner, projectId, runId)).state, "completed");
});
