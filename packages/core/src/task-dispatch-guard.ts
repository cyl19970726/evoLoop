import type { ConsumerObservation, Delivery, Principal, RuntimeRunRecord, Task } from "@evoloop/contracts";
import type { SessionLineEntry } from "@evoloop/contracts/session-line";
import { DomainError, type Transaction } from "@evoloop/contracts/ports";

const blockingRunState = new Set(["requested", "dispatching", "running", "unknown", "completed"]);

export interface TaskDispatchConflict {
  delivery: Delivery | null;
  run: RuntimeRunRecord | null;
}

/** The current Task revision has a fixed Delivery or a Run that must not be dispatched over. */
export async function taskDispatchConflict(tx: Transaction, task: Task): Promise<TaskDispatchConflict> {
  const deliveries = await tx.listDeliveries(task.id);
  const delivery = [...deliveries].reverse()
    .find(item => item.projectId === task.projectId && item.taskRevisionId === task.currentRevisionId) ?? null;
  const runs = await tx.listRuntimeRuns(task.id);
  const run = [...runs].reverse()
    .find(item => item.projectId === task.projectId && item.taskRevisionId === task.currentRevisionId &&
      blockingRunState.has(item.state)) ?? null;
  return { delivery, run };
}

interface TaskAnswerContinuation {
  principal: Principal;
  sessionId: string;
  input: string;
}

interface TaskAnswerBlock {
  discussionId: string;
  messageEventId: string;
  documentId: string;
  revisionId: string;
  contentHash: string;
  text: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/i;

function taskAnswerBlock(input: string): TaskAnswerBlock | null {
  const matches = [...input.matchAll(/(?:^|\n)\[evoloop-task-answer ([^\]\n]+)\]\n([\s\S]*?)\n\[\/evoloop-task-answer\](?=\n|$)/g)];
  if (matches.length !== 1) return null;
  const fields = matches[0]![1]!.split(" ");
  if (fields.length !== 5 || fields.some(item => !item)) return null;
  const [discussionId, messageEventId, documentId, revisionId, contentHash] = fields as [string, string, string, string, string];
  if (![discussionId, messageEventId, documentId, revisionId].every(item => uuid.test(item)) || !sha256.test(contentHash))
    return null;
  return { discussionId, messageEventId, documentId, revisionId, contentHash, text: matches[0]![2]! };
}

/**
 * A Task answer continuation is the one existing ordinary-reserve path that deliberately follows a completed Run with
 * a changed business input. It is accepted only while the exact fixed answer still points at this Task's current
 * revision and this Task's original collaboration Session/Run. Once the reserve derives a new Task revision, the same
 * answer can no longer be reused for another Run.
 */
async function isTaskAnswerContinuation(tx: Transaction, task: Task, conflict: TaskDispatchConflict,
  continuation: TaskAnswerContinuation): Promise<boolean> {
  if (conflict.delivery || conflict.run?.state !== "completed") return false;
  const block = taskAnswerBlock(continuation.input);
  if (!block) return false;
  const discussion = await tx.getDiscussion(block.discussionId);
  if (!discussion || discussion.projectId !== task.projectId || discussion.kind !== "task_collaboration" ||
    discussion.task?.id !== task.id || discussion.task.revisionId !== task.currentRevisionId ||
    discussion.collaboration?.sessionId !== continuation.sessionId ||
    discussion.collaboration.runId !== conflict.run.id ||
    discussion.collaboration.issuerActorId !== continuation.principal.actorId)
    return false;
  const event = (await tx.listDiscussionEvents(discussion.id)).find(item => item.id === block.messageEventId);
  if (!event || event.kind !== "message" || event.collaborationPayload?.type !== "message" ||
    event.collaborationPayload.kind !== "answer" ||
    event.collaborationPayload.body.documentId !== block.documentId ||
    event.collaborationPayload.body.revisionId !== block.revisionId)
    return false;
  const answer = await tx.getDocumentRevision(block.documentId, block.revisionId);
  return !!answer && answer.projectId === task.projectId && answer.documentId === block.documentId &&
    answer.contentHash === block.contentHash && answer.body === block.text;
}

function isReworkInternalStep(entry: SessionLineEntry | null, operationId: string): boolean {
  if (!entry || entry.source !== "rework" || !entry.reworkObservationId || !entry.reworkDeliveryId) return false;
  return entry.state === "starting" && (
    (entry.step === "assign" && operationId === entry.assignOperationId) ||
    (entry.step === "start" && [entry.reassignOperationId, entry.startOperationId, entry.reserveOperationId].includes(operationId))
  );
}

/**
 * Shared server-side guard for the three ordinary dispatch entries. Only the exact operation owned by a live rework
 * entry created from a failed consumer observation may proceed.
 */
export async function assertTaskDispatchAvailable(tx: Transaction, task: Task, operationId: string): Promise<void> {
  const conflict = await taskDispatchConflict(tx, task);
  if (!conflict.delivery && !conflict.run) return;
  const reworkEntry = await tx.sessionLines?.getLiveSessionLineEntryForTask(task.id) ?? null;
  if (isReworkInternalStep(reworkEntry, operationId)) return;
  const source = [
    conflict.delivery ? `delivery ${conflict.delivery.id}` : null,
    conflict.run ? `run ${conflict.run.id} (${conflict.run.state})` : null,
  ].filter(Boolean).join(", ");
  throw new DomainError("TASK_ALREADY_DELIVERED",
    `Task revision ${task.currentRevisionId} already has ${source}; only its existing internal rework entry may continue`,
    task.version);
}

/** The guarded reserve entry's only additional allowance: one still-current fixed Task-answer continuation. */
export async function assertRunReserveAvailable(tx: Transaction, task: Task, operationId: string,
  continuation: TaskAnswerContinuation): Promise<void> {
  const conflict = await taskDispatchConflict(tx, task);
  if (!conflict.delivery && !conflict.run) return;
  if (await isTaskAnswerContinuation(tx, task, conflict, continuation)) return;
  const reworkEntry = await tx.sessionLines?.getLiveSessionLineEntryForTask(task.id) ?? null;
  if (isReworkInternalStep(reworkEntry, operationId)) return;
  const source = [
    conflict.delivery ? `delivery ${conflict.delivery.id}` : null,
    conflict.run ? `run ${conflict.run.id} (${conflict.run.state})` : null,
  ].filter(Boolean).join(", ");
  throw new DomainError("TASK_ALREADY_DELIVERED",
    `Task revision ${task.currentRevisionId} already has ${source}; only its existing internal rework entry may continue`,
    task.version);
}

export interface ObservationReworkInput {
  tx: Transaction;
  task: Task;
  delivery: Delivery;
  observation: ConsumerObservation;
  now: string;
  nextId(): string;
}

/**
 * A failed or unused observation from the declared consumer creates one internal rework entry in the original
 * Session line. It does not alter the Task revision or call the three external dispatch entries.
 */
export async function appendObservationRework(input: ObservationReworkInput): Promise<SessionLineEntry | null> {
  const { tx, task, delivery, observation, now, nextId } = input;
  if (observation.result !== "failed" && observation.result !== "notUsed") return null;
  if (delivery.taskRevisionId !== task.currentRevisionId) return null;
  const deliveries = await tx.listDeliveries(task.id);
  if (deliveries.at(-1)?.id !== delivery.id) return null;
  const proposal = await tx.getTaskProposal(task.id);
  if (!proposal?.consumer || proposal.consumer !== observation.observer) return null;
  if (!delivery.runId) return null;
  const sourceRun = await tx.getRuntimeRun(delivery.runId);
  if (!sourceRun || sourceRun.projectId !== task.projectId || sourceRun.taskId !== task.id) return null;
  const session = await tx.getRuntimeSession(sourceRun.sessionId);
  if (!session || session.projectId !== task.projectId || session.state !== "ready" || session.roleId !== task.owner) return null;
  const lines = tx.sessionLines;
  if (!lines) return null;
  const line = await lines.getSessionLine(session.id);
  if (!line) return null;
  const live = await lines.getLiveSessionLineEntryForTask(task.id);
  if (live) return live.source === "rework" && live.reworkDeliveryId === delivery.id ? live : null;
  const existing = (await lines.listSessionLineEntries(session.id, true))
    .find(entry => entry.source === "rework" && entry.reworkDeliveryId === delivery.id);
  if (existing) return existing;
  const entry = await lines.insertSessionLineEntry({
    projectId: task.projectId,
    id: nextId(),
    sessionId: session.id,
    taskId: task.id,
    state: "queued",
    step: null,
    attempt: 0,
    stepTry: 0,
    assignOperationId: null,
    startOperationId: null,
    reassignOperationId: null,
    reserveOperationId: null,
    messageId: null,
    suspendReason: null,
    withdrawnReason: null,
    source: "rework",
    sourceActorId: observation.actorId,
    reworkObservationId: observation.id,
    reworkDeliveryId: delivery.id,
    scheduleId: null,
    releaseRule: "run_end",
    runId: null,
    runEndedAt: null,
    version: 1,
    appendedAt: now,
    updatedAt: now,
  });
  await lines.touchSessionLine(session.id, line.version, now);
  await lines.appendSessionLineEvent({
    projectId: task.projectId,
    sessionId: session.id,
    entryId: entry.id,
    taskId: task.id,
    kind: "entry.appended",
    detail: {
      source: "rework",
      reworkObservationId: observation.id,
      reworkDeliveryId: delivery.id,
      position: entry.position,
      reason: observation.reason,
    },
    actorId: observation.actorId,
    at: now,
  });
  return entry;
}
