import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal } from "@evoloop/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/evoloop_runtime_test/.test(new URL(url).pathname)) {
  throw new Error("dedicated evoloop_runtime_test database required");
}
const schema = `el_runtime_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
const projectId = randomUUID();
const principal: Principal = { actorId: "runtime-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
const issue = async (data: Record<string, unknown>, operationId = randomUUID()): Promise<CommandResult> =>
  workflow.execute(principal, { ...data, projectId, operationId } as Command);
const applied = (result: CommandResult) => {
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result as Extract<CommandResult, { status: "applied" }>;
};
const rejected = (result: CommandResult, code: string) => {
  assert.equal(result.status, "rejected", JSON.stringify(result));
  if (result.status === "rejected") assert.equal(result.code, code);
};

test("runtime reservations freeze task basis and recover uncertain native starts without replay", async t => {
  await migrate(url, schema);
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: url });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });

  applied(await issue({ type: "project.create", title: "Runtime integration" }));
  const documentId = randomUUID();
  const document = applied(await issue({ type: "document.create", documentId, title: "Requirement", body: "Original basis" }));
  applied(await issue({ type: "document.adopt", documentId, expectedVersion: 1, revisionId: document.revisionId, reason: "Initial basis" }));
  const taskId = randomUUID();
  applied(await issue({ type: "task.create", taskId, title: "Produce output", content: "# One artifact\nProduce output from the fixed source.", acceptance: "Review output", owner: "runtime-owner", documentIds: [documentId], evidence: "Accepted requirement" }));
  const ready = applied(await issue({ type: "task.start", taskId, expectedVersion: 1, basis: [{ documentId, revisionId: document.revisionId }], reason: "Begin work" }));
  const otherTaskId = randomUUID();
  applied(await issue({ type: "task.create", taskId: otherTaskId, title: "Second output", content: "# One artifact\nProduce another output.", acceptance: "Review output", owner: "runtime-owner", documentIds: [documentId], evidence: "Second accepted requirement" }));
  applied(await issue({ type: "task.start", taskId: otherTaskId, expectedVersion: 1, basis: [{ documentId, revisionId: document.revisionId }], reason: "Begin second task" }));

  const sessionId = randomUUID();
  const sessionOperation = randomUUID();
  const reserveSession = { type: "runtime.session.reserve", sessionId, roleId: "runtime-owner", cwd: "/tmp/evoloop-runtime-test", authorizationScope: "project-workspace", sandbox: "workspace-write", approvalPolicy: "on-request" };
  const sessionReceipt = applied(await issue(reserveSession, sessionOperation));
  assert.deepEqual(await issue(reserveSession, sessionOperation), sessionReceipt);
  assert.equal((await runtime.beginSessionCreate(projectId, sessionId)).state, "creating");
  await runtime.recordSessionApprovalDeclined(projectId, sessionId, "owned-thread-1", null, "Approval declined before durable native binding");
  assert.equal((await workflow.listRuntimeSessionEvents(principal, projectId, sessionId)).some(e => e.kind === "runtime.approvalDeclined"), true);
  await assert.rejects(runtime.beginSessionCreate(projectId, sessionId), /already attempted/);
  assert.deepEqual(await runtime.recoverDispatching(projectId), { sessions: [sessionId], runs: [] });
  const binding = { owner: "evoloop-codex-app-server" as const, projectId, sessionId, roleId: "runtime-owner", cwd: "/tmp/evoloop-runtime-test", authorizationScope: "project-workspace", nativeThreadId: "owned-thread-1", nativeSessionId: "owned-session-1" };
  await assert.rejects(runtime.bindSession(projectId, sessionId, { ...binding, projectId: randomUUID() }), /does not match/);
  assert.equal((await runtime.bindSession(projectId, sessionId, binding)).state, "ready");
  await assert.rejects(runtime.recordSessionApprovalDeclined(projectId, sessionId, "foreign-thread", null, "Invalid"), /owned thread/);
  assert.equal((await workflow.getRuntimeSession(principal, projectId, sessionId)).nativeThreadId, "owned-thread-1");

  const runId = randomUUID();
  const runOperation = randomUUID();
  const reserveRun = { type: "runtime.run.reserve", runId, taskId, sessionId, expectedVersion: ready.version, input: "Produce the artifact from the sealed requirement" };
  rejected(await issue({ ...reserveRun, expectedVersion: ready.version + 1 }), "VERSION_CONFLICT");
  const runReceipt = applied(await issue(reserveRun, runOperation));
  assert.deepEqual(await issue(reserveRun, runOperation), runReceipt);
  const run = await workflow.getRuntimeRun(principal, projectId, runId);
  const frozen = await workflow.getTaskRevision(principal, projectId, taskId, run.taskRevisionId);
  assert.equal(frozen.revision.state, "in_progress");
  assert.equal(frozen.basis?.id, run.basisSetId);
  assert.equal(frozen.basis?.members.find(x => x.documentId === documentId)?.revisionId, document.revisionId);
  assert.equal(frozen.revision.content, "# One artifact\nProduce output from the fixed source.");
  assert.notEqual(run.taskRevisionId, ready.revisionId);
  rejected(await issue({ ...reserveRun, runId: randomUUID() }), "VERSION_CONFLICT");
  rejected(await issue({ ...reserveRun, runId: randomUUID(), taskId: otherTaskId }), "SESSION_BUSY");
  assert.equal((await runtime.beginDispatch(projectId, runId)).state, "dispatching");
  assert.deepEqual(await runtime.recoverDispatching(projectId), { sessions: [], runs: [runId] });
  await assert.rejects(runtime.beginDispatch(projectId, runId), /already attempted/);
  await assert.rejects(runtime.bindTurn(projectId, runId, { id: "turn-1", status: "running" }, { kind: "startReply", operationId: runOperation }), /history/);
  await assert.rejects(runtime.bindTurn(projectId, runId, { id: "turn-1", status: "running" }, { kind: "historyMarker", operationId: randomUUID() }), /durable dispatch/);
  assert.equal((await runtime.bindTurn(projectId, runId, { id: "turn-1", status: "running" }, { kind: "historyMarker", operationId: runOperation })).state, "running");
  await assert.rejects(runtime.recordTurn(projectId, runId, "foreign-turn", "completed"), /does not match/);
  const inFlight = await workflow.getRuntimeRun(principal, projectId, runId);
  const taskDuringRun = await workflow.getTask(principal, projectId, taskId);
  const unsafeReopen = await issue({ type: "task.reopen", taskId, expectedVersion: taskDuringRun.task.version,
    reason: "Cannot change the executing input" });
  assert.equal(unsafeReopen.status, "rejected", "an in-flight Run must keep its fixed Task input");
  assert.equal((await workflow.getTask(principal, projectId, taskId)).task.contentRevisionId,
    taskDuringRun.task.contentRevisionId);
  await assert.rejects(runtime.reconcileTerminalObservation(projectId, runId, "turn-1", "completed", "Too early",
    { itemsDigest: "a".repeat(64), completedAtUtc: "2026-10-20T12:00:00.000Z" }, inFlight.version,
    principal, "Native turn has not finished"), /only a terminal bound run/);
  const interruptOperation = randomUUID();
  const interrupt = { type: "runtime.run.interrupt", runId, reason: "Stop the current turn" };
  const interruptReceipt = applied(await issue(interrupt, interruptOperation));
  assert.deepEqual(await issue(interrupt, interruptOperation), interruptReceipt);
  await runtime.recordInterruptResult(projectId, runId, "acknowledged", "Native interrupt RPC accepted");
  await assert.rejects(runtime.recordApprovalDeclined(projectId, runId, "foreign-turn", "Declined"), /another turn/);
  await runtime.recordApprovalDeclined(projectId, runId, "turn-1", "Escalated approval was declined");
  const firstTerminal = await runtime.recordTurn(projectId, runId, "turn-1", "interrupted", "Premature native list observation", { cursor: "cursor-1", itemsDigest: "sha256:items" });
  const oldEvents = await workflow.listRuntimeEvents(principal, projectId, runId);
  const oldTask = await workflow.getTask(principal, projectId, taskId);
  const reviewer: Principal = { actorId: "runtime-reviewer", projectIds: [projectId], permissions: ["read", "review"] };
  const checkpoint = { itemsDigest: "a".repeat(64), completedAtUtc: "2026-10-20T12:00:00.000Z" };
  await assert.rejects(runtime.reconcileTerminalObservation(projectId, runId, "foreign-turn", "completed", "Confirmed", checkpoint,
    firstTerminal.version, reviewer, "Native history completed later"), /does not match bound run/);
  await assert.rejects(runtime.reconcileTerminalObservation(projectId, runId, "turn-1", "completed", "Confirmed", checkpoint,
    firstTerminal.version + 1, reviewer, "Native history completed later"), /run changed/);
  await assert.rejects(runtime.reconcileTerminalObservation(projectId, runId, "turn-1", "completed", "Confirmed", checkpoint,
    firstTerminal.version, { ...reviewer, permissions: ["read"] }, "Native history completed later"), /review permission/);
  await assert.rejects(runtime.reconcileTerminalObservation(projectId, runId, "turn-1", "completed", "Confirmed", checkpoint,
    firstTerminal.version, { ...reviewer, projectIds: [randomUUID()] }, "Native history completed later"), /review permission/);
  await assert.rejects(runtime.reconcileTerminalObservation(projectId, runId, "turn-1", "completed", "Confirmed",
    { ...checkpoint, completedAtUtc: "not-a-date" }, firstTerminal.version, reviewer, "Invalid native timestamp"), /completed UTC/);
  const completed = await runtime.reconcileTerminalObservation(projectId, runId, "turn-1", "completed", "Native turn completed",
    checkpoint, firstTerminal.version, reviewer, "Native list now has a final completedAt timestamp");
  assert.equal(completed.state, "completed");
  assert.equal(completed.version, firstTerminal.version + 1);
  assert.deepEqual(await workflow.getTask(principal, projectId, taskId), oldTask, "terminal reconciliation does not change the task or basis");
  const reconciledEvents = await workflow.listRuntimeEvents(principal, projectId, runId);
  assert.deepEqual(reconciledEvents.slice(0, oldEvents.length), oldEvents, "the earlier terminal observation remains immutable");
  assert.equal(reconciledEvents.at(-1)?.kind, "run.reconciled");
  assert.equal(reconciledEvents.at(-1)?.actorId, reviewer.actorId);
  assert.equal(reconciledEvents.at(-1)?.itemsDigest, checkpoint.itemsDigest);
  assert.match(reconciledEvents.at(-1)?.detail ?? "", /completedAtUtc=2026-10-20T12:00:00.000Z/);
  const outbox = await pool.query("SELECT kind, version FROM outbox_event WHERE project_id=$1 AND entity_id=$2 AND kind='runtime.run.reconciled'", [projectId, runId]);
  assert.deepEqual(outbox.rows, [{ kind: "runtime.run.reconciled", version: completed.version }]);
  await assert.rejects(runtime.reconcileTerminalObservation(projectId, runId, "turn-1", "completed", "Duplicate", checkpoint,
    firstTerminal.version, reviewer, "stale retry"), /run changed/);
  await assert.rejects(runtime.recordHandoffReceipt(projectId, runId, "adopted", "Too early"), /previous handoff/);
  await runtime.recordHandoffReceipt(projectId, runId, "received", "Receiving role saw the result");
  await runtime.recordHandoffReceipt(projectId, runId, "read", "Receiving role read the artifact");
  const events = await workflow.listRuntimeEvents(principal, projectId, runId);
  assert.ok(events.some(item => item.kind === "run.status" && item.cursor === "cursor-1"));
  assert.ok(events.some(item => item.kind === "handoff.read"));
  assert.ok(events.some(item => item.kind === "runtime.approvalDeclined"));
  await assert.rejects(workflow.getRuntimeRun({ actorId: "foreign", projectIds: [randomUUID()], permissions: ["read"] }, projectId, runId), /Permission read/);
  assert.equal(await uow.read(randomUUID(), tx => tx.getRuntimeRun(runId)), null);

  const followupId = randomUUID();
  const followup = applied(await issue({ ...reserveRun, runId: followupId,
    expectedVersion: ready.version! + 1, input: "Inspect the first native result and continue this accepted task" }));
  const followupRun = await workflow.getRuntimeRun(principal, projectId, followupId);
  assert.notEqual(followupRun.taskRevisionId, run.taskRevisionId, "each Turn freezes a new task revision");
  assert.equal((await workflow.getTaskRevision(principal, projectId, taskId, run.taskRevisionId)).basis?.id,
    run.basisSetId, "the first Turn keeps its sealed basis");
  rejected(await issue({ ...reserveRun, runId: randomUUID(), expectedVersion: ready.version! + 2 }), "SESSION_BUSY");
  await runtime.beginDispatch(projectId, followupId);
  await runtime.bindTurn(projectId, followupId, { id: "turn-2", status: "running" },
    { kind: "historyMarker", operationId: followup.operationId });
  assert.equal((await runtime.recordTurn(projectId, followupId, "turn-2", "completed", "Follow-up native Turn completed")).state,
    "completed");
  assert.equal((await workflow.getTask(principal, projectId, taskId)).task.state, "in_progress",
    "native completion never closes the accepted Task");

  const preflightRunId = randomUUID();
  applied(await issue({ ...reserveRun, runId: preflightRunId, taskId: otherTaskId }));
  const failed = await runtime.rejectDispatch(projectId, preflightRunId, "Sealed document body hash did not match");
  assert.equal(failed.state, "failed");
  assert.equal(failed.nativeTurnId, null);
  await assert.rejects(runtime.beginDispatch(projectId, preflightRunId), /already attempted/);
  assert.equal((await workflow.getTask(principal, projectId, otherTaskId)).task.state, "in_progress");

  const readyTask = async (title: string) => {
    const id = randomUUID();
    applied(await issue({ type: "task.create", taskId: id, title, content: "# One artifact\nUse the accepted basis.", acceptance: "Review output", owner: "runtime-owner", documentIds: [documentId], evidence: "Accepted basis" }));
    applied(await issue({ type: "task.start", taskId: id, expectedVersion: 1, basis: [{ documentId, revisionId: document.revisionId }], reason: "Begin work" }));
    return id;
  };
  const [thirdTaskId, fourthTaskId] = await Promise.all([readyTask("Third output"), readyTask("Fourth output")]);
  const concurrent = await Promise.all([
    issue({ ...reserveRun, runId: randomUUID(), taskId: thirdTaskId }),
    issue({ ...reserveRun, runId: randomUUID(), taskId: fourthTaskId }),
  ]);
  assert.equal(concurrent.filter(result => result.status === "applied").length, 1);
  assert.equal(concurrent.filter(result => result.status === "rejected" && result.code === "SESSION_BUSY").length, 1);
  const reserved = concurrent.find(result => result.status === "applied");
  assert.ok(reserved && reserved.status === "applied");
  const updatedDocument = applied(await issue({ type: "document.revise", documentId, expectedVersion: 2, body: "Revised basis", reason: "Change after reservation" }));
  applied(await issue({ type: "document.adopt", documentId, expectedVersion: 3, revisionId: updatedDocument.revisionId, reason: "New adopted basis" }));
  await assert.rejects(runtime.beginDispatch(projectId, reserved.entityId), /review pending basis impacts before dispatch/);
  assert.equal((await runtime.rejectDispatch(projectId, reserved.entityId, "Source changed after task freeze")).state, "failed");

  const manuallyStartedTaskId = randomUUID();
  applied(await issue({ type: "task.create", taskId: manuallyStartedTaskId, title: "Manual start", content: "# Try a Turn",
    acceptance: "Review output", owner: "runtime-owner", documentIds: [documentId], evidence: "Current adopted basis" }));
  const manualStart = applied(await issue({ type: "task.start", taskId: manuallyStartedTaskId,
    expectedVersion: 1, basis: [{ documentId, revisionId: updatedDocument.revisionId }], reason: "Human starts Task" }));
  const manualRunId = randomUUID();
  applied(await issue({ ...reserveRun, runId: manualRunId, taskId: manuallyStartedTaskId,
    expectedVersion: manualStart.version }));
  assert.equal((await runtime.rejectDispatch(projectId, manualRunId, "No external Turn started")).state, "failed");

  const unresolvedTaskId = randomUUID();
  applied(await issue({ type: "task.create", taskId: unresolvedTaskId, title: "Uncertain dispatch", content: "# Try one Turn",
    acceptance: "Review output", owner: "runtime-owner", documentIds: [documentId], evidence: "Current adopted basis" }));
  const unresolvedReady = applied(await issue({ type: "task.start", taskId: unresolvedTaskId,
    expectedVersion: 1, basis: [{ documentId, revisionId: updatedDocument.revisionId }], reason: "Begin uncertain dispatch" }));
  const unresolvedRunId = randomUUID();
  applied(await issue({ ...reserveRun, runId: unresolvedRunId, taskId: unresolvedTaskId,
    expectedVersion: unresolvedReady.version }));
  await runtime.beginDispatch(projectId, unresolvedRunId);
  assert.deepEqual(await runtime.recoverDispatching(projectId), { sessions: [], runs: [unresolvedRunId] });
  rejected(await issue({ ...reserveRun, runId: randomUUID(), taskId: unresolvedTaskId,
    expectedVersion: unresolvedReady.version! + 1 }), "SESSION_BUSY");
});
