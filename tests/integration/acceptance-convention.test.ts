// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { readLeaderWorkTask } from "../../packages/adapter-postgres/src/work-index.js";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { AcceptanceRelayService } from "../../apps/coordinator/src/acceptance-relay/service.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("A dedicated evoloop_*_test database is required");

async function fixture(t: test.TestContext) {
  const schema = `convention_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const projectId = randomUUID();
  const reviewer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] };
  const consumer: Principal = { actorId: "requirements-agent", identityKind: "agent", projectIds: [projectId], permissions: ["read", "write"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") } });
  const issue = async (who: Principal, command: Record<string, unknown>) =>
    workflow.execute(who, { ...command, projectId, operationId: randomUUID() } as never);
  const applied = async (who: Principal, command: Record<string, unknown>) => {
    const result = await issue(who, command); assert.equal(result.status, "applied", JSON.stringify(result)); return result;
  };
  await applied(reviewer, { type: "project.create", title: "Acceptance convention" });
  const owner = fixtureRoleId("convention-owner");
  await seedFixtureRole(pool, projectId, owner);
  const createTask = async (extra: Record<string, unknown> = {}) => {
    const taskId = randomUUID();
    await applied(reviewer, { type: "task.create", taskId, title: "Convention sample", content: "# Sample", acceptance: "Consumer uses it",
      owner, consumer: consumer.actorId, useRequired: true, acceptanceMode: "independent_agent", ...extra });
    return taskId;
  };
  const deliver = async (taskId: string) => {
    const deliveryId = randomUUID();
    const task = await workflow.getTask(reviewer, projectId, taskId);
    await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,
      technical_result,technical_evidence,reason,actor_id,created_at) VALUES($1,$2,$3,$4,'fixture:pr','r1',$5,'passed','fixture','candidate','author',now())`,
      [projectId, deliveryId, taskId, task.task.currentRevisionId, "a".repeat(64)]);
    return deliveryId;
  };
  const relay = new AcceptanceRelayService({ pool, workflow, messages: {} as never, principals: async () => [], canWrite: () => false,
    leaderSession: async () => null, qualify: async () => null, capabilities: async () => [] });
  return { pool, projectId, reviewer, writer, consumer, workflow, issue, applied, createTask, deliver, relay };
}

test("the convention fields and the named_agent target are written, read back, changed and cleared under the acceptance-field rule", async t => {
  const f = await fixture(t);
  const taskId = await f.createTask({ acceptanceTarget: "named_agent", deliveryForm: "code", acceptancePrecondition: "release" });
  const proposal = (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).proposal!;
  assert.equal(proposal.acceptanceTarget, "named_agent");
  assert.equal(proposal.deliveryForm, "code");
  assert.equal(proposal.acceptancePrecondition, "release");

  const update = (who: Principal, extra: Record<string, unknown>, version: number) => f.issue(who, { type: "task.update", taskId, expectedVersion: version,
    title: "Convention sample", content: "# Sample", acceptance: "Consumer uses it", owner: fixtureRoleId("convention-owner"), reason: "convention", ...extra });
  let version = (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).task.version;
  // 1. Change to another target, then clear it: both succeed (null clears).
  assert.equal((await update(f.reviewer, { acceptanceTarget: "business_session" }, version)).status, "applied");
  version += 1;
  assert.equal((await f.workflow.getTask(f.reviewer, f.projectId, taskId)).proposal!.acceptanceTarget, "business_session");
  const cleared = await update(f.reviewer, { acceptanceTarget: null }, version);
  assert.equal(cleared.status, "applied", JSON.stringify(cleared));
  version += 1;
  assert.equal((await f.workflow.getTask(f.reviewer, f.projectId, taskId)).proposal!.acceptanceTarget, null);
  // 2. Back to the new value; the other two fields keep their values when the update does not mention them.
  assert.equal((await update(f.reviewer, { acceptanceTarget: "named_agent" }, version)).status, "applied");
  version += 1;
  const kept = (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).proposal!;
  assert.deepEqual([kept.acceptanceTarget, kept.deliveryForm, kept.acceptancePrecondition], ["named_agent", "code", "release"]);
  // 3. Same rule as the other acceptance fields: review permission needed.
  const denied = await update(f.writer, { deliveryForm: "document" }, version);
  assert.equal(denied.status, "rejected");
  assert.equal((denied as { code: string }).code, "FORBIDDEN");
  // 4. named_agent needs a declared consumer; invalid values are refused by the schema.
  const noConsumer = await f.issue(f.reviewer, { type: "task.create", taskId: randomUUID(), title: "x", content: "# x", acceptance: "y",
    owner: fixtureRoleId("convention-owner"), acceptanceTarget: "named_agent" });
  assert.equal(noConsumer.status, "rejected");
  assert.match(JSON.stringify(noConsumer), /named_agent acceptance needs the declared consumer/);
  await assert.rejects(f.workflow.execute(f.reviewer, { type: "task.create", projectId: f.projectId, operationId: randomUUID(), taskId: randomUUID(),
    title: "x", content: "# x", acceptance: "y", owner: "o", deliveryForm: "poem" } as never));
});

test("acceptance.assign is refused for a named_agent Task with the reason, and unchanged for the other targets", async t => {
  const f = await fixture(t);
  const taskId = await f.createTask({ acceptanceTarget: "named_agent" });
  const deliveryId = await f.deliver(taskId);
  const task = await f.workflow.getTask(f.reviewer, f.projectId, taskId);
  const input = { projectId: f.projectId, taskId, deliveryId, expectedTaskVersion: task.task.version, operationId: randomUUID(), relayId: randomUUID(),
    stage: "candidate" as const, scopeKey: "use", scopeDescription: "Use it", entrypoint: null, publicationRef: null, mode: "session" as const,
    recipientActorId: f.consumer.actorId, sessionId: randomUUID(), senderActorId: f.reviewer.actorId, messageId: null, messageOperationId: null, reason: "r" };
  await assert.rejects(f.relay.arrange(f.reviewer, input), (error: { code: string; message: string }) =>
    error.code === "ACCEPTANCE_NAMED_AGENT" && /requirements-agent.*直接验收.*不经验收接力/.test(error.message));
  // A Task with another target is not touched by the new rule: it still fails on its own (unrelated) checks, not on this one.
  const other = await f.createTask({ acceptanceTarget: "business_session" });
  const otherDelivery = await f.deliver(other);
  const otherTask = await f.workflow.getTask(f.reviewer, f.projectId, other);
  await assert.rejects(f.relay.arrange(f.reviewer, { ...input, taskId: other, deliveryId: otherDelivery, expectedTaskVersion: otherTask.task.version,
    operationId: randomUUID(), relayId: randomUUID() }), (error: { code: string }) => error.code !== "ACCEPTANCE_NAMED_AGENT");
});

test("the projection says waiting for the precondition until it is marked, and names the direct acceptor", async t => {
  const f = await fixture(t);
  const taskId = await f.createTask({ acceptanceTarget: "named_agent", deliveryForm: "code", acceptancePrecondition: "release" });
  const none = await readLeaderWorkTask(f.pool, f.projectId, taskId);
  assert.equal(none!.acceptanceConvention!.readiness, null, "no delivery yet: nothing to be ready");
  const started = await f.issue(f.reviewer, { type: "task.start", taskId, expectedVersion: (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).task.version,
    basis: [], reason: "start" });
  assert.equal(started.status, "applied", JSON.stringify(started));
  const deliveryId = await f.deliver(taskId);
  const waiting = (await readLeaderWorkTask(f.pool, f.projectId, taskId))!;
  assert.equal(waiting.phase, "awaiting_acceptance");
  assert.deepEqual(waiting.acceptanceConvention, { acceptanceTarget: "named_agent", deliveryForm: "code", acceptancePrecondition: "release",
    readiness: "waiting_precondition", namedAgent: "requirements-agent" });
  assert.match(waiting.nextAction, /等待发布后才可验收（尚未标记已满足）/);
  assert.match(waiting.nextAction, /requirements-agent.*直接验收.*不要安排接力/);
  assert.equal(waiting.responsible.id, "requirements-agent");

  // Marking: reviewer only, current delivery only, once.
  const markCommand = { type: "task.acceptancePrecondition.mark", taskId, deliveryId, evidence: "released in the build that contains the PR" };
  await assert.rejects(f.issue(f.writer, markCommand), /Permission review is required/);
  await f.applied(f.reviewer, markCommand);
  const again = await f.issue(f.reviewer, markCommand);
  assert.equal((again as { code: string }).code, "ALREADY_MARKED");
  const ready = (await readLeaderWorkTask(f.pool, f.projectId, taskId))!;
  assert.equal(ready.acceptanceConvention!.readiness, "ready");
  assert.doesNotMatch(ready.nextAction, /等待发布/);

  // A Task that declares nothing has no convention block, and `none` needs no mark.
  const plain = await f.createTask();
  assert.equal((await readLeaderWorkTask(f.pool, f.projectId, plain))!.acceptanceConvention, null);
  const noPrecondition = await f.createTask({ acceptancePrecondition: "none" });
  const noDelivery = await f.deliver(noPrecondition);
  const refused = await f.issue(f.reviewer, { type: "task.acceptancePrecondition.mark", taskId: noPrecondition, deliveryId: noDelivery, evidence: "x" });
  assert.equal((refused as { code: string }).code, "NO_PRECONDITION");
});

test("mine lists, for an Agent consumer, the deliveries it has not signed, with whether the precondition is met", async t => {
  const f = await fixture(t);
  const waitingTask = await f.createTask({ acceptanceTarget: "named_agent", deliveryForm: "code", acceptancePrecondition: "release" });
  const readyTask = await f.createTask({ acceptanceTarget: "named_agent", acceptancePrecondition: "none" });
  const signedTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const noDeliveryTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const someoneElse = await f.createTask({ consumer: "other-agent" });
  const waitingDelivery = await f.deliver(waitingTask);
  await f.deliver(readyTask);
  await f.deliver(someoneElse);
  const signedDelivery = await f.deliver(signedTask);
  await f.pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'agent','used','used it','checked',$5,now())`, [f.projectId, randomUUID(), signedTask, signedDelivery, f.consumer.actorId]);

  const mine = await f.relay.mineDirect(f.consumer, f.projectId) as Array<{ taskId: string; readiness: string; acceptancePrecondition: string | null; deliveryForm: string | null }>;
  const byTask = new Map(mine.map(item => [item.taskId, item]));
  assert.equal(byTask.get(waitingTask)?.readiness, "waiting_precondition");
  assert.equal(byTask.get(waitingTask)?.deliveryForm, "code");
  assert.equal(byTask.get(readyTask)?.readiness, "ready");
  assert.equal(byTask.has(signedTask), false, "signed used: no longer listed");
  assert.equal(byTask.has(noDeliveryTask), false, "no delivery yet: nothing to sign");
  assert.equal(byTask.has(someoneElse), false, "another consumer's delivery is not mine");

  // After the precondition is marked the same entry reads ready; another identity sees nothing of mine.
  await f.applied(f.reviewer, { type: "task.acceptancePrecondition.mark", taskId: waitingTask, deliveryId: waitingDelivery, evidence: "released" });
  const after = await f.relay.mineDirect(f.consumer, f.projectId) as Array<{ taskId: string; readiness: string; preconditionMark: unknown }>;
  assert.equal(after.find(item => item.taskId === waitingTask)?.readiness, "ready");
  assert.ok(after.find(item => item.taskId === waitingTask)?.preconditionMark);
  assert.deepEqual(await f.relay.mineDirect({ ...f.consumer, actorId: "unrelated-agent" }, f.projectId), []);
  await assert.rejects(f.relay.mineDirect({ ...f.consumer, projectIds: [randomUUID()] }, f.projectId), { code: "FORBIDDEN" });
});
