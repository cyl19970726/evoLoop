import type { DiscussionCommand, DiscussionEvent, DiscussionRecord, DiscussionTarget } from "@evoloop/contracts/discussions";
import type { AppliedResult, Document, DocumentRevision, Goal, Principal, Stage, Task } from "@evoloop/contracts";
import { DomainError, type ContentHasher, type Transaction } from "@evoloop/contracts/ports";

interface Context {
  tx: Transaction;
  command: DiscussionCommand;
  principal: Principal;
  now: string;
  nextId(): string;
  hasher: ContentHasher;
}
const fail = (code: string, message: string, currentVersion?: number): never => { throw new DomainError(code, message, currentVersion); };
const need = <T>(item: T | null, name: string): T => item ?? fail("NOT_FOUND", `${name} was not found`);
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
// Keep caller-supplied prose on one rendered line so it cannot introduce a fake authority heading.
const quoted = (value: string): string => JSON.stringify(value);
const quoteBlock = (value: string): string[] => value.split(/\r?\n/).map(line => `> ${line}`);
const assertBody = (value: string): void => { if (bytes(value) > 65_536) fail("BODY_TOO_LARGE", "Discussion document exceeds 65536 UTF-8 bytes"); };
const result = (command: DiscussionCommand, record: DiscussionRecord, revisionId?: string): AppliedResult => ({
  status: "applied", operationId: command.operationId, entityId: record.id, version: record.version,
  ...(revisionId ? { revisionId } : {}),
});
function eventBase(ctx: Context, record: DiscussionRecord, kind: DiscussionEvent["kind"], documentRevisionId: string | null): DiscussionEvent {
  return { projectId: record.projectId, id: ctx.nextId(), discussionId: record.id, version: record.version,
    kind, documentRevisionId, actorId: ctx.principal.actorId, createdAt: ctx.now,
    evidence: null, reason: null, choice: null, unresolved: null, relookCondition: null,
    supersedesDecisionEventId: null, decisionEventId: null, target: null };
}
function documentRevision(ctx: Context, documentId: string, revisionId: string, previousRevisionId: string | null, body: string, reason: string): DocumentRevision {
  assertBody(body);
  return { projectId: ctx.command.projectId, documentId, id: revisionId, body, format: "markdown", mediaType: "text/markdown",
    originalName: `${documentId}.md`, payloadRef: null, entrypoint: null, assetsManifest: [],
    contentHash: ctx.hasher.hash(body), author: ctx.principal.actorId, createdAt: ctx.now, previousRevisionId, reason };
}
function preparedBody(command: Extract<DiscussionCommand, { type: "discussion.prepare" }>, fixed: {
  goal: Goal; stage: Stage | null; task: Task | null; taskStageId: string | null;
  documents: Array<{ document: Document; revision: DocumentRevision }>;
}): string {
  const lines = [
    `# ${quoted(command.title)}`, "", `讨论类型：${command.kind === "allocation" ? "当前分工" : "下一阶段方向"}`,
    `项目：${command.projectId}`,
    "", "## 固定目标", `目标：${fixed.goal.id} · v${fixed.goal.version}`,
    `预期结果：${quoted(fixed.goal.outcome)}`, `约束：${quoted(fixed.goal.constraints)}`,
    `消费者：${quoted(fixed.goal.consumer)}`, `授权：${quoted(fixed.goal.authority)}`,
    `范围：${quoted(fixed.goal.scope)}`, `负责人：${quoted(fixed.goal.owner)}`,
    ...(fixed.stage ? ["", "## 固定阶段", `阶段：${fixed.stage.id} · v${fixed.stage.version}`,
      `交付物：${quoted(fixed.stage.deliverable)}`, `学习问题：${quoted(fixed.stage.learningQuestion)}`,
      `当时状态：${fixed.stage.state}`] : []),
    ...(fixed.task ? ["", "## 固定任务", `任务：${quoted(fixed.task.title)}`,
      `固定修订：${fixed.task.id} · ${command.task!.revisionId}`,
      ...(fixed.stage && fixed.taskStageId === null ? ["关系：独立任务，仅作比较依据，不属于所选阶段"] : []),
      `目标：${quoted(fixed.task.goal)}`, `验收：${quoted(fixed.task.acceptance)}`,
      `负责人：${quoted(fixed.task.owner)}`, `当时状态：${fixed.task.state}`,
      `固定链接：#/p/${command.projectId}/tasks/${fixed.task.id}?revision=${command.task!.revisionId}`] : []),
    ...fixed.documents.flatMap(({ document, revision }) => ["", "## 已采用文档",
      `标题：${quoted(document.title)}`, `固定修订：${document.id} · ${revision.id}`,
      `SHA-256：${revision.contentHash}`,
      `固定链接：#/p/${command.projectId}/documents/${document.id}?revision=${revision.id}`]),
    "", "## 人工交接目标",
    `目标人工会话：${quoted(command.targetSessionLabel)}`,
    ...(command.targetSessionRef ? [`会话参考：${quoted(command.targetSessionRef)}`] : []),
    "", "## 待回答的问题", quoted(command.question), "", "## 备选", ...command.options.map((option, index) => `${index + 1}. ${quoted(option)}`),
    "", "## 授权边界", quoted(command.authorizationBoundary),
    ...(command.body ? ["", "## 补充上下文（提交者提供，需人工核对）", ...quoteBlock(command.body)] : []),
    "", "此文档是人工交接包；不证明 Codex 会话已收到、决定已执行或消费者已使用。",
  ];
  const body = lines.join("\n");
  assertBody(body);
  return body;
}
async function checkCurrentDocument(ctx: Context, record: DiscussionRecord, expectedRevisionId?: string): Promise<{ version: number; body: string }> {
  const document = need(await ctx.tx.getDocument(record.documentId), "Discussion document");
  if (document.currentRevisionId !== record.currentDocumentRevisionId || (expectedRevisionId && expectedRevisionId !== document.currentRevisionId))
    fail("DOCUMENT_CHANGED", "Discussion document changed since the observed revision", document.version);
  const revision = need(await ctx.tx.getDocumentRevision(document.id, document.currentRevisionId), "Discussion document revision");
  if (revision.format !== "markdown" || revision.body === null) throw new DomainError("DOCUMENT_FORMAT", "Discussion document must remain inline Markdown");
  return { version: document.version, body: revision.body };
}
async function appendDocument(ctx: Context, record: DiscussionRecord, expectedRevisionId: string, section: string, reason: string): Promise<{ record: DiscussionRecord; revisionId: string; documentVersion: number }> {
  const current = await checkCurrentDocument(ctx, record, expectedRevisionId);
  const body = `${current.body}\n\n${section}`;
  const revisionId = ctx.nextId();
  await ctx.tx.insertDocumentRevision(documentRevision(ctx, record.documentId, revisionId, expectedRevisionId, body, reason));
  const document = need(await ctx.tx.getDocument(record.documentId), "Discussion document");
  await ctx.tx.updateDocument({ ...document, version: current.version + 1, currentRevisionId: revisionId }, current.version);
  return { record: { ...record, currentDocumentRevisionId: revisionId }, revisionId, documentVersion: current.version + 1 };
}
async function checkTarget(ctx: Context, target: DiscussionTarget): Promise<void> {
  switch (target.kind) {
    case "task": {
      const task = need(await ctx.tx.getTask(target.id), "Linked task");
      need(await ctx.tx.getTaskRevision(target.id, target.revisionId), "Linked task revision");
      if (task.currentRevisionId !== target.revisionId) fail("TARGET_CHANGED", "Linked task revision is no longer current", task.version);
      return;
    }
    case "stage": {
      const stage = need(await ctx.tx.getStage(target.id), "Linked stage");
      if (stage.version !== target.version) fail("TARGET_CHANGED", "Linked stage version is no longer current", stage.version);
      return;
    }
    case "role": {
      const role = need(await ctx.tx.getRole(target.id), "Linked role");
      if (role.currentRevisionId !== target.revisionId) fail("TARGET_CHANGED", "Linked role revision is no longer current", role.version);
      return;
    }
    case "document": {
      const document = need(await ctx.tx.getDocument(target.id), "Linked document");
      need(await ctx.tx.getDocumentRevision(target.id, target.revisionId), "Linked document revision");
      if (document.currentRevisionId !== target.revisionId) fail("TARGET_CHANGED", "Linked document revision is no longer current", document.version);
      return;
    }
  }
}
export async function applyDiscussion(ctx: Context): Promise<{ result: AppliedResult; effects: Array<{ kind: string; entityId: string; version: number }> }> {
  const { tx, command, principal, now } = ctx;
  if (command.type === "discussion.prepare") {
    if (await tx.getDiscussion(command.discussionId) || await tx.getDocument(command.documentId)) fail("ALREADY_EXISTS", "Discussion or document already exists");
    const goal = need(await tx.getGoal(command.goal.id), "Goal");
    if (goal.version !== command.goal.version) fail("BASELINE_CHANGED", "Goal version changed", goal.version);
    let fixedStage: Stage | null = null;
    if (command.stage) {
      const stage = need(await tx.getStage(command.stage.id), "Stage");
      if (stage.goalId !== goal.id || stage.version !== command.stage.version) fail("BASELINE_CHANGED", "Stage no longer belongs to this goal at the observed version", stage.version);
      fixedStage = stage;
    }
    let fixedTask: Task | null = null;
    let taskStageId: string | null = null;
    if (command.task) {
      const task = need(await tx.getTask(command.task.id), "Task");
      need(await tx.getTaskRevision(task.id, command.task.revisionId), "Task revision");
      if (task.currentRevisionId !== command.task.revisionId) fail("BASELINE_CHANGED", "Task revision changed", task.version);
      // TaskProposal remains attached to its proposal revision as accepted/running revisions advance.
      const proposal = await tx.getTaskProposal(task.id);
      if (command.stage && proposal?.stageId && proposal.stageId !== command.stage.id)
        fail("BASELINE_MISMATCH", "Task belongs to another stage");
      taskStageId = proposal?.stageId ?? null;
      fixedTask = task;
    }
    if (new Set(command.adoptedDocuments.map(item => item.documentId)).size !== command.adoptedDocuments.length) fail("DUPLICATE_DOCUMENT", "Adopted document references must be unique");
    const fixedDocuments: Array<{ document: Document; revision: DocumentRevision }> = [];
    for (const item of command.adoptedDocuments) {
      const document = need(await tx.getDocument(item.documentId), "Adopted document");
      if (document.adoptedRevisionId !== item.revisionId) fail("BASELINE_CHANGED", "Document adopted revision changed", document.version);
      const revision = need(await tx.getDocumentRevision(item.documentId, item.revisionId), "Adopted document revision");
      fixedDocuments.push({ document, revision });
    }
    const body = preparedBody(command, { goal, stage: fixedStage, task: fixedTask, taskStageId, documents: fixedDocuments });
    const revisionId = ctx.nextId();
    const document = { projectId: command.projectId, id: command.documentId, title: command.title,
      version: 1, currentRevisionId: revisionId, adoptedRevisionId: null };
    await tx.insertDocument(document);
    await tx.insertDocumentRevision(documentRevision(ctx, document.id, revisionId, null, body, "Discussion handoff prepared"));
    const record: DiscussionRecord = { projectId: command.projectId, id: command.discussionId, version: 1,
      kind: command.kind, status: "prepared", documentId: command.documentId, preparedDocumentRevisionId: revisionId,
      currentDocumentRevisionId: revisionId, latestDecisionEventId: null,
      goal: command.goal, stage: command.stage ?? null, task: command.task ?? null,
      adoptedDocuments: command.adoptedDocuments, question: command.question, options: command.options,
      authorizationBoundary: command.authorizationBoundary, targetSessionLabel: command.targetSessionLabel,
      targetSessionRef: command.targetSessionRef ?? null, actorId: principal.actorId, createdAt: now, updatedAt: now };
    await tx.insertDiscussion(record, eventBase(ctx, record, "prepared", revisionId));
    return { result: result(command, record, revisionId), effects: [
      { kind: "discussion", entityId: record.id, version: 1 }, { kind: "document", entityId: document.id, version: 1 }] };
  }
  const old = need(await tx.getDiscussion(command.discussionId), "Discussion");
  if (old.version !== command.expectedVersion) fail("VERSION_CONFLICT", "Discussion version changed", old.version);
  if (command.type === "discussion.handoff.record") {
    if (old.status !== "prepared") fail("INVALID_STATE", "Only a prepared discussion can record initial handoff");
    const appended = await appendDocument(ctx, old, command.documentRevisionId,
      `## 人工承接观察\n记录者：${quoted(principal.actorId)}\n证据：${quoted(command.evidence)}\n说明：${quoted(command.reason)}\n这仅是人工登记，不证明 Desktop 原生送达。`, command.reason);
    const record: DiscussionRecord = { ...appended.record, version: old.version + 1, status: "handed_off", updatedAt: now };
    await tx.updateDiscussion(record, old.version, { ...eventBase(ctx, record, "handoff", appended.revisionId), evidence: command.evidence, reason: command.reason });
    return { result: result(command, record, appended.revisionId), effects: [
      { kind: "discussion", entityId: record.id, version: record.version }, { kind: "document", entityId: record.documentId, version: appended.documentVersion }] };
  }
  if (command.type === "discussion.decision.record") {
    if (old.status !== "handed_off" && old.status !== "decided" && old.status !== "linked") fail("INVALID_STATE", "Handoff must be recorded before a decision");
    if (old.latestDecisionEventId !== (command.supersedesDecisionEventId ?? null)) fail("DECISION_TARGET_CHANGED", "Correction must supersede the latest decision");
    const appended = await appendDocument(ctx, old, command.documentRevisionId,
      `## 讨论决定\n选择：${quoted(command.choice)}\n理由：${quoted(command.reason)}\n未决：${quoted(command.unresolved)}\n再看条件：${quoted(command.relookCondition)}\n证据：${quoted(command.evidence)}`,
      command.reason);
    const record: DiscussionRecord = { ...appended.record, version: old.version + 1, status: "decided", updatedAt: now };
    const event = { ...eventBase(ctx, record, "decision", appended.revisionId), choice: command.choice,
      reason: command.reason, unresolved: command.unresolved, relookCondition: command.relookCondition,
      evidence: command.evidence, supersedesDecisionEventId: command.supersedesDecisionEventId ?? null };
    record.latestDecisionEventId = event.id;
    await tx.updateDiscussion(record, old.version, event);
    return { result: result(command, record, appended.revisionId), effects: [
      { kind: "discussion", entityId: record.id, version: record.version }, { kind: "document", entityId: record.documentId, version: appended.documentVersion }] };
  }
  if (old.status !== "decided" && old.status !== "linked") fail("INVALID_STATE", "A decision is required before linking action");
  if (old.latestDecisionEventId !== command.decisionEventId) fail("DECISION_TARGET_CHANGED", "Action must link the latest decision");
  await checkCurrentDocument(ctx, old);
  await checkTarget(ctx, command.target);
  const record: DiscussionRecord = { ...old, version: old.version + 1, status: "linked", updatedAt: now };
  await tx.updateDiscussion(record, old.version, { ...eventBase(ctx, record, "action", old.currentDocumentRevisionId),
    decisionEventId: command.decisionEventId, target: command.target, reason: command.reason });
  return { result: result(command, record), effects: [{ kind: "discussion", entityId: record.id, version: record.version }] };
}
