import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { applyTaskCollaboration, taskAnswerInputBlock } from "../../core/src/task-collaboration.ts";
import type { DiscussionEvent, DiscussionRecord, TaskCollaborationCommand } from "@evoloop/contracts/discussions";
import type { Command, Document, DocumentRevision, Principal } from "@evoloop/contracts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Task collaboration storage test requires a dedicated evoloop_*_test database");
const schema = `el_task_collab_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const now = "2026-10-25T00:00:00.000Z";
const hash = (body: string) => createHash("sha256").update(body).digest("hex");

before(async () => { await migrate(url, schema); });
after(async () => {
  await pool.end();
  const cleanup = new pg.Client({ connectionString: url });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

test("Task Discussion and fixed-reference events survive PostgreSQL readback, CAS and immutable journal", async () => {
  const projectId = randomUUID(), taskId = randomUUID(), taskRevisionId = randomUUID(), basisId = randomUUID();
  const sourceId = randomUUID(), sourceRevisionId = randomUUID(), primaryId = randomUUID(), primaryRevisionId = randomUUID();
  const sessionId = randomUUID(), runId = randomUUID(), discussionId = randomUUID(), channelId = randomUUID(), channelRevisionId = randomUUID();
  const messageId = randomUUID(), evidenceId = randomUUID(), evidenceRevisionId = randomUUID();
  const makeDoc = (id: string, revisionId: string, body: string, kind: Document["kind"] = "report") => ({
    head: { projectId, id, title: body, version: 1, currentRevisionId: revisionId,
      adoptedRevisionId: null, kind, status: "draft" as const } satisfies Document,
    revision: { projectId, documentId: id, id: revisionId, body, format: "markdown" as const,
      mediaType: "text/markdown", originalName: `${id}.md`, payloadRef: null, entrypoint: null,
      assetsManifest: [], contentHash: hash(body), author: "worker", createdAt: now,
      previousRevisionId: null, reason: "fixed" } satisfies DocumentRevision,
  });
  const source = makeDoc(sourceId, sourceRevisionId, "Source", "spec");
  const primary = makeDoc(primaryId, primaryRevisionId, "Task", "task");
  const channel = makeDoc(channelId, channelRevisionId, "Channel", "discussion");
  const evidence = makeDoc(evidenceId, evidenceRevisionId, "Actual answer");
  const record: DiscussionRecord = { projectId, id: discussionId, version: 1, kind: "task_collaboration",
    status: "prepared", documentId: channelId, preparedDocumentRevisionId: channelRevisionId,
    currentDocumentRevisionId: channelRevisionId, latestDecisionEventId: null, goal: null, stage: null,
    task: { id: taskId, revisionId: taskRevisionId }, adoptedDocuments: [], question: "", options: [],
    authorizationBoundary: "", targetSessionLabel: "", targetSessionRef: null,
    actorId: "issuer", createdAt: now, updatedAt: now,
    collaboration: { runId, sessionId, issuerActorId: "issuer", recipientActorId: "worker" } };
  const prepared: DiscussionEvent = { projectId, id: randomUUID(), discussionId, version: 1,
    kind: "prepared", documentRevisionId: channelRevisionId, actorId: "issuer", createdAt: now,
    evidence: null, reason: null, choice: null, unresolved: null, relookCondition: null,
    supersedesDecisionEventId: null, decisionEventId: null, target: null };
  await uow.transaction(projectId, async tx => {
    await tx.insertProject({ id: projectId, title: "P1c test", createdAt: now });
    for (const item of [source, primary, channel, evidence]) {
      await tx.insertDocument(item.head); await tx.insertDocumentRevision(item.revision);
    }
    await tx.insertTask({ projectId, id: taskId, version: 1, currentRevisionId: taskRevisionId,
      title: "Task", content: "Task", contentDocumentId: primaryId, contentRevisionId: primaryRevisionId,
      kind: null, acceptance: "Answer", owner: "worker", state: "in_progress" });
    await tx.insertTaskRevision({ projectId, taskId, id: taskRevisionId, version: 1,
      title: "Task", content: "Task", contentDocumentId: primaryId, contentRevisionId: primaryRevisionId,
      kind: null, acceptance: "Answer", owner: "worker", state: "in_progress", basisSetId: basisId,
      actorId: "issuer", reason: "fixed", createdAt: now });
    await tx.insertSealedBasisSet({ projectId, taskId, taskRevisionId, id: basisId, sealed: true,
      members: [{ documentId: sourceId, revisionId: sourceRevisionId }, { documentId: primaryId, revisionId: primaryRevisionId }] });
    await tx.insertRuntimeSession({ projectId, id: sessionId, roleId: "worker-role", cwd: "/tmp/worker",
      authorizationScope: "test", model: null, sandbox: "read-only", approvalPolicy: "on-request",
      state: "ready", version: 1, nativeThreadId: "thread", nativeSessionId: "native-session",
      operationId: randomUUID(), actorId: "controller", createdAt: now, updatedAt: now });
    await tx.insertRuntimeRun({ projectId, id: runId, taskId, taskRevisionId, basisSetId: basisId, sessionId,
      operationId: randomUUID(), input: "Original", inputHash: hash("Original"), state: "requested", version: 1,
      nativeTurnId: null, interruptRequested: false, resultSummary: null, actorId: "controller", createdAt: now, updatedAt: now });
    await tx.insertDiscussion(record, prepared);
    await tx.updateDiscussion({ ...record, version: 2, updatedAt: now }, 1, { ...prepared,
      id: messageId, version: 2, kind: "message", actorId: "issuer", documentRevisionId: null,
      collaborationPayload: { type: "message", kind: "answer", recipientActorId: "worker",
        body: { documentId: evidenceId, revisionId: evidenceRevisionId }, replyToEventId: null } });
  });
  const actual = await uow.read(projectId, async tx => ({ discussion: await tx.getDiscussion(discussionId),
    events: await tx.listDiscussionEvents(discussionId), run: await tx.getRuntimeRun(runId) }));
  assert.equal(actual.discussion?.goal, null);
  assert.deepEqual(actual.discussion?.collaboration, record.collaboration);
  assert.equal(actual.events.length, 2);
  assert.deepEqual(actual.events[1]?.collaborationPayload, { type: "message", kind: "answer",
    recipientActorId: "worker", body: { documentId: evidenceId, revisionId: evidenceRevisionId }, replyToEventId: null });
  assert.equal(actual.run?.input, "Original");
  await assert.rejects(uow.transaction(projectId, tx => tx.updateDiscussion({ ...record, version: 2 }, 1, {
    ...prepared, id: randomUUID(), version: 2 })), error => (error as { code?: string }).code === "VERSION_CONFLICT");
  await assert.rejects(pool.query("UPDATE discussion_event SET actor_id='forged' WHERE project_id=$1 AND event_id=$2", [projectId, messageId]), /immutable/);
});

test("real WorkflowService Run2 reserve advances Task revision; original answer can be adopted only after fixed input is read", async () => {
  const projectId = randomUUID();
  const issuer: Principal = { actorId: "issuer", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const worker: Principal = { actorId: "worker", projectIds: [projectId], permissions: ["read", "write"] };
  let currentTime = "2026-10-25T01:00:00.000Z";
  const deps = { uow, clock: { now: () => currentTime }, ids: { next: randomUUID }, hasher: { hash } };
  const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
  const execute = async (principal: Principal, command: Record<string, unknown>) => {
    const result = await workflow.execute(principal, { projectId, operationId: randomUUID(), ...command } as Command);
    assert.equal(result.status, "applied", JSON.stringify(result));
    return result as Extract<typeof result, { status: "applied" }>;
  };
  await execute(issuer, { type: "project.create", title: "Continuation regression" });
  const sourceId = randomUUID();
  const source = await execute(issuer, { type: "document.create", documentId: sourceId,
    title: "Basis", body: "Original accepted basis" });
  await execute(issuer, { type: "document.adopt", documentId: sourceId, expectedVersion: 1,
    revisionId: source.revisionId, reason: "Fixed source" });
  const taskId = randomUUID();
  await execute(issuer, { type: "task.create", taskId, title: "Answer question", content: "Do the work",
    acceptance: "Use answer", owner: worker.actorId, documentIds: [sourceId] });
  const ready = await execute(issuer, { type: "task.start", taskId, expectedVersion: 1,
    basis: [{ documentId: sourceId, revisionId: source.revisionId }], reason: "Begin" });
  const sessionId = randomUUID(), cwd = "/tmp/p1c-continuation", authorizationScope = "project:p1c";
  await execute(issuer, { type: "runtime.session.reserve", sessionId, roleId: worker.actorId, cwd,
    authorizationScope, sandbox: "workspace-write", approvalPolicy: "on-request" });
  await runtime.beginSessionCreate(projectId, sessionId);
  await runtime.bindSession(projectId, sessionId, { owner: "evoloop-codex-app-server", projectId, sessionId,
    roleId: worker.actorId, cwd, authorizationScope, nativeThreadId: `thread-${projectId}`,
    nativeSessionId: `native-${projectId}` });
  const run1Id = randomUUID();
  const run1 = await execute(issuer, { type: "runtime.run.reserve", runId: run1Id, taskId, sessionId,
    expectedVersion: ready.version, input: "Original Run1 input" });
  await runtime.beginDispatch(projectId, run1Id);
  await runtime.bindTurn(projectId, run1Id, { id: `turn1-${projectId}`, status: "running" },
    { kind: "startReply", operationId: run1.operationId });
  await runtime.recordTurn(projectId, run1Id, `turn1-${projectId}`, "completed", "Question held");

  const channelId = randomUUID(), discussionId = randomUUID();
  const channel = await execute(issuer, { type: "document.create", documentId: channelId,
    kind: "discussion", title: "Task channel", body: "Fixed Task channel" });
  const questionId = randomUUID(), answerId = randomUUID();
  const question = await execute(worker, { type: "document.create", documentId: questionId,
    title: "Question", body: "Which source should I use?" });
  const answer = await execute(issuer, { type: "document.create", documentId: answerId,
    title: "Answer", body: "Use the fixed accepted source." });
  const record: DiscussionRecord = { projectId, id: discussionId, version: 1, kind: "task_collaboration",
    status: "prepared", documentId: channelId, preparedDocumentRevisionId: channel.revisionId!,
    currentDocumentRevisionId: channel.revisionId!, latestDecisionEventId: null, goal: null, stage: null,
    task: { id: taskId, revisionId: run1.revisionId! }, adoptedDocuments: [], question: "", options: [],
    authorizationBoundary: "", targetSessionLabel: "", targetSessionRef: null,
    actorId: issuer.actorId, createdAt: currentTime, updatedAt: currentTime,
    collaboration: { runId: run1Id, sessionId, issuerActorId: issuer.actorId, recipientActorId: worker.actorId } };
  await uow.transaction(projectId, tx => tx.insertDiscussion(record, { projectId, id: randomUUID(),
    discussionId, version: 1, kind: "prepared", documentRevisionId: channel.revisionId!,
    actorId: issuer.actorId, createdAt: currentTime, evidence: null, reason: null, choice: null,
    unresolved: null, relookCondition: null, supersedesDecisionEventId: null, decisionEventId: null, target: null }));
  const apply = (principal: Principal, command: Record<string, unknown>) => uow.transaction(projectId, tx =>
    applyTaskCollaboration({ tx, command: { projectId, operationId: randomUUID(), discussionId, ...command } as TaskCollaborationCommand,
      principal, now: currentTime, nextId: randomUUID, hasher: { hash },
      isAuthorizedRoleActor: async actor => actor === worker.actorId,
      isProjectActor: async actor => actor === issuer.actorId || actor === worker.actorId,
      hasEngineeringActionGrant: async () => false }));
  await apply(worker, { type: "discussion.message.post", expectedVersion: 1, kind: "question",
    recipientActorId: issuer.actorId, body: { documentId: questionId, revisionId: question.revisionId } });
  const questionEvent = (await uow.read(projectId, tx => tx.listDiscussionEvents(discussionId))).at(-1)!;
  await apply(issuer, { type: "discussion.message.post", expectedVersion: 2, kind: "answer",
    recipientActorId: worker.actorId, body: { documentId: answerId, revisionId: answer.revisionId },
    replyToEventId: questionEvent.id });
  const answerEvent = (await uow.read(projectId, tx => tx.listDiscussionEvents(discussionId))).at(-1)!;
  await apply(worker, { type: "discussion.receipt.record", expectedVersion: 3,
    messageEventId: answerEvent.id, stage: "received", evidence: { documentId: answerId, revisionId: answer.revisionId } });
  await apply(worker, { type: "discussion.receipt.record", expectedVersion: 4,
    messageEventId: answerEvent.id, stage: "read", evidence: { documentId: answerId, revisionId: answer.revisionId } });
  currentTime = "2026-10-25T02:00:00.000Z";
  const answerRevision = await uow.read(projectId, tx => tx.getDocumentRevision(answerId, answer.revisionId!));
  const block = taskAnswerInputBlock(discussionId, answerEvent.id, { documentId: answerId,
    revisionId: answer.revisionId!, contentHash: answerRevision!.contentHash, text: answerRevision!.body! });
  const run2Id = randomUUID();
  const taskBeforeRun2 = await uow.read(projectId, tx => tx.getTask(taskId));
  const run2 = await execute(issuer, { type: "runtime.run.reserve", runId: run2Id, taskId, sessionId,
    expectedVersion: taskBeforeRun2!.version, input: `Continue the original Task.\n${block}` });
  assert.notEqual(run2.revisionId, run1.revisionId, "real reserve creates a new fixed Task revision");
  await assert.rejects(apply(worker, { type: "discussion.receipt.record", expectedVersion: 5,
    messageEventId: answerEvent.id, stage: "adopted", evidence: { documentId: answerId, revisionId: answer.revisionId },
    continuation: { runId: run2Id, taskRevisionId: run2.revisionId } }), error =>
    (error as { code?: string }).code === "CONTINUATION_MISMATCH", "reserved Run alone is not actual adoption");
  await runtime.beginDispatch(projectId, run2Id);
  await runtime.bindTurn(projectId, run2Id, { id: `turn2-${projectId}`, status: "running" },
    { kind: "startReply", operationId: run2.operationId });
  await runtime.recordTurn(projectId, run2Id, `turn2-${projectId}`, "completed", "Answer consumed");
  await apply(worker, { type: "discussion.receipt.record", expectedVersion: 5,
    messageEventId: answerEvent.id, stage: "adopted", evidence: { documentId: answerId, revisionId: answer.revisionId },
    continuation: { runId: run2Id, taskRevisionId: run2.revisionId } });
  const adopted = (await uow.read(projectId, tx => tx.listDiscussionEvents(discussionId))).at(-1)!;
  assert.deepEqual((adopted.collaborationPayload as { continuation: unknown }).continuation,
    { runId: run2Id, taskRevisionId: run2.revisionId });
  assert.equal((await uow.read(projectId, tx => tx.getRuntimeRun(run1Id)))?.input, "Original Run1 input");
});
