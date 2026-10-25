import type { TaskCollaborationCommand, DiscussionEvent, DiscussionRecord, TaskCollaborationPayload } from "@evoloop/contracts/discussions";
import type { AppliedResult, DocumentRevision, Principal } from "@evoloop/contracts";
import { DomainError, type ContentHasher, type Transaction } from "@evoloop/contracts/ports";
import { canonicalTaskInputJson, taskInputSignature } from "./task-input.js";

interface Context { tx: Transaction; command: TaskCollaborationCommand; principal: Principal; now: string;
  nextId(): string; hasher: ContentHasher; isAuthorizedRoleActor(projectId: string, actorId: string, roleId: string): Promise<boolean>;
  isProjectActor(projectId: string, actorId: string): Promise<boolean>;
  hasEngineeringActionGrant(principal: Principal, action: Extract<TaskCollaborationPayload, { type: "action_request" }>): Promise<boolean> }
const fail = (code: string, message: string, version?: number): never => { throw new DomainError(code, message, version); };
const need = <T>(value: T | null, label: string): T => value ?? fail("NOT_FOUND", `${label} was not found`);
const expired = (expiresAt: string, now: string): boolean => Date.parse(expiresAt) <= Date.parse(now);
/** The dispatcher includes this exact fixed block in the continuation Run input. */
export function taskAnswerInputBlock(discussionId: string, messageEventId: string,
  body: { documentId: string; revisionId: string; contentHash: string; text: string }): string {
  return `[evoloop-task-answer ${discussionId} ${messageEventId} ${body.documentId} ${body.revisionId} ${body.contentHash}]\n${body.text}\n[/evoloop-task-answer]`;
}
const ref = async (ctx: Context, value: { documentId: string; revisionId: string }): Promise<DocumentRevision> => {
  const document = need(await ctx.tx.getDocument(value.documentId), "Document");
  const revision = need(await ctx.tx.getDocumentRevision(value.documentId, value.revisionId), "Document revision");
  if (document.projectId !== ctx.command.projectId || revision.projectId !== ctx.command.projectId ||
    revision.documentId !== document.id || revision.body === null || revision.format !== "markdown" ||
    ctx.hasher.hash(revision.body) !== revision.contentHash)
    fail("DOCUMENT_SCOPE", "Message must reference a verified inline Markdown revision in this project");
  return revision;
};
const result = (command: TaskCollaborationCommand, record: DiscussionRecord, revisionId?: string): AppliedResult => ({
  status: "applied", operationId: command.operationId, entityId: record.id, version: record.version,
  ...(revisionId ? { revisionId } : {}),
});
const event = (ctx: Context, record: DiscussionRecord, payload: TaskCollaborationPayload, revisionId: string | null): DiscussionEvent => ({
  projectId: record.projectId, id: ctx.nextId(), discussionId: record.id, version: record.version,
  kind: payload.type, documentRevisionId: null, actorId: ctx.principal.actorId, createdAt: ctx.now,
  evidence: null, reason: null, choice: null, unresolved: null, relookCondition: null,
  supersedesDecisionEventId: null, decisionEventId: null, target: null, collaborationPayload: payload,
});
const participants = (record: DiscussionRecord): [string, string] => {
  if (record.kind !== "task_collaboration" || !record.collaboration) fail("INVALID_DISCUSSION", "Task collaboration required");
  return [record.collaboration!.issuerActorId, record.collaboration!.recipientActorId];
};
const actionRequestOf = (item: DiscussionEvent): Extract<TaskCollaborationPayload, { type: "action_request" }> => {
  if (item.kind !== "action_request" || item.collaborationPayload?.type !== "action_request")
    fail("ACTION_MISMATCH", "Action request event required");
  return item.collaborationPayload as Extract<TaskCollaborationPayload, { type: "action_request" }>;
};

export async function applyTaskCollaboration(ctx: Context): Promise<{ result: AppliedResult; effects: Array<{ kind: string; entityId: string; version: number }> }> {
  const { tx, command, principal, now } = ctx;
  if (!principal.actorId || !principal.projectIds.includes(command.projectId) || !principal.permissions.includes("write"))
    fail("FORBIDDEN", "Actual project principal with write access required");
  if (command.type === "discussion.openTask") {
    if (!principal.permissions.includes("review")) fail("FORBIDDEN", "Opening a Task channel requires review authority");
    if (principal.actorId === command.recipientActorId) fail("INVALID_PARTICIPANTS", "Issuer and recipient must differ");
    if (await tx.getDiscussion(command.discussionId) || await tx.getDocument(command.documentId)) fail("ALREADY_EXISTS", "Discussion or Document already exists");
    const task = need(await tx.getTask(command.task.id), "Task");
    const revision = need(await tx.getTaskRevision(command.task.id, command.task.revisionId), "Task revision");
    const run = need(await tx.getRuntimeRun(command.runId), "Run");
    const session = need(await tx.getRuntimeSession(command.sessionId), "Session");
    if (task.projectId !== command.projectId || revision.projectId !== command.projectId ||
      run.projectId !== command.projectId || session.projectId !== command.projectId)
      fail("PROJECT_SCOPE", "Task, Run and Session must belong to the project");
    if (task.currentRevisionId !== revision.id) fail("BASELINE_CHANGED", "Task revision changed", task.version);
    if (run.taskId !== task.id || run.taskRevisionId !== revision.id || run.sessionId !== session.id)
      fail("RUN_MISMATCH", "Run must contain this fixed Task revision and Session");
    if (!(await ctx.isAuthorizedRoleActor(command.projectId, command.recipientActorId, session.roleId)))
      fail("RECIPIENT_HELD", "Recipient has no verified authority for this Session role");
    const binding = (await tx.listSessionBindings(session.roleId)).some(item => item.sessionId === session.id);
    if (!binding) fail("SESSION_HELD", "Session is not bound to its owned Role");
    const body = `# ${command.title}\n\nTask ${task.id}@${revision.id}\nRun ${run.id}\nSession ${session.id}\n\n消息正文见各消息引用的固定 DocumentRevision。`;
    const revisionId = ctx.nextId();
    await tx.insertDocument({ projectId: command.projectId, id: command.documentId, title: command.title,
      version: 1, currentRevisionId: revisionId, adoptedRevisionId: null, kind: "discussion", status: "draft" });
    await tx.insertDocumentRevision({ projectId: command.projectId, documentId: command.documentId, id: revisionId,
      body, format: "markdown", mediaType: "text/markdown", originalName: `${command.documentId}.md`, payloadRef: null,
      entrypoint: null, assetsManifest: [], contentHash: ctx.hasher.hash(body), author: principal.actorId,
      createdAt: now, previousRevisionId: null, reason: "Task collaboration opened" });
    const record: DiscussionRecord = { projectId: command.projectId, id: command.discussionId, version: 1,
      kind: "task_collaboration", status: "prepared", documentId: command.documentId,
      preparedDocumentRevisionId: revisionId, currentDocumentRevisionId: revisionId, latestDecisionEventId: null,
      goal: null, stage: null, task: command.task, adoptedDocuments: [], question: "", options: [],
      authorizationBoundary: "", targetSessionLabel: "", targetSessionRef: null,
      actorId: principal.actorId, createdAt: now, updatedAt: now,
      collaboration: { runId: run.id, sessionId: session.id, issuerActorId: principal.actorId,
        recipientActorId: command.recipientActorId } };
    await tx.insertDiscussion(record, { ...event(ctx, record, { type: "message", kind: "handoff",
      recipientActorId: command.recipientActorId, body: { documentId: command.documentId, revisionId }, replyToEventId: null }, revisionId),
      kind: "prepared", collaborationPayload: null });
    return { result: result(command, record, revisionId), effects: [{ kind: "discussion", entityId: record.id, version: 1 },
      { kind: "document", entityId: command.documentId, version: 1 }] };
  }
  const old = need(await tx.getDiscussion(command.discussionId), "Discussion");
  if (old.projectId !== command.projectId) fail("PROJECT_SCOPE", "Discussion belongs to another project");
  if (old.version !== command.expectedVersion) fail("VERSION_CONFLICT", "Discussion version changed", old.version);
  const [issuer, recipient] = participants(old);
  if (command.type !== "discussion.action.execute" && principal.actorId !== issuer && principal.actorId !== recipient)
    fail("FORBIDDEN", "Only the two participants may act");
  if (command.type === "discussion.message.post" || command.type === "discussion.action.request") {
    const task = need(await tx.getTask(old.task!.id), "Task");
    if (task.currentRevisionId !== old.task!.revisionId) fail("BASELINE_CHANGED", "Task revision changed; open a new fixed channel", task.version);
    const session = need(await tx.getRuntimeSession(old.collaboration!.sessionId), "Original Session");
    if (session.projectId !== command.projectId || !(await ctx.isAuthorizedRoleActor(command.projectId, recipient, session.roleId)))
      fail("RECIPIENT_HELD", "Worker no longer has verified authority for this Session role");
  }
  const events = await tx.listDiscussionEvents(old.id);
  const get = (id: string) => need(events.find(item => item.id === id) ?? null, "Referenced event");
  let payload: TaskCollaborationPayload;
  let revisionId: string | null;
  if (command.type === "discussion.message.post") {
    if (command.recipientActorId !== (principal.actorId === issuer ? recipient : issuer)) fail("RECIPIENT_MISMATCH", "Message must address the other participant");
    if (command.replyToEventId) {
      const parent = get(command.replyToEventId);
      if (parent.kind !== "message" || parent.actorId !== command.recipientActorId) fail("REPLY_MISMATCH", "Reply must target the recipient's message");
      if (command.kind === "answer" && parent.collaborationPayload?.type !== "message") fail("REPLY_MISMATCH", "Answer requires a question");
      if (command.kind === "answer" && parent.collaborationPayload?.type === "message" && parent.collaborationPayload.kind !== "question")
        fail("REPLY_MISMATCH", "Answer must reply to a question");
    }
    if (command.kind === "answer" && !command.replyToEventId) fail("REPLY_MISMATCH", "Answer must reply to a question");
    await ref(ctx, command.body);
    payload = { type: "message", kind: command.kind, recipientActorId: command.recipientActorId,
      body: command.body, replyToEventId: command.replyToEventId ?? null };
    revisionId = command.body.revisionId;
  } else if (command.type === "discussion.receipt.record") {
    const message = get(command.messageEventId);
    if (message.kind !== "message" || message.collaborationPayload?.type !== "message" ||
      message.collaborationPayload.recipientActorId !== principal.actorId) fail("RECEIPT_MISMATCH", "Only the actual recipient can acknowledge a message");
    const messagePayload = message.collaborationPayload as Extract<TaskCollaborationPayload, { type: "message" }>;
    const stages = ["received", "read", "adopted", "resolved"];
    const prior = events.filter(item => item.kind === "receipt" && item.collaborationPayload?.type === "receipt" &&
      item.collaborationPayload.messageEventId === message.id);
    if (prior.some(item => item.collaborationPayload?.type === "receipt" && item.collaborationPayload.stage === command.stage))
      fail("ALREADY_RECORDED", "Receipt stage already recorded");
    const highest = Math.max(-1, ...prior.map(item => stages.indexOf((item.collaborationPayload as Extract<TaskCollaborationPayload, { type: "receipt" }>).stage)));
    if (command.stage === "resolved" && messagePayload.kind !== "answer") {
      if (highest < stages.indexOf("read")) fail("RECEIPT_ORDER", "Recipient must first receive and read the message");
      if (messagePayload.kind === "question" && !events.some(item => item.kind === "message" &&
        item.actorId === principal.actorId && item.collaborationPayload?.type === "message" &&
        item.collaborationPayload.kind === "answer" && item.collaborationPayload.replyToEventId === message.id))
        fail("ANSWER_REQUIRED", "Question resolution requires a fixed reply from this recipient");
    } else if (stages.indexOf(command.stage) > highest + 1) fail("RECEIPT_ORDER", "Record earlier receipt stages first");
    if ((command.stage === "adopted") !== (command.continuation !== undefined))
      fail("CONTINUATION_REQUIRED", "Adoption alone requires a verified continuation Run");
    if (command.stage === "adopted") {
      if (messagePayload.kind !== "answer") fail("ADOPTION_TARGET", "Only a fixed answer can be adopted by a continuation Run");
      const continued = need(await tx.getRuntimeRun(command.continuation!.runId), "Continuation Run");
      const original = need(await tx.getRuntimeRun(old.collaboration!.runId), "Original Run");
      if (continued.projectId !== command.projectId || continued.id === original.id ||
        continued.taskId !== old.task!.id || continued.sessionId !== old.collaboration!.sessionId ||
        continued.taskRevisionId !== command.continuation!.taskRevisionId ||
        continued.state !== "completed" || !continued.nativeTurnId ||
        Date.parse(continued.createdAt) < Date.parse(message.createdAt))
        fail("CONTINUATION_MISMATCH", "Adoption requires a completed later Run in the original Task and Session");
      const task = need(await tx.getTask(old.task!.id), "Task");
      const originalInput = await taskInputSignature(tx, task, original.taskRevisionId);
      const continuedInput = await taskInputSignature(tx, task, continued.taskRevisionId);
      if (canonicalTaskInputJson(originalInput) !== canonicalTaskInputJson(continuedInput))
        fail("TASK_INPUT_CHANGED", "Continuation changed the full fixed Task input");
      const answer = await ref(ctx, messagePayload.body);
      const block = taskAnswerInputBlock(old.id, message.id, { documentId: answer.documentId,
        revisionId: answer.id, contentHash: answer.contentHash, text: answer.body! });
      if (ctx.hasher.hash(continued.input) !== continued.inputHash || !continued.input.includes(block))
        fail("ANSWER_NOT_IN_RUN", "Continuation Run input does not include the fixed answer block");
    }
    await ref(ctx, command.evidence);
    payload = { type: "receipt", messageEventId: message.id, stage: command.stage, evidence: command.evidence,
      continuation: command.continuation ?? null };
    revisionId = command.evidence.revisionId;
  } else if (command.type === "discussion.action.request") {
    if (principal.actorId !== recipient) fail("FORBIDDEN", "Worker participant must request the bounded action");
    if (!(await ctx.isProjectActor(command.projectId, command.executorActorId))) fail("EXECUTOR_HELD", "Designated executor is not a verified project actor");
    const run = need(await tx.getRuntimeRun(old.collaboration!.runId), "Original Run");
    if (run.projectId !== command.projectId || run.taskId !== old.task!.id ||
      run.taskRevisionId !== old.task!.revisionId || run.sessionId !== old.collaboration!.sessionId ||
      run.inputHash !== command.inputHash) fail("RUN_MISMATCH", "Action must cite the original fixed Run input hash");
    if (expired(command.expiresAt, now)) fail("ACTION_EXPIRED", "Action request has expired");
    if (events.some(item => item.collaborationPayload?.type === "action_request" && item.collaborationPayload.requestId === command.requestId))
      fail("ALREADY_EXISTS", "Action request ID already exists");
    await ref(ctx, command.detail);
    payload = { type: "action_request", requestId: command.requestId, executorActorId: command.executorActorId,
      actionType: command.actionType, scope: command.scope, inputHash: command.inputHash, reason: command.reason,
      authorityEvidence: command.authorityEvidence, expiresAt: command.expiresAt, acceptance: command.acceptance, detail: command.detail };
    revisionId = command.detail.revisionId;
  } else if (command.type === "discussion.action.decide") {
    if (principal.actorId !== issuer || !principal.permissions.includes("review")) fail("FORBIDDEN", "Action decision requires issuer review authority");
    const requested = get(command.requestEventId);
    const action = actionRequestOf(requested);
    if (events.some(item => item.collaborationPayload?.type === "action_decision" && item.collaborationPayload.requestEventId === requested.id))
      fail("ALREADY_DECIDED", "Action request already decided");
    if (command.decision === "approved" && expired(action.expiresAt, now)) fail("ACTION_EXPIRED", "Action request has expired");
    await ref(ctx, command.evidence);
    payload = { type: "action_decision", requestEventId: requested.id, decision: command.decision, evidence: command.evidence };
    revisionId = command.evidence.revisionId;
  } else {
    const requested = get(command.requestEventId), decided = get(command.decisionEventId);
    const action = actionRequestOf(requested);
    if (decided.kind !== "action_decision" || decided.collaborationPayload?.type !== "action_decision" ||
      decided.collaborationPayload.requestEventId !== requested.id || decided.collaborationPayload.decision !== "approved")
      fail("ACTION_NOT_APPROVED", "Action requires its approved decision");
    if (action.executorActorId !== principal.actorId || !principal.permissions.includes("review"))
      fail("EXECUTOR_HELD", "Actual executor lacks this action's review authority");
    const prior = events.filter(item => item.collaborationPayload?.type === "action_execution" && item.collaborationPayload.requestEventId === requested.id);
    if (!prior.length && expired(action.expiresAt, now)) fail("ACTION_EXPIRED", "Action approval has expired");
    if (!prior.length && !(await ctx.hasEngineeringActionGrant(principal, action)))
      fail("ACTION_HELD", "No verified grant covers the exact engineering action scope");
    if (prior.some(item => item.collaborationPayload?.type === "action_execution" && item.collaborationPayload.externalOperationId !== command.externalOperationId))
      fail("OPERATION_MISMATCH", "External operation ID is fixed for this action");
    if (prior.some(item => item.collaborationPayload?.type === "action_execution" && item.collaborationPayload.state !== "started" && item.collaborationPayload.state !== "unknown"))
      fail("ACTION_SETTLED", "Action already has a terminal receipt");
    if (prior.some(item => item.collaborationPayload?.type === "action_execution" && item.collaborationPayload.state === command.state))
      fail("ALREADY_RECORDED", "Execution state already recorded");
    if (!prior.length && command.state !== "started" && command.state !== "unknown") fail("ACTION_NOT_STARTED", "Record start or unknown before outcome");
    if (prior.some(item => item.collaborationPayload?.type === "action_execution" && item.collaborationPayload.state === "unknown") && command.state === "started")
      fail("OPERATION_UNKNOWN", "Unknown action requires reconciliation of the same operation, not a new start");
    await ref(ctx, command.artifact);
    payload = { type: "action_execution", requestEventId: requested.id, decisionEventId: decided.id,
      state: command.state, externalOperationId: command.externalOperationId, artifact: command.artifact };
    revisionId = command.artifact.revisionId;
  }
  const record = { ...old, version: old.version + 1, updatedAt: now };
  await tx.updateDiscussion(record, old.version, event(ctx, record, payload, revisionId));
  return { result: result(command, record, revisionId ?? undefined), effects: [{ kind: "discussion", entityId: record.id, version: record.version }] };
}
