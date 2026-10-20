import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const title = z.string().trim().min(1).max(240);
const version = z.number().int().positive();
const common = { projectId: id, operationId: id };
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
    type: z.literal("task.judge"),
    taskId: id,
    expectedVersion: version,
    decision: z.enum(["approve", "needsEvidence", "defer", "reject"]),
    reason: text,
    evidence: text,
    relookCondition: text.optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.revise"),
    taskId: id,
    expectedVersion: version,
    title,
    goal: text,
    acceptance: text,
    owner: text,
    documentIds: z.array(id).max(20),
    evidence: text,
    reason: text,
    stopCondition: text.optional(),
    consumer: text.optional(),
    useRequired: z.boolean().optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.start"),
    taskId: id,
    expectedVersion: version,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.block"),
    taskId: id,
    expectedVersion: version,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.defer"),
    taskId: id,
    expectedVersion: version,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.resume"),
    taskId: id,
    expectedVersion: version,
    target: z.enum(["ready", "active"]),
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("task.cancel"),
    taskId: id,
    expectedVersion: version,
    reason: text,
  }),
  z.strictObject({
    ...common,
    type: z.literal("delivery.record"),
    taskId: id,
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
    deliveryId: id,
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
export interface TaskProposal {
  projectId: string;
  taskId: string;
  taskRevisionId: string;
  stageId: string | null;
  consumer: string;
  useRequired: boolean;
  evidence: string;
  stopCondition: string;
  createdAt: string;
}
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
  deliveryId: string;
  acceptanceResult: "met";
  acceptanceEvidence: string;
  reason: string;
  actorId: string;
  createdAt: string;
}
