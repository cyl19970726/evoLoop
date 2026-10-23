import { z } from "zod";
import type { Page } from "./index.js";

const id = z.uuid();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const note = z.string().trim().min(1).max(4000);
const version = z.number().int().positive();
const fixedRef = z.strictObject({ kind: z.enum(["document", "git", "wiki", "delivery", "evidence"]),
  id: z.string().min(1).max(512), revision: z.string().min(1).max(512), contentHash: sha });
export type EvaluationFixedRef = z.infer<typeof fixedRef>;
const nextActionRef = z.union([fixedRef, z.strictObject({ kind: z.literal("task"), taskId: id, taskRevisionId: id })]);
export type EvaluationNextActionRef = z.infer<typeof nextActionRef>;
const sourceSignature = z.strictObject({ title: note, contentDocumentId: id, contentRevisionId: id,
  acceptance: note, owner: note, kind: note, basis: z.array(z.strictObject({ documentId: id, revisionId: id, contentHash: sha })).min(1).max(20),
  retentions: z.array(z.strictObject({ documentId: id, revisionId: id, observedAdoptedRevisionId: id,
    reason: note, actorId: note, createdAt: z.string().min(1) })).max(19),
  external: z.array(z.strictObject({ slotId: id, kind: z.enum(["git", "wiki", "run"]), referenceId: z.string().min(1).max(512),
    revision: z.string().min(1).max(512), contentHash: sha })).max(100) });
export type EvaluationSourceSignature = z.infer<typeof sourceSignature>;
const environment = z.strictObject({ cwd: z.string().min(1).max(1024).regex(/^\//), authorizationScope: note,
  sandbox: z.enum(["read-only", "workspace-write"]), approvalPolicy: z.enum(["on-request", "untrusted"]) });
const condition = z.strictObject({ id, kind: z.enum(["direct", "wiki"]), wikiRefs: z.array(fixedRef).min(1).max(20).nullable(),
  model: note, environment });
export type EvaluationCondition = z.infer<typeof condition>;
const evaluationCase = z.strictObject({ id, taskId: id, sourceTaskRevisionId: id, sourceSignature,
  commonInput: note, materials: z.array(fixedRef).min(1).max(20), criteria: note });
export type EvaluationCase = z.infer<typeof evaluationCase>;
const definition = z.strictObject({ ownerTaskId: id, question: note, protocol: fixedRef,
  case: evaluationCase, conditions: z.tuple([condition, condition]), limits: note });
export type EvaluationDefinition = z.infer<typeof definition>;
const cost = z.strictObject({ phase: note, unit: note, amount: z.number().finite().nonnegative().nullable(),
  source: note, evidence: fixedRef.nullable() });
export type EvaluationCost = z.infer<typeof cost>;
const assessmentValues = z.strictObject({ sourceFidelity: z.enum(["qualified", "failed", "unknown", "needs_review"]),
  knowledgeAdoption: z.enum(["correct", "misused", "not_used", "not_observed", "not_applicable", "needs_review"]),
  deliveryQuality: z.enum(["qualified", "failed", "unknown", "needs_review"]),
  humanEffect: z.enum(["observed", "unknown", "needs_review"]) });
export type EvaluationAssessmentValues = z.infer<typeof assessmentValues>;
const common = { projectId: id, operationId: id, evaluationId: id };
export const evaluationCommands = [
  z.strictObject({ ...common, type: z.literal("evaluation.create"), revisionId: id, definition }),
  z.strictObject({ ...common, type: z.literal("evaluation.revise"), expectedVersion: version, revisionId: id, definition, reason: note }),
  z.strictObject({ ...common, type: z.literal("evaluation.assessment.record"), revisionId: id, assessmentId: id,
    attemptId: id, deliveryId: id.nullable(), observationId: id.nullable(), supersedesId: id.nullable(),
    values: assessmentValues, costs: z.array(cost).max(50), evidence: z.array(fixedRef).max(50),
    assessorKind: z.enum(["human", "agent"]), reason: note }),
  z.strictObject({ ...common, type: z.literal("evaluation.conclusion.record"), revisionId: id, conclusionId: id,
    assessmentIds: z.array(id).min(1).max(200), supersedesId: id.nullable(),
    finding: note, limits: note, comparability: z.enum(["comparable", "with_limits", "unknown"]),
    comparabilityReason: note, nextChoice: z.enum(["read_direct", "adopt_with_limits", "maintain", "research", "wait", "stop"]),
    affectedRefs: z.array(fixedRef).max(50), nextActionRef: nextActionRef.nullable() }),
] as const;
export type EvaluationCommand = z.infer<(typeof evaluationCommands)[number]>;
export interface EvaluationRevision { projectId: string; evaluationId: string; id: string; version: number;
  definition: EvaluationDefinition; actorId: string; reason: string; createdAt: string }
export interface EvaluationAttempt { projectId: string; id: string; evaluationId: string; revisionId: string;
  caseId: string; conditionId: string; ordinal: number; runId: string; sourceTaskRevisionId: string;
  actualTaskRevisionId: string; sessionId: string; actorId: string; createdAt: string }
export interface EvaluationAssessment { projectId: string; id: string; evaluationId: string; revisionId: string;
  attemptId: string; deliveryId: string | null; observationId: string | null; supersedesId: string | null;
  values: EvaluationAssessmentValues; costs: EvaluationCost[]; evidence: EvaluationFixedRef[];
  assessorKind: "human" | "agent"; actorId: string; reason: string; createdAt: string }
export interface EvaluationConclusion { projectId: string; id: string; evaluationId: string; revisionId: string;
  assessmentIds: string[]; supersedesId: string | null; finding: string; limits: string;
  comparability: "comparable" | "with_limits" | "unknown"; comparabilityReason: string;
  nextChoice: "read_direct" | "adopt_with_limits" | "maintain" | "research" | "wait" | "stop";
  affectedRefs: EvaluationFixedRef[]; nextActionRef: EvaluationNextActionRef | null; actorId: string; createdAt: string }
export interface EvaluationReader {
  getEvaluation(id: string, revisionId?: string): Promise<EvaluationRevision | null>;
  listEvaluations(limit: number, cursor?: string, taskId?: string, knowledgePageId?: string): Promise<Page<EvaluationRevision>>;
  listEvaluationRevisions(id: string): Promise<EvaluationRevision[]>;
  listEvaluationAttempts(id: string, revisionId: string): Promise<EvaluationAttempt[]>;
  listEvaluationAssessments(id: string, revisionId: string): Promise<EvaluationAssessment[]>;
  listEvaluationConclusions(id: string, revisionId: string): Promise<EvaluationConclusion[]>;
}
export interface EvaluationTransaction extends EvaluationReader {
  insertEvaluationRevision(value: EvaluationRevision): Promise<void>;
  insertEvaluationAttempt(value: EvaluationAttempt): Promise<void>;
  insertEvaluationAssessment(value: EvaluationAssessment): Promise<void>;
  insertEvaluationConclusion(value: EvaluationConclusion): Promise<void>;
}
