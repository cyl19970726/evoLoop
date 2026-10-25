import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const short = z.string().trim().min(1).max(240);
const version = z.number().int().positive();
const fixed = z.strictObject({ id, version });
const documentBasis = z.strictObject({ documentId: id, revisionId: id });
const common = { projectId: id, operationId: id, discussionId: id };
const documentRef = z.strictObject({ documentId: id, revisionId: id });
const taskMessageKind = z.enum(["question", "answer", "progress", "blocker", "handoff", "result"]);
const actionType = z.enum(["worktree.write", "git.commit", "git.push", "pr.create", "pr.review", "pr.merge", "deployment"]);
const actionScope = z.strictObject({ repository: short, worktree: z.string().min(1).max(1024).regex(/^\//),
  paths: z.array(z.string().trim().min(1).max(1024).refine(path =>
    !path.startsWith("/") && !path.split("/").includes("..") && !/[?*]/.test(path),
  "Exact repository-relative path required")).min(1).max(100), commit: short.optional(), pullRequest: short.optional() });
const actionRequest = z.strictObject({ requestId: id, executorActorId: short, actionType, scope: actionScope,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), reason: text, authorityEvidence: text,
  expiresAt: z.iso.datetime({ offset: true }), acceptance: text });
export const taskCollaborationCommands = [
  z.strictObject({ ...common, type: z.literal("discussion.openTask"), documentId: id, title: short,
    task: z.strictObject({ id, revisionId: id }), runId: id, sessionId: id, recipientActorId: short }),
  z.strictObject({ ...common, type: z.literal("discussion.message.post"), expectedVersion: version,
    kind: taskMessageKind, recipientActorId: short, body: documentRef, replyToEventId: id.optional() }),
  z.strictObject({ ...common, type: z.literal("discussion.receipt.record"), expectedVersion: version,
    messageEventId: id, stage: z.enum(["received", "read", "adopted", "resolved"]),
    evidence: documentRef,
    continuation: z.strictObject({ runId: id, taskRevisionId: id }).optional() }),
  z.strictObject({ ...common, type: z.literal("discussion.action.request"), expectedVersion: version,
    ...actionRequest.shape, detail: documentRef }),
  z.strictObject({ ...common, type: z.literal("discussion.action.decide"), expectedVersion: version,
    requestEventId: id, decision: z.enum(["approved", "rejected", "expired"]), evidence: documentRef }),
  z.strictObject({ ...common, type: z.literal("discussion.action.execute"), expectedVersion: version,
    requestEventId: id, decisionEventId: id, state: z.enum(["started", "succeeded", "failed", "unknown"]),
    externalOperationId: id, artifact: documentRef }),
] as const;
export type TaskCollaborationCommand = z.infer<(typeof taskCollaborationCommands)[number]>;
export const discussionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), id, revisionId: id }),
  z.strictObject({ kind: z.literal("stage"), id, version }),
  z.strictObject({ kind: z.literal("role"), id, revisionId: id }),
  z.strictObject({ kind: z.literal("document"), id, revisionId: id }),
]);
export type DiscussionTarget = z.infer<typeof discussionTargetSchema>;
export const discussionCommands = [
  z.strictObject({ ...common, type: z.literal("discussion.prepare"), documentId: id,
    kind: z.enum(["allocation", "direction"]), title: short,
    body: z.string().max(65536).default(""), goal: fixed, stage: fixed.optional(),
    task: z.strictObject({ id, revisionId: id }).optional(),
    adoptedDocuments: z.array(documentBasis).max(20).default([]), question: text,
    options: z.array(text).min(1).max(10), authorizationBoundary: text,
    targetSessionLabel: short, targetSessionRef: short.optional() }),
  z.strictObject({ ...common, type: z.literal("discussion.handoff.record"),
    expectedVersion: version, documentRevisionId: id, evidence: text, reason: text }),
  z.strictObject({ ...common, type: z.literal("discussion.decision.record"),
    expectedVersion: version, documentRevisionId: id, choice: text, reason: text,
    unresolved: text, relookCondition: text, evidence: text,
    documentRecovery: z.strictObject({ expectedDocumentVersion: version, reason: text }).optional(),
    supersedesDecisionEventId: id.optional() }),
  z.strictObject({ ...common, type: z.literal("discussion.action.link"),
    expectedVersion: version, decisionEventId: id, target: discussionTargetSchema, reason: text }),
] as const;
export type DiscussionCommand = z.infer<(typeof discussionCommands)[number]>;
export type DiscussionStatus = "prepared" | "handed_off" | "decided" | "linked";
export interface DiscussionRecord {
  projectId: string; id: string; version: number; kind: "allocation" | "direction" | "task_collaboration";
  status: DiscussionStatus; documentId: string; preparedDocumentRevisionId: string;
  currentDocumentRevisionId: string; latestDecisionEventId: string | null;
  goal: { id: string; version: number } | null; stage: { id: string; version: number } | null;
  task: { id: string; revisionId: string } | null;
  adoptedDocuments: Array<{ documentId: string; revisionId: string }>;
  question: string; options: string[]; authorizationBoundary: string;
  targetSessionLabel: string; targetSessionRef: string | null;
  actorId: string; createdAt: string; updatedAt: string;
  collaboration?: { runId: string; sessionId: string; issuerActorId: string; recipientActorId: string } | null;
}
export type TaskCollaborationPayload =
  | { type: "message"; kind: z.infer<typeof taskMessageKind>; recipientActorId: string; body: z.infer<typeof documentRef>; replyToEventId: string | null }
  | { type: "receipt"; messageEventId: string; stage: "received" | "read" | "adopted" | "resolved";
    evidence: z.infer<typeof documentRef>; continuation: { runId: string; taskRevisionId: string } | null }
  | ({ type: "action_request"; detail: z.infer<typeof documentRef> } & z.infer<typeof actionRequest>)
  | { type: "action_decision"; requestEventId: string; decision: "approved" | "rejected" | "expired"; evidence: z.infer<typeof documentRef> }
  | { type: "action_execution"; requestEventId: string; decisionEventId: string; state: "started" | "succeeded" | "failed" | "unknown"; externalOperationId: string; artifact: z.infer<typeof documentRef> };
export interface DiscussionEvent {
  projectId: string; id: string; discussionId: string; version: number;
  kind: "prepared" | "handoff" | "decision" | "action" | "message" | "receipt" | "action_request" | "action_decision" | "action_execution";
  documentRevisionId: string | null; actorId: string; createdAt: string;
  evidence: string | null; reason: string | null;
  choice: string | null; unresolved: string | null; relookCondition: string | null;
  supersedesDecisionEventId: string | null; decisionEventId: string | null;
  target: DiscussionTarget | null;
  collaborationPayload?: TaskCollaborationPayload | null;
}
