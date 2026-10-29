import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { canonicalTaskInputJson, taskInputSignature } from "../../core/src/task-input.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname))
  throw new Error("dedicated evoloop_*_test database required");
const schema = `el_dependency_gate_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool, {
  grant: async () => true, binding: async () => true, lead: async () => true,
  input: async (reader, taskId) =>
    canonicalTaskInputJson(await taskInputSignature(reader, (await reader.getTask(taskId))!)),
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clock = { now: () => new Date().toISOString() }, ids = { next: randomUUID };
const workflow = new WorkflowService({ uow, clock, ids, hasher: { hash },
  collaborationAuthority: {
    actorForRole: async () => "worker", isAuthorizedRoleActor: async () => true,
    isProjectActor: async () => true, hasEngineeringActionGrant: async () => false,
  } });

before(async () => { await migrate(url, schema); });
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

test("queue claim reaches the same current-acceptance dependency gate as static reserve", async () => {
  const projectId = randomUUID(), roleId = randomUUID(), roleRevisionId = randomUUID();
  const prerequisiteTaskId = randomUUID(), dependentTaskId = randomUUID(), sessionId = randomUUID();
  const queueId = randomUUID(), entryId = randomUUID();
  const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const worker: Principal = { actorId: "worker", projectIds: [projectId], permissions: ["read", "write"] };
  const consumer: Principal = { actorId: "consumer", projectIds: [projectId], permissions: ["read", "write"] };
  const apply = async (command: Parameters<typeof workflow.execute>[1], principal = lead) => {
    const result = await workflow.execute(principal, command);
    assert.equal(result.status, "applied", JSON.stringify(result));
    return result;
  };

  await apply({ type: "project.create", projectId, operationId: randomUUID(), title: "Dependency queue gate" });
  const setup = await pool.connect();
  try {
    await setup.query("BEGIN");
    await setup.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,
      proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,
      [projectId, roleId, roleRevisionId]);
    await setup.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,
      actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`,
      [projectId, roleId, roleRevisionId]);
    await setup.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      model,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,
      created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/dependency-gate','project',NULL,'danger-full-access','never','ready',1,$4,$5,$6,'worker',now(),now())`,
      [projectId, sessionId, roleId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID()]);
    await setup.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,
      role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,'lead','queue fixture',now())`,
      [projectId, randomUUID(), roleId, sessionId, roleRevisionId]);
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK");
    throw error;
  } finally {
    setup.release();
  }

  for (const taskId of [prerequisiteTaskId, dependentTaskId]) {
    await apply({ type: "task.create", projectId, operationId: randomUUID(), taskId,
      title: taskId === prerequisiteTaskId ? "Accepted prerequisite" : "Dependent work",
      content: "# Fixed work", acceptance: "Consumer uses the fixed result", owner: roleId,
      acceptanceMode: "independent_agent", consumer: consumer.actorId, useRequired: true });
    await apply({ type: "task.start", projectId, operationId: randomUUID(), taskId, expectedVersion: 1,
      reason: "Seal fixed input" });
  }
  for (const taskId of [prerequisiteTaskId, dependentTaskId]) {
    const task = (await workflow.getTask(lead, projectId, taskId)).task;
    await apply({ type: "task.assignment.set", projectId, operationId: randomUUID(), taskId,
      expectedTaskVersion: task.version, expectedVersion: 0,
      target: { kind: "owned", sessionId }, recipientActorId: worker.actorId,
      reason: "Assign the fixed Session" });
    await apply({ type: "task.assignment.acknowledge", projectId, operationId: randomUUID(), taskId,
      expectedTaskVersion: task.version, expectedVersion: 1, evidence: "Worker read the fixed Task",
      sourceRef: "fixture://dependency-gate" }, worker);
  }
  await pool.query(`INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,actor_id,reason,created_at)
    VALUES($1,$2,$3,'lead','Must wait for accepted prerequisite',now())`,
    [projectId, dependentTaskId, prerequisiteTaskId]);
  const dependent = (await workflow.getTask(lead, projectId, dependentTaskId)).task;
  await apply({ type: "queue.create", projectId, operationId: randomUUID(), queueId, maxRuns: 1,
    reason: "Dependent queue", entries: [{ id: entryId, taskId: dependentTaskId,
      taskRevisionId: dependent.currentRevisionId, sessionId, roleId,
      dependsOn: [], consumerId: consumer.actorId, useRequired: true, releaseRule: "accepted" }] });
  await apply({ type: "queue.adopt", projectId, operationId: randomUUID(), queueId, expectedVersion: 1 });

  const firstOperation = randomUUID();
  const blocked = await workflow.execute(lead, { type: "queue.claim", projectId, operationId: firstOperation,
    queueId, entryId, expectedVersion: 1, claimId: randomUUID(), runId: randomUUID(),
    runOperationId: firstOperation });
  const claims = await pool.query(`SELECT claim_id,task_id,session_id,released_at FROM resident_queue_claim
    WHERE project_id=$1`, [projectId]);
  assert.equal(blocked.status, "rejected", JSON.stringify({ blocked, queue:
    await workflow.getResidentQueue(lead, projectId, queueId), claims: claims.rows }));
  if (blocked.status === "rejected") assert.equal(blocked.code, "TASK_DEPENDENCY_BLOCKED");
  assert.equal((await workflow.getResidentQueue(lead, projectId, queueId)).entries[0]!.state, "queued");

  const delivered = await apply({ type: "delivery.record", projectId, operationId: randomUUID(),
    taskId: prerequisiteTaskId, expectedVersion: 2, artifactRef: "fixture://prerequisite",
    artifactRevision: "v1", contentHash: hash("prerequisite"), technicalResult: "passed",
    technicalEvidence: "Fixed result checked", reason: "Deliver prerequisite" }, worker);
  await apply({ type: "observation.record", projectId, operationId: randomUUID(), taskId: prerequisiteTaskId,
    deliveryId: delivered.revisionId!, observer: consumer.actorId, observerKind: "agent",
    result: "used", evidence: "Consumer used the fixed prerequisite", reason: "Independent use" }, consumer);
  const currentPrerequisite = (await workflow.getTask(lead, projectId, prerequisiteTaskId)).task;
  await apply({ type: "task.close", projectId, operationId: randomUUID(), taskId: prerequisiteTaskId,
    expectedVersion: currentPrerequisite.version, deliveryId: delivered.revisionId!,
    acceptanceResult: "met", acceptanceEvidence: "Current delivery used", reason: "Accept prerequisite" });

  const secondOperation = randomUUID(), runId = randomUUID();
  const claimed = await workflow.execute(lead, { type: "queue.claim", projectId, operationId: secondOperation,
    queueId, entryId, expectedVersion: 1, claimId: randomUUID(), runId, runOperationId: secondOperation });
  assert.equal(claimed.status, "applied", JSON.stringify(claimed));
  assert.equal((await workflow.getRuntimeRun(lead, projectId, runId)).state, "requested");
});
