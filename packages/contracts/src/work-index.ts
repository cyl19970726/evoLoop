import { z } from "zod";
import type { DocumentKind, DocumentStatus, TaskKind, TaskState } from "./index.js";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const timestamp = z.iso.datetime({ offset: true });

export const leaderWorkPlanCommandSchema = z.strictObject({
  projectId: id,
  operationId: id,
  taskId: id,
  expectedTaskVersion: z.number().int().positive(),
  expectedPlanVersion: z.number().int().nonnegative(),
  plannedStartAt: timestamp.nullable(),
  dueAt: timestamp.nullable(),
  priority: z.number().int().min(1).max(4).nullable(),
  reason: note,
}).superRefine((value, ctx) => {
  if (value.plannedStartAt && value.dueAt && Date.parse(value.plannedStartAt) > Date.parse(value.dueAt))
    ctx.addIssue({ code: "custom", path: ["dueAt"], message: "dueAt must not precede plannedStartAt" });
});

export const leaderWorkDependenciesCommandSchema = z.strictObject({
  projectId: id,
  operationId: id,
  taskId: id,
  expectedTaskVersion: z.number().int().positive(),
  expectedDependencyVersion: z.number().int().nonnegative(),
  dependsOnTaskIds: z.array(id).max(100).refine(ids => new Set(ids).size === ids.length, "duplicate Task IDs"),
  reason: note,
});
export const leaderWorkReviewCommandSchema = z.strictObject({
  projectId: id,
  operationId: id,
  taskId: id,
  expectedTaskVersion: z.number().int().positive(),
  expectedTaskRevisionId: id,
  expectedWorkChangeSequence: z.number().int().nonnegative(),
  decision: z.enum(["acknowledged", "deferred"]),
  reason: note,
});
export type LeaderWorkPlanCommand = z.infer<typeof leaderWorkPlanCommandSchema>;
export type LeaderWorkDependenciesCommand = z.infer<typeof leaderWorkDependenciesCommandSchema>;
export type LeaderWorkReviewCommand = z.infer<typeof leaderWorkReviewCommandSchema>;

export type LeaderWorkPhase =
  | "unknown"
  | "rework"
  | "blocked"
  | "awaiting_delivery"
  | "awaiting_acceptance"
  | "ready"
  | "awaiting_assignment"
  | "running"
  | "unassigned"
  | "closed"
  | "cancelled";

export interface LeaderWorkDependency {
  taskId: string;
  title: string;
  state: TaskState;
  currentRevisionId: string;
  acceptanceSatisfied: boolean;
  actorId?: string | null;
  reason?: string | null;
  createdAt?: string | null;
}

export interface LeaderWorkAssignment {
  state: "assigned" | "accepted" | "released";
  targetKind: "owned" | "external";
  targetId: string;
  recipientActorId: string | null;
  /** The Task revision the assignment is fixed to. When it is not the Task's current revision the assignment must be
   * made again; older servers omit it, and then nothing is concluded. */
  taskRevisionId?: string;
}

export interface LeaderWorkRunFact {
  runId: string;
  state: "requested" | "dispatching" | "running" | "unknown" | "completed" | "failed" | "interrupted";
}

export interface LeaderWorkDeliveryFact {
  deliveryId: string;
  taskRevisionId: string;
  technicalResult: "passed" | "failed";
  consumer: string | null;
  useRequired: boolean;
  observationResult: "used" | "failed" | "notUsed" | null;
  observationActorId: string | null;
  observationKind: "human" | "agent" | null;
}

export type LeaderWorkTimingStage = "unassigned" | "awaiting_ack" | "awaiting_run" |
  "run_reserved" | "running" | "awaiting_submission" | "awaiting_delivery" |
  "awaiting_acceptance" | "awaiting_publication" | "rework" | "blocked" | "closed" | "cancelled" | "unknown";
export interface LeaderWorkTimingSource { kind: string; id: string }
export interface LeaderWorkWaitingFor {
  kind: "session" | "consumer" | "leader" | "role" | "publisher" | "user" | "task" | "unknown";
  id: string | null;
}
export interface LeaderWorkTimingInterval {
  stage: LeaderWorkTimingStage;
  startedAt: string | null;
  endedAt: string | null;
  source: LeaderWorkTimingSource | null;
  waitingFor: LeaderWorkWaitingFor;
}
/** Read-only Task timeline. Null times and unknown sources are gaps, never zero elapsed time. */
export interface LeaderWorkTaskTiming {
  /** Creation and entry to todo are one Task action; this does not assert code publication. */
  createdAt: string | null;
  publication: { at: string | null; source: "unknown" | "explicit" };
  /** May show an explicit publication wait after Task closure; closed round duration remains fixed. */
  current: LeaderWorkTimingInterval & { elapsedMs: number | null };
  rounds: Array<{
    number: number; startedAt: string | null; endedAt: string | null;
    elapsedMs: number | null; intervals: LeaderWorkTimingInterval[];
  }>;
  latestEffectiveProgress: { kind: string; sourceId: string; at: string } | null;
  /** Native current Turn activity, only when its source binds this exact Task and Run. */
  executionActivity: {
    runId: string; kind: "native_turn"; at: string; observedAt: string;
    freshness: "live" | "stale" | "unknown";
  } | null;
  observedAt: string;
}

/** One current Task projection. Facts remain authoritative in the Task and related records. */
export interface LeaderWorkTask {
  kind: "task";
  taskId: string;
  version: number;
  currentRevisionId: string;
  workChangeSequence: number;
  title: string;
  taskKind: TaskKind | null;
  taskState: TaskState;
  phase: LeaderWorkPhase;
  nextAction: string;
  responsible: {
    kind: "role" | "session" | "consumer" | "leader" | "publisher" | "user" | "task" | "unknown";
    id: string | null;
    label: string;
  };
  assignment: LeaderWorkAssignment | null;
  /** The Task's declared acceptance convention (DEC-042); null when it declared nothing. `readiness` is null until a delivery exists. */
  acceptanceConvention?: {
    acceptanceTarget: "human" | "leader" | "business_session" | "named_agent" | null;
    acceptancePrecondition: "none" | "refresh" | "release" | "migration" | "config_restart" | null;
    readiness: "ready" | "waiting_precondition" | null;
    /** Set for `named_agent`: the business identity that accepts directly. */
    namedAgent: string | null;
  } | null;
  latestRun: LeaderWorkRunFact | null;
  delivery: LeaderWorkDeliveryFact | null;
  pendingImpactCount: number;
  queueHold: string | null;
  goal: { goalId: string; outcome: string } | null;
  stage: { stageId: string; deliverable: string } | null;
  plan: {
    plannedStartAt: string | null; dueAt: string | null; priority: number | null;
    version?: number; actorId?: string | null; updatedAt?: string | null;
  } | null;
  dependencies: LeaderWorkDependency[];
  dependencyVersion: number;
  review: {
    reviewId: string; decision: "acknowledged" | "deferred";
    actorId: string; reason: string; operationId: string; reviewedChangeSequence: number; at: string;
  } | null;
  dates: {
    createdAt: string;
    businessChangedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    observedAt: string;
  };
  /** Latest directly attributable business event. Never a rename of businessChangedAt. */
  latestProgress?: {
    sequence: number;
    entityKind: LeaderWorkChange["entityKind"];
    entityId: string;
    eventName: string;
    changedAt: string;
  } | null;
  timing: LeaderWorkTaskTiming;
  /** Stable identity for a reviewed action on this exact observed Task version. */
  actionKey: string;
}

export interface LeaderWorkDocumentReference {
  taskId: string;
  title: string;
  state: TaskState;
  relations: Array<"content" | "link" | "basis">;
}

/** A process Document's lifecycle projection, never a substitute for adopting a fixed revision. */
export interface LeaderWorkDocument {
  kind: "document";
  documentId: string;
  version: number;
  title: string;
  documentKind: DocumentKind | null;
  status: DocumentStatus;
  currentRevisionId: string;
  adoptedRevisionId: string | null;
  nextAction: string;
  dates: {
    createdAt: string;
    currentRevisionAt: string;
    adoptedAt: string | null;
    changedAt: string | null;
    observedAt: string;
  };
  references: LeaderWorkDocumentReference[];
  actionKey: string;
}

export interface LeaderWorkChange {
  sequence: number;
  entityKind: "task" | "document" | "assignment" | "delivery" | "observation" |
    "closure" | "run" | "submission" | "impact" | "queue" | "plan" | "dependency" | "review";
  entityId: string;
  taskId: string | null;
  documentId: string | null;
  version: number | null;
  changedAt: string;
}

export interface LeaderWorkPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
  counts: Record<string, number>;
  changeSequence: number;
  observedAt: string;
  partial: boolean;
}

export interface LeaderWorkChangesPage {
  items: LeaderWorkChange[];
  nextCursor: string | null;
  changeSequence: number;
  observedAt: string;
}
