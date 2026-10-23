import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import { PgSchedulingStore } from "@evoloop/adapter-postgres/scheduling";
import { SchedulingService } from "@evoloop/core/scheduling";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { WorkerCredentialBroker } from "../../apps/coordinator/src/workers/credentials.js";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import { ManagedLoopRunner } from "../../apps/coordinator/src/orchestration/runner.js";
import { createWorkerSealer } from "../../apps/coordinator/src/orchestration/seal.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || new URL(url).pathname !== "/evoloop_schedule_bridge_test")
  throw new Error("schedule bridge tests require evoloop_schedule_bridge_test");
const schema = `schedule_bridge_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), owner = "schedule-owner", cognition = "cognition-role", business = "business-role";
const goalId = randomUUID(), stageId = randomUUID(), loopId = randomUUID(), otherLoopId = randomUUID();
const principal = (actorId = owner) => ({ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let now = new Date().toISOString();
const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => now }, ids: { next: randomUUID }, hasher: { hash: sha } });
const runtime = new RuntimeWorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => now }, ids: { next: randomUUID } });
const scheduling = new SchedulingService(new PgSchedulingStore(pool));
let broker: WorkerCredentialBroker;
const store = new PgOrchestrationStore(pool, {
  getAuthorizationFact: async (_project, scope) => ({ projectId, scopeId: scope, actorId: owner, roleId: scope === "business-scope" ? business : cognition, active: true }),
  canActAsRole: async (_project, actor, role) => actor === owner && [cognition, business].includes(role) ||
    (await broker?.identityForActor(actor))?.scope.roleId === role,
  wasActorRole: async (_project, actor, loop, role) =>
    (await broker?.identityForActor(actor))?.scope.loopId === loop && (await broker?.identityForActor(actor))?.scope.roleId === role,
});
const orchestration = new OrchestrationService({ store, now: () => now, nextId: randomUUID, hash: sha });
const issue = async (command: Record<string, unknown>) => orchestration.execute(principal(), { projectId, operationId: randomUUID(), ...command } as never);
const write = async (command: Record<string, unknown>) => {
  const result = await workflow.execute(principal(), { projectId, operationId: randomUUID(), ...command } as never);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
};

test("a targeted Schedule occurrence creates one Stage Task and enters only its Loop", async t => {
  await migrate(url, schema);
  const directory = await mkdtemp(join(tmpdir(), "evoloop-schedule-bridge-"));
  const token = randomUUID() + randomUUID();
  const app = await buildServer({ service: workflow,
    credentials: [{ token, actorId: owner, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    schedulingGrants: () => [{ projectId, actorId: owner, scopeId: "schedule-scope", roleId: business }],
    workers: { authenticate: header => broker.authenticate(header), facts: identity => workerGuardFacts(pool, identity) },
    orchestration: { service: orchestration } });
  const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  broker = new WorkerCredentialBroker({ workerRoot: join(directory, "workers"), apiUrl,
    cliMain: resolve("apps/cli/dist/main.js"), nodeExecutable: process.execPath, ttlMs: 600_000 });
  const cliCommand = async (command: Record<string, unknown>) => {
    const file = join(directory, `${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ projectId, operationId: randomUUID(), ...command }), { mode: 0o600 });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), "command", "run", file], {
        env: { ...process.env, EVOLOOP_API_URL: apiUrl, EVOLOOP_TOKEN: token,
          EVOLOOP_PROJECT: projectId, EVOLOOP_STATE_DIR: join(directory, "receipts") },
        stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject); child.once("close", code => done({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  t.after(async () => {
    await app.close();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
    const client = new pg.Client({ connectionString: url }); await client.connect();
    try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
  });
  await write({ type: "project.create", title: "Schedule bridge fixture" });
  await write({ type: "goal.create", goalId, outcome: "Recurring check", constraints: "Local fixture",
    consumer: owner, authority: owner, scope: "Bounded", owner });
  await write({ type: "stage.propose", stageId, goalId, deliverable: "Check", learningQuestion: "What changed?", reason: "Trial" });
  await write({ type: "stage.accept", stageId, expectedVersion: 1, reason: "Start" });
  const sourceAfter = { createdAtUtc: now, eventId: null };
  await issue({ type: "loop.enroll", loopId, goalId, stageId, cognitiveRoleId: cognition,
    allowedBusinessRoleIds: [business], sourceAfter, maxRuns: 10, maxConcurrent: 2, reason: "Schedule target" });
  await issue({ type: "loop.enroll", loopId: otherLoopId, goalId, stageId, cognitiveRoleId: cognition,
    allowedBusinessRoleIds: [business], sourceAfter, maxRuns: 10, maxConcurrent: 2, reason: "Same scope, separate Loop" });
  const planned = new Date(Date.parse(now) + 60_000).toISOString();
  const scheduleId = randomUUID(), revisionId = randomUUID();
  const command = { type: "schedule.create", scheduleId, revisionId, timezone: "UTC",
    rule: { kind: "once", atUtc: planned }, misfire: { kind: "latest" }, overlap: "skip",
    template: { title: "Recurring check", content: "# Do scheduled check", acceptance: "Record result",
      owner: business, managedTarget: { loopId, stageId } },
    authorization: { scopeId: "schedule-scope", roleId: business, authorizedBy: owner, expiresAtUtc: null },
    reason: "Create managed Schedule", watermarkUtc: now, state: "active" };
  const createdByCli = await cliCommand(command);
  assert.equal(createdByCli.status, "applied", JSON.stringify(createdByCli));
  now = planned;
  const first = await scheduling.tick(principal(), projectId, now, ["schedule-scope"]);
  assert.equal(first.length, 1); assert.equal(first[0]?.state, "created");
  const taskId = first[0]!.taskId!;
  assert.equal((await workflow.getTask(principal(), projectId, taskId)).proposal?.stageId, stageId);
  const event = (await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2", [projectId, first[0]!.operationId])).rows[0].event_id as string;
  const source = (await orchestration.listSourceFacts(principal(), projectId, loopId)).items.find(item => item.id === event);
  assert.equal(source?.kind, "schedule.task.todo");
  assert.equal(source?.scheduleTaskRevisionId, (await workflow.getTask(principal(), projectId, taskId)).task.currentRevisionId);
  assert.equal((await orchestration.listSourceFacts(principal(), projectId, otherLoopId)).items.some(item => item.id === event), false);
  await assert.rejects(issue({ type: "inbox.accept", loopId: otherLoopId, sourceEventId: event,
    recipientRoleId: cognition, purpose: "cognitive_review" }), (error: unknown) => error instanceof OrchestrationError && error.code === "SOURCE_UNAVAILABLE");
  const workerCommand = async (wrapper: string, command: Record<string, unknown>) => {
    const file = join(directory, `${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ projectId, operationId: randomUUID(), ...command }), { mode: 0o600 });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [wrapper, "command", "run", file], {
        env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject); child.once("close", code => done({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, any>;
  };
  const fixtureRuntime = { pump: async () => {
    const pending = await pool.query(`SELECT session_id,role_id,cwd,authorization_scope FROM runtime_session
      WHERE project_id=$1 AND state='reserved' ORDER BY session_id`, [projectId]);
    for (const row of pending.rows) {
      await runtime.beginSessionCreate(projectId, row.session_id);
      await runtime.bindSession(projectId, row.session_id, { owner: "evoloop-codex-app-server", projectId,
        sessionId: row.session_id, roleId: row.role_id, cwd: row.cwd,
        authorizationScope: row.authorization_scope, nativeThreadId: `fixture-${row.session_id}`,
        nativeSessionId: `fixture-${row.session_id}` });
    }
  } };
  const runner = new ManagedLoopRunner({ projects: [projectId], reader: () => principal(),
    orchestration, workflow, runtime: fixtureRuntime,
    controller: async (_project, roleId) => ({ principal: principal(),
      authorizationScopeId: roleId === cognition ? "cognition-scope" : "business-scope",
      cwd: directory, sandbox: "read-only", approvalPolicy: "on-request" }),
    credential: broker,
    sealSubmission: createWorkerSealer({ workflow, orchestration, credential: broker,
      controller: () => principal(), now: () => now }), now: () => now, canWrite: () => true });
  const pumpUntil = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      await runner.pump();
      const result = await read();
      if (result) return result;
    }
    assert.fail(`${label} did not appear; runner faults: ${JSON.stringify(runner.status().faults)}`);
  };
  // The software runner accepts the verified PG source and creates the cognition dispatch and Run.
  const parent = await pumpUntil(async () => (await orchestration.listDispatches(principal(), projectId, loopId)).items
    .find(item => item.sourceEventId === event && item.purpose === "cognition" && item.runtimeRunId), "cognition Run");
  const parentId = parent.id, parentRun = parent.runtimeRunId!;
  assert.equal((await orchestration.listInbox(principal(), projectId, loopId)).items
    .some(item => item.sourceEventId === event && item.purpose === "cognitive_review"), true);
  const worker = await broker.lookup(parentRun);
  assert(worker, "runner issued the cognition worker credential");
  const next = await workerCommand(worker.wrapperPath, { type: "inbox.accept", loopId, sourceEventId: event,
    recipientRoleId: cognition, purpose: "next_action" });
  await workerCommand(worker.wrapperPath, { type: "inbox.ack", inboxId: next.entityId,
    expectedVersion: 1, reason: "Reuse original scheduled Task" });
  const childId = randomUUID();
  await workerCommand(worker.wrapperPath, { type: "dispatch.request", inboxId: next.entityId,
    expectedInboxVersion: 2, dispatchId: childId, parentDispatchId: parentId, taskId,
    expectedTaskVersion: 1, recipientRoleId: business, purpose: "Execute scheduled Task",
    authorizationScopeId: "business-scope", reason: "Reuse exact occurrence Task" });
  await workerCommand(worker.wrapperPath, { type: "worker.decision", decisionId: randomUUID(),
    dispatchId: parentId, runId: parentRun, kind: "waiting",
    reason: "Original scheduled Task delegated to business role", evidenceRefs: [] });
  // This fixture makes the preflight Run terminal; it never starts a native model Turn.
  await runtime.rejectDispatch(projectId, parentRun, "Fixture terminal after signed waiting decision; no native model run");
  const child = await pumpUntil(async () => {
    const item = await orchestration.getDispatch(principal(), projectId, childId);
    return item?.runtimeRunId ? item : undefined;
  }, "business Run");
  const childRun = child.runtimeRunId!;
  assert.equal((await workflow.getRuntimeRun(principal(), projectId, childRun)).taskId, taskId);
  assert.equal(child.parentDispatchId, parentId);
  await runner.pump();
  assert.equal((await orchestration.listDispatches(principal(), projectId, loopId)).items
    .filter(item => item.sourceEventId === event && item.purpose === "cognition").length, 1,
  "runner rescans a durable source without duplicating its cognition dispatch");
  assert.deepEqual(await scheduling.tick(principal(), projectId, now, ["schedule-scope"]), []);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task WHERE project_id=$1 AND task_id=$2", [projectId, taskId])).rows[0].n, 1);

  // One open occurrence queues later UTC slots without Tasks. Draining keeps the original revision and target.
  const intervalId = randomUUID(), intervalRevision = randomUUID();
  const intervalEnd = new Date(Date.parse(now) + 3 * 60_000).toISOString();
  await write({ ...command, scheduleId: intervalId, revisionId: intervalRevision, watermarkUtc: now,
    rule: { kind: "interval", anchorUtc: now, everyMinutes: 1 },
    misfire: { kind: "bounded", maxCatchUp: 3 }, overlap: "queue" });
  now = intervalEnd;
  const slots = (await scheduling.tick(principal(), projectId, now, ["schedule-scope"]))
    .filter(item => item.scheduleId === intervalId);
  assert.deepEqual(slots.map(item => item.state), ["created", "queued", "queued"]);
  assert(slots[0]?.taskId);
  assert.equal(slots[1]?.taskId, null);
  assert.equal(slots[2]?.taskId, null);
  await write({ type: "task.cancel", taskId: slots[0]!.taskId, expectedVersion: 1, reason: "Close first occurrence" });
  const drained = (await scheduling.tick(principal(), projectId, now, ["schedule-scope"]))
    .filter(item => item.scheduleId === intervalId);
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.plannedAtUtc, slots[1]?.plannedAtUtc);
  assert.equal(drained[0]?.state, "created");
  assert.equal((await workflow.getTask(principal(), projectId, drained[0]!.taskId!)).proposal?.stageId, stageId);
  assert.equal((await pool.query("SELECT schedule_revision_id FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND planned_at_utc=$3",
    [projectId, intervalId, slots[1]!.plannedAtUtc])).rows[0].schedule_revision_id, intervalRevision);
  const intervalEvent = (await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2",
    [projectId, drained[0]!.operationId])).rows[0].event_id as string;
  assert.equal((await orchestration.listSourceFacts(principal(), projectId, loopId)).items.some(item => item.id === intervalEvent), true);
  const { watermarkUtc: _watermark, ...reviseTemplate } = command;
  await write({ ...reviseTemplate, type: "schedule.revise", scheduleId: intervalId, revisionId: randomUUID(),
    expectedVersion: 1, state: "active", overlap: "queue",
    rule: { kind: "interval", anchorUtc: new Date(Date.parse(now) - 3 * 60_000).toISOString(), everyMinutes: 1 },
    misfire: { kind: "bounded", maxCatchUp: 3 },
    template: { ...command.template, managedTarget: { loopId: otherLoopId, stageId } },
    reason: "Retarget later occurrences after old queue review" });
  await write({ type: "task.cancel", taskId: drained[0]!.taskId, expectedVersion: 1, reason: "Close second occurrence" });
  await scheduling.tick(principal(), projectId, now, ["schedule-scope"]);
  const held = (await pool.query("SELECT state,task_id,schedule_revision_id FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND planned_at_utc=$3",
    [projectId, intervalId, slots[2]!.plannedAtUtc])).rows[0];
  assert.equal(held.state, "queued"); assert.equal(held.task_id, null);
  assert.equal(held.schedule_revision_id, intervalRevision, "old queued UTC slot is not silently retargeted");

  // An outbox label with no matching immutable occurrence and applied operation is never a source.
  const forged = randomUUID();
  await pool.query(`INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at)
    VALUES($1,$2,$3,'forged','schedule.task.todo',$4,1,$5)`, [projectId, forged, first[0]!.operationId, taskId, now]);
  assert.equal((await orchestration.listSourceFacts(principal(), projectId, loopId)).items.some(item => item.id === forged), false);
  await assert.rejects(issue({ type: "inbox.accept", loopId, sourceEventId: forged,
    recipientRoleId: cognition, purpose: "cognitive_review" }), (error: unknown) => error instanceof OrchestrationError && error.code === "SOURCE_UNAVAILABLE");

  // Pausing the Loop does not pause its Schedule. The source waits for resume.
  const pausedAt = new Date(Date.parse(now) + 60_000).toISOString();
  const pausedScheduleId = randomUUID();
  await write({ ...command, scheduleId: pausedScheduleId, revisionId: randomUUID(),
    watermarkUtc: now, rule: { kind: "once", atUtc: pausedAt } });
  const beforePause = (await orchestration.getLoop(principal(), projectId, loopId))!;
  await issue({ type: "loop.state", loopId, expectedVersion: beforePause.version, state: "paused", reason: "Hold cognition" });
  now = pausedAt;
  const whilePaused = (await scheduling.tick(principal(), projectId, now, ["schedule-scope"])).find(item => item.scheduleId === pausedScheduleId);
  assert(whilePaused?.taskId);
  const pausedEvent = (await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2",
    [projectId, whilePaused.operationId])).rows[0].event_id as string;
  await assert.rejects(issue({ type: "inbox.accept", loopId, sourceEventId: pausedEvent,
    recipientRoleId: cognition, purpose: "cognitive_review" }), (error: unknown) => error instanceof OrchestrationError && error.code === "LOOP_PAUSED");
  const beforeResume = (await orchestration.getLoop(principal(), projectId, loopId))!;
  await issue({ type: "loop.state", loopId, expectedVersion: beforeResume.version, state: "active", reason: "Resume cognition" });
  assert.equal((await orchestration.listSourceFacts(principal(), projectId, loopId)).items.some(item => item.id === pausedEvent), true);
  await issue({ type: "inbox.accept", loopId, sourceEventId: pausedEvent,
    recipientRoleId: cognition, purpose: "cognitive_review" });

  // A legacy Schedule remains an ordinary unscoped todo, even in the same Goal.
  const legacyId = randomUUID(), legacyRevisionId = randomUUID();
  const legacyTime = new Date(Date.parse(now) + 60_000).toISOString();
  await write({ ...command, scheduleId: legacyId, revisionId: legacyRevisionId,
    watermarkUtc: now, rule: { kind: "once", atUtc: legacyTime },
    template: { title: "Ordinary check", content: "# Ordinary", acceptance: "Record", owner: business } });
  now = legacyTime;
  const legacy = (await scheduling.tick(principal(), projectId, now, ["schedule-scope"])).find(item => item.scheduleId === legacyId);
  assert(legacy?.taskId);
  assert.equal((await workflow.getTask(principal(), projectId, legacy.taskId)).proposal?.stageId, null);
  assert.equal((await orchestration.listSourceFacts(principal(), projectId, loopId)).items.some(item => item.subjectId === legacy.taskId), false);

  const future = new Date(Date.parse(now) + 60_000).toISOString();
  const invalidScheduleId = randomUUID(), ordinaryScheduleId = randomUUID();
  await write({ ...command, scheduleId: invalidScheduleId, revisionId: randomUUID(),
    watermarkUtc: now, rule: { kind: "once", atUtc: future } });
  await write({ ...command, scheduleId: ordinaryScheduleId, revisionId: randomUUID(),
    watermarkUtc: now, rule: { kind: "once", atUtc: future },
    template: { title: "Unscoped after stop", content: "# Ordinary", acceptance: "Record", owner: business } });
  const beforeStop = (await orchestration.getLoop(principal(), projectId, loopId))!;
  await issue({ type: "loop.state", loopId, expectedVersion: beforeStop.version, state: "stopped", reason: "Stop pilot" });
  now = future;
  await assert.rejects(scheduling.tick(principal(), projectId, now, ["schedule-scope"]), /managed schedule target is no longer eligible/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2",
    [projectId, invalidScheduleId])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND state='created'",
    [projectId, ordinaryScheduleId])).rows[0].n, 1, "a bad targeted Schedule does not block another due Schedule");
  const rejected = await workflow.execute(principal(), { projectId, operationId: randomUUID(),
    ...command, scheduleId: randomUUID(), revisionId: randomUUID(), watermarkUtc: now,
    rule: { kind: "once", atUtc: new Date(Date.parse(now) + 60_000).toISOString() } } as never);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.code, "INVALID_SCHEDULE_TARGET");

  // Materialization takes a shared lock on Stage authority. A concurrent transition to
  // reviewed must finish first, then the occurrence fails closed with no Task or event.
  const lockLoopId = randomUUID(), lockScheduleId = randomUUID();
  await issue({ type: "loop.enroll", loopId: lockLoopId, goalId, stageId, cognitiveRoleId: cognition,
    allowedBusinessRoleIds: [business], sourceAfter: { createdAtUtc: now, eventId: null },
    maxRuns: 2, maxConcurrent: 1, reason: "Concurrent Stage fixture" });
  const lockTime = new Date(Date.parse(now) + 60_000).toISOString();
  await write({ ...command, scheduleId: lockScheduleId, revisionId: randomUUID(), watermarkUtc: now,
    rule: { kind: "once", atUtc: lockTime }, template: { ...command.template,
      managedTarget: { loopId: lockLoopId, stageId } } });
  const lockStore = new PgSchedulingStore(pool);
  const lockDefinition = await lockStore.get(projectId, lockScheduleId);
  assert(lockDefinition);
  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    await lockClient.query("UPDATE project_stage SET state='reviewed' WHERE project_id=$1 AND stage_id=$2", [projectId, stageId]);
    let settled = false;
    const pending = lockStore.materialize(lockDefinition, lockTime, lockTime, "created", "concurrent Stage transition")
      .finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(settled, false, "materialize waits for the Stage row lock");
    await lockClient.query("COMMIT");
    await assert.rejects(pending, /managed schedule target is no longer eligible/);
  } finally {
    await lockClient.query("ROLLBACK").catch(() => {});
    lockClient.release();
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2",
    [projectId, lockScheduleId])).rows[0].n, 0);
});
