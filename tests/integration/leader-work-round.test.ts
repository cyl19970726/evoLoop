import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import type { Principal } from "@evoloop/contracts";
import { canonicalTaskInputJson, taskInputSignature } from "../../packages/core/src/task-input.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { createLeaderWorkIndexReader } from "../../apps/coordinator/src/work-management/work-index.js";
import { OrdinaryRunSubmissionService } from "../../apps/coordinator/src/ordinary-run-submission/service.js";
import { createOrdinaryRunSealer } from "../../apps/coordinator/src/ordinary-run-submission/seal.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(database).pathname))
  throw new Error("dedicated evoloop_*_test database required");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("HTTP round connects creator Task, Leader projection, dependency, ordinary Delivery, use, close and release", async t => {
  const schema = `el_leader_round_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: database });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
  });

  const projectId = randomUUID(), roleId = randomUUID(), roleRevisionId = randomUUID();
  const prerequisiteTaskId = randomUUID(), dependentTaskId = randomUUID();
  const sessionId = randomUUID(), prerequisiteQueueId = randomUUID(), dependentQueueId = randomUUID();
  const prerequisiteEntry = randomUUID(), dependentEntry = randomUUID();
  const worker: Principal = { actorId: "business-worker", projectIds: [projectId], permissions: ["read", "write"] };
  const consumer: Principal = { actorId: "acceptance-owner", projectIds: [projectId], permissions: ["read", "write"] };
  const lead: Principal = { actorId: "leader", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const workerToken = "w".repeat(40), consumerToken = "c".repeat(40), leadToken = "l".repeat(40);
  const uow = new PostgresUnitOfWork(pool, {
    grant: async () => true, binding: async () => true, lead: async () => true,
    input: async (reader, taskId) => canonicalTaskInputJson(await taskInputSignature(reader, (await reader.getTask(taskId))!)),
  });
  const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash }, collaborationAuthority: {
      actorForRole: async () => worker.actorId, isAuthorizedRoleActor: async () => true,
      isProjectActor: async () => true, hasEngineeringActionGrant: async () => false,
    } });
  const trusted = new RuntimeWorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID } });
  const ordinary = new OrdinaryRunSubmissionService(pool, uow);
  const app = await buildServer({
    service: workflow,
    workIndex: createLeaderWorkIndexReader(pool),
    ordinarySubmissions: ordinary,
    credentials: [
      { token: workerToken, actorId: worker.actorId, projectIds: [projectId], permissions: ["read", "write"] },
      { token: consumerToken, actorId: consumer.actorId, projectIds: [projectId], permissions: ["read", "write"] },
      { token: leadToken, actorId: lead.actorId, projectIds: [projectId], permissions: ["read", "write", "review"] },
    ],
  });
  t.after(() => app.close());

  const applied = (command: Parameters<typeof workflow.execute>[1], principal = lead) =>
    workflow.execute(principal, command).then(result => {
      assert.equal(result.status, "applied", JSON.stringify(result));
      return result;
    });
  const command = (token: string, payload: Record<string, unknown>) => app.inject({
    method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` }, payload,
  });

  await applied({ type: "project.create", projectId, operationId: randomUUID(), title: "Leader round" });
  const setup = await pool.connect();
  try {
    await setup.query("BEGIN");
    await setup.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,
      proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','leader',now(),now()+interval '1 day',now())`,
      [projectId, roleId, roleRevisionId]);
    await setup.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,
      actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'leader','trial',now(),now()+interval '1 day')`,
      [projectId, roleId, roleRevisionId]);
    await setup.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/leader-round','project',NULL,'danger-full-access','never','ready',1,$4,$5,$6,'leader',now(),now())`,
      [projectId, sessionId, roleId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID()]);
    await setup.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,
      role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,'leader','owned',now())`,
      [projectId, randomUUID(), roleId, sessionId, roleRevisionId]);
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK");
    throw error;
  } finally {
    setup.release();
  }

  for (const [taskId, title] of [[prerequisiteTaskId, "Accepted prerequisite"], [dependentTaskId, "Dependent delivery"]] as const) {
    const created = await command(workerToken, {
      projectId, operationId: randomUUID(), type: "task.create", taskId, title, content: `# ${title}`,
      acceptance: "Acceptance owner uses the fixed result", owner: roleId,
      acceptanceMode: "independent_agent", consumer: consumer.actorId, useRequired: true,
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().status, "applied");
    const started = await command(leadToken, {
      projectId, operationId: randomUUID(), type: "task.start", taskId, expectedVersion: 1,
      reason: "Seal the fixed Task input",
    });
    assert.equal(started.statusCode, 200, started.body);
  }
  for (const taskId of [prerequisiteTaskId, dependentTaskId]) {
    const task = (await workflow.getTask(lead, projectId, taskId)).task;
    const assigned = await command(leadToken, {
      projectId, operationId: randomUUID(), type: "task.assignment.set", taskId,
      expectedTaskVersion: task.version, expectedVersion: 0,
      target: { kind: "owned", sessionId }, recipientActorId: worker.actorId,
      reason: "Assign the fixed Session",
    });
    assert.equal(assigned.statusCode, 200, assigned.body);
    const acknowledged = await command(workerToken, {
      projectId, operationId: randomUUID(), type: "task.assignment.acknowledge", taskId,
      expectedTaskVersion: task.version, expectedVersion: 1,
      evidence: "Worker read the fixed Task", sourceRef: "fixture://leader-round",
    });
    assert.equal(acknowledged.statusCode, 200, acknowledged.body);
  }

  const exactUrl = `/api/projects/${projectId}/work-management/tasks/${dependentTaskId}`;
  const projected = await app.inject({ url: exactUrl, headers: { authorization: `Bearer ${leadToken}` } });
  assert.equal(projected.statusCode, 200, projected.body);
  const projectedTask = projected.json() as { version: number; workChangeSequence: number; currentRevisionId: string };
  const planOperation = randomUUID();
  const plan = await app.inject({ method: "PUT", url: `${exactUrl}/plan`,
    headers: { authorization: `Bearer ${leadToken}` },
    payload: { operationId: planOperation, expectedTaskVersion: projectedTask.version, expectedPlanVersion: 0,
      plannedStartAt: new Date(Date.now() + 60_000).toISOString(),
      dueAt: new Date(Date.now() + 3_600_000).toISOString(), priority: 2,
      reason: "Leader scheduled the fixed round" } });
  assert.equal(plan.statusCode, 200, plan.body);
  const planOperationRead = await app.inject({
    url: `/api/projects/${projectId}/operations/${planOperation}`,
    headers: { authorization: `Bearer ${leadToken}` },
  });
  assert.equal(planOperationRead.statusCode, 200, planOperationRead.body);
  assert.equal(planOperationRead.json().commandType, "work.plan.set");

  const dependency = await app.inject({
    method: "PUT", url: `${exactUrl}/dependencies`,
    headers: { authorization: `Bearer ${leadToken}` },
    payload: { operationId: randomUUID(), expectedTaskVersion: projectedTask.version,
      expectedDependencyVersion: 0, dependsOnTaskIds: [prerequisiteTaskId],
      reason: "Require the current prerequisite acceptance" },
  });
  assert.equal(dependency.statusCode, 200, dependency.body);
  const prerequisite = (await workflow.getTask(lead, projectId, prerequisiteTaskId)).task;
  const dependent = (await workflow.getTask(lead, projectId, dependentTaskId)).task;
  for (const [queueId, entryId, taskId, revisionId] of [
    [prerequisiteQueueId, prerequisiteEntry, prerequisiteTaskId, prerequisite.currentRevisionId],
    [dependentQueueId, dependentEntry, dependentTaskId, dependent.currentRevisionId],
  ] as const) {
    const queue = await command(leadToken, {
      projectId, operationId: randomUUID(), type: "queue.create", queueId, maxRuns: 1,
      reason: "Leader fixed one Task input", entries: [
        { id: entryId, taskId, taskRevisionId: revisionId,
          sessionId, roleId, dependsOn: [], consumerId: consumer.actorId, useRequired: true, releaseRule: "accepted" },
      ],
    });
    assert.equal(queue.statusCode, 200, queue.body);
    assert.equal(queue.json().status, "applied");
    const adopted = await command(leadToken, {
      projectId, operationId: randomUUID(), type: "queue.adopt", queueId, expectedVersion: 1,
    });
    assert.equal(adopted.statusCode, 200, adopted.body);
  }

  const blockedOperation = randomUUID();
  const blocked = await command(leadToken, {
    projectId, operationId: blockedOperation, type: "queue.claim", queueId: dependentQueueId, entryId: dependentEntry,
    expectedVersion: 1, claimId: randomUUID(), runId: randomUUID(), runOperationId: blockedOperation,
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().status, "rejected");
  assert.equal(blocked.json().code, "TASK_DEPENDENCY_BLOCKED");
  assert.equal((await workflow.getResidentQueue(lead, projectId, dependentQueueId)).entries[0]!.state, "queued");

  const prerequisiteClaimOperation = randomUUID(), prerequisiteRunId = randomUUID(), prerequisiteClaimId = randomUUID();
  const prerequisiteClaim = await command(leadToken, {
    projectId, operationId: prerequisiteClaimOperation, type: "queue.claim", queueId: prerequisiteQueueId,
    entryId: prerequisiteEntry,
    expectedVersion: 1, claimId: prerequisiteClaimId, runId: prerequisiteRunId, runOperationId: prerequisiteClaimOperation,
  });
  assert.equal(prerequisiteClaim.statusCode, 200, prerequisiteClaim.body);
  assert.equal(prerequisiteClaim.json().status, "applied", prerequisiteClaim.body);
  const runBefore = await workflow.getRuntimeRun(lead, projectId, prerequisiteRunId);
  await trusted.beginDispatch(projectId, prerequisiteRunId);
  await trusted.bindTurn(projectId, prerequisiteRunId, { id: `turn-${prerequisiteRunId}` },
    { kind: "startReply", operationId: runBefore.operationId });
  const deliveryOperationId = randomUUID(), deliveryIntent = {
    artifactRef: "fixture://leader-round-artifact", artifactRevision: "fixed-v1",
    contentHash: hash("leader-round-artifact"), technicalResult: "passed" as const,
    technicalEvidence: "Independent checks passed", reason: "Signed ordinary result",
  };
  const submission = {
    projectId, operationId: randomUUID(), submissionId: randomUUID(), deliveryOperationId,
    runId: prerequisiteRunId, taskId: prerequisiteTaskId, sessionId,
    taskRevisionId: runBefore.taskRevisionId, runInputHash: runBefore.inputHash, deliveryIntent,
  };
  const signed = await app.inject({
    method: "POST", url: `/api/projects/${projectId}/ordinary-runs/submissions`,
    headers: { authorization: `Bearer ${workerToken}` }, payload: submission,
  });
  assert.equal(signed.statusCode, 200, signed.body);
  await trusted.recordTurn(projectId, prerequisiteRunId, `turn-${prerequisiteRunId}`, "completed", "Fixed result completed");
  const sealed = await createOrdinaryRunSealer({
    readSubmission: (p, r) => ordinary.readSubmission(p, r),
    updateSubmission: (next, expected) => ordinary.updateSubmission(next, expected),
    readRun: (p, r) => ordinary.readRun(p, r),
    readDeliveryOperation: submission => ordinary.readDeliveryOperation(submission),
    readDelivery: (p, d) => ordinary.readDelivery(p, d),
    resolveSubmittedActor: async () => ({ actorId: worker.actorId, projectIds: [projectId], permissions: ["read", "write"] }),
    workflow, sealer: { actorId: "system:ordinary-run-sealer", projectIds: [projectId],
      permissions: ["read", "write", "review"] },
    now: () => new Date().toISOString(), canWrite: () => true,
  })(projectId, prerequisiteRunId);
  assert.equal(sealed.status, "sealed", JSON.stringify(sealed));
  const deliveryId = sealed.deliveryId;

  const used = await command(consumerToken, {
    projectId, operationId: randomUUID(), type: "observation.record", taskId: prerequisiteTaskId,
    deliveryId, observer: consumer.actorId, observerKind: "agent", result: "used",
    evidence: "Consumer used the fixed artifact", reason: "Independent use confirmed",
  });
  assert.equal(used.statusCode, 200, used.body);
  const current = (await workflow.getTask(lead, projectId, prerequisiteTaskId)).task;
  const closed = await command(leadToken, {
    projectId, operationId: randomUUID(), type: "task.close", taskId: prerequisiteTaskId,
    expectedVersion: current.version, deliveryId, acceptanceResult: "met",
    acceptanceEvidence: "Independent consumer used the fixed artifact", reason: "Accepted current delivery",
  });
  assert.equal(closed.statusCode, 200, closed.body);
  const released = await command(leadToken, {
    projectId, operationId: randomUUID(), type: "queue.release", queueId: prerequisiteQueueId,
    entryId: prerequisiteEntry,
    claimId: prerequisiteClaimId,
  });
  assert.equal(released.statusCode, 200, released.body);
  assert.equal(released.json().status, "applied");

  const dependentOperation = randomUUID();
  const dependentClaim = await command(leadToken, {
    projectId, operationId: dependentOperation, type: "queue.claim", queueId: dependentQueueId,
    entryId: dependentEntry,
    expectedVersion: 1, claimId: randomUUID(), runId: randomUUID(), runOperationId: dependentOperation,
  });
  assert.equal(dependentClaim.statusCode, 200, dependentClaim.body);
  assert.equal(dependentClaim.json().status, "applied", dependentClaim.body);
  const leadReread = await app.inject({ url: exactUrl, headers: { authorization: `Bearer ${leadToken}` } });
  assert.equal(leadReread.statusCode, 200, leadReread.body);
  assert.equal(leadReread.json().latestRun.state, "requested");
  assert.ok(leadReread.json().workChangeSequence > projectedTask.workChangeSequence);
});
