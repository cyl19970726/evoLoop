import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import type { DiscussionEvent, DiscussionRecord } from "@evoloop/contracts/discussions";
import type { Document, DocumentRevision } from "@evoloop/contracts";

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
