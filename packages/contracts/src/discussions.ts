import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const short = z.string().trim().min(1).max(240);
const version = z.number().int().positive();
const fixed = z.strictObject({ id, version });
const documentBasis = z.strictObject({ documentId: id, revisionId: id });
export const discussionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("task"), id, revisionId: id }),
  z.strictObject({ kind: z.literal("stage"), id, version }),
  z.strictObject({ kind: z.literal("role"), id, revisionId: id }),
  z.strictObject({ kind: z.literal("document"), id, revisionId: id }),
]);
export type DiscussionTarget = z.infer<typeof discussionTargetSchema>;
const common = { projectId: id, operationId: id, discussionId: id };
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
  projectId: string; id: string; version: number; kind: "allocation" | "direction";
  status: DiscussionStatus; documentId: string; preparedDocumentRevisionId: string;
  currentDocumentRevisionId: string; latestDecisionEventId: string | null;
  goal: { id: string; version: number }; stage: { id: string; version: number } | null;
  task: { id: string; revisionId: string } | null;
  adoptedDocuments: Array<{ documentId: string; revisionId: string }>;
  question: string; options: string[]; authorizationBoundary: string;
  targetSessionLabel: string; targetSessionRef: string | null;
  actorId: string; createdAt: string; updatedAt: string;
}
export interface DiscussionEvent {
  projectId: string; id: string; discussionId: string; version: number;
  kind: "prepared" | "handoff" | "decision" | "action";
  documentRevisionId: string | null; actorId: string; createdAt: string;
  evidence: string | null; reason: string | null;
  choice: string | null; unresolved: string | null; relookCondition: string | null;
  supersedesDecisionEventId: string | null; decisionEventId: string | null;
  target: DiscussionTarget | null;
}
