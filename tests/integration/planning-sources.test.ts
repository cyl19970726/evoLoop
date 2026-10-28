import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { OrchestrationService } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import type { Principal } from "@evoloop/contracts";
import { readTaskContext, readOriginal } from "../../apps/cli/src/materials.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { readPlanningSources } from "../../apps/coordinator/src/orchestration/planning-sources.js";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import type { WorkerIdentity } from "../../apps/coordinator/src/workers/types.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(connectionString).pathname.slice(1)))
  throw new Error("Dedicated evoloop_*_test TEST_DATABASE_URL required");
const schema = `el_plan_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({connectionString, options: `-c search_path=${schema}`});
const uow = new PostgresUnitOfWork(pool);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const projectId = randomUUID(), goalId = randomUUID(), stageId = randomUUID(), otherGoalId = randomUUID(),
  otherStageId = randomUUID(), loopId = randomUUID(), taskId = randomUUID(), cognitiveTaskId = randomUUID(), otherTaskId = randomUUID(),
  documentId = randomUUID(), draftId = randomUUID();
const plannerRole = fixtureRoleId("planner"), builderRole = fixtureRoleId("builder");
const owner: Principal = {actorId: "planning-owner", projectIds: [projectId], permissions: ["read", "write", "review"]};
const worker: WorkerIdentity = {principal: {actorId: `worker-${randomUUID()}`, projectIds: [projectId], permissions: ["read", "write"]},
  scope: {projectId, loopId, taskId: cognitiveTaskId, runId: randomUUID(), sessionId: randomUUID(),
    roleId: plannerRole, kind: "cognition", allowedRoleIds: [plannerRole, builderRole]}};
const workflow = new WorkflowService({uow, clock: {now: () => "2026-10-24T00:00:00.000Z"},
  ids: {next: randomUUID}, hasher: {hash}});
const orchestration = new OrchestrationService({store: new PgOrchestrationStore(pool, {
  getAuthorizationFact: async () => null, canActAsRole: async () => false, wasActorRole: async () => false,
}), now: () => "2026-10-24T00:00:00.000Z", nextId: randomUUID, hash});
let app: Awaited<ReturnType<typeof buildServer>>;
const execute = async (command: Record<string, unknown>) => {
  const result = await workflow.execute(owner, {projectId, operationId: randomUUID(), ...command} as Parameters<WorkflowService["execute"]>[1]);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
};

before(async () => {
  await migrate(connectionString!, schema);
  await execute({type: "project.create", title: "Planning test"});
  await seedFixtureRole(pool, projectId, plannerRole);
  await seedFixtureRole(pool, projectId, builderRole);
  for (const id of [goalId, otherGoalId]) await execute({type: "goal.create", goalId: id,
    outcome: "Check handoff", constraints: "Use fixed sources", consumer: "Reviewer", authority: "Owner", scope: "Local", owner: "owner"});
  for (const [id, goal] of [[stageId, goalId], [otherStageId, otherGoalId]]) {
    await execute({type: "stage.propose", stageId: id, goalId: goal, deliverable: "Planning", learningQuestion: "What next?", reason: "Test"});
    await execute({type: "stage.accept", stageId: id, expectedVersion: 1, reason: "Test"});
  }
  await execute({type: "document.create", documentId, title: "Published source", body: "Exact source", kind: "spec"});
  await execute({type: "document.create", documentId: draftId, title: "Draft source", body: "Not published", kind: "spec"});
  const document = await workflow.getDocument(owner, projectId, documentId);
  await execute({type: "document.adopt", documentId, expectedVersion: 1, revisionId: document.current.id, reason: "Test"});
  await execute({type: "task.create", taskId, stageId, title: "Todo seed", content: "Read linked material", acceptance: "Decide",
    owner: builderRole, kind: "research", documentIds: [documentId, draftId], consumer: "Reviewer", evidence: "Test", stopCondition: "Decide"});
  await execute({type: "task.create", taskId: cognitiveTaskId, stageId, title: "Cognition", content: "Plan",
    acceptance: "Decide", owner: plannerRole, kind: "research", consumer: "Reviewer", evidence: "Test", stopCondition: "Decide"});
  await execute({type: "task.create", taskId: otherTaskId, stageId: otherStageId, title: "Other Stage", content: "Other",
    acceptance: "Decide", owner: builderRole, kind: "research", documentIds: [documentId], consumer: "Reviewer", evidence: "Test", stopCondition: "Decide"});
  const enrolled = await orchestration.execute(owner, {type: "loop.enroll", projectId, operationId: randomUUID(), loopId,
    goalId, stageId, cognitiveRoleId: plannerRole, allowedBusinessRoleIds: [builderRole],
    sourceAfter: {createdAtUtc: "2026-10-24T00:00:00.000Z", eventId: null},
    maxRuns: 1, maxConcurrent: 1, reason: "Planning source scope fixture"});
  assert.equal(enrolled.entityId, loopId);
  app = await buildServer({service: workflow, credentials: [{token: "o".repeat(40), actorId: owner.actorId,
    projectIds: [projectId], permissions: owner.permissions}],
    planningSources: (principal, project, task, revision, loop) =>
      readPlanningSources(pool, principal, project, task, revision, loop),
    workers: {authenticate: async header => header === "Bearer worker-test" ? worker : null,
      facts: identity => workerGuardFacts(pool, identity)},
    documents: {uow, blobsForPrincipal: async () => ({}) as never},
    references: {uow, gitForPrincipal: async () => ({}) as never, knowledgeForPrincipal: async () => ({}) as never}});
});
after(async () => {
  if (app) await app.close();
  await pool.end();
  const cleanup = new pg.Client({connectionString});
  await cleanup.connect();
  try {await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);} finally {await cleanup.end();}
});

test("scoped HTTP and CLI context discover adopted todo candidate without sealing or reading it", async () => {
  const detail = await workflow.getTask(owner, projectId, taskId);
  const path = `/api/projects/${projectId}/orchestration/tasks/${taskId}/planning-sources?taskRevisionId=${detail.revision.id}`;
  const direct = await readPlanningSources(pool, worker.principal, projectId, taskId, detail.revision.id, loopId);
  assert.equal(direct.observedPlanningCandidates.length, 1);
  const response = await app.inject({method: "GET", url: path, headers: {authorization: "Bearer worker-test"}});
  assert.equal(response.statusCode, 200, response.body);
  const planning = response.json();
  assert.equal(planning.sealed, false);
  assert.equal(planning.observedPlanningCandidates.length, 1);
  assert.equal(planning.observedPlanningCandidates[0].documentId, documentId);
  assert.equal(planning.observedPlanningCandidates[0].contentHash, hash("Exact source"));
  assert.deepEqual(planning.unavailableLinks, [{documentId: draftId, reason: "not_published"}]);
  const get = async (url: string) => {
    const read = await app.inject({method: "GET", url, headers: {authorization: "Bearer worker-test"}});
    if (read.statusCode !== 200) throw new Error(`${read.statusCode}: ${read.body}`);
    return read.json();
  };
  const context = await readTaskContext({get}, projectId, taskId);
  assert.equal(context.status, "partial");
  assert.equal(context.basis, null);
  assert.equal(context.documents.length, 1, JSON.stringify(context.failures));
  assert.equal(context.observedPlanningCandidates[0]?.documentId, documentId);
  assert.equal(context.failures.some(failure => failure.id === draftId), true);
  const ownerGet = async (url: string) => {
    const read = await app.inject({method: "GET", url, headers: {authorization: `Bearer ${"o".repeat(40)}`}});
    if (read.statusCode !== 200) throw new Error(`${read.statusCode}: ${read.body}`);
    return read.json();
  };
  const ownerContext = await readTaskContext({get: ownerGet}, projectId, taskId);
  assert.equal(ownerContext.observedPlanningCandidates[0]?.adoptedRevisionId,
    planning.observedPlanningCandidates[0].adoptedRevisionId);
  const original = await readOriginal({get}, projectId, documentId,
    planning.observedPlanningCandidates[0].adoptedRevisionId);
  assert.equal(original.body, "Exact source");
  assert.equal((await workflow.getTask(owner, projectId, taskId)).task.state, "todo");
  assert.equal((await workflow.getTask(owner, projectId, taskId)).basis, null);
  for (const table of ["runtime_run", "delivery", "task_closure"] as const) {
    const count = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE project_id=$1 AND task_id=$2`, [projectId, taskId]);
    assert.equal(count.rows[0].count, 0);
  }
});

test("business, other Stage, stale Task revision and unversioned documents stay unavailable", async () => {
  const detail = await workflow.getTask(owner, projectId, taskId);
  const path = `/api/projects/${projectId}/orchestration/tasks/${taskId}/planning-sources?taskRevisionId=${detail.revision.id}`;
  const business = {...worker, scope: {...worker.scope, kind: "business" as const, roleId: builderRole}};
  worker.scope = business.scope;
  try {assert.equal((await app.inject({method: "GET", url: path, headers: {authorization: "Bearer worker-test"}})).statusCode, 403);}
  finally {worker.scope = {...business.scope, kind: "cognition", roleId: plannerRole};}
  const otherRevision = (await workflow.getTask(owner, projectId, otherTaskId)).revision.id;
  assert.equal((await app.inject({method: "GET", url: path.replace(taskId, otherTaskId).replace(detail.revision.id, otherRevision),
    headers: {authorization: "Bearer worker-test"}})).statusCode, 403);
  assert.equal((await app.inject({method: "GET", url: path.replace(detail.revision.id, randomUUID()),
    headers: {authorization: "Bearer worker-test"}})).statusCode, 403);
  assert.equal((await app.inject({method: "GET", url: `/api/projects/${projectId}/documents/${documentId}`,
    headers: {authorization: "Bearer worker-test"}})).statusCode, 403);
  assert.equal((await app.inject({method: "GET", url: path, headers: {authorization: `Bearer ${"o".repeat(40)}`}})).statusCode, 200);
  await assert.rejects(readPlanningSources(pool, worker.principal, projectId, otherTaskId, otherRevision, loopId),
    /authorized Stage/);
});

test("archive and new adoption withdraw old planning pointer without exposing a new body", async () => {
  const task = await workflow.getTask(owner, projectId, taskId);
  const old = (await workflow.getDocument(owner, projectId, documentId)).adopted!.id;
  const draft = await workflow.getDocument(owner, projectId, draftId);
  await execute({type: "document.adopt", documentId: draftId, expectedVersion: 1, revisionId: draft.current.id, reason: "Test"});
  await execute({type: "document.archive", documentId: draftId, expectedVersion: 2, reason: "Test"});
  assert.equal((await app.inject({method: "GET",
    url: `/api/projects/${projectId}/documents/${draftId}/revisions/${draft.current.id}/original`,
    headers: {authorization: "Bearer worker-test"}})).statusCode, 403);
  const archived = await readPlanningSources(pool, owner, projectId, taskId, task.revision.id, loopId);
  assert.deepEqual(archived.unavailableLinks, [{documentId: draftId, reason: "archived"}]);
  assert.equal(archived.observedPlanningCandidates.some(item => item.documentId === draftId), false);
  await execute({type: "document.revise", documentId, expectedVersion: 2, body: "New adopted source", reason: "Test"});
  const newRevision = (await workflow.getDocument(owner, projectId, documentId)).current.id;
  await execute({type: "document.adopt", documentId, expectedVersion: 3, revisionId: newRevision, reason: "Test"});
  const next = await readPlanningSources(pool, owner, projectId, taskId, task.revision.id, loopId);
  assert.equal(next.observedPlanningCandidates[0]?.adoptedRevisionId, newRevision);
  assert.equal(next.observedPlanningCandidates[0]?.contentHash, hash("New adopted source"));
  assert.equal((await app.inject({method: "GET",
    url: `/api/projects/${projectId}/documents/${documentId}/revisions/${old}/original`,
    headers: {authorization: "Bearer worker-test"}})).statusCode, 403);
  assert.equal((await app.inject({method: "GET", url: next.observedPlanningCandidates[0]!.originalPath,
    headers: {authorization: "Bearer worker-test"}})).statusCode, 200);
});

test("archiving a source preserves an already sealed Task basis original", async () => {
  const sealedDocumentId = randomUUID(), sealedTaskId = randomUUID();
  await execute({type: "document.create", documentId: sealedDocumentId, title: "Sealed source", body: "Fixed evidence", kind: "spec"});
  const source = await workflow.getDocument(owner, projectId, sealedDocumentId);
  await execute({type: "document.adopt", documentId: sealedDocumentId, expectedVersion: 1,
    revisionId: source.current.id, reason: "Test"});
  await execute({type: "task.create", taskId: sealedTaskId, stageId, title: "Started Task", content: "Use fixed evidence",
    acceptance: "Check", owner: builderRole, kind: "research", documentIds: [sealedDocumentId],
    consumer: "Reviewer", evidence: "Test", stopCondition: "Check"});
  await execute({type: "task.start", taskId: sealedTaskId, expectedVersion: 1,
    basis: [{documentId: sealedDocumentId, revisionId: source.current.id}], reason: "Test"});
  await execute({type: "document.archive", documentId: sealedDocumentId, expectedVersion: 2, reason: "Test"});
  const response = await app.inject({method: "GET",
    url: `/api/projects/${projectId}/documents/${sealedDocumentId}/revisions/${source.current.id}/original`,
    headers: {authorization: "Bearer worker-test"}});
  assert.equal(response.statusCode, 200, response.body);
});

test("a changed todo Task revision invalidates its earlier planning query", async () => {
  const before = await workflow.getTask(owner, projectId, taskId);
  await execute({type: "task.update", taskId, expectedVersion: before.task.version, title: "Revised seed",
    content: "Changed plan", acceptance: "Decide", owner: builderRole, kind: "research", reason: "Test"});
  const oldPath = `/api/projects/${projectId}/orchestration/tasks/${taskId}/planning-sources?taskRevisionId=${before.revision.id}`;
  const old = await app.inject({method: "GET", url: oldPath, headers: {authorization: "Bearer worker-test"}});
  assert.equal(old.statusCode, 409);
  assert.equal(old.json().code, "PLANNING_SOURCE_UNAVAILABLE");
  const current = await workflow.getTask(owner, projectId, taskId);
  assert.equal(current.task.state, "todo");
  assert.equal(current.basis, null);
  assert.equal((await readPlanningSources(pool, owner, projectId, taskId, current.revision.id, loopId)).observedPlanningCandidates.length, 1);
});

test("more than 19 linked sources fails at the bounded query", async () => {
  const documentIds = Array.from({length: 20}, () => randomUUID());
  for (const sourceId of documentIds)
    await execute({type: "document.create", documentId: sourceId, title: "Bounded source", body: "Unpublished", kind: "spec"});
  const crowdedTaskId = randomUUID();
  await execute({type: "task.create", taskId: crowdedTaskId, stageId, title: "Crowded", content: "Plan",
    acceptance: "Decide", owner: builderRole, kind: "research", documentIds,
    consumer: "Reviewer", evidence: "Test", stopCondition: "Decide"});
  const revisionId = (await workflow.getTask(owner, projectId, crowdedTaskId)).revision.id;
  await assert.rejects(readPlanningSources(pool, owner, projectId, crowdedTaskId, revisionId, loopId),
    /more than 19 linked/);
});

test("Goal-only Loop keeps the same Goal boundary across Stage tasks", async () => {
  const goalOnlyLoopId = randomUUID();
  const enrolled = await orchestration.execute(owner, {type: "loop.enroll", projectId, operationId: randomUUID(), loopId: goalOnlyLoopId,
    goalId, stageId: null, cognitiveRoleId: plannerRole, allowedBusinessRoleIds: [builderRole],
    sourceAfter: {createdAtUtc: "2026-10-24T00:00:00.000Z", eventId: null},
    maxRuns: 1, maxConcurrent: 1, reason: "Goal-only planning scope fixture"});
  assert.equal(enrolled.entityId, goalOnlyLoopId);
  const current = await workflow.getTask(owner, projectId, taskId);
  const accepted = await readPlanningSources(pool, worker.principal, projectId, taskId, current.revision.id, goalOnlyLoopId);
  assert.equal(accepted.observedPlanningCandidates.length, 1);
  const other = await workflow.getTask(owner, projectId, otherTaskId);
  await assert.rejects(readPlanningSources(pool, worker.principal, projectId, otherTaskId, other.revision.id, goalOnlyLoopId),
    /authorized Stage/);
});
