import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import { WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal } from "@evoloop/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/evoloop.*test/.test(new URL(url).pathname)) throw new Error("dedicated evoloop test database required");
const schema = `el_history_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool),
  clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
  hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
const projectId = randomUUID();
const reviewer: Principal = { actorId: "history-reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const writer: Principal = { actorId: "history-writer", projectIds: [projectId], permissions: ["read", "write"] };
const issue = (principal: Principal, data: Record<string, unknown>, operationId = randomUUID()) =>
  service.execute(principal, { ...data, projectId, operationId } as Command);
const applied = (value: CommandResult) => {
  assert.equal(value.status, "applied", JSON.stringify(value));
  return value as Extract<CommandResult, { status: "applied" }>;
};
const rejected = (value: CommandResult, code: string) => {
  assert.equal(value.status, "rejected", JSON.stringify(value));
  if (value.status === "rejected") assert.equal(value.code, code);
};

test("task history exposes persisted states and reviewed-stage correction appends a scoped superseding review", async t => {
  await migrate(url, schema);
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: url });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  applied(await issue(reviewer, { type: "project.create", title: "History regression" }));
  const ownerRoleId=fixtureRoleId(reviewer.actorId);
  await seedFixtureRole(pool,projectId,ownerRoleId);
  const goalId = randomUUID(), firstStageId = randomUUID(), secondStageId = randomUUID();
  applied(await issue(reviewer, { type: "goal.create", goalId, outcome: "One verified outcome", constraints: "Small scope",
    consumer: "reader", authority: "project owner", scope: "single stage", owner: reviewer.actorId }));
  const prepareStage = async (stageId: string) => {
    applied(await issue(reviewer, { type: "stage.propose", stageId, goalId, deliverable: "One artifact",
      learningQuestion: "What changed?", reason: "Proposed" }));
    applied(await issue(reviewer, { type: "stage.accept", stageId, expectedVersion: 1, reason: "Accepted" }));
    return applied(await issue(reviewer, { type: "stage.review", stageId, expectedVersion: 2,
      adopted: "Observed result", rejected: "Unproven alternative", gap: "One sample", nextChoice: "research",
      evidence: "Reviewed artifact", reason: "Initial review" }));
  };
  const firstReviewReceipt = await prepareStage(firstStageId);
  const secondReviewReceipt = await prepareStage(secondStageId);
  const firstReview = (await service.listStageReviews(reviewer, projectId, firstStageId))[0]!;
  const secondReview = (await service.listStageReviews(reviewer, projectId, secondStageId))[0]!;
  assert.equal(firstReview.id, firstReviewReceipt.revisionId);
  assert.equal(firstReview.supersedesReviewId, null, "pre-correction reviews remain valid without a predecessor");

  const documentId = randomUUID(), taskId = randomUUID();
  const document = applied(await issue(reviewer, { type: "document.create", documentId,
    title: "Fixed source", body: "Original requirement" }));
  applied(await issue(reviewer, { type: "document.adopt", documentId, expectedVersion: 1,
    revisionId: document.revisionId, reason: "Accepted source" }));
  applied(await issue(reviewer, { type: "task.create", taskId, title: "Historical task", content: "# Read it\nUse the fixed source.",
    acceptance: "One answer", owner: ownerRoleId, documentIds: [documentId] }));
  const updated = applied(await issue(reviewer, { type: "task.update", taskId, expectedVersion: 1,
    title: "Historical task", content: "# Read it\nUse the fixed source and record the answer.",
    acceptance: "One answer", owner: ownerRoleId, documentIds: [documentId], reason: "Clarify the instruction" }));
  applied(await issue(reviewer, { type: "task.start", taskId, expectedVersion: updated.version,
    basis: [{ documentId, revisionId: document.revisionId }], reason: "Bound to original source" }));
  const taskBefore = await service.getTask(reviewer, projectId, taskId);
  const history = await service.listTaskRevisions(reviewer, projectId, taskId);
  assert.deepEqual(history.map(item => item.revision.state), ["todo", "todo", "in_progress"]);
  assert.equal(history[1]?.revision.reason, "Clarify the instruction");
  assert.equal(history[2]?.revision.actorId, reviewer.actorId);
  assert.ok(history.every(item => Number.isFinite(Date.parse(item.revision.createdAt))));
  assert.equal(history[2]?.basis?.members.find(item => item.documentId === documentId)?.revisionId, document.revisionId);
  assert.equal(history[2]?.basis?.members.find(item => item.documentId === history[2]?.revision.contentDocumentId)?.revisionId,
    history[2]?.revision.contentRevisionId);
  assert.equal(history[0]?.revision.content, "# Read it\nUse the fixed source.");
  assert.equal(history[2]?.revision.content, "# Read it\nUse the fixed source and record the answer.");
  assert.notEqual(history[0]?.revision.contentRevisionId, history[1]?.revision.contentRevisionId,
    "the old Task revision keeps its original Document revision");
  assert.equal(history[0]?.revision.contentDocumentId, history[2]?.revision.contentDocumentId);
  await assert.rejects(service.listTaskRevisions({ ...writer, projectIds: [randomUUID()] }, projectId, taskId), /Permission read/);

  const correction = { type: "stage.review.correct", stageId: firstStageId, expectedVersion: 3,
    supersedesReviewId: firstReview.id, adopted: "Corrected observation", rejected: "Original explanation",
    gap: "Still one sample", nextChoice: "continue", evidence: "Follow-up inspection", reason: "Correct the interpretation" };
  rejected(await issue(reviewer, { ...correction, expectedVersion: 2 }), "VERSION_CONFLICT");
  rejected(await issue(reviewer, { ...correction, supersedesReviewId: secondReview.id }), "REVIEW_TARGET_CHANGED");
  await assert.rejects(issue(writer, correction), /Permission review/);
  const { supersedesReviewId: _supersedesReviewId, ...ordinaryReview } = correction;
  rejected(await issue(reviewer, { ...ordinaryReview, type: "stage.review" }), "INVALID_STATE");
  const operationId = randomUUID();
  const corrected = applied(await issue(reviewer, correction, operationId));
  assert.deepEqual(await issue(reviewer, correction, operationId), corrected, "same operation replays its receipt");
  assert.equal(corrected.version, 4);
  const reviews = await service.listStageReviews(reviewer, projectId, firstStageId);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews[0], firstReview, "old review is untouched");
  assert.equal(reviews[1]?.id, corrected.revisionId);
  assert.equal(reviews[1]?.supersedesReviewId, firstReview.id);
  assert.equal(reviews[1]?.stageVersion, 3);
  assert.equal((await service.getStage(reviewer, projectId, firstStageId)).state, "reviewed");
  assert.deepEqual((await service.listStageRevisions(reviewer, projectId, firstStageId)).map(item => item.state),
    ["proposed", "active", "reviewed", "reviewed"]);
  assert.deepEqual(await service.getTask(reviewer, projectId, taskId), taskBefore, "stage correction does not touch the task");
  rejected(await issue(reviewer, { ...correction, expectedVersion: 4 }), "REVIEW_TARGET_CHANGED");
  const secondCorrection = applied(await issue(reviewer, { ...correction, expectedVersion: 4,
    supersedesReviewId: corrected.revisionId, adopted: "Rechecked interpretation", reason: "Further correction" }));
  assert.equal(secondCorrection.version, 5);
  assert.equal((await service.listStageReviews(reviewer, projectId, firstStageId))[2]?.supersedesReviewId, corrected.revisionId);
  assert.equal((await service.getStage(reviewer, projectId, firstStageId)).state, "reviewed");
  const outbox = await pool.query("SELECT kind,version FROM outbox_event WHERE project_id=$1 AND operation_id=$2", [projectId, operationId]);
  assert.deepEqual(outbox.rows, [{ kind: "stage.review.correct", version: 4 }]);
  await assert.rejects(pool.query("UPDATE stage_review SET adopted='rewritten' WHERE project_id=$1 AND review_id=$2", [projectId, firstReview.id]), /append-only/);
  await assert.rejects(pool.query(`INSERT INTO stage_review(project_id,review_id,stage_id,stage_version,supersedes_review_id,adopted,rejected,gap,next_choice,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,99,$4,'a','r','g','stop','e','reason','actor',now())`,
  [projectId, randomUUID(), firstStageId, secondReviewReceipt.revisionId]), /foreign key/);
});
