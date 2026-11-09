import type { DiscussionEvent, DiscussionRecord, DiscussionTarget, Document, Goal, Stage, Task } from "@evoloop/contracts";
import { safeArtifactHref } from "../../shared/api";

export function discussionCopyEnvelope(origin: string, projectId: string, documentId: string, revisionId: string, body: string): string {
  const fixed = `${origin}/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revisionId)}`;
  return `工作台入口：${origin}/\n固定原件入口：${fixed}\n以下正文才是被 SHA-256 核对的原件；此定位封套在复制时添加，不属于原件哈希。\n\n${body}`;
}

export interface VerifiedDocumentHead { version: number; revisionId: string; contentHash: string; author: string; body: string }

/** An explicit recovery uses the observed owner Document head; the old Discussion revision stays fixed. */
export function discussionDecisionPayload(record: DiscussionRecord, latestDecision: DiscussionEvent | undefined,
  head: VerifiedDocumentHead, values: Record<string, string>): Record<string, unknown> {
  const mismatch = head.revisionId !== record.currentDocumentRevisionId;
  if (mismatch && (values.confirmRecovery !== "confirmed" || !values.documentRecoveryReason?.trim()))
    throw new Error("请先核对两版并明确确认恢复及理由");
  return { type: "discussion.decision.record", discussionId: record.id, expectedVersion: record.version,
    documentRevisionId: mismatch ? head.revisionId : record.currentDocumentRevisionId,
    choice: values.choice, unresolved: values.unresolved, relookCondition: values.relookCondition,
    evidence: values.evidence, reason: values.reason,
    ...(latestDecision ? { supersedesDecisionEventId: latestDecision.id } : {}),
    ...(mismatch ? { documentRecovery: { expectedDocumentVersion: head.version, reason: values.documentRecoveryReason.trim() } } : {}) };
}

export interface PrepareChoices { goals: Goal[]; stages: Stage[]; tasks: Task[]; documents: Document[] }
export interface PrepareValues {
  kind: "allocation" | "direction"; title: string; goalId: string; stageId: string; taskId: string; documentIds: string[];
  question: string; options: string; authorizationBoundary: string; targetSessionLabel: string; targetSessionRef: string; body: string;
}
const optionLines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
/** A reference to the receiving agent is kept only when it is a page of this project, an http(s) address or a fixed codex thread. */
export function safeSessionReference(value: string, projectId: string): boolean {
  return !!safeArtifactHref(value, projectId) || /^codex:\/\/threads\/[0-9a-f-]{36}$/i.test(value.trim());
}

/** discussion.prepare from what the reader picked; every picked object must still be in the list it was picked from. */
export function discussionPreparePayload(choices: PrepareChoices, values: PrepareValues, ids: { discussionId: string; documentId: string },
  projectId: string): Record<string, unknown> {
  const goal = choices.goals.find(item => item.id === values.goalId);
  const stage = values.stageId ? choices.stages.find(item => item.id === values.stageId) : undefined;
  const task = values.taskId ? choices.tasks.find(item => item.id === values.taskId) : undefined;
  const documents = values.documentIds.map(id => choices.documents.find(item => item.id === id));
  if (!goal || (values.stageId && (!stage || stage.goalId !== goal.id)) || (values.taskId && !task) || documents.some(item => !item?.adoptedRevisionId))
    throw new Error("所选目标、阶段、任务或文档已不在读回的清单里，请重新选择。");
  if (values.targetSessionRef.trim() && !safeSessionReference(values.targetSessionRef, projectId))
    throw new Error("智能体引用只接受本项目页面、http(s) 地址或固定 codex://threads/<ID>。");
  const options = optionLines(values.options);
  if (options.length < 1 || options.length > 10) throw new Error("备选做法写一到十项，每行一项。");
  return { type: "discussion.prepare", discussionId: ids.discussionId, documentId: ids.documentId, kind: values.kind,
    title: values.title.trim(), body: values.body, goal: { id: goal.id, version: goal.version },
    ...(stage ? { stage: { id: stage.id, version: stage.version } } : {}),
    ...(task ? { task: { id: task.id, revisionId: task.currentRevisionId } } : {}),
    adoptedDocuments: documents.map(item => ({ documentId: item!.id, revisionId: item!.adoptedRevisionId! })),
    question: values.question, options, authorizationBoundary: values.authorizationBoundary,
    targetSessionLabel: values.targetSessionLabel.trim(), ...(values.targetSessionRef.trim() ? { targetSessionRef: values.targetSessionRef.trim() } : {}) };
}

/** The handoff is recorded against the discussion's registered package revision, at the version the reader saw. */
export function discussionHandoffPayload(record: DiscussionRecord, values: { evidence: string; reason: string }): Record<string, unknown> {
  return { type: "discussion.handoff.record", discussionId: record.id, expectedVersion: record.version,
    documentRevisionId: record.currentDocumentRevisionId, evidence: values.evidence, reason: values.reason };
}

/** A link names one object that already exists, at the fixed revision or version that was read. */
export function discussionLinkPayload(record: DiscussionRecord, decision: DiscussionEvent, target: DiscussionTarget, reason: string): Record<string, unknown> {
  return { type: "discussion.action.link", discussionId: record.id, expectedVersion: record.version,
    decisionEventId: decision.id, target, reason };
}
