import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const title = z.string().trim().min(1).max(240);
const version = z.number().int().positive();
const common = { projectId: id, operationId: id };
// Milestone fields of a stage (migration 118): a short name for one table row, a due date (calendar day, may be unset), how to check it, and which
// verification-ladder levels (M0, M0.5, M1, ...) it supplies evidence for.
const shortName = z.string().trim().min(1).max(40);
const dueOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "dueOn must be a real calendar date");
const ladderKeys = z.array(z.string().regex(/^M[0-9]+(?:\.[0-9]+)?$/)).max(10).refine(keys => new Set(keys).size === keys.length, "ladderKeys must be unique");
export const workflowCommands = [
  z.strictObject({
    ...common,
    type: z.literal("goal.create"),
    goalId: id,
    outcome: text,
    constraints: text,
    consumer: text,
    authority: text,
    scope: text,
    owner: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("goal.revise"),
    goalId: id,
    expectedVersion: version,
    outcome: text,
    constraints: text,
    consumer: text,
    authority: text,
    scope: text,
    owner: text,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("stage.propose"),
    stageId: id,
    goalId: id,
    deliverable: text,
    learningQuestion: text,
    // Required from migration 118: no stage is proposed without a table-row name and a way to check it.
    shortName,
    checkMethod: text,
    dueOn: dueOn.nullable().optional(),
    ladderKeys: ladderKeys.optional(),
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("stage.milestone.set"),
    stageId: id,
    // The milestone row's own optimistic version: 0 when the stage has no row yet, otherwise the version read back.
    expectedVersion: z.number().int().min(0),
    shortName,
    checkMethod: text,
    dueOn: dueOn.nullable(),
    ladderKeys,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("stage.phaseKey.set"),
    stageId: id,
    // Links the stage to a roadmap phase (M1, M0.5, …) for the overview's milestones; null clears the link. Review permission.
    phaseKey: z.string().regex(/^M[0-9]+(?:\.[0-9]+)?$/).nullable(),
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("stage.accept"),
    stageId: id,
    expectedVersion: version,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.start"),
    taskId: id,
    expectedVersion: version,
    reason: text,
    basis: z.array(z.strictObject({ documentId: id, revisionId: id })).max(19).optional(),
    retentions: z.array(z.strictObject({ documentId: id, revisionId: id,
      observedAdoptedRevisionId: id, reason: text })).max(19).optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.cancel"),
    taskId: id,
    expectedVersion: version,
    reason: text,
  }),
  z.strictObject({ ...common, type: z.literal("task.reopen"), taskId: id, expectedVersion: version, reason: text }),
  z.strictObject({
    ...common,
    type: z.literal("delivery.record"),
    taskId: id,
    runId: id.optional(),
    expectedVersion: version,
    artifactRef: text,
    artifactRevision: text,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/i),
    technicalResult: z.enum(["passed", "failed"]),
    technicalEvidence: text,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("observation.record"),
    taskId: id,
    deliveryId: id,
    observer: text,
    observerKind: z.enum(["human", "agent"]),
    result: z.enum(["used", "failed", "notUsed"]),
    evidence: text,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.close"),
    taskId: id,
    expectedVersion: version,
    deliveryId: id.optional(),
    decisionId: id.optional(),
    waitingInboxId: id.optional(),
    handoffDispatchId: id.optional(),
    acceptanceResult: z.enum(["met", "unmet"]),
    acceptanceEvidence: text,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("stage.review"),
    stageId: id,
    expectedVersion: version,
    adopted: text,
    rejected: text,
    gap: text,
    nextChoice: z.enum(["continue", "newTask", "research", "stop"]),
    evidence: text,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("stage.review.correct"),
    stageId: id,
    expectedVersion: version,
    supersedesReviewId: id,
    adopted: text,
    rejected: text,
    gap: text,
    nextChoice: z.enum(["continue", "newTask", "research", "stop"]),
    evidence: text,
    reason: text,
  }),
] as const;

export interface Goal {
  projectId: string;
  id: string;
  version: number;
  outcome: string;
  constraints: string;
  consumer: string;
  authority: string;
  scope: string;
  owner: string;
  createdAt: string;
  actorId: string;
}
export interface GoalRevision extends Goal {
  reason: string;
}
export interface Stage {
  projectId: string;
  id: string;
  goalId: string;
  version: number;
  deliverable: string;
  learningQuestion: string;
  state: "proposed" | "active" | "reviewed";
  createdAt: string;
  actorId: string;
}
/** The four milestone fields of a stage (side table `stage_milestone`; `project_stage` and its revisions are untouched). */
export interface StageMilestone {
  projectId: string;
  stageId: string;
  version: number;
  shortName: string | null;
  dueOn: string | null;
  checkMethod: string | null;
  ladderKeys: string[];
  actorId: string;
  reason: string;
  updatedAt: string;
}
/** A Task's stage ownership (side table `task_stage`): a stage, or an explicit "not part of any stage" with its reason. No row means unassigned. */
export interface TaskStageLink {
  projectId: string;
  taskId: string;
  version: number;
  stageId: string | null;
  noStageReason: string | null;
  actorId: string;
  reason: string;
  updatedAt: string;
}
export interface StageRevision {
  projectId: string;
  stageId: string;
  id: string;
  version: number;
  state: Stage["state"];
  deliverable: string;
  learningQuestion: string;
  actorId: string;
  reason: string;
  createdAt: string;
}
export interface StageReview {
  projectId: string;
  id: string;
  stageId: string;
  stageVersion: number;
  supersedesReviewId: string | null;
  adopted: string;
  rejected: string;
  gap: string;
  nextChoice: "continue" | "newTask" | "research" | "stop";
  evidence: string;
  reason: string;
  actorId: string;
  createdAt: string;
}
export type AcceptanceMode = "independent_agent" | "human_required";
export interface TaskProposal {
  projectId: string;
  taskId: string;
  taskRevisionId: string;
  stageId: string | null;
  consumer: string;
  useRequired: boolean;
  /** Null is the historical contract; new Tasks always set an explicit mode. */
  acceptanceMode?: AcceptanceMode | null;
  /** Explicitly permits Leader acceptance; historical null requires a concrete arrangement decision. */
  /** `named_agent`: the declared consumer (a business identity, not a managed Session) accepts directly; no relay is arranged. */
  acceptanceTarget?: "human" | "leader" | "business_session" | "named_agent" | null;
  /** What must happen before the delivery can be checked at its real entrance. Null: not declared. */
  acceptancePrecondition?: "none" | "refresh" | "release" | "migration" | "config_restart" | null;
  /**
   * When the Task may close (Task b5993311). `delivered`: a passed, used Delivery is enough (the behaviour before this field). `merged`: the PR the Delivery names must also be
   * merged into the main line, as the repository itself shows (`CompletionFacts`); the closer's own statement counts for nothing. Null: declared nothing (a Task made before
   * the field existed), which closes as `delivered`.
   */
  completionBoundary?: CompletionBoundary | null;
  evidence: string;
  stopCondition: string;
  createdAt: string;
}
export type CompletionBoundary = "delivered" | "merged";
/** What the repository says about the PR a Delivery names, read when a Task closes or is read back. Never taken from the closer. */
export type MergeFact =
  | { state: "merged"; mainCommit: string; via: "ancestor" | "merge_commit"; detail: string }
  | { state: "not_merged"; mainCommit: string | null; detail: string }
  | { state: "unreadable"; detail: string };
/**
 * What a Task reads back about its completion boundary: the declared boundary, and whether it is met now. `met` is true/false for `merged` (from the repository's own
 * answer, never the closer's), null where there is nothing to judge (`delivered`, or declared nothing). `reason` says why in words.
 */
export interface TaskCompletionView {
  boundary: CompletionBoundary | null;
  met: boolean | null;
  pullRequest: number | null;
  head: string | null;
  fact: MergeFact | null;
  reason: string;
}
/** The repository read behind the `merged` boundary; supplied by the host (the coordinator reads the project's registered repository). */
export type MergeFactReader = (input: { projectId: string; pullRequest: number; head: string }) => Promise<MergeFact>;
export interface TaskJudgement {
  projectId: string;
  id: string;
  taskId: string;
  taskRevisionId: string;
  decision: "approve" | "needsEvidence" | "defer" | "reject";
  reason: string;
  evidence: string;
  relookCondition: string | null;
  actorId: string;
  createdAt: string;
}
export interface Delivery {
  projectId: string;
  id: string;
  taskId: string;
  taskRevisionId: string;
  /** Explicitly declared source Run; null for deliveries registered without one. */
  runId: string | null;
  /** Terminal source Run version at recording; null for historical or Run-free Delivery. */
  sourceRunVersion?: number | null;
  /** Trusted submission signer. Null for historical or manually registered Run deliveries. */
  submittedByActorId?: string | null;
  artifactRef: string;
  artifactRevision: string;
  contentHash: string;
  technicalResult: "passed" | "failed";
  technicalEvidence: string;
  reason: string;
  actorId: string;
  createdAt: string;
}
export interface ConsumerObservation {
  projectId: string;
  id: string;
  taskId: string;
  deliveryId: string;
  observer: string;
  observerKind: "human" | "agent";
  result: "used" | "failed" | "notUsed";
  evidence: string;
  reason: string;
  actorId: string;
  createdAt: string;
}
export interface TaskClosure {
  projectId: string;
  id: string;
  taskId: string;
  taskRevisionId: string;
  deliveryId: string | null;
  decisionId: string | null;
  sourceInboxId: string | null;
  sourceEventId: string | null;
  sourceTaskId: string | null;
  waitingInboxId: string | null;
  handoffDispatchId: string | null;
  handoffTaskId: string | null;
  acceptanceResult: "met";
  acceptanceEvidence: string;
  reason: string;
  actorId: string;
  createdAt: string;
}
