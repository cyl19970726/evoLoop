import type { ReferenceReader, ReferenceTransaction } from "./references.js";
import type { BasisDecision, BasisSet, Document, DocumentDecision, DocumentRevision, DocumentTaskReference, Impact, Operation, OutboxEvent, Page, Project, Task, TaskDocumentLink, TaskRevision } from "./index.js";
import type { ConsumerObservation, Delivery, Goal, GoalRevision, Stage, StageRevision, StageReview, TaskClosure, TaskJudgement, TaskProposal } from "./workflow.js";
import type { RuntimeRecordEvent, RuntimeRunRecord, RuntimeSessionRecord } from "./runtime.js";
import type { RoleReader, RoleTransaction } from "./roles.js";
import type { SchedulingReader, SchedulingTransaction } from "./scheduling.js";
import type { DocumentPayloadReader, DocumentPayloadTransaction } from "./process-documents.js";
import type { DiscussionRecord, DiscussionEvent } from "./discussions.js";
import type { AllocationRelationsReader } from "./allocation-relations.js";
import type { EvaluationReader, EvaluationTransaction } from "./evaluation.js";
import type { ResidentReader, ResidentTransaction } from "./resident-hosts.js";
import type { QueueReader, QueueTransaction } from "./queues.js";
import type { SessionMessageReader, SessionMessageTransaction } from "./session-messages.js";
import type { SessionAssignmentReader, SessionAssignmentTransaction } from "./session-assignments.js";
import type { SessionObservationReader } from "./session-observation.js";

// Persistence ports are a separate export; browser clients never import driver or transaction types.
export interface Reader extends ReferenceReader, RoleReader, SchedulingReader, DocumentPayloadReader, EvaluationReader, ResidentReader {
  recovery?: import('./session-recovery.js').SessionRecoveryReader;
  /** Queue capability is optional for legacy in-memory adapters; commands reject its absence. */
  queue?: QueueReader;
  sessionMessages?: SessionMessageReader;
  sessionAssignments?: SessionAssignmentReader;
  sessionObservation?(scope: string): SessionObservationReader;
  allocationRelations?(scope: string): AllocationRelationsReader;
  /** Project-scoped, verified cognition decision and terminal outcome for explicit Task acceptance. */
  getCognitiveClosureFact?(decisionId: string): Promise<CognitiveClosureFact | null>;
  getWaitingHandoffFact?(inboxId: string): Promise<WaitingHandoffFact | null>;
  getChildHandoffFact?(dispatchId: string): Promise<ChildHandoffFact | null>;
  getDiscussion(id: string): Promise<DiscussionRecord | null>;
  listDiscussions(limit: number, cursor?: string, kind?: DiscussionRecord['kind']): Promise<Page<DiscussionRecord>>;
  listDiscussionEvents(id: string): Promise<DiscussionEvent[]>;
  getRuntimeSession(id: string): Promise<RuntimeSessionRecord | null>;
  listRuntimeSessions(): Promise<RuntimeSessionRecord[]>;
  getRuntimeRun(id: string): Promise<RuntimeRunRecord | null>;
  listRuntimeRuns(taskId?: string): Promise<RuntimeRunRecord[]>;
  listRuntimeEvents(runId: string): Promise<RuntimeRecordEvent[]>;
  listRuntimeSessionEvents(sessionId: string): Promise<RuntimeRecordEvent[]>;
  getGoal(id: string): Promise<Goal | null>;
  listGoals(limit: number, cursor?: string): Promise<Page<Goal>>;
  listGoalRevisions(goalId: string): Promise<GoalRevision[]>;
  getStage(id: string): Promise<Stage | null>;
  listStages(goalId?: string): Promise<Stage[]>;
  listStageRevisions(stageId: string): Promise<StageRevision[]>;
  listStageReviews(stageId: string): Promise<StageReview[]>;
  getTaskProposal(taskId: string, taskRevisionId?: string): Promise<TaskProposal | null>;
  listTaskJudgements(taskId: string): Promise<TaskJudgement[]>;
  getDelivery(id: string): Promise<Delivery | null>;
  listDeliveries(taskId: string): Promise<Delivery[]>;
  listObservations(taskId: string): Promise<ConsumerObservation[]>;
  listTaskClosures(taskId: string): Promise<TaskClosure[]>;
  getProject(): Promise<Project | null>;
  getDocument(id: string): Promise<Document | null>;
  getDocumentRevision(documentId: string, revisionId: string): Promise<DocumentRevision | null>;
  /** Whether this fixed revision was ever published by an immutable adoption decision. */
  hasDocumentAdoption(documentId: string, revisionId: string): Promise<boolean>;
  listDocuments(limit: number, cursor?: string): Promise<Page<Document>>;
  getTask(id: string): Promise<Task | null>;
  getTaskRevision(taskId: string, revisionId: string): Promise<TaskRevision | null>;
  listTaskRevisions(taskId: string): Promise<TaskRevision[]>;
  getBasisSet(taskId: string, taskRevisionId: string, basisSetId: string): Promise<BasisSet | null>;
  listTasks(limit: number, cursor?: string): Promise<Page<Task>>;
  listDocumentTaskReferences?(documentId: string, limit: number, cursor?: string): Promise<Page<DocumentTaskReference>>;
  listLinks(taskId: string): Promise<TaskDocumentLink[]>;
  getImpact(id: string): Promise<Impact | null>;
  listImpacts(taskId?: string): Promise<Impact[]>;
  listBasisDecisions(taskId: string): Promise<BasisDecision[]>;
  getOperation(id: string): Promise<Operation | null>;
  findTasksUsingDocument(documentId: string): Promise<Task[]>;
}
export interface CognitiveClosureFact {
  projectId: string; decisionId: string; actorId: string; kind: "no_action" | "waiting" | "stop" | "failed";
  taskId: string; taskRevisionId: string; runId: string; runState: "completed" | "failed" | "interrupted";
  dispatchId: string; loopId: string; sourceInboxId: string; sourceEventId: string; sourceTaskId: string | null;
  /** Historical source Task was itself dispatched for cognition; it is not a business handoff. */
  sourceTaskIsCognition: boolean;
  outcome: "no_action" | "waiting" | "failed"; purpose: string; recipientRoleId: string; cognitiveRoleId: string;
  loopState: "active" | "paused" | "stopped";
  decidedAtUtc: string;
}
export interface WaitingHandoffFact {
  projectId: string; inboxId: string; loopId: string; sourceEventId: string;
  recipientRoleId: string; disposition: "waiting"; actorId: string;
}
export interface ChildHandoffFact {
  projectId: string; dispatchId: string; taskId: string; loopId: string; sourceEventId: string;
  parentDispatchId: string; recipientRoleId: string; cognitiveRoleId: string;
  requestedBy: string; requestedAtUtc: string; sourceInboxId: string;
  /** Present only for a verified, historically completed Division transfer and receiving worker receipt. */
  division?: { bindingId: string; waitingDecisionId: string; acknowledgedRunId: string };
}
export interface Transaction extends Reader, Omit<RoleTransaction, "getTask" | "getRuntimeSession">, ResidentTransaction, SchedulingTransaction, DocumentPayloadTransaction, ReferenceTransaction, EvaluationTransaction {
  /** Row lock before Session gate admission; never requires an empty Run queue. */
  lockRuntimeSession?(id: string): Promise<RuntimeSessionRecord | null>;
  recovery?: import('./session-recovery.js').SessionRecoveryTransaction;
  queue?: QueueTransaction;
  sessionMessages?: SessionMessageTransaction;
  sessionAssignments?: SessionAssignmentTransaction;
  insertDiscussion(value: DiscussionRecord, event: DiscussionEvent): Promise<void>;
  updateDiscussion(value: DiscussionRecord, expectedVersion: number, event: DiscussionEvent): Promise<void>;
  insertRuntimeSession(session: RuntimeSessionRecord): Promise<void>;
  updateRuntimeSession(session: RuntimeSessionRecord, expectedVersion: number): Promise<void>;
  insertRuntimeRun(run: RuntimeRunRecord): Promise<void>;
  updateRuntimeRun(run: RuntimeRunRecord, expectedVersion: number): Promise<void>;
  appendRuntimeEvent(event: RuntimeRecordEvent): Promise<void>;
  insertGoal(goal: Goal, reason: string): Promise<void>;
  updateGoal(goal: Goal, expectedVersion: number, reason: string): Promise<void>;
  insertStage(stage: Stage, revision: StageRevision): Promise<void>;
  updateStage(stage: Stage, revision: StageRevision, expectedVersion: number): Promise<void>;
  insertStageReview(review: StageReview): Promise<void>;
  insertTaskProposal(proposal: TaskProposal): Promise<void>;
  insertTaskJudgement(judgement: TaskJudgement): Promise<void>;
  insertDelivery(delivery: Delivery): Promise<void>;
  insertObservation(observation: ConsumerObservation): Promise<void>;
  insertTaskClosure(closure: TaskClosure): Promise<void>;
  savepoint<T>(action: () => Promise<T>): Promise<T>;
  insertProject(project: Project): Promise<void>;
  insertDocument(document: Document): Promise<void>;
  insertDocumentRevision(revision: DocumentRevision): Promise<void>;
  insertDocumentDecision(decision: DocumentDecision): Promise<void>;
  updateDocument(document: Document, expectedVersion: number): Promise<void>;
  insertTask(task: Task): Promise<void>;
  insertTaskRevision(revision: TaskRevision): Promise<void>;
  insertSealedBasisSet(basis: BasisSet): Promise<void>;
  updateTask(task: Task, expectedVersion: number): Promise<void>;
  insertLink(link: TaskDocumentLink): Promise<void>;
  insertImpact(impact: Impact): Promise<void>;
  resolveImpact(id: string, decisionId: string): Promise<void>;
  supersedeImpacts(taskId: string, documentId: string): Promise<void>;
  insertBasisDecision(decision: BasisDecision): Promise<void>;
  insertOperation(operation: Operation): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
}
export interface UnitOfWork {
  // One transaction/client, serializes commands per project; reads use a consistent snapshot.
  transaction<T>(projectId: string, action: (tx: Transaction) => Promise<T>): Promise<T>;
  read<T>(projectId: string, action: (reader: Reader) => Promise<T>): Promise<T>;
}
export interface Clock { now(): string }
export interface IdFactory { next(): string }
export interface ContentHasher { hash(value: string): string }
export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly currentVersion?: number) {
    super(message); this.name = "DomainError";
  }
}
