import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const short = z.string().trim().min(1).max(240);
const common = { projectId: id, operationId: id, roleId: id };
const evidence = z.strictObject({ kind: z.enum(["backlog", "omission", "rework", "effect", "cost"]), observation: text, sourceRef: text, observedAtUtc: z.iso.datetime() });
const alternative = z.strictObject({ kind: z.enum(["method", "knowledge", "another-instance", "temporary-assignment"]), assessment: text, estimatedCost: text });
export const roleProposalSchema = z.strictObject({
  title: short, goal: text, independentResponsibility: text, ownerScope: text,
  inputs: z.array(text).min(1).max(20), writableAssets: z.array(text).max(20), deliverables: z.array(text).min(1).max(20),
  triggers: z.array(text).min(1).max(20), workflow: text, handoffBoundary: text,
  evidence: z.array(evidence).min(1).max(40), alternatives: z.array(alternative).min(4).max(4),
  firstTaskId: id, baseline: text, expectedEffect: text, costLimit: text,
  trialDays: z.number().int().min(1).max(90), reviewAtUtc: z.iso.datetime(), exitCriteria: text,
}).superRefine((value, context) => {
  const kinds = new Set(value.alternatives.map(item => item.kind));
  if (kinds.size !== 4) context.addIssue({ code: "custom", message: "all four alternative categories must be assessed", path: ["alternatives"] });
  const observations = new Set(value.evidence.map(item => item.kind));
  if (!["backlog", "omission", "rework"].some(kind => observations.has(kind as "backlog" | "omission" | "rework")) || !observations.has("effect") || !observations.has("cost"))
    context.addIssue({ code: "custom", message: "proposal needs a responsibility gap, observed effect, and cost evidence", path: ["evidence"] });
});
export type RoleProposal = z.infer<typeof roleProposalSchema>;

export const roleCommands = [
  z.strictObject({ ...common, type: z.literal("role.propose"), proposal: roleProposalSchema }),
  z.strictObject({ ...common, type: z.literal("role.decide"), expectedVersion: z.number().int().positive(), decision: z.enum(["accept-trial", "reject", "defer"]), reason: text }),
  z.strictObject({ ...common, type: z.literal("role.review"), expectedVersion: z.number().int().positive(), decision: z.enum(["continue-trial", "activate", "merge", "retire"]), effectEvidence: text, effectEvidenceRefs: z.array(text).min(1).max(20), costEvidence: text, costEvidenceRefs: z.array(text).min(1).max(20), baselineComparison: text, reason: text, nextReviewAtUtc: z.iso.datetime().optional(), mergeTargetRoleId: id.optional() }),
  z.strictObject({ ...common, type: z.literal("role.handoff"), expectedVersion: z.number().int().positive(), handoffId: id, kind: z.enum(["task", "knowledge", "session"]), sourceRef: text, targetRoleId: id, observedTaskVersion: z.number().int().positive().optional(), note: text }),
  z.strictObject({ ...common, type: z.literal("role.ackHandoff"), expectedVersion: z.number().int().positive(), handoffId: id, note: text }),
  z.strictObject({ ...common, type: z.literal("role.bindSession"), expectedVersion: z.number().int().positive(), sessionId: id, note: text }),
  z.strictObject({ ...common, type: z.literal("role.retire"), expectedVersion: z.number().int().positive(), reason: text, knowledgeDisposition: text, runtimeDisposition: text }),
] as const;
export const roleCommandSchema = z.discriminatedUnion("type", roleCommands);
export type RoleCommand = z.infer<typeof roleCommandSchema>;
export type RoleState = "candidate" | "trial" | "active" | "retirement-pending" | "retired" | "rejected" | "deferred";
export interface RoleRecord { projectId: string; id: string; version: number; currentRevisionId: string; state: RoleState; proposal: RoleProposal; proposedBy: string; createdAtUtc: string; trialStartedAtUtc: string | null; reviewAtUtc: string; mergeTargetRoleId: string | null }
export interface RoleRevision { projectId: string; roleId: string; id: string; version: number; state: RoleState; proposal: RoleProposal; actorId: string; reason: string; createdAtUtc: string; reviewAtUtc: string; mergeTargetRoleId: string | null }
export interface RoleDecision { projectId: string; id: string; roleId: string; revisionId: string; decision: "accept-trial" | "reject" | "defer"; actorId: string; reason: string; createdAtUtc: string }
export interface RoleTrialReview { projectId: string; id: string; roleId: string; revisionId: string; decision: "continue-trial" | "activate" | "merge" | "retire"; effectEvidence: string; effectEvidenceRefs: string[]; costEvidence: string; costEvidenceRefs: string[]; baselineComparison: string; actorId: string; reason: string; createdAtUtc: string }
export interface RoleHandoff { projectId: string; id: string; roleId: string; kind: "task" | "knowledge" | "session"; sourceRef: string; targetRoleId: string; observedTaskVersion: number | null; state: "prepared" | "acknowledged"; preparedAtUtc: string; acknowledgedAtUtc: string | null }
export interface RoleHandoffEvent { projectId: string; id: string; handoffId: string; roleId: string; state: "prepared" | "acknowledged"; actorId: string; note: string; createdAtUtc: string }
export interface RoleSessionBinding { projectId: string; id: string; roleId: string; sessionId: string; roleRevisionId: string; actorId: string; note: string; createdAtUtc: string }
export interface RoleTaskSnapshot { id: string; owner: string; version: number; state: string }
export interface RoleRuntimeSessionSnapshot { id: string; roleId: string; state: string; nativeThreadId: string | null }
export interface RoleTransaction {
  getRole(roleId: string): Promise<RoleRecord | null>;
  createRole(record: RoleRecord, revision: RoleRevision): Promise<void>;
  advanceRole(record: RoleRecord, expectedVersion: number, revision: RoleRevision): Promise<void>;
  addDecision(value: RoleDecision): Promise<void>;
  addReview(value: RoleTrialReview): Promise<void>;
  getHandoff(handoffId: string): Promise<RoleHandoff | null>;
  addHandoff(value: RoleHandoff, event: RoleHandoffEvent): Promise<void>;
  acknowledgeHandoff(value: RoleHandoff, event: RoleHandoffEvent): Promise<void>;
  listUnacknowledgedHandoffs(roleId: string): Promise<RoleHandoff[]>;
  getTask(taskId: string): Promise<RoleTaskSnapshot | null>;
  listUnfinishedOwnedTasks(roleId: string): Promise<RoleTaskSnapshot[]>;
  getRuntimeSession(sessionId: string): Promise<RoleRuntimeSessionSnapshot | null>;
  listOpenRuntimeSessions(roleId: string): Promise<RoleRuntimeSessionSnapshot[]>;
  addSessionBinding(value: RoleSessionBinding): Promise<void>;
}
export interface RoleReader {
  getRole(roleId: string): Promise<RoleRecord | null>;
  listRoles(limit?: number, afterRoleId?: string): Promise<{ items: RoleRecord[]; nextCursor: string | null }>;
  listRevisions(roleId: string): Promise<RoleRevision[]>;
  listReviews(roleId: string): Promise<RoleTrialReview[]>;
  listHandoffs(roleId: string): Promise<RoleHandoff[]>;
  listSessionBindings(roleId: string): Promise<RoleSessionBinding[]>;
}
