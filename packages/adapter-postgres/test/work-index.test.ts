import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { BasisSet, Document, DocumentRevision, Project, Task, TaskRevision } from "@evoloop/contracts";
import { PostgresUnitOfWork, migrate } from "../src/index.ts";
import { PgLeaderWorkWriter, leaderWorkTaskFromRow, readLeaderWorkChanges, readLeaderWorkDocuments,
  readLeaderWorkTasks } from "../src/work-index.ts";

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
