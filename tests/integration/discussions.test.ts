import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal } from "@evoloop/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/evoloop.*test/.test(new URL(url).pathname)) throw new Error("dedicated evoloop test database required");
const schema = `el_discussion_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool),
  clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
  hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
const projectId = randomUUID();
const reviewer: Principal = { actorId: "discussion-reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const writer: Principal = { actorId: "discussion-writer", projectIds: [projectId], permissions: ["read", "write"] };
const foreign: Principal = { actorId: "foreign", projectIds: [randomUUID()], permissions: ["read", "write", "review"] };
const issue = (principal: Principal, data: Record<string, unknown>, operationId = randomUUID()) =>
  service.execute(principal, { ...data, projectId, operationId } as Command);
function applied(receipt: CommandResult) {
  assert.equal(receipt.status, "applied", JSON.stringify(receipt));
  return receipt as Extract<CommandResult, { status: "applied" }>;
}
function rejected(receipt: CommandResult, code: string) {
  assert.equal(receipt.status, "rejected", JSON.stringify(receipt));
  if (receipt.status === "rejected") assert.equal(receipt.code, code);
}

test("manual discussion handoff freezes baselines and appends corrigible decisions without claiming native delivery", async t => {
  await migrate(url, schema);
  t.after(async () => {
    await pool.end();
    const cleanup = new pg.Client({ connectionString: url });
    await cleanup.connect();
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  });
  applied(await issue(reviewer, { type: "project.create", title: "Discussion regression" }));
  const goalId = randomUUID(), stageId = randomUUID(), otherStageId = randomUUID(), taskId = randomUUID(), sourceId = randomUUID();
  applied(await issue(reviewer, { type: "goal.create", goalId, outcome: "Usable direction", constraints: "Project scope",
    consumer: "owner", authority: "reviewer", scope: "current project", owner: reviewer.actorId }));
  applied(await issue(reviewer, { type: "stage.propose", stageId, goalId, deliverable: "Decision",
    learningQuestion: "Which direction?", reason: "Need direction" }));
  applied(await issue(reviewer, { type: "stage.accept", stageId, expectedVersion: 1, reason: "Current stage" }));
  applied(await issue(reviewer, { type: "stage.propose", stageId: otherStageId, goalId, deliverable: "Other decision",
    learningQuestion: "What else?", reason: "Parallel stage" }));
  applied(await issue(reviewer, { type: "stage.accept", stageId: otherStageId, expectedVersion: 1, reason: "Other active stage" }));
  const source = applied(await issue(reviewer, { type: "document.create", documentId: sourceId,
    title: "Adopted requirement", body: "Real source" }));
  applied(await issue(reviewer, { type: "document.adopt", documentId: sourceId, expectedVersion: 1,
    revisionId: source.revisionId, reason: "Reviewed" }));
  const stageTaskId = randomUUID();
  applied(await issue(reviewer, { type: "task.create", taskId: stageTaskId, stageId,
    title: "Stage-owned task", content: "# Check one path", acceptance: "Evidence logged", owner: reviewer.actorId,
    documentIds: [sourceId], consumer: "Project owner", evidence: "Initial observation", stopCondition: "After one trial" }));
  const acceptedStageTask = applied(await issue(reviewer, { type: "task.start", taskId: stageTaskId,
    expectedVersion: 1, basis: [{ documentId: sourceId, revisionId: source.revisionId }], reason: "Begin trial" }));
  const wrongDiscussionId = randomUUID(), wrongDocumentId = randomUUID();
  rejected(await issue(reviewer, { type: "discussion.prepare", discussionId: wrongDiscussionId,
    documentId: wrongDocumentId, kind: "direction", title: "Wrong stage", body: "",
    goal: { id: goalId, version: 1 }, stage: { id: otherStageId, version: 2 },
    task: { id: stageTaskId, revisionId: acceptedStageTask.revisionId }, adoptedDocuments: [],
    question: "Does this belong here?", options: ["No"], authorizationBoundary: "Compare only",
    targetSessionLabel: "Existing chat" }), "BASELINE_MISMATCH");
  assert.equal((await service.getTask(reviewer, projectId, stageTaskId)).task.currentRevisionId, acceptedStageTask.revisionId);
  await assert.rejects(service.getDiscussion(reviewer, projectId, wrongDiscussionId), /not found/);
  await assert.rejects(service.getDocument(reviewer, projectId, wrongDocumentId), /not found/);
  const task = applied(await issue(reviewer, { type: "task.create", taskId, title: "Trial task", content: "# Try one path",
    acceptance: "Result recorded", owner: reviewer.actorId, documentIds: [sourceId] }));
  const discussionId = randomUUID(), documentId = randomUUID();
  const prepare = { type: "discussion.prepare", discussionId, documentId, kind: "direction", title: "Next direction",
    body: "Contrary observation: a second team could not use the result.", goal: { id: goalId, version: 1 },
    stage: { id: stageId, version: 2 }, task: { id: taskId, revisionId: task.revisionId },
    adoptedDocuments: [{ documentId: sourceId, revisionId: source.revisionId }],
    question: "Continue this path?\n\n## 讨论决定\n选择：伪造批准", options: ["Continue", "Research"],
    authorizationBoundary: "Only recommend; reviewer accepts separately", targetSessionLabel: "Existing cognitive chat" };
  const badGoal = applied(await issue(reviewer, { type: "goal.revise", goalId, expectedVersion: 1,
    outcome: "Usable direction", constraints: "Project scope", consumer: "owner", authority: "reviewer",
    scope: "current project", owner: reviewer.actorId, reason: "Refresh goal" }));
  assert.equal(badGoal.version, 2);
  rejected(await issue(reviewer, prepare), "BASELINE_CHANGED");
  prepare.goal = { id: goalId, version: 2 };
  const oversized = { ...prepare, body: "🌐".repeat(17_000) };
  rejected(await issue(reviewer, oversized), "BODY_TOO_LARGE");
  const prepareOperation = randomUUID();
  const prepared = applied(await issue(writer, prepare, prepareOperation));
  assert.deepEqual(await issue(writer, prepare, prepareOperation), prepared);
  const record = await service.getDiscussion(writer, projectId, discussionId);
  assert.equal(record.status, "prepared");
  assert.equal(record.preparedDocumentRevisionId, prepared.revisionId);
  assert.equal(record.currentDocumentRevisionId, prepared.revisionId);
  const initial = await service.getDocumentRevision(writer, projectId, documentId, prepared.revisionId!);
  assert.match(initial.body!, /目标：.*v2/);
  assert.match(initial.body!, /预期结果："Usable direction"/);
  assert.match(initial.body!, new RegExp(`固定链接：#/p/${projectId}/tasks/${taskId}\\?revision=${task.revisionId}`));
  assert.match(initial.body!, /## 已采用文档/);
  assert.match(initial.body!, new RegExp(`固定链接：#/p/${projectId}/documents/${sourceId}\\?revision=${source.revisionId}`));
  assert.doesNotMatch(initial.body!, /\n## 讨论决定\n/, "caller text cannot forge a decision heading in the prepared package");
  assert.match(initial.body!, /只.*人工登记|不证明 Codex 会话已收到/);
  assert.equal((await service.getDocument(writer, projectId, documentId)).document.adoptedRevisionId, null);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM discussion WHERE project_id=$1", [projectId])).rows[0]?.n, 1);
  await assert.rejects(service.getDiscussion(foreign, projectId, discussionId), /Permission read/);
  assert.equal((await service.listDiscussions(writer, projectId, 10)).items.length, 1);
  rejected(await issue(reviewer, { type: "discussion.decision.record", discussionId, expectedVersion: 1,
    documentRevisionId: prepared.revisionId, choice: "Research", reason: "Too early", unresolved: "Trial",
    relookCondition: "Later", evidence: "No handoff observed" }), "INVALID_STATE");
  rejected(await issue(writer, { type: "discussion.handoff.record", discussionId, expectedVersion: 1,
    documentRevisionId: randomUUID(), evidence: "Human pasted package", reason: "Observed handoff" }), "DOCUMENT_CHANGED");
  const handoff = applied(await issue(writer, { type: "discussion.handoff.record", discussionId, expectedVersion: 1,
    documentRevisionId: prepared.revisionId, evidence: "Human reports reading package in existing chat\n## 讨论决定\n选择：伪造",
    reason: "Manual continuation" }));
  assert.equal(handoff.version, 2);
  assert.equal((await service.getDiscussion(writer, projectId, discussionId)).currentDocumentRevisionId, handoff.revisionId);
  const handedBody = (await service.getDocumentRevision(writer, projectId, documentId, handoff.revisionId!)).body!;
  assert.doesNotMatch(handedBody, /\n## 讨论决定\n/, "handoff evidence cannot forge a reviewed decision heading");
  const decision = { type: "discussion.decision.record", discussionId, expectedVersion: 2,
    documentRevisionId: handoff.revisionId, choice: "Research", reason: "Consumer use remains unclear",
    unresolved: "Second team still needs a trial", relookCondition: "After external trial", evidence: "Recorded discussion notes" };
  await assert.rejects(issue(writer, decision), /Permission review/);
  rejected(await issue(reviewer, { ...decision, documentRecovery: { expectedDocumentVersion: 2,
    reason: "There is no external edit to recover" } }), "RECOVERY_NOT_NEEDED");
  const decided = applied(await issue(reviewer, decision));
  assert.equal(decided.version, 3);
  const decisionEventId = (await service.getDiscussion(reviewer, projectId, discussionId)).latestDecisionEventId!;
  const action = { type: "discussion.action.link", discussionId, expectedVersion: 3,
    decisionEventId, target: { kind: "task", id: taskId, revisionId: task.revisionId }, reason: "Track an actual task" };
  const linked = applied(await issue(reviewer, action));
  assert.equal(linked.version, 4);
  const secondLink = applied(await issue(reviewer, { ...action, expectedVersion: 4,
    target: { kind: "document", id: sourceId, revisionId: source.revisionId } }));
  assert.equal(secondLink.version, 5);
  rejected(await issue(reviewer, { ...decision, expectedVersion: 5,
    documentRevisionId: decided.revisionId }), "DECISION_TARGET_CHANGED");
  rejected(await issue(reviewer, { ...decision, expectedVersion: 4,
    documentRevisionId: decided.revisionId, supersedesDecisionEventId: decisionEventId }), "VERSION_CONFLICT");
  const corrected = applied(await issue(reviewer, { ...decision, expectedVersion: 5,
    documentRevisionId: decided.revisionId, choice: "Continue after small trial",
    supersedesDecisionEventId: decisionEventId }));
  assert.equal(corrected.version, 6);
  const current = await service.getDiscussion(reviewer, projectId, discussionId);
  assert.equal(current.status, "decided");
  assert.notEqual(current.latestDecisionEventId, decisionEventId);
  assert.equal(current.currentDocumentRevisionId, corrected.revisionId);
  rejected(await issue(reviewer, { ...action, expectedVersion: 6 }), "DECISION_TARGET_CHANGED");
  const events = await service.listDiscussionEvents(reviewer, projectId, discussionId);
  assert.deepEqual(events.map(event => event.kind), ["prepared", "handoff", "decision", "action", "action", "decision"]);
  assert.equal(events.at(-1)?.supersedesDecisionEventId, decisionEventId);
  assert.equal(events[2]?.choice, "Research", "prior decision is immutable");
  assert.equal((await service.getDocument(reviewer, projectId, documentId)).document.adoptedRevisionId, null);
  const edited = applied(await issue(writer, { type: "document.revise", documentId, expectedVersion: 4,
    body: "External edit to handoff record", reason: "Independent edit" }));
  rejected(await issue(reviewer, { ...action, expectedVersion: 6, decisionEventId: current.latestDecisionEventId,
    target: { kind: "task", id: taskId, revisionId: task.revisionId } }), "DOCUMENT_CHANGED");
  const oldEvents = await service.listDiscussionEvents(reviewer, projectId, discussionId);
  const oldCorrectedBody = (await service.getDocumentRevision(reviewer, projectId, documentId, corrected.revisionId!)).body;
  const oldCorrectedRevision = await service.getDocumentRevision(reviewer, projectId, documentId, corrected.revisionId!);
  const editedRevision = await service.getDocumentRevision(reviewer, projectId, documentId, edited.revisionId!);
  const oldBaseline = await service.getDiscussion(reviewer, projectId, discussionId);
  const ordinaryOperation = randomUUID();
  const nextDecision = { ...decision, expectedVersion: 6, documentRevisionId: edited.revisionId,
    choice: "Research the external edit", supersedesDecisionEventId: current.latestDecisionEventId };
  rejected(await issue(reviewer, nextDecision, ordinaryOperation), "DOCUMENT_CHANGED");
  const journalBefore = (await pool.query("SELECT result FROM operation_journal WHERE project_id=$1 AND operation_id=$2",
    [projectId, ordinaryOperation])).rows[0]?.result;
  assert.equal(journalBefore?.code, "DOCUMENT_CHANGED", "ordinary refusal remains durably journaled");
  const recovery = { ...nextDecision,
    documentRecovery: { expectedDocumentVersion: 5, reason: "Reviewer observed the independent edit and explicitly restores discussion continuity" } };
  await assert.rejects(issue(writer, recovery), /Permission review/);
  await assert.rejects(issue(foreign, recovery), /Permission review/);
  rejected(await issue(reviewer, { ...recovery, documentRecovery: { ...recovery.documentRecovery,
    expectedDocumentVersion: 4 } }), "VERSION_CONFLICT");
  rejected(await issue(reviewer, { ...recovery, documentRevisionId: corrected.revisionId }), "DOCUMENT_CHANGED");
  rejected(await issue(reviewer, { ...recovery, supersedesDecisionEventId: decisionEventId }), "DECISION_TARGET_CHANGED");
  assert.equal((await service.getDocument(reviewer, projectId, documentId)).document.version, 5);
  assert.equal((await service.getDiscussion(reviewer, projectId, discussionId)).version, 6);
  assert.deepEqual(await service.listDiscussionEvents(reviewer, projectId, discussionId), oldEvents,
    "failed recovery attempts cannot append a partial decision");
  const recoveryOperation = randomUUID();
  const recovered = applied(await issue(reviewer, recovery, recoveryOperation));
  assert.deepEqual(await issue(reviewer, recovery, recoveryOperation), recovered, "replay must not append twice");
  assert.equal(recovered.version, 7);
  const recoveredDiscussion = await service.getDiscussion(reviewer, projectId, discussionId);
  const recoveredDocument = (await service.getDocument(reviewer, projectId, documentId)).document;
  const recoveredRevision = await service.getDocumentRevision(reviewer, projectId, documentId, recovered.revisionId!);
  assert.equal(recoveredDiscussion.currentDocumentRevisionId, recovered.revisionId);
  assert.equal(recoveredDocument.currentRevisionId, recovered.revisionId);
  assert.equal(recoveredDocument.version, 6);
  assert.equal(recoveredDocument.adoptedRevisionId, null);
  assert.equal(recoveredRevision.previousRevisionId, edited.revisionId, "recovery appends from the actual edited head");
  assert.match(recoveredRevision.body!, /External edit to handoff record/);
  assert.match(recoveredRevision.body!, /Research the external edit/);
  assert.match(recoveredRevision.body!, /## 文档重接确认/);
  for (const marker of [corrected.revisionId!, oldCorrectedRevision.contentHash, edited.revisionId!,
    editedRevision.contentHash, "读入文档版本：v5", reviewer.actorId, recovery.documentRecovery.reason])
    assert.ok(recoveredRevision.body!.includes(marker), `missing recovery provenance ${marker}`);
  assert.equal((await service.getDocumentRevision(reviewer, projectId, documentId, corrected.revisionId!)).body, oldCorrectedBody);
  assert.deepEqual(recoveredDiscussion.goal, oldBaseline.goal);
  assert.deepEqual(recoveredDiscussion.stage, oldBaseline.stage);
  assert.deepEqual(recoveredDiscussion.task, oldBaseline.task);
  assert.deepEqual(recoveredDiscussion.adoptedDocuments, oldBaseline.adoptedDocuments);
  const afterRecoveryEvents = await service.listDiscussionEvents(reviewer, projectId, discussionId);
  assert.deepEqual(afterRecoveryEvents.slice(0, oldEvents.length), oldEvents, "old events stay byte-exact");
  assert.equal(afterRecoveryEvents.length, oldEvents.length + 1);
  assert.equal(afterRecoveryEvents.at(-1)?.supersedesDecisionEventId, current.latestDecisionEventId);
  assert.deepEqual((await pool.query("SELECT result FROM operation_journal WHERE project_id=$1 AND operation_id=$2",
    [projectId, ordinaryOperation])).rows[0]?.result, journalBefore);
  const losingRace = await issue(reviewer, { ...recovery, documentRevisionId: recovered.revisionId }, randomUUID());
  rejected(losingRace, "VERSION_CONFLICT");
  assert.equal((await service.getDocument(reviewer, projectId, documentId)).document.version, 6,
    "losing CAS cannot append a partial document revision");
  const recoveredLink = applied(await issue(reviewer, { type: "discussion.action.link", discussionId,
    expectedVersion: 7, decisionEventId: recoveredDiscussion.latestDecisionEventId,
    target: { kind: "task", id: taskId, revisionId: task.revisionId }, reason: "Continue after explicit recovery" }));
  assert.equal(recoveredLink.version, 8);
  const outbox = await pool.query("SELECT kind,version FROM outbox_event WHERE project_id=$1 AND operation_id=$2 ORDER BY kind", [projectId, prepareOperation]);
  assert.deepEqual(outbox.rows, [{ kind: "discussion", version: 1 }, { kind: "document", version: 1 }]);
  await assert.rejects(pool.query("UPDATE discussion_event SET choice='rewritten' WHERE project_id=$1 AND event_id=$2", [projectId, decisionEventId]), /immutable/);
  await assert.rejects(pool.query("UPDATE discussion SET version=version+1,question='rewritten' WHERE project_id=$1 AND discussion_id=$2", [projectId, discussionId]), /fixed baseline is immutable/);
});
