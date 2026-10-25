/** Persistent queue state is deliberately separate from the Task lifecycle. */
export type QueueEntryState = "queued" | "held" | "claimed" | "released";
export type QueueHoldCode = "not_adopted" | "task_changed" | "task_unavailable" | "dependency" | "session_unready" | "binding_changed" | "grant_revoked" | "occupied" | "run_in_flight" | "unknown" | "awaiting_acceptance" | "manual_review";
export type QueueReleaseRule = "accepted" | "bounded_decision";
export interface ResidentQueueEntry {
  projectId: string; queueId: string; id: string; taskId: string; taskRevisionId: string;
  sessionId: string; roleId: string; position: number; dependsOn: string[];
  consumerId: string; useRequired: boolean; releaseRule: QueueReleaseRule;
  state: QueueEntryState; holdCode: QueueHoldCode | null; holdReason: string | null;
  claimId: string | null; version: number;
}
export interface ResidentQueue {
  projectId: string; id: string; version: number; adoptedVersion: number | null;
  reason: string; actorId: string; entries: ResidentQueueEntry[];
}
export interface QueueClaim {
  projectId: string; queueId: string; entryId: string; claimId: string;
  taskId: string; taskRevisionId: string; sessionId: string; roleId: string;
  runId: string; operationId: string; state: "intent" | "dispatching" | "running" | "terminal" | "unknown" | "released";
  nativeTurnId: string | null; reason: string | null;
}
export interface QueueSourceFacts {
  currentTaskRevisionId: string | null;
  taskState: "todo" | "in_progress" | "done" | "cancelled" | "other";
  sessionReady: boolean; nativeThreadId: string | null; bindingCurrent: boolean;
  grantCurrent: boolean; conflictingRun: boolean;
}
export interface QueueReleaseEvidence {
  taskRevisionId: string; taskState: "done" | "in_progress";
  deliveryId: string | null; deliveryCurrent: boolean; deliveryPassed: boolean;
  observationId: string | null; observationConsumerId: string | null; observationUsed: boolean;
  closureId: string | null; closureCurrent: boolean;
  boundedDecisionId: string | null; boundedDecisionActorId: string | null;
  boundedDecisionReason: string | null; nextResponsibility: string | null;
}
