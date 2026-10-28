import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { CommandResult, Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/\/evoloop_[a-z0-9_]*test(?:\?|$)/.test(database)) throw new Error("Use a dedicated evoloop_*test database");

test("reviewed-stage Task can be explicitly detached and rebound without changing its fixed history", async t => {
  const schema = `task_stage_${randomUUID().replaceAll("-", "")}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const projectId = randomUUID(), otherProjectId = randomUUID(), taskId = randomUUID();
  const oldStageId = randomUUID(), nextStageId = randomUUID(), proposedStageId = randomUUID(), foreignStageId = randomUUID();
  const goalId = randomUUID(), foreignGoalId = randomUUID();
  const principal: Principal = { actorId: "owner", projectIds: [projectId, otherProjectId], permissions: ["read", "write", "review"] };
  const token = randomUUID(), writerToken = randomUUID(), revokedToken = randomUUID();
  const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool),
    clock: { now: () => "2026-10-21T00:00:00.000Z" }, ids: { next: randomUUID },
    hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const app = await buildServer({ service, credentials: [
    { token, ...principal },
    { token: writerToken, actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] },
    { token: revokedToken, actorId: principal.actorId, projectIds: [projectId], permissions: ["read", "write"] },
  ] });
  t.after(async () => {
    await app.close(); await pool.end();
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const send = async (body: Record<string, unknown>, credential = token, scopedProjectId = projectId) => {
    const operationId = (body.operationId as string | undefined) ?? randomUUID();
    const reply = await app.inject({ method: "POST", url: "/api/commands",
      headers: { authorization: `Bearer ${credential}` }, payload: { projectId: scopedProjectId, operationId, ...body } });
    return { reply, result: reply.json() as CommandResult, operationId };
  };
  const applied = ({ result }: Awaited<ReturnType<typeof send>>) => {
    assert.equal(result.status, "applied", JSON.stringify(result));
    return result as Extract<CommandResult, { status: "applied" }>;
  };
  const rejected = ({ result }: Awaited<ReturnType<typeof send>>, code: string) => {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.code, code);
  };
  const makeGoal = async (id: string, scopedProjectId = projectId) => applied(await send({ type: "goal.create", goalId: id,
    outcome: "One checked result", constraints: "Keep historical decisions", consumer: "owner",
    authority: "Local review", scope: "This test project", owner: "owner" }, token, scopedProjectId));
  const proposeStage = async (stageId: string, goal: string, scopedProjectId = projectId) => applied(await send({
    type: "stage.propose", stageId, goalId: goal, deliverable: "Checked work", learningQuestion: "Was it useful?",
    reason: "Plan a bounded stage" }, token, scopedProjectId));
  const acceptStage = async (stageId: string, scopedProjectId = projectId) => applied(await send({
    type: "stage.accept", stageId, expectedVersion: 1, reason: "Authorize stage" }, token, scopedProjectId));
  applied(await send({ type: "project.create", title: "Stage rebinding" }));
  const ownerRoleId=fixtureRoleId("owner");
  await seedFixtureRole(pool,projectId,ownerRoleId);
  applied(await send({ type: "project.create", title: "Other project" }, token, otherProjectId));
  await makeGoal(goalId);
  await makeGoal(foreignGoalId, otherProjectId);
  await proposeStage(oldStageId, goalId);
  await acceptStage(oldStageId);
  await proposeStage(nextStageId, goalId);
  await acceptStage(nextStageId);
  await proposeStage(proposedStageId, goalId);
  await proposeStage(foreignStageId, foreignGoalId, otherProjectId);
  await acceptStage(foreignStageId, otherProjectId);

  const original = applied(await send({ type: "task.create", taskId, title: "Original Task", content: "Keep same task identity",
    acceptance: "A checked result", owner: ownerRoleId, stageId: oldStageId, consumer: "owner",
    evidence: "Observed original need", stopCondition: "Owner reviews delivery" }));
  const first = await service.getTask(principal, projectId, taskId);
  assert.equal(first.proposal?.stageId, oldStageId);
  applied(await send({ type: "stage.review", stageId: oldStageId, expectedVersion: 2,
    adopted: "Observed outcome", rejected: "No automatic continuation", gap: "New scope needs a decision",
    nextChoice: "continue", evidence: "Fixed review", reason: "Review completed" }));
  assert.equal((await service.getStage(principal, projectId, oldStageId)).state, "reviewed");

  const omitted = applied(await send({ type: "task.update", taskId, expectedVersion: original.version,
    title: "Reframed original Task", content: "Updated work", acceptance: "A checked result", owner: ownerRoleId,
    reason: "Reframe without touching stage" }));
  assert.equal((await service.getTask(principal, projectId, taskId)).proposal?.stageId, oldStageId,
    "omitting stageId preserves the fixed association");
  const refusedStart = await send({ type: "task.start", taskId, expectedVersion: omitted.version,
    reason: "Try reviewed stage" });
  rejected(refusedStart, "INVALID_STAGE");

  const detachCommand = { type: "task.update", taskId, expectedVersion: omitted.version,
    title: "Reframed original Task", content: "Updated work", acceptance: "A checked result", owner: ownerRoleId,
    stageId: null, reason: "Explicitly detach after reviewed stage" };
  const writer = await send(detachCommand, writerToken);
  assert.equal(writer.reply.statusCode, 403);
  const revokedOperationId = randomUUID();
  const authorizedDetach = applied(await send({ ...detachCommand, operationId: revokedOperationId }));
  assert.equal((await send({ ...detachCommand, operationId: revokedOperationId }, revokedToken)).reply.statusCode, 403,
    "a successful operation cannot be replayed after review authority is withdrawn");
  const detached = await service.getTask(principal, projectId, taskId);
  assert.equal(detached.proposal?.stageId, null);
  assert.equal(detached.task.id, taskId);
  assert.equal((await service.getTaskRevision(principal, projectId, taskId, first.revision.id)).revision.content, "Keep same task identity");
  const oldProposal = await pool.query("SELECT stage_id FROM task_proposal WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3",
    [projectId, taskId, first.revision.id]);
  assert.equal(oldProposal.rows[0].stage_id, oldStageId);
  assert.equal((await service.getStage(principal, projectId, oldStageId)).state, "reviewed");
  assert.equal((await service.listStageReviews(principal, projectId, oldStageId)).length, 1);
  const refusedJournal = await service.getOperation(principal, projectId, refusedStart.operationId);
  assert.equal(refusedJournal?.result.status, "rejected");

  const started = applied(await send({ type: "task.start", taskId, expectedVersion: authorizedDetach.version,
    reason: "Authorize reframed original Task" }));
  assert.equal((await service.getTask(principal, projectId, taskId)).task.state, "in_progress");
  rejected(await send({ type: "task.update", taskId, expectedVersion: started.version,
    title: "Reframed original Task", content: "Updated work", acceptance: "A checked result", owner: ownerRoleId,
    stageId: nextStageId, reason: "Cannot rebind while running" }), "REOPEN_REQUIRED");
  const reopened = applied(await send({ type: "task.reopen", taskId, expectedVersion: started.version,
    reason: "Plan next phase" }));
  rejected(await send({ type: "task.update", taskId, expectedVersion: reopened.version,
    title: "Reframed original Task", content: "Updated work", acceptance: "A checked result", owner: ownerRoleId,
    stageId: proposedStageId, reason: "Inactive stage" }), "INVALID_STAGE");
  rejected(await send({ type: "task.update", taskId, expectedVersion: reopened.version,
    title: "Reframed original Task", content: "Updated work", acceptance: "A checked result", owner: ownerRoleId,
    stageId: foreignStageId, reason: "Cross-project stage" }), "NOT_FOUND");
  const rebound = applied(await send({ type: "task.update", taskId, expectedVersion: reopened.version,
    title: "Reframed original Task", content: "Updated work", acceptance: "A checked result", owner: ownerRoleId,
    stageId: nextStageId, reason: "Bind active next stage" }));
  assert.equal((await service.getTask(principal, projectId, taskId)).proposal?.stageId, nextStageId);
  applied(await send({ type: "task.start", taskId, expectedVersion: rebound.version, reason: "Start under active stage" }));
});
