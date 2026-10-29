import { z } from "zod";
import { workflowCommands } from "./workflow.js";
import { runtimeCommands } from "./runtime.js";
import { roleCommands } from "./roles.js";
import { scheduleCommands } from "./scheduling.js";
import { discussionCommands } from "./discussions.js";
import { taskCollaborationCommands } from "./discussions.js";
import { queueCommandSchema } from "./queues.js";
import { evaluationCommands } from "./evaluation.js";
import { residentCommands } from "./resident-hosts.js";
import { sessionMessageCommands } from "./session-messages.js";
import { sessionAssignmentCommands } from "./session-assignments.js";
import { sessionRecoveryCommands } from "./session-recovery.js";
import { nativeInputReplyCommand } from "./native-input.js";
export type { NativeInputCapture, NativeInputEvent, NativeInputQuestion, NativeInputRecord, NativeInputResponse, NativeInputSource } from "./native-input.js";
export type { ExecutionProfileSnapshot, ExecutionProfileRevision, SessionExecutionProfile, SessionRecoveryGate, SessionRecoveryDecision, SessionRecoveryView } from "./session-recovery.js";
export type { EvaluationRevision, EvaluationAttempt, EvaluationAssessment, EvaluationConclusion, EvaluationDefinition, EvaluationFixedRef, EvaluationNextActionRef, EvaluationSourceSignature, EvaluationCondition, EvaluationCase, EvaluationCost } from "./evaluation.js";
export type { RuntimeSessionRecord, RuntimeRunRecord, RuntimeRecordEvent, RuntimeRunState, RuntimeSessionState } from "./runtime.js";
export type { Goal, GoalRevision, Stage, StageRevision, StageReview, TaskProposal, TaskJudgement, Delivery, ConsumerObservation, TaskClosure, AcceptanceMode } from "./workflow.js";
export type { DiscussionRecord, DiscussionEvent, DiscussionTarget, DiscussionStatus } from "./discussions.js";
export type { ResidentQueue, ResidentQueueEntry, QueueClaim, QueueAttempt } from "./queues.js";

export const idSchema = z.uuid();
const text = z.string().trim().min(1).max(4000);
const declaredConsumer = text.optional().describe("Exact-match declared consumer identifier. For an Agent, use the actual principal.actorId that will personally sign the observation; do not use a roleId, display name, or explanation. Put explanation in evidence or reason.");
const consumerUseRequired = z.boolean().optional().describe("When true, also declare consumer. Task.close requires the latest observation by the declared consumer for the current Delivery to have result=used. Worker completion, a Delivery alone, or use by another actor does not satisfy this.");
const acceptanceMode = z.enum(["independent_agent", "human_required"]).optional();
const title = z.string().trim().min(1).max(240);
const version = z.number().int().positive();
const common = { projectId: idSchema, operationId: idSchema };
export const documentBasisSchema = z.strictObject({ documentId: idSchema, revisionId: idSchema });
export type DocumentBasis = z.infer<typeof documentBasisSchema>;
const basisSchema = z.array(documentBasisSchema).min(1).max(20);
export const taskKindSchema = z.enum(["implementation", "research", "validation"]);
export const documentKindSchema = z.enum(["task", "issue", "spec", "discussion", "report"]);
export const documentOriginSchema = z.strictObject({ taskId: idSchema, runId: idSchema.optional() });
// Only the implemented command surface is exported; a missing integration is not a no-op command.
export const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("project.create"), title }),
  z.strictObject({ ...common, type: z.literal("document.create"), documentId: idSchema, title, body: z.string().min(1).max(65536), kind: documentKindSchema.nullable().optional(), origin: documentOriginSchema.optional() }),
  z.strictObject({ ...common, type: z.literal("document.revise"), documentId: idSchema, expectedVersion: version, body: z.string().min(1).max(65536), reason: text }),
  z.strictObject({ ...common, type: z.literal("document.adopt"), documentId: idSchema, expectedVersion: version, revisionId: idSchema, reason: text }),
  z.strictObject({ ...common, type: z.literal("document.publish"), documentId: idSchema, expectedVersion: version, revisionId: idSchema, reason: text }),
  z.strictObject({ ...common, type: z.literal("document.archive"), documentId: idSchema, expectedVersion: version, reason: text }),
  z.strictObject({ ...common, type: z.literal("document.restore"), documentId: idSchema, expectedVersion: version, reason: text }),
  z.strictObject({ ...common, type: z.literal("task.create"), taskId: idSchema, title, content: z.string().min(1).max(65536), acceptance: text, owner: text, kind: taskKindSchema.nullable().optional(), domainId: idSchema.nullable().optional(), documentIds: z.array(idSchema).max(20).optional(), stageId: idSchema.optional(), consumer: declaredConsumer, useRequired: consumerUseRequired, acceptanceMode, evidence: text.optional(), stopCondition: text.optional() }),
  z.strictObject({ ...common, type: z.literal("task.update"), taskId: idSchema, expectedVersion: version, title, content: z.string().min(1).max(65536), acceptance: text, owner: text, kind: taskKindSchema.nullable().optional(), domainId: idSchema.nullable().optional(), documentIds: z.array(idSchema).max(20).optional(), stageId: idSchema.nullable().optional(), consumer: declaredConsumer.nullable(), useRequired: consumerUseRequired, acceptanceMode, evidence: text.optional(), stopCondition: text.optional(), reason: text,
    basis: z.array(z.strictObject({ documentId: idSchema, revisionId: idSchema })).max(19).optional(),
    retentions: z.array(z.strictObject({ documentId: idSchema, revisionId: idSchema,
      observedAdoptedRevisionId: idSchema, reason: text })).max(19).optional() }),
  z.strictObject({ ...common, type: z.literal("task.reviewBasis"), taskId: idSchema, expectedVersion: version, impactId: idSchema, decision: z.enum(["adopt", "retain"]), reason: text, acceptance: text.optional() }),
  ...workflowCommands,
  ...runtimeCommands,
  ...roleCommands,
  ...residentCommands,
  ...sessionMessageCommands,
  ...sessionAssignmentCommands,
  ...sessionRecoveryCommands,
  nativeInputReplyCommand,
  ...scheduleCommands,
  ...discussionCommands,
  ...taskCollaborationCommands,
  ...queueCommandSchema.options,
  ...evaluationCommands,
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandInput = z.input<typeof commandSchema>;
export type LeaderWorkRequestType = "work.plan.set" | "work.dependencies.set" | "work.review.set";
export type Permission = "read" | "write" | "review";
export interface Principal { actorId: string; projectIds: string[]; permissions: Permission[]; identityKind?: "agent" | "human" | undefined }
export interface Project { id: string; title: string; createdAt: string }
export interface Document {
  projectId: string; id: string; title: string; version: number;
  currentRevisionId: string; adoptedRevisionId: string | null; kind: DocumentKind | null; status: DocumentStatus;
  primaryTaskId?: string | null;
  origin?: { taskId: string; runId: string | null; taskRevisionId: string } | null;
}
export type DocumentKind = "task" | "issue" | "spec" | "discussion" | "report";
export type DocumentStatus = "draft" | "published" | "archived";
export interface DocumentRevision {
  projectId: string; documentId: string; id: string; body: string | null; format: "markdown" | "html";
  mediaType: "text/markdown" | "text/html"; originalName: string; payloadRef: string | null;
  entrypoint: string | null; assetsManifest: import("./process-documents.js").DocumentAsset[];
  contentHash: string; author: string; createdAt: string; previousRevisionId: string | null; reason: string;
}
export interface DocumentDecision {
  projectId: string; id: string; documentId: string; revisionId: string;
  actorId: string; reason: string; createdAt: string;
}
export type TaskState = "todo" | "in_progress" | "done" | "cancelled";
export type TaskRevisionState = TaskState | "proposed" | "ready" | "active" | "review" | "blocked" | "deferred";
export type TaskKind = "implementation" | "research" | "validation";
export interface LegacyTaskDecision {
  state: Exclude<TaskRevisionState, TaskState>;
  decision: "approve" | "needsEvidence" | "defer" | "reject" | null;
  reason: string;
}
export interface Task {
  projectId: string; id: string; version: number; currentRevisionId: string;
  title: string; content: string; contentDocumentId: string; contentRevisionId: string; kind: TaskKind | null; domainId?: string | null;
  acceptance: string; owner: string; state: TaskState;
  legacyDecision?: LegacyTaskDecision | null;
}
export interface TaskRevision {
  projectId: string; taskId: string; id: string; version: number;
  title: string; content: string; contentDocumentId: string; contentRevisionId: string; kind: TaskKind | null; domainId?: string | null;
  acceptance: string; owner: string; state: TaskRevisionState;
  basisSetId: string | null; actorId: string; reason: string; createdAt: string;
}
export interface BasisSet {
  projectId: string; taskId: string; taskRevisionId: string; id: string;
  members: DocumentBasis[]; sealed: true;
  retentions?: BasisRetention[];
}
export interface BasisRetention {
  documentId: string; revisionId: string; observedAdoptedRevisionId: string;
  reason: string; actorId: string; createdAt: string;
}
export interface TaskDocumentLink {
  projectId: string; id: string; taskId: string; documentId: string; actorId: string; createdAt: string;
}
export interface Impact {
  projectId: string; id: string; taskId: string; taskRevisionId: string;
  documentId: string; fromRevisionId: string; toRevisionId: string;
  state: "pending" | "resolved" | "superseded"; decisionId: string | null; createdAt: string;
}
export interface BasisDecision {
  projectId: string; id: string; impactId: string; taskId: string;
  previousTaskRevisionId: string; nextTaskRevisionId: string;
  decision: "adopt" | "retain"; reason: string; actorId: string; createdAt: string;
}
export interface AppliedResult {
  status: "applied"; operationId: string; entityId: string; version?: number;
  revisionId?: string; decisionId?: string; impactIds?: string[];
  queue?: { claimId: string | null; runId: string | null; held: import("./queues.js").QueueHoldCode | null };
}
export interface RejectedResult {
  status: "rejected"; operationId: string; code: string; message: string; currentVersion?: number;
}
export type CommandResult = AppliedResult | RejectedResult;
export interface Operation {
  projectId: string; id: string; actorId: string; commandHash: string;
  commandType: Command["type"] | LeaderWorkRequestType |
    "document.payload" | "reference.git" | "reference.formal" | "reference.task";
  result: CommandResult; createdAt: string;
}
export interface OutboxEvent {
  projectId: string; id: string; operationId: string; effectKey: string;
  kind: string; entityId: string; version: number; createdAt: string;
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface DocumentTaskReference extends Pick<Task, "projectId" | "id" | "title" | "state" | "owner" | "kind" | "version" | "currentRevisionId"> {
  relations: Array<"content" | "link" | "basis">;
}
export interface TaskDetail { task: Task; revision: TaskRevision; basis: BasisSet | null; links: TaskDocumentLink[]; impacts: Impact[]; decisions: BasisDecision[]; proposal?: import("./workflow.js").TaskProposal | null; judgements?: import("./workflow.js").TaskJudgement[]; deliveries?: import("./workflow.js").Delivery[]; observations?: import("./workflow.js").ConsumerObservation[]; closures?: import("./workflow.js").TaskClosure[] }
export interface DocumentDetail { document: Document; current: DocumentRevision; adopted: DocumentRevision | null }
export const capabilities = { processMarkdown: true, basisReview: true, git: false, html: false, feishu: false, wiki: false, runtime: false } as const;
