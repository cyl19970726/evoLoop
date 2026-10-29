import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { BasisSet, Document, DocumentRevision, Project, Task, TaskRevision } from "@evoloop/contracts";
import { PostgresUnitOfWork, migrate } from "../src/index.ts";
import { PgLeaderWorkWriter, leaderWorkTaskFromRow, readLeaderWorkChanges, readLeaderWorkDocuments,
  readLeaderWorkTask, readLeaderWorkTasks } from "../src/work-index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL is required for leader work index tests");
const schema = `el_leader_work_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const actor = "work-index-test", now = "2026-10-28T00:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const principal = { actorId: actor, projectIds: [] as string[], permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };

before(async () => { await migrate(connectionString, schema); });
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

function document(projectId: string, title: string, kind: Document["kind"] = "spec") {
  const id = randomUUID(), revisionId = randomUUID(), body = `# ${title}`;
  const head: Document = { projectId, id, title, version: 1, currentRevisionId: revisionId,
    adoptedRevisionId: null, kind, status: "draft" };
  const revision: DocumentRevision = { projectId, documentId: id, id: revisionId, body, format: "markdown",
    mediaType: "text/markdown", originalName: `${id}.md`, payloadRef: null, entrypoint: null, assetsManifest: [],
    contentHash: hash(body), author: actor, createdAt: now, previousRevisionId: null, reason: "fixture" };
  return { head, revision };
}

function task(projectId: string, title: string, state: Task["state"], dependency?: ReturnType<typeof document>) {
  const id = randomUUID(), revisionId = randomUUID(), basisId = randomUUID();
  const primary = document(projectId, `${title} primary`, "task");
  const head: Task = { projectId, id, version: 1, currentRevisionId: revisionId, title, content: primary.revision.body!,
    contentDocumentId: primary.head.id, contentRevisionId: primary.revision.id, kind: "implementation",
    acceptance: "Visible acceptance", owner: actor, state };
  const revision: TaskRevision = { projectId, taskId: id, id: revisionId, version: 1, title, content: head.content,
    contentDocumentId: head.contentDocumentId, contentRevisionId: head.contentRevisionId, kind: head.kind,
    acceptance: head.acceptance, owner: actor, state, basisSetId: basisId, actorId: actor, reason: "fixture", createdAt: now };
  const basis: BasisSet = { projectId, taskId: id, taskRevisionId: revisionId, id: basisId, sealed: true,
    members: [{ documentId: primary.head.id, revisionId: primary.revision.id },
      ...(dependency ? [{ documentId: dependency.head.id, revisionId: dependency.revision.id }] : [])] };
  return { head, revision, basis, primary };
}

async function seedProject() {
  const project: Project = { id: randomUUID(), title: "Leader work index", createdAt: now };
  const source = document(project.id, "Shared source");
  const prerequisite = task(project.id, "Prerequisite", "in_progress", source);
  const dependent = task(project.id, "Dependent", "todo", source);
  await uow.transaction(project.id, async tx => {
    await tx.insertProject(project);
    await tx.insertDocument(source.head);
    await tx.insertDocumentRevision(source.revision);
    for (const item of [prerequisite, dependent]) {
      await tx.insertDocument(item.primary.head);
      await tx.insertDocumentRevision(item.primary.revision);
      await tx.insertTask(item.head);
      await tx.insertTaskRevision(item.revision);
      await tx.insertSealedBasisSet(item.basis);
    }
  });
  await pool.query(`INSERT INTO task_work_plan(project_id,task_id,version,planned_start_at,due_at,priority,actor_id,reason,updated_at)
    VALUES($1,$2,1,'2026-10-28T01:00:00Z','2026-10-30T10:00:00Z',2,$3,'Leader ordered work',$4)`,
    [project.id, dependent.head.id, actor, now]);
  await pool.query(`INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,actor_id,reason,created_at)
    VALUES($1,$2,$3,$4,'Must wait for prerequisite acceptance',$5)`,
    [project.id, dependent.head.id, prerequisite.head.id, actor, now]);
  return { project, source, prerequisite, dependent };
}

test("leader work index exposes plan, dependency, current version and a stable bounded cursor", async () => {
  const fixture = await seedProject();
  const first = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]!.taskId, fixture.dependent.head.id);
  assert.equal(first.items[0]!.phase, "blocked");
  assert.equal(first.items[0]!.dependencies[0]!.acceptanceSatisfied, false);
  assert.equal(first.items[0]!.plan?.priority, 2);
  assert.equal(first.items[0]!.dates.businessChangedAt, now);
  assert.ok(first.nextCursor);

  const second = await readLeaderWorkTasks(pool, fixture.project.id,
    { view: "tasks", limit: 1, cursor: first.nextCursor! });
  assert.equal(second.items[0]!.taskId, fixture.prerequisite.head.id);
  assert.equal(first.changeSequence, second.changeSequence);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.taskId)).size, 2);
  const exact = await readLeaderWorkTask(pool, fixture.project.id, fixture.prerequisite.head.id);
  assert.equal(exact?.taskId, fixture.prerequisite.head.id);
  assert.equal(exact?.phase, "ready");
  assert.equal(exact?.dependencyVersion, 0);
  const beyond=Buffer.from(JSON.stringify({version:1,view:"tasks",projectId:fixture.project.id,
    includeClosed:false,sequence:first.changeSequence,offset:999}),
    "utf8").toString("base64url");
  await assert.rejects(readLeaderWorkTasks(pool, fixture.project.id,
    { view: "tasks", limit: 1, cursor: beyond }), (error: { code?: string }) => error.code === "INVALID_CURSOR");

  await pool.query("UPDATE task_work_plan SET priority=3 WHERE project_id=$1 AND task_id=$2",
    [fixture.project.id, fixture.dependent.head.id]);
  await assert.rejects(readLeaderWorkTasks(pool, fixture.project.id,
    { view: "tasks", limit: 1, cursor: first.nextCursor! }), (error: { code?: string }) =>
    error.code === "WORK_INDEX_CHANGED");
});

test("document projection distinguishes current, adopted and related Task facts", async () => {
  const fixture = await seedProject();
  const decisionId = randomUUID();
  await pool.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at)
    VALUES($1,$2,$3,$4,$5,'Reviewed source',$6)`,
    [fixture.project.id, decisionId, fixture.source.head.id, fixture.source.revision.id, actor, now]);
  await pool.query(`UPDATE process_document SET version=2,adopted_revision_id=$3,status='published'
    WHERE project_id=$1 AND document_id=$2`, [fixture.project.id, fixture.source.head.id, fixture.source.revision.id]);

  const page = await readLeaderWorkDocuments(pool, fixture.project.id, { view: "documents", limit: 50 });
  const source = page.items.find(item => item.documentId === fixture.source.head.id)!;
  assert.equal(source.status, "published");
  assert.equal(source.currentRevisionId, fixture.source.revision.id);
  assert.equal(source.adoptedRevisionId, fixture.source.revision.id);
  assert.deepEqual(source.references.map(item => item.taskId).sort(),
    [fixture.prerequisite.head.id, fixture.dependent.head.id].sort());
  assert.ok(source.references.every(item => item.relations.includes("basis")));
});

test("change feed uses the persisted monotonic sequence rather than object UUIDs", async () => {
  const fixture = await seedProject();
  const all = await readLeaderWorkChanges(pool, fixture.project.id, 100);
  assert.ok(all.items.length > 0);
  assert.ok(all.items.every((item, index) => index === 0 || item.sequence > all.items[index - 1]!.sequence));
  assert.ok(all.items.some(item => item.entityKind === "plan"));
  assert.ok(all.items.some(item => item.entityKind === "dependency"));
  const last = all.items.at(-1)!.sequence;
  const none = await readLeaderWorkChanges(pool, fixture.project.id, 100,
    Buffer.from(JSON.stringify({ version: 1, view: "changes", projectId: fixture.project.id, sequence: last }),
      "utf8").toString("base64url"));
  assert.equal(none.items.length, 0);
  assert.equal(none.changeSequence, all.changeSequence);
  assert.ok(none.nextCursor);
  const later = await pool.query(`INSERT INTO task_work_plan(project_id,task_id,version,priority,actor_id,reason,updated_at)
    VALUES($1,$2,2,1,$3,'New change after checkpoint',$4)
    ON CONFLICT(project_id,task_id) DO UPDATE SET version=EXCLUDED.version,priority=EXCLUDED.priority,
      actor_id=EXCLUDED.actor_id,reason=EXCLUDED.reason,updated_at=EXCLUDED.updated_at`,
    [fixture.project.id, fixture.dependent.head.id, actor, now]);
  assert.equal(later.rowCount, 1);
  const afterCheckpoint = await readLeaderWorkChanges(pool, fixture.project.id, 100, none.nextCursor);
  assert.equal(afterCheckpoint.items.length, 1);
  assert.equal(afterCheckpoint.items[0]!.entityKind, "plan");
});

test("planning writes are authorized, CAS guarded, cyclic-safe and idempotent", async () => {
  const fixture = await seedProject();
  const writer = new PgLeaderWorkWriter(pool);
  const who = { ...principal, projectIds: [fixture.project.id] };
  const planOperationId = randomUUID();
  const plan = {
    projectId: fixture.project.id, operationId: planOperationId, taskId: fixture.dependent.head.id,
    expectedTaskVersion: 1, expectedPlanVersion: 1, plannedStartAt: "2026-10-29T01:00:00.000Z",
    dueAt: "2026-10-31T10:00:00.000Z", priority: 3, reason: "Leader reprioritized reviewed work",
  };
  const applied = await writer.setTaskPlan(who, fixture.project.id, plan);
  assert.equal(applied.status, "applied");
  assert.deepEqual(await writer.setTaskPlan(who, fixture.project.id, plan), applied);
  await assert.rejects(writer.setTaskPlan(who, fixture.project.id, { ...plan, priority: 4 }),
    (error: { code?: string }) => error.code === "OPERATION_CONFLICT");
  await assert.rejects(writer.setTaskPlan(who, fixture.project.id, {
    ...plan, operationId: randomUUID(), expectedPlanVersion: 1,
  }), (error: { code?: string }) => error.code === "VERSION_CONFLICT");

  const dependencyOperationId = randomUUID();
  const dependencies = {
    projectId: fixture.project.id, operationId: dependencyOperationId, taskId: fixture.dependent.head.id,
    expectedTaskVersion: 1, expectedDependencyVersion: 0,
    dependsOnTaskIds: [fixture.prerequisite.head.id], reason: "Wait for reviewed prerequisite",
  };
  const dependencyResult = await writer.setTaskDependencies(who, fixture.project.id, dependencies);
  assert.equal(dependencyResult.status, "applied");
  assert.deepEqual(await writer.setTaskDependencies(who, fixture.project.id, dependencies), dependencyResult);
  await assert.rejects(writer.setTaskDependencies(who, fixture.project.id, {
    ...dependencies, operationId: randomUUID(), taskId: fixture.prerequisite.head.id,
    expectedTaskVersion: 1, expectedDependencyVersion: 0, dependsOnTaskIds: [fixture.dependent.head.id],
  }), (error: { code?: string }) => error.code === "DEPENDENCY_CYCLE");

  const beforeReview = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const reviewPosition = beforeReview.items.find(item => item.taskId === fixture.dependent.head.id)!.workChangeSequence;
  const review = { projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.dependent.head.id,
    expectedTaskVersion: 1, expectedTaskRevisionId: fixture.dependent.revision.id,
    expectedWorkChangeSequence: reviewPosition,
    decision: "deferred" as const, reason: "Wait for the prerequisite to be accepted" };
  const reviewResult = await writer.setTaskReview(who, fixture.project.id, review);
  assert.equal(reviewResult.status, "applied");
  assert.deepEqual(await writer.setTaskReview(who, fixture.project.id, review), reviewResult);
  const reviewed = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  assert.equal(reviewed.items.find(item => item.taskId === fixture.dependent.head.id)?.review?.decision, "deferred");
  assert.ok(reviewed.items.find(item => item.taskId === fixture.dependent.head.id)!.review!.reviewedChangeSequence > 0);
  assert.equal(reviewed.counts.review_deferred, 1);
  await assert.rejects(pool.query("UPDATE leader_work_review SET reason='changed' WHERE project_id=$1 AND task_id=$2",
    [fixture.project.id, fixture.dependent.head.id]), /immutable/);
  const replanned = await writer.setTaskPlan(who, fixture.project.id, {
    ...plan, operationId: randomUUID(), expectedPlanVersion: 2, priority: 4,
    reason: "A later plan fact requires a fresh review",
  });
  assert.equal(replanned.status, "applied");
  const staleReview = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  assert.equal(staleReview.items.find(item => item.taskId === fixture.dependent.head.id)?.review, null,
    "a later plan change cannot be swallowed by an earlier review");
  assert.equal(staleReview.counts.review_deferred, 0);
  assert.equal(staleReview.counts.review_acknowledged, 0);
  const refreshedReview = await writer.setTaskReview(who, fixture.project.id, {
    ...review, operationId: randomUUID(), expectedWorkChangeSequence:
      staleReview.items.find(item => item.taskId === fixture.dependent.head.id)!.workChangeSequence,
    decision: "acknowledged",
    reason: "Reviewed the current plan and dependency facts",
  });
  assert.equal(refreshedReview.status, "applied");
  const currentReview = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  assert.equal(currentReview.items.find(item => item.taskId === fixture.dependent.head.id)?.review?.decision, "acknowledged");
  assert.equal(currentReview.counts.review_acknowledged, 1);
  const reviewChanges = await readLeaderWorkChanges(pool, fixture.project.id, 100);
  assert.ok(reviewChanges.items.some(item => item.entityKind === "review" && item.taskId === fixture.dependent.head.id));
});

test("Task.start and Leader plan/review use one project-before-row lock order", async () => {
  const fixture = await seedProject();
  const lockOrderPool = new pg.Pool({ connectionString,
    options: `-c search_path=${schema} -c lock_timeout=3000 -c statement_timeout=10000` });
  const lockOrderUow = new PostgresUnitOfWork(lockOrderPool);
  const workflow = new WorkflowService({ uow: lockOrderUow, clock: { now: () => now }, ids: { next: randomUUID },
    hasher: { hash } });
  const writer = new PgLeaderWorkWriter(lockOrderPool);
  const who = { actorId: actor, projectIds: [fixture.project.id],
    permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  try {
    const plan = {
      projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.dependent.head.id,
      expectedTaskVersion: 1, expectedPlanVersion: 1, plannedStartAt: null, dueAt: null,
      priority: 1, reason: "Race a real Task start through the same project lock",
    };
    const start = { type: "task.start" as const, projectId: fixture.project.id, operationId: randomUUID(),
      taskId: fixture.dependent.head.id, expectedVersion: 1, basis: [], reason: "Start concurrently with planning" };
    const settled = await Promise.allSettled([
      writer.setTaskPlan(who, fixture.project.id, plan),
      workflow.execute(who, start),
    ]);
    assert.equal(settled.every(item => item.status === "fulfilled" ||
      !(item.reason && typeof item.reason === "object" && "code" in item.reason) ||
      !["40P01", "55P03"].includes(item.reason.code)), true, "no project/Task deadlock or lock timeout");
    assert.ok(settled.some(item => item.status === "fulfilled" &&
      item.value.status === "applied"), JSON.stringify(settled));

    const observed = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
    const review = { projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.prerequisite.head.id,
      expectedTaskVersion: 1, expectedTaskRevisionId: fixture.prerequisite.revision.id,
      expectedWorkChangeSequence: observed.items.find(item => item.taskId === fixture.prerequisite.head.id)!.workChangeSequence,
      decision: "deferred" as const, reason: "Review concurrently with planning" };
    const parallelPlan = {
      projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.prerequisite.head.id,
      expectedTaskVersion: 1, expectedPlanVersion: 0, plannedStartAt: null, dueAt: null,
      priority: 4, reason: "Race a real review through the same project lock",
    };
    const parallel = await Promise.allSettled([
      writer.setTaskReview(who, fixture.project.id, review),
      writer.setTaskPlan(who, fixture.project.id, parallelPlan),
    ]);
    assert.equal(parallel.every(item => item.status === "fulfilled" ||
      !(item.reason && typeof item.reason === "object" && "code" in item.reason) ||
      !["40P01", "55P03"].includes(item.reason.code)), true, JSON.stringify(parallel));
    assert.equal(parallel[1]!.status, "fulfilled", JSON.stringify(parallel));
    assert.equal(parallel[1]!.status === "fulfilled" && parallel[1]!.value.status, "applied");
    assert.ok(parallel[0]!.status === "fulfilled" && parallel[0]!.value.status === "applied" ||
      parallel[0]!.status === "rejected" && parallel[0]!.reason?.code === "WORK_INDEX_CHANGED", JSON.stringify(parallel));

    const beforeRevision = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
    const workflowReview = {
      projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.prerequisite.head.id,
      expectedTaskVersion: 1, expectedTaskRevisionId: fixture.prerequisite.revision.id,
      expectedWorkChangeSequence: beforeRevision.items.find(item =>
        item.taskId === fixture.prerequisite.head.id)!.workChangeSequence,
      decision: "acknowledged" as const, reason: "Review concurrently with a real Task revision",
    };
    const revisionRace = await Promise.allSettled([
      writer.setTaskReview(who, fixture.project.id, workflowReview),
      workflow.execute(who, { type: "task.reopen", projectId: fixture.project.id, operationId: randomUUID(),
        taskId: fixture.prerequisite.head.id, expectedVersion: 1, reason: "Create a new Task revision concurrently" }),
    ]);
    assert.equal(revisionRace.every(item => item.status === "fulfilled" ||
      !(item.reason && typeof item.reason === "object" && "code" in item.reason) ||
      !["40P01", "55P03"].includes(item.reason.code)), true, JSON.stringify(revisionRace));
    assert.equal(revisionRace[1]!.status, "fulfilled", JSON.stringify(revisionRace));
    assert.equal(revisionRace[1]!.status === "fulfilled" && revisionRace[1]!.value.status, "applied");
    assert.ok(revisionRace[0]!.status === "fulfilled" && revisionRace[0]!.value.status === "applied" ||
      revisionRace[0]!.status === "rejected" &&
        ["VERSION_CONFLICT", "WORK_INDEX_CHANGED"].includes(revisionRace[0]!.reason?.code), JSON.stringify(revisionRace));
  } finally {
    await lockOrderPool.end();
  }
});

test("Leader review compares the exact per-Task change position read before the decision", async () => {
  const fixture = await seedProject();
  const writer = new PgLeaderWorkWriter(pool);
  const who = { actorId: actor, projectIds: [fixture.project.id],
    permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const initial = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const dependentPosition = initial.items.find(item => item.taskId === fixture.dependent.head.id)!.workChangeSequence;

  await writer.setTaskPlan(who, fixture.project.id, {
    projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.prerequisite.head.id,
    expectedTaskVersion: 1, expectedPlanVersion: 0, plannedStartAt: null, dueAt: null,
    priority: 2, reason: "Another Task changed after the Leader read",
  });
  const isolated = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  assert.equal(isolated.items.find(item => item.taskId === fixture.dependent.head.id)!.workChangeSequence,
    dependentPosition, "an unrelated Task change does not invalidate this Task review");
  const firstReview = await writer.setTaskReview(who, fixture.project.id, {
    projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.dependent.head.id,
    expectedTaskVersion: 1, expectedTaskRevisionId: fixture.dependent.revision.id,
    expectedWorkChangeSequence: dependentPosition, decision: "deferred",
    reason: "Reviewed this Task position",
  });
  assert.equal(firstReview.status, "applied");

  const observed = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const reviewedPosition = observed.items.find(item => item.taskId === fixture.dependent.head.id)!.workChangeSequence;
  await writer.setTaskPlan(who, fixture.project.id, {
    projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.dependent.head.id,
    expectedTaskVersion: 1, expectedPlanVersion: 1, plannedStartAt: null, dueAt: null,
    priority: 4, reason: "Plan changed after the Leader read",
  });
  const stalePlanReview = {
    projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.dependent.head.id,
    expectedTaskVersion: 1, expectedTaskRevisionId: fixture.dependent.revision.id,
    expectedWorkChangeSequence: reviewedPosition, decision: "acknowledged" as const,
    reason: "This position predates the plan change",
  };
  await assert.rejects(writer.setTaskReview(who, fixture.project.id, stalePlanReview),
    (error: { code?: string }) => error.code === "WORK_INDEX_CHANGED");
  const refreshed = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const refreshedPlanPosition = refreshed.items.find(item => item.taskId === fixture.dependent.head.id)!.workChangeSequence;
  assert.ok(refreshedPlanPosition > reviewedPosition);
  assert.equal((await writer.setTaskReview(who, fixture.project.id, {
    ...stalePlanReview, operationId: randomUUID(), expectedWorkChangeSequence: refreshedPlanPosition,
  })).status, "applied");

  const preAssignment = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const assignmentPosition = preAssignment.items.find(item =>
    item.taskId === fixture.prerequisite.head.id)!.workChangeSequence;
  const sessionId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/leader-work','project',NULL,'danger-full-access','never','ready',1,$4,$5,$6,$3,$7,$7)`,
      [fixture.project.id, sessionId, actor, `thread-${sessionId}`, `native-${sessionId}`, randomUUID(), now]);
    await client.query(`INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,
      target_kind,target_id,recipient_actor_id,state,actor_id,reason,updated_at)
      VALUES($1,$2,1,$3,'owned',$4,NULL,'assigned',$5,'Assignment changed after the Leader read',$6)`,
      [fixture.project.id, fixture.prerequisite.head.id, fixture.prerequisite.revision.id, sessionId, actor, now]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  const staleAssignmentReview = {
    projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.prerequisite.head.id,
    expectedTaskVersion: 1, expectedTaskRevisionId: fixture.prerequisite.revision.id,
    expectedWorkChangeSequence: assignmentPosition, decision: "deferred" as const,
    reason: "This position predates the assignment change",
  };
  await assert.rejects(writer.setTaskReview(who, fixture.project.id, staleAssignmentReview),
    (error: { code?: string }) => error.code === "WORK_INDEX_CHANGED");
  const afterAssignment = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const assignmentRefreshedPosition = afterAssignment.items.find(item =>
    item.taskId === fixture.prerequisite.head.id)!.workChangeSequence;
  assert.ok(assignmentRefreshedPosition > assignmentPosition);
  assert.equal((await writer.setTaskReview(who, fixture.project.id, {
    ...staleAssignmentReview, operationId: randomUUID(), expectedWorkChangeSequence: assignmentRefreshedPosition,
    decision: "acknowledged",
  })).status, "applied");
});

test("direct prerequisite close and reopen invalidate only the dependent review position", async () => {
  const fixture = await seedProject();
  const writer = new PgLeaderWorkWriter(pool);
  const who = { actorId: actor, projectIds: [fixture.project.id],
    permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const workflow = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID },
    hasher: { hash } });
  const dependentId = fixture.dependent.head.id;
  const before = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const beforePosition = before.items.find(item => item.taskId === dependentId)!.workChangeSequence;
  const initialReview = {
    projectId: fixture.project.id, operationId: randomUUID(), taskId: dependentId,
    expectedTaskVersion: 1, expectedTaskRevisionId: fixture.dependent.revision.id,
    expectedWorkChangeSequence: beforePosition, decision: "deferred" as const,
    reason: "The direct prerequisite is still in progress",
  };
  assert.equal((await writer.setTaskReview(who, fixture.project.id, initialReview)).status, "applied");
  const afterInitialReview = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const reviewPositionAfterWrite = afterInitialReview.items.find(item => item.taskId === dependentId)!.workChangeSequence;
  assert.ok(reviewPositionAfterWrite > beforePosition);

  await writer.setTaskPlan(who, fixture.project.id, {
    projectId: fixture.project.id, operationId: randomUUID(), taskId: fixture.prerequisite.head.id,
    expectedTaskVersion: 1, expectedPlanVersion: 0, plannedStartAt: null, dueAt: null,
    priority: 3, reason: "This prerequisite plan does not change its acceptance position",
  });
  const afterPrerequisitePlan = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const reviewed = afterPrerequisitePlan.items.find(item => item.taskId === dependentId)!;
  assert.equal(reviewed.workChangeSequence, reviewPositionAfterWrite);
  assert.equal(reviewed.review?.decision, "deferred",
    "an unrelated prerequisite plan position does not replace the dependent review");

  const delivered = await workflow.execute(who, { type: "delivery.record", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: 1,
    artifactRef: "fixture://direct-prerequisite", artifactRevision: "accepted-v1",
    contentHash: hash("direct prerequisite accepted"), technicalResult: "passed",
    technicalEvidence: "The current prerequisite revision passed checks",
    reason: "Deliver the current prerequisite revision" });
  assert.equal(delivered.status, "applied", JSON.stringify(delivered));
  const closed = await workflow.execute(who, { type: "task.close", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: delivered.version!,
    deliveryId: delivered.revisionId!, acceptanceResult: "met",
    acceptanceEvidence: "The current prerequisite revision was accepted",
    reason: "Satisfy the dependent's direct prerequisite" });
  assert.equal(closed.status, "applied", JSON.stringify(closed));

  const afterClose = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const closePosition = reviewPositionAfterWrite;
  const closedDependent = afterClose.items.find(item => item.taskId === dependentId)!;
  assert.equal(closedDependent.dependencies[0]!.acceptanceSatisfied, true);
  assert.ok(closedDependent.workChangeSequence > closePosition,
    "the direct prerequisite closure belongs to the dependent's current review position");
  assert.equal(closedDependent.review, null, "the pre-close decision is retained only as history");
  assert.equal(afterClose.counts.review_deferred, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM leader_work_review
    WHERE project_id=$1 AND task_id=$2`, [fixture.project.id, dependentId])).rows[0].count, 1);
  await assert.rejects(writer.setTaskReview(who, fixture.project.id, {
    ...initialReview, operationId: randomUUID(), decision: "acknowledged",
    reason: "This review still uses the pre-close position",
  }), (error: { code?: string }) => error.code === "WORK_INDEX_CHANGED");
  const afterCloseReview = await writer.setTaskReview(who, fixture.project.id, {
    ...initialReview, operationId: randomUUID(), expectedWorkChangeSequence: closedDependent.workChangeSequence,
    decision: "acknowledged", reason: "Reviewed the accepted direct prerequisite",
  });
  assert.equal(afterCloseReview.status, "applied");
  const currentAfterClose = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const currentReview = currentAfterClose.items.find(item => item.taskId === dependentId)!;
  assert.equal(currentReview.review?.decision, "acknowledged");

  const reopened = await workflow.execute(who, { type: "task.reopen", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: closed.version!,
    reason: "Reopen the direct prerequisite for another cycle" });
  assert.equal(reopened.status, "applied", JSON.stringify(reopened));
  const afterReopen = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const reopenedDependent = afterReopen.items.find(item => item.taskId === dependentId)!;
  assert.equal(reopenedDependent.dependencies[0]!.acceptanceSatisfied, false);
  assert.ok(reopenedDependent.workChangeSequence > currentReview.workChangeSequence);
  assert.equal(reopenedDependent.review, null, "reopening the prerequisite retires the prior current decision");
  assert.equal(afterReopen.counts.review_acknowledged, 0);
  await assert.rejects(writer.setTaskReview(who, fixture.project.id, {
    ...initialReview, operationId: randomUUID(), expectedWorkChangeSequence: currentReview.workChangeSequence,
    decision: "deferred", reason: "This review predates the prerequisite reopen",
  }), (error: { code?: string }) => error.code === "WORK_INDEX_CHANGED");
  assert.equal((await writer.setTaskReview(who, fixture.project.id, {
    ...initialReview, operationId: randomUUID(), expectedWorkChangeSequence: reopenedDependent.workChangeSequence,
    decision: "deferred", reason: "Reviewed the reopened direct prerequisite",
  })).status, "applied");
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM leader_work_review
    WHERE project_id=$1 AND task_id=$2`, [fixture.project.id, dependentId])).rows[0].count, 3,
  "superseded decisions remain immutable history");
});

test("runtime reservation enforces current Task acceptance and invalidates after prerequisite reopen", async () => {
  const fixture = await seedProject();
  const workflow = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID },
    hasher: { hash } });
  const who = { actorId: actor, projectIds: [fixture.project.id],
    permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const sessionId = randomUUID();
  await uow.transaction(fixture.project.id, async tx => {
    await tx.insertRuntimeSession({ projectId: fixture.project.id, id: sessionId, roleId: actor,
      cwd: "/tmp/leader-work", authorizationScope: "project", model: null, sandbox: "danger-full-access",
      approvalPolicy: "never", state: "ready", version: 1, nativeThreadId: `thread-${sessionId}`,
      nativeSessionId: `native-${sessionId}`, operationId: randomUUID(), actorId: actor, createdAt: now, updatedAt: now });
    await tx.insertRuntimeRun({ projectId: fixture.project.id, id: randomUUID(), taskId: fixture.prerequisite.head.id,
      taskRevisionId: fixture.prerequisite.revision.id, basisSetId: fixture.prerequisite.basis.id, sessionId,
      operationId: randomUUID(), input: "terminal prerequisite work", inputHash: hash("terminal prerequisite work"),
      state: "completed", version: 1, nativeTurnId: `turn-${randomUUID()}`, interruptRequested: false,
      resultSummary: "Terminal is not acceptance", actorId: actor, createdAt: now, updatedAt: now });
  });
  const blockers = await uow.read(fixture.project.id, reader =>
    reader.listTaskDependencyBlockers!(fixture.dependent.head.id));
  assert.deepEqual(blockers.map(item => item.taskId), [fixture.prerequisite.head.id],
    "a terminal prerequisite Run remains unsatisfied");
  const started = await workflow.execute(who, { type: "task.start", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.dependent.head.id, expectedVersion: 1, basis: [],
    reason: "Start dependent work" });
  assert.equal(started.status, "applied", JSON.stringify(started));
  const blocked = await workflow.execute(who, { type: "runtime.run.reserve", projectId: fixture.project.id,
    operationId: randomUUID(), runId: randomUUID(), taskId: fixture.dependent.head.id, sessionId,
    expectedVersion: started.version!, input: "Execute dependent work" });
  assert.equal(blocked.status, "rejected");
  if (blocked.status === "rejected") assert.equal(blocked.code, "TASK_DEPENDENCY_BLOCKED");

  const delivered = await workflow.execute(who, { type: "delivery.record", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: 1,
    artifactRef: "https://example.test/prerequisite", artifactRevision: "accepted",
    contentHash: hash("prerequisite"), technicalResult: "passed", technicalEvidence: "Current checks and use passed",
    reason: "Accept prerequisite current revision" });
  assert.equal(delivered.status, "applied", JSON.stringify(delivered));
  const closed = await workflow.execute(who, { type: "task.close", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: delivered.version!,
    deliveryId: delivered.revisionId!, acceptanceResult: "met", acceptanceEvidence: "Current revision accepted",
    reason: "Close prerequisite current revision" });
  assert.equal(closed.status, "applied", JSON.stringify(closed));

  const dependentRun = await workflow.execute(who, { type: "runtime.run.reserve", projectId: fixture.project.id,
    operationId: randomUUID(), runId: randomUUID(), taskId: fixture.dependent.head.id, sessionId,
    expectedVersion: started.version!, input: "Execute dependent work" });
  assert.equal(dependentRun.status, "applied", JSON.stringify(dependentRun));
  const dependentCurrentVersion = (await uow.read(fixture.project.id,
    reader => reader.getTask(fixture.dependent.head.id)))!.version;
  await pool.query(`UPDATE runtime_run SET state='completed',native_turn_id=$4,version=version+1,updated_at=$3
    WHERE project_id=$1 AND run_id=$2`, [fixture.project.id, dependentRun.entityId, now, `turn-${dependentRun.entityId}`]);

  const reopened = await workflow.execute(who, { type: "task.reopen", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: closed.version!,
    reason: "Create a new prerequisite revision" });
  assert.equal(reopened.status, "applied", JSON.stringify(reopened));
  const afterReopen = await workflow.execute(who, { type: "runtime.run.reserve", projectId: fixture.project.id,
    operationId: randomUUID(), runId: randomUUID(), taskId: fixture.dependent.head.id, sessionId,
    expectedVersion: dependentCurrentVersion, input: "A new attempt must wait for the new prerequisite revision" });
  assert.equal(afterReopen.status, "rejected");
  if (afterReopen.status === "rejected") assert.equal(afterReopen.code, "TASK_DEPENDENCY_BLOCKED");
});

test("a newer completed Run waits for its own Delivery instead of reviving an older failed one", () => {
  const row = {
    task_id: "task", version: 4, current_revision_id: "revision", title: "Retried work",
    kind: "implementation", owner: "owner", state: "in_progress",
    created_at: "2026-10-28T00:00:00.000Z", business_changed_at: "2026-10-28T00:01:00.000Z",
    latest_run_id: "new-run", latest_run_state: "completed",
    run_updated_at: "2026-10-28T02:00:00.000Z",
    delivery_id: "old-delivery", delivery_task_revision_id: "revision", delivery_result: "failed",
    delivery_created_at: "2026-10-28T01:00:00.000Z", pending_impact_count: 0,
    dependency_facts: [], plan_version: null, has_closure: false,
  };
  const waiting = leaderWorkTaskFromRow(row as never, now);
  assert.equal(waiting.phase, "awaiting_delivery");
  const currentAttempt = leaderWorkTaskFromRow({ ...row,
    delivery_id: "new-delivery", delivery_created_at: "2026-10-28T02:05:00.000Z" } as never, now);
  assert.equal(currentAttempt.phase, "rework");
  const observedFailure = leaderWorkTaskFromRow({ ...row,
    delivery_id: "new-delivery", delivery_result: "passed", delivery_created_at: "2026-10-28T02:05:00.000Z",
    observation_result: "failed" } as never, now);
  assert.equal(observedFailure.phase, "rework");
});

test("a failed Run from an earlier Task revision does not mark the new revision as current work", async () => {
  const fixture = await seedProject();
  const sessionId = randomUUID(), runId = randomUUID();
  await uow.transaction(fixture.project.id, async tx => {
    await tx.insertRuntimeSession({ projectId: fixture.project.id, id: sessionId, roleId: actor,
      cwd: "/tmp/leader-work", authorizationScope: "project", model: null, sandbox: "danger-full-access",
      approvalPolicy: "never", state: "ready", version: 1, nativeThreadId: `thread-${sessionId}`,
      nativeSessionId: `native-${sessionId}`, operationId: randomUUID(), actorId: actor, createdAt: now, updatedAt: now });
    await tx.insertRuntimeRun({ projectId: fixture.project.id, id: runId, taskId: fixture.prerequisite.head.id,
      taskRevisionId: fixture.prerequisite.revision.id, basisSetId: fixture.prerequisite.basis.id, sessionId,
      operationId: randomUUID(), input: "older fixed work", inputHash: hash("older fixed work"), state: "failed",
      version: 1, nativeTurnId: null, interruptRequested: false, resultSummary: "Old revision failed",
      actorId: actor, createdAt: now, updatedAt: now });
  });
  const workflow = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID },
    hasher: { hash } });
  const who = { actorId: actor, projectIds: [fixture.project.id],
    permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const reopened = await workflow.execute(who, { type: "task.reopen", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: 1,
    reason: "Open a corrected revision" });
  assert.equal(reopened.status, "applied", JSON.stringify(reopened));
  const page = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const task = page.items.find(item => item.taskId === fixture.prerequisite.head.id)!;
  assert.notEqual(task.currentRevisionId, fixture.prerequisite.revision.id);
  assert.equal(task.latestRun, null);
  assert.equal(task.phase, "unassigned");
});

test("closure may advance the Task revision without hiding the Delivery it accepted", async () => {
  const fixture = await seedProject();
  const workflow = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID },
    hasher: { hash } });
  const who = { actorId: actor, projectIds: [fixture.project.id],
    permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const sessionId = randomUUID(), runId = randomUUID();
  await uow.transaction(fixture.project.id, async tx => {
    await tx.insertRuntimeSession({ projectId: fixture.project.id, id: sessionId, roleId: actor,
      cwd: "/tmp/leader-work", authorizationScope: "project", model: null, sandbox: "danger-full-access",
      approvalPolicy: "never", state: "ready", version: 1, nativeThreadId: `thread-${sessionId}`,
      nativeSessionId: `native-${sessionId}`, operationId: randomUUID(), actorId: actor, createdAt: now, updatedAt: now });
    await tx.insertRuntimeRun({ projectId: fixture.project.id, id: runId, taskId: fixture.prerequisite.head.id,
      taskRevisionId: fixture.prerequisite.revision.id, basisSetId: fixture.prerequisite.basis.id, sessionId,
      operationId: randomUUID(), input: "accepted work", inputHash: hash("accepted work"), state: "completed",
      version: 1, nativeTurnId: `turn-${runId}`, interruptRequested: false,
      resultSummary: "The fixed work completed", actorId: actor, createdAt: now, updatedAt: now });
  });
  const delivered = await workflow.execute(who, { type: "delivery.record", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: 1,
    runId,
    artifactRef: "https://example.test/accepted", artifactRevision: "accepted-v1",
    contentHash: hash("accepted"), technicalResult: "passed", technicalEvidence: "All checks passed",
    reason: "Reviewed delivery" });
  assert.equal(delivered.status, "applied", JSON.stringify(delivered));
  const deliveryId = delivered.status === "applied" ? delivered.revisionId ?? "" : "";
  const deliveryVersion = delivered.status === "applied" ? delivered.version ?? 2 : 2;
  const deliveredTaskRevisionId = (await uow.read(fixture.project.id,
    reader => reader.getTask(fixture.prerequisite.head.id)))!.currentRevisionId;
  const storedDelivery = (await uow.read(fixture.project.id,
    reader => reader.listDeliveries(fixture.prerequisite.head.id))).at(-1)!;
  assert.equal(storedDelivery.taskRevisionId, deliveredTaskRevisionId);
  assert.equal(storedDelivery.runId, runId);
  const awaiting = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10 });
  const deliveredTask = awaiting.items.find(item => item.taskId === fixture.prerequisite.head.id)!;
  assert.equal(deliveredTask.phase, "awaiting_acceptance");
  assert.equal(deliveredTask.latestRun?.runId, runId,
    "Delivery advancement keeps its accepted source Run associated");
  const closedResult = await workflow.execute(who, { type: "task.close", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: deliveryVersion,
    deliveryId, acceptanceResult: "met", acceptanceEvidence: "Independent acceptance passed",
    reason: "Close with the accepted delivery" });
  assert.equal(closedResult.status, "applied", JSON.stringify(closedResult));
  const page = await readLeaderWorkTasks(pool, fixture.project.id, { view: "tasks", limit: 10, includeClosed: true });
  const closed = page.items.find(item => item.taskId === fixture.prerequisite.head.id)!;
  assert.equal(closed.phase, "closed");
  assert.equal(closed.delivery?.deliveryId, deliveryId);
  assert.equal(closed.delivery?.taskRevisionId, deliveredTaskRevisionId);
  assert.equal(closed.latestRun?.runId, runId);
  assert.notEqual(closed.currentRevisionId, deliveredTaskRevisionId);

  const reopened = await workflow.execute(who, { type: "task.reopen", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: closedResult.version!,
    reason: "Start a distinct reporting cycle" });
  assert.equal(reopened.status, "applied", JSON.stringify(reopened));
  const afterReopen = await readLeaderWorkTasks(pool, fixture.project.id,
    { view: "tasks", limit: 10, includeClosed: true });
  const nextCycle = afterReopen.items.find(item => item.taskId === fixture.prerequisite.head.id)!;
  assert.equal(nextCycle.phase, "unassigned");
  assert.equal(nextCycle.delivery, null, "the previous closure cannot attach its Delivery to the new cycle");
  assert.equal(nextCycle.latestRun, null, "the accepted Run belongs to the completed cycle");
  assert.equal(nextCycle.dates.completedAt, null);

  const updated = await workflow.execute(who, { type: "task.update", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: reopened.version!,
    title: fixture.prerequisite.head.title, content: "# Corrected cycle\n\nUse the new accepted checks.",
    acceptance: fixture.prerequisite.head.acceptance, owner: fixture.prerequisite.head.owner,
    reason: "Clarify the next cycle" });
  assert.equal(updated.status, "applied", JSON.stringify(updated));
  const started = await workflow.execute(who, { type: "task.start", projectId: fixture.project.id,
    operationId: randomUUID(), taskId: fixture.prerequisite.head.id, expectedVersion: updated.version!,
    basis: [], reason: "Begin the next cycle" });
  assert.equal(started.status, "applied", JSON.stringify(started));
  const afterStart = await readLeaderWorkTasks(pool, fixture.project.id,
    { view: "tasks", limit: 10, includeClosed: true });
  const activeCycle = afterStart.items.find(item => item.taskId === fixture.prerequisite.head.id)!;
  assert.equal(activeCycle.phase, "ready");
  assert.equal(activeCycle.delivery, null);
  assert.equal(activeCycle.latestRun, null);
  assert.notEqual(activeCycle.currentRevisionId, nextCycle.currentRevisionId);
});

test("the Leader index can page beyond the former 5000-row ceiling", async () => {
  const projectId = randomUUID(), count = 5_001;
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Large Leader index',$2)",
    [projectId, now]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,
      adopted_revision_id,kind,status)
      SELECT $1,md5('bulk-document-'||g)::uuid,'Bulk Task '||g,1,md5('bulk-document-revision-'||g)::uuid,
        NULL,'task','draft'
      FROM generate_series(1,$2) g`, [projectId, count]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,
      content_hash,author,created_at,previous_revision_id,reason)
      SELECT $1,md5('bulk-document-'||g)::uuid,md5('bulk-document-revision-'||g)::uuid,
        '# Bulk Task '||g,'markdown',repeat('a',64),$3,$4,NULL,'bulk fixture'
      FROM generate_series(1,$2) g`, [projectId, count, actor, now]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,
      owner,state,kind,content_document_id,content_revision_id)
      SELECT $1,md5('bulk-task-'||g)::uuid,1,md5('bulk-task-revision-'||g)::uuid,
        'Bulk Task '||g,'Visible acceptance',$3,'todo','implementation',
        md5('bulk-document-'||g)::uuid,md5('bulk-document-revision-'||g)::uuid
      FROM generate_series(1,$2) g`, [projectId, count, actor]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,
      owner,state,kind,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
      SELECT $1,md5('bulk-task-'||g)::uuid,md5('bulk-task-revision-'||g)::uuid,1,
        'Bulk Task '||g,'Visible acceptance',$3,'todo','implementation',
        md5('bulk-document-'||g)::uuid,md5('bulk-document-revision-'||g)::uuid,NULL,$3,'bulk fixture',$4
      FROM generate_series(1,$2) g`, [projectId, count, actor, now]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  let cursor: string | undefined, pages = 0;
  const ids = new Set<string>();
  do {
    const page = await readLeaderWorkTasks(pool, projectId,
      { view: "tasks", limit: 100, ...(cursor ? { cursor } : {}) });
    assert.equal(page.partial, false);
    assert.equal(page.total, count);
    assert.equal(page.counts.unassigned, count);
    assert.ok(page.items.length <= 100);
    for (const item of page.items) ids.add(item.taskId);
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(ids.size, count);
  assert.equal(pages, 51);
});

test("change sequence allocation waits for the earlier uncommitted project writer", async () => {
  const fixture = await seedProject();
  const before = await readLeaderWorkChanges(pool, fixture.project.id, 100);
  assert.ok(before.nextCursor);
  const first = await pool.connect(), second = await pool.connect();
  let secondSettled = false;
  try {
    await first.query("BEGIN");
    await first.query("UPDATE task_work_plan SET priority=4 WHERE project_id=$1 AND task_id=$2",
      [fixture.project.id, fixture.dependent.head.id]);
    await second.query("BEGIN");
    const secondWrite = second.query(`INSERT INTO task_work_plan(project_id,task_id,version,priority,actor_id,reason,updated_at)
      VALUES($1,$2,1,1,$3,'Second committed change',$4)`,
      [fixture.project.id, fixture.prerequisite.head.id, actor, now]).then(() => { secondSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(secondSettled, false, "a later sequence cannot bypass an uncommitted earlier writer");
    await first.query("COMMIT");
    await secondWrite;
    await second.query("COMMIT");
    const changes = await readLeaderWorkChanges(pool, fixture.project.id, 100, before.nextCursor);
    assert.equal(changes.items.filter(item => item.entityKind === "plan").length, 2);
    assert.deepEqual(changes.items.map(item => item.sequence), [...changes.items.map(item => item.sequence)].sort((a, b) => a - b));
  } catch (error) {
    await first.query("ROLLBACK").catch(() => {});
    await second.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    first.release();
    second.release();
  }
});
