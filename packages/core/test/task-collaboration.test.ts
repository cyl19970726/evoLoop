import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { DiscussionEvent, DiscussionRecord, TaskCollaborationCommand } from "@evoloop/contracts/discussions";
import type { Document, DocumentRevision, Principal, Task, TaskRevision } from "@evoloop/contracts";
import type { Transaction } from "@evoloop/contracts/ports";
import { applyTaskCollaboration } from "../src/task-collaboration.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const projectId = id(1), discussionId = id(2), taskId = id(3), taskRevisionId = id(4),
  sessionId = id(5), runId = id(6), channelDocumentId = id(7);
const issuer: Principal = { actorId: "issuer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const worker: Principal = { actorId: "worker", projectIds: [projectId], permissions: ["read", "write"] };
const executor: Principal = { ...issuer };
const ref = (n: number) => ({ documentId: id(n), revisionId: id(n + 100) });

function fixture() {
  const task: Task = { projectId, id: taskId, version: 2, currentRevisionId: taskRevisionId,
    title: "Fixed task", content: "Task body", contentDocumentId: id(80), contentRevisionId: id(81),
    kind: null, acceptance: "Expected", owner: "worker", state: "in_progress" };
  const taskRevision: TaskRevision = { projectId, taskId, id: taskRevisionId, version: 2, title: task.title,
    content: task.content, contentDocumentId: task.contentDocumentId, contentRevisionId: task.contentRevisionId,
    kind: null, acceptance: task.acceptance, owner: task.owner, state: "in_progress",
    basisSetId: null, actorId: "issuer", reason: "Fixed", createdAt: "2026-10-25T00:00:00Z" };
  const run = { projectId, id: runId, taskId, taskRevisionId, sessionId, input: "Original input", inputHash: hash("Original input") };
  let discussion: DiscussionRecord | null = null;
  const events: DiscussionEvent[] = [];
  const documents = new Map<string, Document>();
  const revisions = new Map<string, DocumentRevision>();
  for (let n = 20; n <= 27; n++) {
    const r = ref(n), body = `Evidence ${n}`;
    documents.set(r.documentId, { projectId, id: r.documentId, title: body, version: 1,
      currentRevisionId: r.revisionId, adoptedRevisionId: null, kind: "report", status: "draft" });
    revisions.set(r.revisionId, { projectId, documentId: r.documentId, id: r.revisionId,
      body, contentHash: hash(body), format: "markdown", mediaType: "text/markdown", originalName: "evidence.md",
      payloadRef: null, entrypoint: null, assetsManifest: [], author: "worker", createdAt: "2026-10-25T00:00:00Z",
      previousRevisionId: null, reason: "Evidence" });
  }
  let recipientValid = true;
  let actionGrant = true;
  let next = 200;
  const tx = {
    getDiscussion: async () => discussion,
    getDocument: async (documentId: string) => documents.get(documentId) ?? null,
    getDocumentRevision: async (_documentId: string, revisionId: string) => revisions.get(revisionId) ?? null,
    insertDocument: async (document: Document) => { documents.set(document.id, document); },
    insertDocumentRevision: async (revision: DocumentRevision) => { revisions.set(revision.id, revision); },
    getTask: async (value: string) => value === taskId ? task : null,
    getTaskRevision: async (value: string, revisionId: string) => value === taskId && revisionId === taskRevisionId ? taskRevision : null,
    getRuntimeRun: async (value: string) => value === runId ? run : null,
    getRuntimeSession: async (value: string) => value === sessionId ? { projectId, id: sessionId, roleId: id(50) } : null,
    listSessionBindings: async () => [{ sessionId }],
    listDiscussionEvents: async () => events,
    insertDiscussion: async (value: DiscussionRecord, event: DiscussionEvent) => { discussion = value; events.push(event); },
    updateDiscussion: async (value: DiscussionRecord, expected: number, event: DiscussionEvent) => {
      assert.equal(discussion?.version, expected); discussion = value; events.push(event);
    },
  } as unknown as Transaction;
  async function apply(command: TaskCollaborationCommand, principal: Principal = worker, now = "2026-10-25T01:00:00Z") {
    return applyTaskCollaboration({ tx, command, principal, now, nextId: () => id(next++),
      hasher: { hash }, isAuthorizedRoleActor: async actor => recipientValid && actor === "worker",
      isProjectActor: async actor => actor === "issuer" || actor === "worker",
      hasEngineeringActionGrant: async () => actionGrant });
  }
  async function open() {
    return apply({ type: "discussion.openTask", projectId, operationId: id(100), discussionId,
      documentId: channelDocumentId, title: "Task coordination", task: { id: taskId, revisionId: taskRevisionId },
      runId, sessionId, recipientActorId: "worker" }, issuer);
  }
  const version = () => discussion!.version;
  return { apply, open, version, events, documents, revisions, task, run,
    setRecipientValid: (value: boolean) => { recipientValid = value; },
    setActionGrant: (value: boolean) => { actionGrant = value; },
    get discussion() { return discussion; } };
}
const base = (type: string, version: number, n: number) => ({ type, projectId, operationId: id(n), discussionId, expectedVersion: version });
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, error => (error as { code?: string }).code === code);

test("fixed Task question, answer and actual adoption preserve the original Run input", async () => {
  const f = fixture();
  await f.open();
  assert.equal(f.discussion?.goal, null);
  assert.equal(f.discussion?.collaboration?.issuerActorId, "issuer");
  const question = await f.apply({ ...base("discussion.message.post", f.version(), 101),
    kind: "question", recipientActorId: "issuer", body: ref(20) } as TaskCollaborationCommand);
  const questionEvent = f.events.at(-1)!;
  await f.apply({ ...base("discussion.receipt.record", f.version(), 102), messageEventId: questionEvent.id,
    stage: "received", evidence: ref(21) } as TaskCollaborationCommand, issuer);
  await f.apply({ ...base("discussion.receipt.record", f.version(), 103), messageEventId: questionEvent.id,
    stage: "read", evidence: ref(22) } as TaskCollaborationCommand, issuer);
  await f.apply({ ...base("discussion.message.post", f.version(), 104), kind: "answer",
    recipientActorId: "worker", body: ref(23), replyToEventId: questionEvent.id } as TaskCollaborationCommand, issuer);
  const answer = f.events.at(-1)!;
  await f.apply({ ...base("discussion.receipt.record", f.version(), 105), messageEventId: answer.id,
    stage: "received", evidence: ref(24) } as TaskCollaborationCommand);
  await f.apply({ ...base("discussion.receipt.record", f.version(), 106), messageEventId: answer.id,
    stage: "read", evidence: ref(25) } as TaskCollaborationCommand);
  await f.apply({ ...base("discussion.receipt.record", f.version(), 107), messageEventId: answer.id,
    stage: "adopted", evidence: ref(26) } as TaskCollaborationCommand);
  assert.equal(question.result.version, 2);
  assert.equal((f.events.at(-1)!.collaborationPayload as { stage: string }).stage, "adopted");
  assert.equal(f.run.input, "Original input");
  assert.equal(f.run.inputHash, hash("Original input"));
  assert.equal(f.discussion?.task?.revisionId, taskRevisionId);
});

test("opening rejects unverified recipient; participants and fixed Task provenance are enforced", async () => {
  const f = fixture();
  await rejects(f.apply({ type: "discussion.openTask", projectId, operationId: id(140), discussionId,
    documentId: channelDocumentId, title: "Bad source", task: { id: taskId, revisionId: taskRevisionId },
    runId: id(999), sessionId, recipientActorId: "worker" }, issuer), "NOT_FOUND");
  f.setRecipientValid(false);
  await rejects(f.open(), "RECIPIENT_HELD");
  f.setRecipientValid(true);
  await f.open();
  const outsider = { ...worker, actorId: "outsider" };
  await rejects(f.apply({ ...base("discussion.message.post", f.version(), 101), kind: "question",
    recipientActorId: "issuer", body: ref(20) } as TaskCollaborationCommand, outsider), "FORBIDDEN");
  await rejects(f.apply({ ...base("discussion.message.post", f.version(), 102), kind: "question",
    recipientActorId: "issuer", body: { documentId: id(999), revisionId: id(998) } } as TaskCollaborationCommand), "NOT_FOUND");
  f.documents.set(ref(27).documentId, { ...f.documents.get(ref(27).documentId)!, projectId: id(999) });
  await rejects(f.apply({ ...base("discussion.message.post", f.version(), 102), kind: "question",
    recipientActorId: "issuer", body: ref(27) } as TaskCollaborationCommand), "DOCUMENT_SCOPE");
  f.task.currentRevisionId = id(999);
  await rejects(f.apply({ ...base("discussion.message.post", f.version(), 103), kind: "question",
    recipientActorId: "issuer", body: ref(20) } as TaskCollaborationCommand), "BASELINE_CHANGED");
});

test("bounded action requires approval, actual executor, expiry and stable reconciliation ID", async () => {
  const f = fixture(); await f.open();
  const request = { ...base("discussion.action.request", f.version(), 101), requestId: id(120),
    executorActorId: "issuer", actionType: "pr.create", scope: { repository: "evoLoop", worktree: "/tmp/worktree",
      paths: ["packages/core/src/task-collaboration.ts"], commit: "abc123" }, inputHash: hash("Original input"),
    reason: "Create PR", authorityEvidence: "Review grant", expiresAt: "2026-10-26T00:00:00Z",
    acceptance: "PR URL", detail: ref(20) } as TaskCollaborationCommand;
  await rejects(f.apply({ ...request, inputHash: hash("stale input") }), "RUN_MISMATCH");
  await f.apply(request);
  const requestEventId = f.events.at(-1)!.id;
  const execute = { ...base("discussion.action.execute", f.version(), 102), requestEventId,
    decisionEventId: id(999), state: "started", externalOperationId: id(130), artifact: ref(21) } as TaskCollaborationCommand;
  await rejects(f.apply(execute, executor), "NOT_FOUND");
  await f.apply({ ...base("discussion.action.decide", f.version(), 103), requestEventId,
    decision: "approved", evidence: ref(22) } as TaskCollaborationCommand, issuer);
  const decisionEventId = f.events.at(-1)!.id;
  await rejects(f.apply({ ...execute, expectedVersion: f.version(), decisionEventId }, worker), "EXECUTOR_HELD");
  f.setActionGrant(false);
  await rejects(f.apply({ ...execute, expectedVersion: f.version(), decisionEventId }, executor), "ACTION_HELD");
  f.setActionGrant(true);
  await f.apply({ ...execute, expectedVersion: f.version(), decisionEventId }, executor);
  await f.apply({ ...execute, expectedVersion: f.version(), decisionEventId, state: "unknown", artifact: ref(23) }, executor);
  await rejects(f.apply({ ...execute, expectedVersion: f.version(), decisionEventId,
    externalOperationId: id(131) }, executor), "OPERATION_MISMATCH");
  await f.apply({ ...execute, expectedVersion: f.version(), decisionEventId, state: "succeeded", artifact: ref(24) }, executor);
  await rejects(f.apply({ ...execute, expectedVersion: f.version(), decisionEventId, state: "failed" }, executor), "ACTION_SETTLED");
  const expired = fixture(); await expired.open();
  await expired.apply({ ...request, expectedVersion: expired.version() });
  await rejects(expired.apply({ ...base("discussion.action.decide", expired.version(), 104),
    requestEventId: expired.events.at(-1)!.id, decision: "approved", evidence: ref(22) } as TaskCollaborationCommand,
  issuer, "2026-10-27T00:00:00Z"), "ACTION_EXPIRED");
  const rejected = fixture(); await rejected.open();
  await rejected.apply({ ...request, expectedVersion: rejected.version() });
  const rejectedRequest = rejected.events.at(-1)!.id;
  await rejected.apply({ ...base("discussion.action.decide", rejected.version(), 105),
    requestEventId: rejectedRequest, decision: "rejected", evidence: ref(22) } as TaskCollaborationCommand, issuer);
  await rejects(rejected.apply({ ...execute, expectedVersion: rejected.version(),
    requestEventId: rejectedRequest, decisionEventId: rejected.events.at(-1)!.id }, executor), "ACTION_NOT_APPROVED");
});
