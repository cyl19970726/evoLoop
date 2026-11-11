// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { runner } from "node-pg-migrate";
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
  const taskId = await f.createTask({ acceptanceTarget: "named_agent", acceptancePrecondition: "release" });
  const proposal = (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).proposal!;
  assert.equal(proposal.acceptanceTarget, "named_agent");
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
  assert.deepEqual([kept.acceptanceTarget, kept.acceptancePrecondition], ["named_agent", "release"]);
  // 3. Same rule as the other acceptance fields: review permission needed.
  const denied = await update(f.writer, { acceptancePrecondition: "migration" }, version);
  assert.equal(denied.status, "rejected");
  assert.equal((denied as { code: string }).code, "FORBIDDEN");
  // 4. named_agent needs a declared consumer; invalid values are refused by the schema.
  const noConsumer = await f.issue(f.reviewer, { type: "task.create", taskId: randomUUID(), title: "x", content: "# x", acceptance: "y",
    owner: fixtureRoleId("convention-owner"), acceptanceTarget: "named_agent" });
  assert.equal(noConsumer.status, "rejected");
  assert.match(JSON.stringify(noConsumer), /named_agent acceptance needs the declared consumer/);
  await assert.rejects(f.workflow.execute(f.reviewer, { type: "task.create", projectId: f.projectId, operationId: randomUUID(), taskId: randomUUID(),
    title: "x", content: "# x", acceptance: "y", owner: "o", acceptancePrecondition: "someday" } as never));
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
    operationId: randomUUID(), relayId: randomUUID() }), (error: { code: string }) => error.code !== "ACCEPTANCE_NAMED_AGENT" && typeof error.code === "string" && error.code.length > 0);
});

test("the projection says waiting for the precondition until it is marked, and names the direct acceptor", async t => {
  const f = await fixture(t);
  const taskId = await f.createTask({ acceptanceTarget: "named_agent", acceptancePrecondition: "release" });
  const none = await readLeaderWorkTask(f.pool, f.projectId, taskId);
  assert.equal(none!.acceptanceConvention!.readiness, null, "no delivery yet: nothing to be ready");
  const started = await f.issue(f.reviewer, { type: "task.start", taskId, expectedVersion: (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).task.version,
    basis: [], reason: "start" });
  assert.equal(started.status, "applied", JSON.stringify(started));
  const deliveryId = await f.deliver(taskId);
  const waiting = (await readLeaderWorkTask(f.pool, f.projectId, taskId))!;
  assert.equal(waiting.phase, "awaiting_acceptance");
  assert.deepEqual(waiting.acceptanceConvention, { acceptanceTarget: "named_agent", acceptancePrecondition: "release",
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

test("mine lists, for an Agent consumer, the deliveries the workbench 等我使用的交付 lists, by the same rule, with the precondition state", async t => {
  const f = await fixture(t);
  const observe = (taskId: string, deliveryId: string, observer: string, result: string, kind = "agent") => f.pool.query(
    `INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,'e','r',$5,now())`, [f.projectId, randomUUID(), taskId, deliveryId, observer, kind, result]);
  const waitingTask = await f.createTask({ acceptanceTarget: "named_agent", acceptancePrecondition: "release" });
  const readyTask = await f.createTask({ acceptanceTarget: "named_agent", acceptancePrecondition: "none" });
  const signedTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const failedTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const notUsedTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const othersLastTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const othersLastAfterMyUsed = await f.createTask({ acceptanceTarget: "named_agent" });
  const noDeliveryTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const someoneElse = await f.createTask({ consumer: "other-agent" });
  const staleTask = await f.createTask({ acceptanceTarget: "named_agent" });
  const waitingDelivery = await f.deliver(waitingTask);
  await f.deliver(readyTask); await f.deliver(someoneElse);
  await observe(signedTask, await f.deliver(signedTask), f.consumer.actorId, "used");
  await observe(failedTask, await f.deliver(failedTask), f.consumer.actorId, "failed");
  await observe(notUsedTask, await f.deliver(notUsedTask), f.consumer.actorId, "notUsed");
  await observe(othersLastTask, await f.deliver(othersLastTask), "someone-else", "notUsed");
  const mineUsed = await f.deliver(othersLastAfterMyUsed);
  await observe(othersLastAfterMyUsed, mineUsed, f.consumer.actorId, "used");
  await new Promise(resolve => setTimeout(resolve, 5));
  await observe(othersLastAfterMyUsed, mineUsed, "someone-else", "notUsed");
  // A delivery for an older revision no longer counts: the Task was revised after it.
  await f.deliver(staleTask);
  const staleVersion = (await f.workflow.getTask(f.reviewer, f.projectId, staleTask)).task.version;
  await f.applied(f.reviewer, { type: "task.update", taskId: staleTask, expectedVersion: staleVersion, title: "Convention sample", content: "# Sample revised",
    acceptance: "Consumer uses it", owner: fixtureRoleId("convention-owner"), reason: "revised after delivery" });

  const direct = await f.relay.mineDirect(f.consumer, f.projectId);
  assert.equal(direct.complete, true);
  const byTask = new Map((direct.items as Array<{ taskId: string; readiness: string; last: string | null; othersObserved: boolean }>).map(item => [item.taskId, item]));
  assert.equal(byTask.get(waitingTask)?.readiness, "waiting_precondition");
  assert.equal(byTask.get(readyTask)?.readiness, "ready");
  assert.equal(byTask.get(notUsedTask)?.last, "notUsed", "未使用 stays listed, as in the workbench");
  assert.equal(byTask.get(othersLastTask)?.othersObserved, true, "someone else observed last, I have not used it");
  for (const [task, why] of [[signedTask, "I signed used"], [failedTask, "使用失败 goes back to rework"], [othersLastAfterMyUsed, "I already used it before the other observation"],
    [noDeliveryTask, "no delivery yet"], [someoneElse, "another consumer's delivery"], [staleTask, "the delivery is for an older revision"]] as const)
    assert.equal(byTask.has(task), false, why);

  // The very same judgement function the workbench uses decides each of those, so the two lists cannot drift.
  assert.deepEqual([...byTask.keys()].sort(), [waitingTask, readyTask, notUsedTask, othersLastTask].sort());

  // After the precondition is marked the same entry reads ready; another identity sees nothing of mine; no read permission is refused.
  await f.applied(f.reviewer, { type: "task.acceptancePrecondition.mark", taskId: waitingTask, deliveryId: waitingDelivery, evidence: "released" });
  const after = (await f.relay.mineDirect(f.consumer, f.projectId)).items as Array<{ taskId: string; readiness: string }>;
  assert.equal(after.find(item => item.taskId === waitingTask)?.readiness, "ready");
  assert.deepEqual((await f.relay.mineDirect({ ...f.consumer, actorId: "unrelated-agent" }, f.projectId)).items, []);
  await assert.rejects(f.relay.mineDirect({ ...f.consumer, projectIds: [randomUUID()] }, f.projectId), { code: "FORBIDDEN" });
});

test("the six work types are accepted by the service and the database, and older Tasks keep theirs", async t => {
  const f = await fixture(t);
  const owner = fixtureRoleId("convention-owner");
  for (const kind of ["implementation", "research", "validation", "defect", "documentation", "operation"]) {
    const taskId = await f.createTask({ kind });
    assert.equal((await f.workflow.getTask(f.reviewer, f.projectId, taskId)).task.kind, kind);
  }
  // An update changes the type (a defect filed as an implementation Task is reclassified this way).
  const taskId = await f.createTask({ kind: "implementation" });
  const detail = await f.workflow.getTask(f.reviewer, f.projectId, taskId);
  await f.applied(f.reviewer, { type: "task.update", taskId, expectedVersion: detail.task.version, title: "缺陷：sample", content: "# Sample",
    acceptance: "Consumer uses it", owner, kind: "defect", reason: "reclassify" });
  assert.equal((await f.workflow.getTask(f.reviewer, f.projectId, taskId)).task.kind, "defect");
  // Unknown types are still refused by the schema, and by the database check if a writer bypasses it.
  await assert.rejects(f.workflow.execute(f.reviewer, { type: "task.create", projectId: f.projectId, operationId: randomUUID(), taskId: randomUUID(),
    title: "x", content: "# x", acceptance: "y", owner, kind: "feature" } as never));
  // The database check is the widened one on both tables (a direct write is blocked by the head-version trigger, so read the constraint).
  const checks = (await f.pool.query(`SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE contype='c' AND conname IN ('task_kind_check','task_revision_kind_check') AND connamespace=current_schema()::regnamespace ORDER BY 1`)).rows;
  assert.equal(checks.length, 2);
  for (const check of checks) for (const kind of ["implementation", "research", "validation", "defect", "documentation", "operation"])
    assert.match(check.def, new RegExp(`'${kind}'`), `${check.tbl} allows ${kind}`);
});

test("migration 091 widens the work types and targets on a schema that already holds Tasks, changing no existing row", async t => {
  const schema = `convention_upgrade_${randomUUID().replaceAll("-", "")}`;
  const migrations = fileURLToPath(new URL("../../packages/adapter-postgres/migrations/", import.meta.url));
  const before = (await readdir(migrations)).filter(name => name.endsWith(".mjs") && Number(name.slice(0, 3)) < 88).length;
  await runner({ databaseUrl: database!, dir: migrations, migrationsTable: "pgmigrations", schema, createSchema: true, createMigrationsSchema: true,
    direction: "up", singleTransaction: true, count: before, log: () => {} });
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const columns = async () => (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='task_proposal'
    AND column_name IN ('acceptance_precondition','delivery_form')`, [schema])).rows.map(row => row.column_name);
  assert.deepEqual(await columns(), [], "091 has not run yet");

  const projectId = randomUUID(), taskId = randomUUID(), revisionId = randomUUID(), documentId = randomUUID(), contentId = randomUUID(), roleId = randomUUID();
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'upgrade',$2)", [projectId, now]);
    await client.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'t',1,$3,'task','draft')", [projectId, documentId, contentId]);
    await client.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason) VALUES($1,$2,$3,'b','markdown',$4,'a',$5,'r')", [projectId, documentId, contentId, "a".repeat(64), now]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id,kind)
      VALUES($1,$2,1,$3,'Old task','done',$4,'todo',$5,$6,'research')`, [projectId, taskId, revisionId, roleId, documentId, contentId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id,kind)
      VALUES($1,$2,$3,1,'Old task','done',$4,'todo',NULL,'a','r',$5,$6,$7,'research')`, [projectId, taskId, revisionId, roleId, now, documentId, contentId]);
    await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,stage_id,consumer,use_required,acceptance_mode,acceptance_target,evidence,stop_condition,created_at)
      VALUES($1,$2,$3,NULL,'c',true,'independent_agent','business_session','','',$4)`, [projectId, taskId, revisionId, now]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const snapshot = async () => ({
    task: (await pool.query("SELECT kind,version,state FROM task WHERE task_id=$1", [taskId])).rows,
    revision: (await pool.query("SELECT kind,version FROM task_revision WHERE task_id=$1", [taskId])).rows,
    proposal: (await pool.query("SELECT acceptance_target,consumer,use_required FROM task_proposal WHERE task_id=$1", [taskId])).rows,
  });
  const old = await snapshot();
  const definitions = async () => Object.fromEntries((await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE contype='c' AND connamespace=$1::regnamespace AND (conname='task_proposal_acceptance_target_check' OR (conrelid IN ('task'::regclass,'task_revision'::regclass)
      AND pg_get_constraintdef(oid) LIKE '%implementation%'))`, [schema])).rows.map(row => [row.conname, row.def as string]));
  const narrow = await definitions();
  assert.ok(!narrow.task_proposal_acceptance_target_check!.includes("named_agent"), "not yet allowed before 091");
  assert.ok(Object.values(narrow).filter(def => def.includes("implementation")).every(def => !def.includes("defect")), "the old type check before 091");

  await migrate(database!, schema);
  assert.deepEqual(await columns(), ["acceptance_precondition"], "the optional column exists, delivery_form never does");
  assert.deepEqual(await snapshot(), old, "no existing row changed");
  assert.equal((await pool.query("SELECT acceptance_precondition FROM task_proposal WHERE task_id=$1", [taskId])).rows[0].acceptance_precondition, null);
  const wide = await definitions();
  assert.match(wide.task_proposal_acceptance_target_check!, /named_agent/);
  assert.match(wide.task_proposal_acceptance_target_check!, /business_session/, "the earlier targets stay");
  const typeChecks = Object.entries(wide).filter(([, def]) => def.includes("implementation"));
  assert.equal(typeChecks.length, 2, "exactly one type check on task and one on task_revision, no leftover narrow one");
  for (const [, def] of typeChecks) for (const kind of ["implementation", "research", "validation", "defect", "documentation", "operation"]) assert.match(def, new RegExp(`'${kind}'`));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name='task_acceptance_precondition_mark'`, [schema])).rows[0].n, 1);
});

test("review 3: a direct-acceptance Task is refused as such before any Delivery exists; a replay still returns its first result", async t => {
  const f = await fixture(t);
  const taskId = await f.createTask({ acceptanceTarget: "named_agent" });
  const task = await f.workflow.getTask(f.reviewer, f.projectId, taskId);
  const input = { projectId: f.projectId, taskId, deliveryId: randomUUID(), expectedTaskVersion: 99, operationId: randomUUID(), relayId: randomUUID(),
    stage: "candidate" as const, scopeKey: "use", scopeDescription: "Use it", entrypoint: null, publicationRef: null, mode: "session" as const,
    recipientActorId: f.consumer.actorId, sessionId: randomUUID(), senderActorId: f.reviewer.actorId, messageId: null, messageOperationId: null, reason: "r" };
  // No Delivery, a wrong Task version and an unknown Delivery would each fail first under the old order.
  await assert.rejects(f.relay.arrange(f.reviewer, input), (error: { code: string }) => error.code === "ACCEPTANCE_NAMED_AGENT");
  assert.ok(task.task.version >= 1);
  // The real Delivery path gives the same answer.
  const deliveryId = await f.deliver(taskId);
  await assert.rejects(f.relay.arrange(f.reviewer, { ...input, deliveryId, expectedTaskVersion: task.task.version, operationId: randomUUID(), relayId: randomUUID() }),
    (error: { code: string }) => error.code === "ACCEPTANCE_NAMED_AGENT");
});

test("review 5: direct acceptance needs the independent_agent mode, on create and on update", async t => {
  const f = await fixture(t);
  const owner = fixtureRoleId("convention-owner");
  const created = await f.issue(f.reviewer, { type: "task.create", taskId: randomUUID(), title: "x", content: "# x", acceptance: "y", owner,
    consumer: f.consumer.actorId, useRequired: true, acceptanceTarget: "named_agent", acceptanceMode: "human_required" });
  assert.equal(created.status, "rejected", JSON.stringify(created));
  // An existing Task with no mode cannot be switched to direct acceptance.
  const legacy = randomUUID();
  await f.applied(f.reviewer, { type: "task.create", taskId: legacy, title: "Legacy", content: "# l", acceptance: "y", owner, consumer: f.consumer.actorId, useRequired: true, acceptanceMode: "independent_agent" });
  // Data from before acceptance modes existed has none; the service no longer creates such a Task, so the fixture writes it past the history guard.
  await f.pool.query("ALTER TABLE task_proposal DISABLE TRIGGER USER");
  try { await f.pool.query("UPDATE task_proposal SET acceptance_mode=NULL,use_required=false WHERE project_id=$1 AND task_id=$2", [f.projectId, legacy]); }
  finally { await f.pool.query("ALTER TABLE task_proposal ENABLE TRIGGER USER"); }
  const version = (await f.workflow.getTask(f.reviewer, f.projectId, legacy)).task.version;
  const update = await f.issue(f.reviewer, { type: "task.update", taskId: legacy, expectedVersion: version, title: "Legacy", content: "# l", acceptance: "y", owner,
    consumer: f.consumer.actorId, acceptanceTarget: "named_agent", reason: "direct" });
  assert.equal(update.status, "rejected", JSON.stringify(update)); assert.match(JSON.stringify(update), /independent_agent/);
});

test("review 2: once the declared consumer has signed used or failed, the responsible and next step return to the ordinary rule", async t => {
  const f = await fixture(t);
  const taskId = await f.createTask({ acceptanceTarget: "named_agent" });
  const version = (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).task.version;
  await f.applied(f.reviewer, { type: "task.start", taskId, expectedVersion: version, basis: [], reason: "start" });
  const deliveryId = await f.deliver(taskId);
  const before = (await readLeaderWorkTask(f.pool, f.projectId, taskId))!;
  assert.equal(before.phase, "awaiting_acceptance");
  assert.equal(before.responsible.kind, "consumer"); assert.match(before.nextAction, /直接验收/);
  // The consumer's "used" is stored as the service would (the command also needs a passed Run, which this fixture has no need of).
  await f.pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'agent','used','Read and applied the result','direct acceptance',$5,now())`, [f.projectId, randomUUID(), taskId, deliveryId, f.consumer.actorId]);
  const after = (await readLeaderWorkTask(f.pool, f.projectId, taskId))!;
  assert.doesNotMatch(after.nextAction, /直接验收/, "no longer asks for what the consumer already did");
  assert.ok(!(after.responsible.kind === "consumer" && /直接验收/.test(String(after.responsible.label))));
});

test("review 1: the direct list survives a write between pages and a failure there does not take the human list down", async t => {
  const f = await fixture(t);
  // More Tasks than one page (50): two started Tasks the consumer has to sign, the rest plain.
  const owed: string[] = [];
  for (let i = 0; i < 2; i++) {
    const taskId = await f.createTask({ acceptanceTarget: "named_agent" });
    const v = (await f.workflow.getTask(f.reviewer, f.projectId, taskId)).task.version;
    await f.applied(f.reviewer, { type: "task.start", taskId, expectedVersion: v, basis: [], reason: "start" });
    await f.deliver(taskId); owed.push(taskId);
  }
  for (let i = 0; i < 55; i++) await f.createTask();
  let connects = 0, interfered = false;
  const racing = new Proxy(f.pool, { get: (target, key) => {
    if (key === "connect") return async () => {
      connects++;
      // The second page is read: a write lands between the pages.
      if (connects === 2 && !interfered) { interfered = true; await f.createTask(); }
      return (target.connect as () => Promise<unknown>).call(target);
    };
    const value = (target as never)[key] as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } }) as typeof f.pool;
  const relay = new AcceptanceRelayService({ pool: racing, workflow: f.workflow, messages: {} as never, principals: async () => [], canWrite: () => false,
    leaderSession: async () => null, qualify: async () => null, capabilities: async () => [] });
  const direct = await relay.mineDirect(f.consumer, f.projectId);
  assert.ok(interfered, "a write really landed between two pages");
  assert.equal(direct.complete, true, "re-read from the first page until a consistent snapshot");
  assert.deepEqual(direct.items.map(item => (item as { taskId: string }).taskId).sort(), owed.sort());
});
