// The commands written from the task page (任务操作, 依据与影响, 运行与关联, 执行时间与重复), as pure functions of what
// the form recorded when it opened (`seen`, its baseline) and what the person entered. Each one keeps the shape the
// old forms on main sent, field for field; `task-commands.test.ts` pins them, the expected versions first.
// useCommand adds the project and a new operation ID.
import type { DocumentDetail, Impact, TaskDetail, TaskRevisionState } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { ResidentQueue, ResidentQueueEntry } from "@evoloop/contracts/queues";
import type { TaskAttentionFollowUp } from "@evoloop/contracts";
import type { TaskTimingView } from "../../shared/api";
import { timingSetPayload } from "./taskTimingPresentation";

type Detail = Pick<TaskDetail, "task" | "links" | "proposal">;
type Id = () => string;
const newId: Id = () => crypto.randomUUID();

export const taskStateLabel: Record<TaskRevisionState, string> = {
  todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消",
  proposed: "历史·待判断", ready: "历史·可做", active: "历史·进行中", review: "历史·待验收",
  blocked: "历史·阻塞", deferred: "历史·暂缓",
};

/** What the acceptance contract carries over when the task's text is edited (task.update keeps it). */
function proposalFields(detail: Detail) {
  const proposal = detail.proposal;
  return proposal ? {
    ...(proposal.consumer ? { consumer: proposal.consumer } : {}), useRequired: proposal.useRequired,
    ...(proposal.evidence ? { evidence: proposal.evidence } : {}),
    ...(proposal.stopCondition ? { stopCondition: proposal.stopCondition } : {}),
  } : {};
}
const documentIds = (detail: Detail) => detail.links.map(link => link.documentId);

/** A local date-time input ("2026-11-10T09:30") or an ISO time as an instant; empty is null. */
export function instantOrNull(value: string, label: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}不是有效的时间。`);
  return date.toISOString();
}

/** An ISO instant as the value of a local date-time input. */
export function localInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── 任务操作 ────────────────────────────────────────────────────────────────────────────────────────────

export interface TaskSeen { taskVersion: number }

export function taskUpdateCommand(detail: Detail, seen: TaskSeen, values: { title: string; kind: string; content: string; acceptance: string; owner: string; reason: string }) {
  return { taskId: detail.task.id, expectedVersion: seen.taskVersion, type: "task.update", title: values.title, kind: values.kind || null,
    content: values.content, acceptance: values.acceptance, owner: values.owner, documentIds: documentIds(detail),
    ...proposalFields(detail), reason: values.reason };
}

export function acceptanceResponsibilityCommand(detail: Detail, seen: TaskSeen, values: { acceptanceMode: string; consumer: string; reason: string }) {
  const task = detail.task;
  return { taskId: task.id, expectedVersion: seen.taskVersion, type: "task.update", title: task.title, content: task.content, acceptance: task.acceptance,
    owner: task.owner, kind: task.kind, documentIds: documentIds(detail),
    ...(values.acceptanceMode !== "legacy" ? { acceptanceMode: values.acceptanceMode, useRequired: true } : {}),
    consumer: values.consumer.trim() || null, reason: values.reason };
}

/** A fixed basis document whose published version moved on, without a recorded decision to keep the fixed one. */
export interface OlderSource { documentId: string; revisionId: string; title: string; observedAdoptedRevisionId: string }

export function olderBasisSources(detail: Pick<TaskDetail, "basis" | "impacts" | "decisions">, documents: Record<string, DocumentDetail | undefined>): OlderSource[] {
  return (detail.basis?.members ?? []).flatMap(member => {
    const document = documents[member.documentId]?.document;
    const checkpoint = detail.basis?.retentions?.some(item => item.documentId === member.documentId
      && item.revisionId === member.revisionId && item.observedAdoptedRevisionId === document?.adoptedRevisionId);
    const reviewedImpact = detail.impacts.some(impact => impact.documentId === member.documentId && impact.fromRevisionId === member.revisionId
      && impact.toRevisionId === document?.adoptedRevisionId && impact.state === "resolved"
      && detail.decisions.some(decision => decision.impactId === impact.id && decision.decision === "retain"));
    return document?.adoptedRevisionId && document.adoptedRevisionId !== member.revisionId && !checkpoint && !reviewedImpact
      ? [{ documentId: member.documentId, revisionId: member.revisionId, title: document.title, observedAdoptedRevisionId: document.adoptedRevisionId }] : [];
  });
}

export function taskStartCommand(detail: Detail, seen: TaskSeen, sources: OlderSource[], values: { reason: string; retain: Record<string, string> }) {
  const retentions = sources.filter(source => values.retain[source.documentId]?.trim()).map(source => ({ documentId: source.documentId,
    revisionId: source.revisionId, observedAdoptedRevisionId: source.observedAdoptedRevisionId, reason: values.retain[source.documentId]!.trim() }));
  return { taskId: detail.task.id, expectedVersion: seen.taskVersion, type: "task.start", reason: values.reason, ...(retentions.length ? { retentions } : {}) };
}

export function deliveryRecordCommand(detail: Detail, seen: TaskSeen, values: { runId: string; artifactRef: string; artifactRevision: string;
  contentHash: string; technicalResult: string; technicalEvidence: string; reason: string }) {
  const { runId, ...fields } = values;
  return { taskId: detail.task.id, expectedVersion: seen.taskVersion, type: "delivery.record", ...fields, ...(runId ? { runId } : {}) };
}

export function observationRecordCommand(detail: Detail, seen: { deliveryId: string }, values: { observer: string; observerKind: string; result: string; evidence: string; reason: string }) {
  return { type: "observation.record", taskId: detail.task.id, deliveryId: seen.deliveryId, ...values };
}

export function taskCloseCommand(detail: Detail, seen: TaskSeen & { deliveryId: string }, values: { acceptanceEvidence: string; reason: string }) {
  return { taskId: detail.task.id, expectedVersion: seen.taskVersion, type: "task.close", deliveryId: seen.deliveryId, acceptanceResult: "met", ...values };
}

export function taskCancelCommand(detail: Detail, seen: TaskSeen, values: { reason: string }) {
  return { taskId: detail.task.id, expectedVersion: seen.taskVersion, type: "task.cancel", ...values };
}

export function taskReopenCommand(detail: Detail, seen: TaskSeen, values: { reason: string }) {
  return { taskId: detail.task.id, expectedVersion: seen.taskVersion, type: "task.reopen", ...values };
}

/** Whether the latest delivery may close the current revision: technical check passed and, when required, used. */
export function closableDelivery(detail: Pick<TaskDetail, "revision" | "deliveries" | "observations" | "proposal">): boolean {
  const latest = (detail.deliveries ?? []).at(-1);
  const acceptanceMode = detail.proposal?.acceptanceMode ?? null;
  const used = (detail.observations ?? []).filter(item => item.deliveryId === latest?.id &&
    (!detail.proposal?.consumer || item.observer === detail.proposal.consumer)).at(-1);
  const observedUse = !detail.proposal?.useRequired && !acceptanceMode || used?.result === "used" &&
    (acceptanceMode === "independent_agent" ? !!latest?.submittedByActorId &&
      used.observerKind === "agent" && used.actorId === used.observer && used.actorId !== latest.submittedByActorId
      : acceptanceMode === "human_required" ? used.observerKind === "human" && used.actorId === detail.proposal?.consumer : true);
  return latest?.taskRevisionId === detail.revision.id && latest.technicalResult === "passed" && observedUse;
}

// ── 统筹安排（独立端点，命令不经 /api/commands）──────────────────────────────────────────────────────────

export interface LeaderSeen { taskVersion: number }

export function planCommand(taskId: string, seen: LeaderSeen & { planVersion: number }, values: { plannedStartAt: string; dueAt: string; priority: string; reason: string }) {
  return { type: "work.plan.set", taskId, expectedTaskVersion: seen.taskVersion, expectedPlanVersion: seen.planVersion,
    plannedStartAt: instantOrNull(values.plannedStartAt, "计划开始"), dueAt: instantOrNull(values.dueAt, "计划截止"),
    priority: values.priority ? Number(values.priority) : null, reason: values.reason };
}

export function dependenciesCommand(taskId: string, seen: LeaderSeen & { dependencyVersion: number }, values: { dependsOnTaskIds: string[]; reason: string }) {
  return { type: "work.dependencies.set", taskId, expectedTaskVersion: seen.taskVersion, expectedDependencyVersion: seen.dependencyVersion,
    dependsOnTaskIds: values.dependsOnTaskIds.map(item => item.trim()).filter(Boolean), reason: values.reason };
}

export function reviewCommand(taskId: string, seen: LeaderSeen & { revisionId: string; workChangeSequence: number }, values: { decision: string; reason: string }) {
  return { type: "work.review.set", taskId, expectedTaskVersion: seen.taskVersion, expectedTaskRevisionId: seen.revisionId,
    expectedWorkChangeSequence: seen.workChangeSequence, decision: values.decision, reason: values.reason };
}

export const leaderSeen = (task: { version: number; currentRevisionId: string }, leader: LeaderWorkTask) => ({
  taskVersion: task.version, revisionId: task.currentRevisionId, planVersion: leader.plan?.version ?? 0,
  dependencyVersion: leader.dependencyVersion, workChangeSequence: leader.workChangeSequence,
});

/** The Leader's endpoints take the command without its type; the schema is checked on the same body. */
export function withoutOperationType(value: Record<string, unknown>) {
  const { type: _operationType, ...body } = value;
  return body;
}

// ── 依据复核 ────────────────────────────────────────────────────────────────────────────────────────────

export function reviewBasisCommand(taskId: string, seen: TaskSeen & { impactId: string }, values: { decision: "adopt" | "retain"; reason: string; acceptance: string }) {
  return { type: "task.reviewBasis", taskId, expectedVersion: seen.taskVersion, impactId: seen.impactId, decision: values.decision,
    reason: values.reason.trim(), ...(values.decision === "adopt" && values.acceptance.trim() ? { acceptance: values.acceptance.trim() } : {}) };
}

export const impactSeen = (task: { version: number }, impact: Pick<Impact, "id" | "state" | "fromRevisionId" | "toRevisionId">) => ({
  taskVersion: task.version, impactId: impact.id, impactState: impact.state, from: impact.fromRevisionId, to: impact.toRevisionId,
});

// ── 执行时间与重复 ──────────────────────────────────────────────────────────────────────────────────────

export interface TimingSeen { taskVersion: number; timingVersion: number }

/** task.update for a repeating task's prompt, this occurrence only or this and the following ones. */
export function seriesCurrentPromptCommand(detail: Detail, seen: TimingSeen, values: { scope: string; title: string; content: string; acceptance: string; reason: string }) {
  if (!values.reason.trim() || !values.title.trim() || !values.content.trim() || !values.acceptance.trim()) throw new Error("请填写完整任务要求与理由。");
  if (values.scope !== "this" && values.scope !== "this_and_future") throw new Error("请选择本次修改范围。");
  const task = detail.task;
  return { type: "task.update", taskId: task.id, expectedVersion: seen.taskVersion,
    title: values.title, content: values.content, acceptance: values.acceptance, owner: task.owner, kind: task.kind,
    documentIds: documentIds(detail), ...proposalFields(detail),
    repeatScope: values.scope, ...(values.scope === "this_and_future" ? { expectedTimingVersion: seen.timingVersion } : {}), reason: values.reason.trim() };
}

/** The template later occurrences are created from; the occurrences already created keep their own. */
export function seriesFuturePromptCommand(taskId: string, seen: TimingSeen, timing: TaskTimingView, values: { title: string; content: string; acceptance: string; reason: string }) {
  if (!values.reason.trim() || !values.title.trim() || !values.content.trim() || !values.acceptance.trim()) throw new Error("请填写完整的以后任务要求与理由。");
  return { ...timingSetPayload(taskId, seen.taskVersion, { ...timing, version: seen.timingVersion },
    { executeAtUtc: timing.executeAtUtc, timezone: timing.timezone, repeat: timing.repeat, scope: "future", reason: values.reason }),
    title: values.title, content: values.content, acceptance: values.acceptance };
}

// ── 运行与关联：分派、队列、运行 ────────────────────────────────────────────────────────────────────────

export interface AssignmentSeen { taskVersion: number; assignmentVersion: number }

export function assignmentAcknowledgeCommand(taskId: string, seen: AssignmentSeen, values: { evidence: string; sourceRef: string }) {
  return { type: "task.assignment.acknowledge", taskId, expectedVersion: seen.assignmentVersion, expectedTaskVersion: seen.taskVersion,
    evidence: values.evidence, sourceRef: values.sourceRef || null };
}

export function assignmentObserveCommand(taskId: string, seen: AssignmentSeen, values: { evidence: string; sourceRef: string }) {
  return { type: "task.assignment.observeAcceptance", taskId, expectedVersion: seen.assignmentVersion, expectedTaskVersion: seen.taskVersion,
    evidence: values.evidence, sourceRef: values.sourceRef || null };
}

export function assignmentReleaseCommand(taskId: string, seen: AssignmentSeen, values: { reason: string }) {
  return { type: "task.assignment.release", taskId, expectedVersion: seen.assignmentVersion, reason: values.reason };
}

export function assignmentSetCommand(taskId: string, seen: AssignmentSeen, values: { target: unknown; recipientActorId: string; reason: string }) {
  return { type: "task.assignment.set", taskId, expectedTaskVersion: seen.taskVersion, expectedVersion: seen.assignmentVersion,
    target: values.target, recipientActorId: values.recipientActorId.trim() || null, reason: values.reason.trim() };
}

export interface QueueSeen { queueVersion: number }

export function queueAdoptCommand(queueId: string, seen: QueueSeen) {
  return { type: "queue.adopt", queueId, expectedVersion: seen.queueVersion };
}

/** Moves one waiting entry a place forward. */
export function queueReorderCommand(queue: Pick<ResidentQueue, "id" | "entries">, seen: QueueSeen, values: { entryId: string; reason: string }) {
  const ids = [...queue.entries].sort((a, b) => a.position - b.position).map(entry => entry.id);
  const at = ids.indexOf(values.entryId);
  if (at <= 0) throw new Error("这一项已是第一项，请选择后面的任务。");
  [ids[at - 1], ids[at]] = [ids[at]!, ids[at - 1]!];
  return { type: "queue.reorder", queueId: queue.id, expectedVersion: seen.queueVersion, entryIds: ids, reason: values.reason };
}

export function queueAmendCommand(queueId: string, seen: QueueSeen & { entryId: string; taskRevisionId: string }, values: { reason: string }) {
  return { type: "queue.amend", queueId, expectedVersion: seen.queueVersion, entryId: seen.entryId, taskRevisionId: seen.taskRevisionId, reason: values.reason };
}

export function queueHoldCommand(queueId: string, entry: Pick<ResidentQueueEntry, "id">, values: { reason: string }) {
  return { type: "queue.hold", queueId, entryId: entry.id, reason: values.reason };
}

export function queueUnholdCommand(queueId: string, seen: { entryId: string; entryVersion: number }, values: { reason: string }) {
  return { type: "queue.unhold", queueId, entryId: seen.entryId, expectedEntryVersion: seen.entryVersion, reason: values.reason };
}

export interface ArrangeSeen { taskVersion: number; revisionId: string; owner: string }

/** A one-task queue for a concrete agent of the task's role; it still has to be adopted before anything runs. */
export function queueCreateCommand(detail: Pick<TaskDetail, "task" | "proposal">, seen: ArrangeSeen, values: { sessionId: string; consumerId: string; reason: string }, id: Id = newId) {
  return { type: "queue.create", queueId: id(), maxRuns: 3, reason: values.reason,
    entries: [{ id: id(), taskId: detail.task.id, taskRevisionId: seen.revisionId,
      sessionId: values.sessionId, roleId: seen.owner, dependsOn: [], consumerId: values.consumerId,
      useRequired: detail.proposal?.useRequired ?? false, releaseRule: "accepted" }] };
}

export function runReserveCommand(taskId: string, seen: ArrangeSeen, values: { sessionId: string; input: string }, id: Id = newId) {
  return { type: "runtime.run.reserve", runId: id(), taskId, expectedVersion: seen.taskVersion, sessionId: values.sessionId, input: values.input };
}

export function runInterruptCommand(runId: string, values: { reason: string }) {
  return { type: "runtime.run.interrupt", runId, ...values };
}

export function runAbandonCommand(runId: string, seen: { runVersion: number }, values: { reason: string; evidence: string }) {
  return { type: "runtime.run.abandonReadOnly", runId, expectedVersion: seen.runVersion, ...values };
}

export function handoffRecordCommand(runId: string, values: { stage: string; evidence: string }) {
  return { type: "runtime.handoff.record", runId, ...values };
}

// ── 当前关注 ────────────────────────────────────────────────────────────────────────────────────────────

export interface AttentionSeen { taskVersion: number; revisionId: string; followUpVersion: number }

export function attentionResolveCommand(item: { id: string }, seen: { itemVersion: number }, values: { reason: string }) {
  return { type: "task.attention.resolve", itemId: item.id, expectedVersion: seen.itemVersion, disposition: "resolved", reason: values.reason.trim() };
}

export function followUpCommand(taskId: string, seen: AttentionSeen, values: {
  waitingKind: NonNullable<TaskAttentionFollowUp["waitingOn"]>["kind"]; waitingId: string; decision: TaskAttentionFollowUp["decision"];
  actionTaken: string; evidenceRef: string; nextCheck: string; reason: string;
  handoff: null | { recipient: string; artifactRef: string; note: string; readyAt: string };
}) {
  return { type: "task.attention.followUp.set", taskId,
    expectedTaskVersion: seen.taskVersion, expectedTaskRevisionId: seen.revisionId, expectedVersion: seen.followUpVersion,
    waitingOn: { kind: values.waitingKind, id: values.waitingId.trim() || null },
    decision: values.decision, actionTaken: values.actionTaken.trim(), evidenceRef: values.evidenceRef.trim() || null,
    nextCheckAt: instantOrNull(values.nextCheck, "下一检查时间"),
    releaseHandoff: values.handoff ? { recipient: values.handoff.recipient.trim(), artifactRef: values.handoff.artifactRef.trim(),
      note: values.handoff.note.trim(), readyForPublicationAt: instantOrNull(values.handoff.readyAt, "具备发布条件时间")! } : null,
    reason: values.reason.trim() };
}

export function publicationCommand(taskId: string, seen: AttentionSeen, values: { publishedAt: string; publicationRef: string; reason: string }) {
  return { type: "task.attention.publication.record", taskId,
    expectedTaskVersion: seen.taskVersion, expectedTaskRevisionId: seen.revisionId,
    expectedVersion: seen.followUpVersion, publishedAt: instantOrNull(values.publishedAt, "实际发布时间")!,
    publicationRef: values.publicationRef.trim(), reason: values.reason.trim() };
}
