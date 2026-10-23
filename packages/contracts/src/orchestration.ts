import { z } from "zod";

const id = z.uuid();
const short = z.string().trim().min(1).max(240);
const role = z.string().trim().min(1).max(4000);
const reason = z.string().trim().min(1).max(4000);
const version = z.number().int().positive();
const boundedCount = z.number().int().min(1).max(1000);
const utc = z.iso.datetime({ offset: false });
const deliveryIntent = z.strictObject({ artifactRef: reason, artifactRevision: reason, contentHash: z.string().regex(/^[a-f0-9]{64}$/i), technicalResult: z.enum(["passed", "failed"]), technicalEvidence: reason, reason });
const cursor = z.strictObject({ createdAtUtc: utc, eventId: id.nullable() });
const common = { projectId: id, operationId: id };

export const orchestrationCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("loop.enroll"), loopId: id, goalId: id, stageId: id.nullable(), cognitiveRoleId: role, allowedBusinessRoleIds: z.array(role).min(1).max(20), sourceAfter: cursor, maxRuns: boundedCount, maxConcurrent: z.number().int().min(1).max(20), reason }),
  z.strictObject({ ...common, type: z.literal("loop.state"), loopId: id, expectedVersion: version, state: z.enum(["active", "paused", "stopped"]), reason }),
  z.strictObject({ ...common, type: z.literal("inbox.accept"), loopId: id, sourceEventId: id, recipientRoleId: role, purpose: z.enum(["cognitive_review", "next_action"]) }),
  z.strictObject({ ...common, type: z.literal("inbox.ack"), inboxId: id, expectedVersion: version, reason }),
  z.strictObject({ ...common, type: z.literal("inbox.dispose"), inboxId: id, expectedVersion: version, disposition: z.enum(["no_action", "waiting", "failed", "stop"]), reason, evidenceRef: short.nullable() }),
  z.strictObject({ ...common, type: z.literal("dispatch.request"), inboxId: id, expectedInboxVersion: version, dispatchId: id, parentDispatchId: id.nullable(), taskId: id, expectedTaskVersion: version, recipientRoleId: role, purpose: short, authorizationScopeId: role, reason }),
  z.strictObject({ ...common, type: z.literal("dispatch.claim"), dispatchId: id, claimToken: id, leaseUntilUtc: utc }),
  z.strictObject({ ...common, type: z.literal("dispatch.reclaim"), dispatchId: id, expectedVersion: version, claimToken: id, leaseUntilUtc: utc }),
  z.strictObject({ ...common, type: z.literal("dispatch.start"), dispatchId: id, claimToken: id }),
  z.strictObject({ ...common, type: z.literal("dispatch.resolve"), dispatchId: id, claimToken: id, result: z.enum(["accepted", "unknown", "rejected"]), runtimeRunId: id.nullable(), reason }),
  z.strictObject({ ...common, type: z.literal("dispatch.reconcile"), dispatchId: id, expectedVersion: version, resolution: z.enum(["accepted", "rejected"]), runtimeRunId: id.nullable(), evidenceRef: short, reason }),
  z.strictObject({ ...common, type: z.literal("worker.decision"), decisionId: id, dispatchId: id, runId: id, kind: z.enum(["no_action", "waiting", "failed", "stop"]), reason, evidenceRefs: z.array(short).max(20) }),
  z.strictObject({ ...common, type: z.literal("worker.submit"), submissionId: id, dispatchId: id, runId: id, taskRevisionId: id, runInputHash: short, deliveryOperationId: id, deliveryIntent, agentObservation: reason.nullable(), evidenceRefs: z.array(short).max(20) }),
  z.strictObject({ ...common, type: z.literal("worker.beginSeal"), submissionId: id, expectedVersion: version, expectedTaskVersion: version, sealToken: id }),
  z.strictObject({ ...common, type: z.literal("worker.finishSeal"), submissionId: id, sealToken: id, result: z.enum(["sealed", "unknown", "rejected"]), deliveryId: id.nullable(), reason }),
  z.strictObject({ ...common, type: z.literal("worker.reconcileSeal"), submissionId: id, expectedVersion: version, resolution: z.enum(["sealed", "rejected"]), deliveryId: id.nullable(), evidenceRef: short, reason }),
  z.strictObject({ ...common, type: z.literal("worker.outcome"), dispatchId: id, outcome: z.enum(["delivered", "no_action", "waiting", "failed"]), deliveryId: id.nullable(), decisionId: id.nullable(), evidenceRef: short.nullable(), reason }),
  z.strictObject({ ...common, type: z.literal("dispatch.gap"), dispatchId: id, expectedVersion: version, reason, evidenceRef: short.nullable() }),
]);
export type OrchestrationCommand = z.infer<typeof orchestrationCommandSchema>;
export type LoopState = "active" | "paused" | "stopped";
export type InboxState = "pending" | "acknowledged" | "disposed";
export type DispatchState = "pending" | "claimed" | "dispatching" | "accepted" | "unknown" | "rejected" | "completed";
export type SubmissionState = "submitted" | "sealing" | "sealed" | "unknown" | "rejected";
export type DeliveryIntent = z.infer<typeof deliveryIntent>;
export type WorkerOutcome = "delivered" | "no_action" | "waiting" | "failed";
export interface EventCursor { createdAtUtc: string; eventId: string | null }
export interface OrchestrationLoop {
  projectId: string; id: string; version: number; goalId: string; stageId: string | null; bootstrapEventId: string;
  cognitiveRoleId: string; allowedBusinessRoleIds: string[]; sourceAfter: EventCursor;
  maxRuns: number; maxConcurrent: number; dispatchCount: number; state: LoopState;
  enrolledBy: string; createdAtUtc: string; updatedAtUtc: string;
}
export interface OrchestrationInbox {
  projectId: string; id: string; version: number; loopId: string; sourceEventId: string;
  recipientRoleId: string; purpose: string; state: InboxState;
  acknowledgedBy: string | null; disposition: "dispatch" | "no_action" | "waiting" | "failed" | "stop" | null;
  reason: string | null; evidenceRef: string | null; dispatchId: string | null;
  createdAtUtc: string; updatedAtUtc: string;
}
export interface OrchestrationDispatch {
  projectId: string; id: string; version: number; loopId: string; inboxId: string; sourceEventId: string;
  taskId: string; taskVersion: number; parentDispatchId: string | null; recipientRoleId: string; purpose: string; authorizationScopeId: string;
  state: DispatchState; claimToken: string | null; leaseUntilUtc: string | null;
  runtimeRunId: string | null; outcome: WorkerOutcome | null; deliveryId: string | null;
  evidenceRef: string | null; reason: string; requestedBy: string; createdAtUtc: string; updatedAtUtc: string;
}
export interface OrchestrationWorkerDecision {
  projectId: string; id: string; dispatchId: string; runId: string; taskId: string;
  kind: "no_action" | "waiting" | "failed" | "stop";
  reason: string; evidenceRefs: string[]; actorId: string; createdAtUtc: string;
}
export interface OrchestrationSubmission {
  projectId: string; id: string; version: number; dispatchId: string; runId: string; taskId: string;
  taskRevisionId: string; runInputHash: string; deliveryOperationId: string;
  deliveryIntent: DeliveryIntent; agentObservation: string | null; evidenceRefs: string[];
  state: SubmissionState; submittedBy: string; sealedBy: string | null;
  expectedTaskVersion: number | null; sealToken: string | null; deliveryId: string | null;
  reason: string | null; createdAtUtc: string; updatedAtUtc: string;
}
export interface OrchestrationEvent {
  projectId: string; id: string; loopId: string; entityType: "loop" | "inbox" | "dispatch" | "submission" | "decision";
  entityId: string; operationId: string; kind: string; actorId: string; detail: Record<string, unknown>; createdAtUtc: string;
}
export interface OrchestrationOperation {
  projectId: string; id: string; actorId: string; commandHash: string; result: OrchestrationResult; createdAtUtc: string;
}
export interface OrchestrationResult { entityType: "loop" | "inbox" | "dispatch" | "submission" | "decision"; entityId: string; version: number; replayed: boolean }
export interface OrchestrationSourceFact {
  projectId: string; id: string; createdAtUtc: string; kind: string;
  subjectId: string; subjectVersion: number; sourceLoopId: string | null; originDispatchId: string | null;
  /** Populated only for a verified workflow observation.record outbox event. */
  operationId: string | null; sourceActorId: string | null; observationId: string | null;
  deliveryId: string | null; observationResult: "used" | "failed" | "notUsed" | null;
  /** Fixed Run of a formal dispatch.gap; absent for other source kinds. */
  gapRunId?: string | null; gapTaskVersion?: number | null;
  /** Creation revision of a scoped issue; report and unscoped Document events are not sources. */
  issueRevisionId?: string | null; issueContentHash?: string | null;
  /** Fixed managed Schedule occurrence and creation Task revision. */
  scheduleId?: string | null; scheduleRevisionId?: string | null; plannedAtUtc?: string | null;
  scheduleTargetLoopId?: string | null; scheduleTargetStageId?: string | null; scheduleTaskRevisionId?: string | null;
}
export interface OrchestrationIssueFact {
  projectId: string; documentId: string; revisionId: string; contentHash: string; author: string;
  kind: "issue"; originTaskId: string; originTaskRevisionId: string;
  originTaskVersion: number; originRunId: string | null;
}
export interface OrchestrationTaskFact { projectId: string; id: string; version: number; state: "todo" | "in_progress" | "done" | "cancelled"; ownerRoleId: string; goalId: string | null; stageId: string | null }
export interface OrchestrationTaskScopeFact { projectId: string; taskId: string; taskVersion: number; goalId: string | null; stageId: string | null }
export interface OrchestrationGoalFact { projectId: string; id: string; state: string }
export interface OrchestrationStageFact { projectId: string; id: string; goalId: string; state: string }
export interface OrchestrationRunFact { projectId: string; id: string; taskId: string; taskRevisionId: string; inputHash: string; state: "requested" | "dispatching" | "running" | "completed" | "failed" | "interrupted" | "unknown" }
export interface OrchestrationDeliveryFact { projectId: string; id: string; taskId: string; taskRevisionId: string; runId: string | null; actorId: string; artifactRef: string; artifactRevision: string; contentHash: string; technicalResult: "passed" | "failed"; technicalEvidence: string }
/** Historical scope is the nearest TaskProposal at or before the Delivery's fixed TaskRevision, never today's Task head. */
export interface OrchestrationObservationFact { projectId: string; id: string; taskId: string; deliveryId: string; actorId: string; result: "used" | "failed" | "notUsed"; taskRevisionId: string; stageId: string | null }
export interface OrchestrationWorkflowOperationFact { projectId: string; id: string; actorId: string; commandType: string; commandHash: string; status: "applied" | "rejected"; resultRefId: string | null; resultVersion: number | null }
export interface OrchestrationAuthorizationFact { projectId: string; scopeId: string; actorId: string; roleId: string; active: boolean }

/** Methods are project-scoped and run on the same database transaction/client. */
export interface OrchestrationTransaction {
  getOperation(id: string): Promise<OrchestrationOperation | null>;
  insertOperation(value: OrchestrationOperation): Promise<void>;
  getLoop(id: string): Promise<OrchestrationLoop | null>;
  insertLoop(value: OrchestrationLoop): Promise<void>;
  updateLoop(value: OrchestrationLoop, expectedVersion: number): Promise<void>;
  getInbox(id: string): Promise<OrchestrationInbox | null>;
  findInbox(loopId: string, sourceEventId: string, recipientRoleId: string, purpose: string): Promise<OrchestrationInbox | null>;
  insertInbox(value: OrchestrationInbox): Promise<void>;
  updateInbox(value: OrchestrationInbox, expectedVersion: number): Promise<void>;
  getDispatch(id: string): Promise<OrchestrationDispatch | null>;
  getSubmission(id: string): Promise<OrchestrationSubmission | null>;
  getDecision(id: string): Promise<OrchestrationWorkerDecision | null>;
  findSubmissionByDispatch(dispatchId: string): Promise<OrchestrationSubmission | null>;
  findDecisionByDispatch(dispatchId: string): Promise<OrchestrationWorkerDecision | null>;
  insertDecision(value: OrchestrationWorkerDecision): Promise<void>;
  insertSubmission(value: OrchestrationSubmission): Promise<void>;
  updateSubmission(value: OrchestrationSubmission, expectedVersion: number): Promise<void>;
  insertDispatch(value: OrchestrationDispatch): Promise<void>;
  updateDispatch(value: OrchestrationDispatch, expectedVersion: number): Promise<void>;
  /** Project-scoped running capacity: claimed, dispatching, unknown always count; accepted counts only while its bound Run is nonterminal or unknown. A confirmed terminal Run frees capacity even if worker intent/outcome still needs reconciliation. */
  countCapacityUsed(loopId: string): Promise<number>;
  appendEvent(value: OrchestrationEvent): Promise<void>;
  getSourceFact(id: string): Promise<OrchestrationSourceFact | null>;
  getTaskFact(id: string): Promise<OrchestrationTaskFact | null>;
  /** Scope at the dispatch's fixed Task revision, never the current Task head. */
  getTaskScopeAtVersion(taskId: string, taskVersion: number): Promise<OrchestrationTaskScopeFact | null>;
  getGoalFact(id: string): Promise<OrchestrationGoalFact | null>;
  getStageFact(id: string): Promise<OrchestrationStageFact | null>;
  getAuthorizationFact(scopeId: string): Promise<OrchestrationAuthorizationFact | null>;
  getRunFact(id: string): Promise<OrchestrationRunFact | null>;
  getDeliveryFact(id: string): Promise<OrchestrationDeliveryFact | null>;
  getObservationFact(id: string): Promise<OrchestrationObservationFact | null>;
  getWorkflowOperationFact(id: string): Promise<OrchestrationWorkflowOperationFact | null>;
  getIssueFact(documentId: string, revisionId: string): Promise<OrchestrationIssueFact | null>;
  canActAsRole(actorId: string, roleId: string): Promise<boolean>;
  /** Historical classification only. Never grants command authority. */
  wasActorRole(actorId: string, loopId: string, roleId: string): Promise<boolean>;
}
export interface OrchestrationReader {
  getOperation(id: string): Promise<OrchestrationOperation | null>;
  getLoop(id: string): Promise<OrchestrationLoop | null>;
  listLoops(limit: number, cursor?: string): Promise<{ items: OrchestrationLoop[]; nextCursor: string | null }>;
  getInbox(id: string): Promise<OrchestrationInbox | null>;
  listInbox(loopId: string, limit: number, cursor?: string): Promise<{ items: OrchestrationInbox[]; nextCursor: string | null }>;
  getDispatch(id: string): Promise<OrchestrationDispatch | null>;
  getSubmission(id: string): Promise<OrchestrationSubmission | null>;
  getDecision(id: string): Promise<OrchestrationWorkerDecision | null>;
  findSubmissionByDispatch(dispatchId: string): Promise<OrchestrationSubmission | null>;
  findDecisionByDispatch(dispatchId: string): Promise<OrchestrationWorkerDecision | null>;
  listSubmissions(loopId: string, limit: number, cursor?: string): Promise<{ items: OrchestrationSubmission[]; nextCursor: string | null }>;
  listDispatches(loopId: string, limit: number, cursor?: string): Promise<{ items: OrchestrationDispatch[]; nextCursor: string | null }>;
  listEvents(loopId: string, limit: number, cursor?: string): Promise<{ items: OrchestrationEvent[]; nextCursor: string | null }>;
  /** Repeat from the first page on every poll. Pagination is not a durable watermark: late commits can precede a prior cursor. */
  listSourceFacts(loopId: string, limit: number, cursor?: string): Promise<{ items: OrchestrationSourceFact[]; nextCursor: string | null }>;
}
export interface OrchestrationStore {
  transaction<T>(projectId: string, action: (tx: OrchestrationTransaction) => Promise<T>): Promise<T>;
  read<T>(projectId: string, action: (reader: OrchestrationReader) => Promise<T>): Promise<T>;
}
