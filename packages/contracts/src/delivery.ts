import type { CollaborationBinding, ExternalActorEvidence, IncomingChangeCandidate, ProjectionObservation } from "./collaboration.js";

export type DeliveryState = "pending" | "claimed" | "dispatching" | "applied" | "unknown" | "conflict" | "failed";
export interface DeliveryRecord {
  projectId: string; eventId: string; consumerId: string; operationId: string; effectKey: string;
  taskId: string; taskVersion: number; state: DeliveryState; fence: number;
  leaseOwner: string | null; leaseUntilUtc: string | null; nextRetryAtUtc: string | null;
  lastReason: string | null; updatedAtUtc: string;
}
export interface DeliveryClaim { delivery: DeliveryRecord; token: string }
export interface DeliveryAttempt {
  projectId: string; id: string; eventId: string; consumerId: string; fence: number;
  action: "dispatch" | "reconcile" | "retry" | "recover";
  outcome: DeliveryState; reason: string; remoteRecordId: string | null;
  actorId: string; createdAtUtc: string;
}
export interface ProjectionStatus {
  configured: boolean; verifiedAtUtc: string | null; error: string | null;
  deliveries: DeliveryRecord[]; incomingPending: number;
}
export interface IncomingRecord extends IncomingChangeCandidate {
  projectId: string; id: string; operationId: string; state: "pending" | "review-only" | "applied" | "rejected" | "conflict" | "unknown";
  sourceEventId: string; observedAtUtc: string; reviewedBy: string | null; reviewedAtUtc: string | null;
}
export interface IncomingDecision { projectId: string; id: string; operationId: string; state: IncomingRecord["state"]; actorId: string; reason: string; createdAtUtc: string }
export interface DeliveryStore {
  claimNext(projectId: string, consumerId: string, leaseOwner: string, nowUtc: string, leaseMs: number): Promise<DeliveryClaim | null>;
  beginDispatch(claim: DeliveryClaim, actorId: string, nowUtc: string): Promise<boolean>;
  finish(claim: DeliveryClaim, observation: ProjectionObservation, actorId: string, nowUtc: string, action: "dispatch" | "reconcile"): Promise<DeliveryRecord | null>;
  recoverInterrupted(projectId: string, consumerId: string, nowUtc: string): Promise<number>;
  claimUnknown(projectId: string, eventId: string, consumerId: string, leaseOwner: string, nowUtc: string, leaseMs: number): Promise<DeliveryClaim | null>;
  requestRetry(projectId: string, eventId: string, consumerId: string, actorId: string, reason: string, nowUtc: string): Promise<boolean>;
  get(projectId: string, eventId: string, consumerId: string): Promise<DeliveryRecord | null>;
  list(projectId: string, consumerId: string, limit?: number, afterEventId?: string): Promise<{ items: DeliveryRecord[]; nextCursor: string | null }>;
  attempts(projectId: string, eventId: string, consumerId: string): Promise<DeliveryAttempt[]>;
  getBinding(projectId: string, taskId: string, consumerId: string): Promise<CollaborationBinding | null>;
  listBindings(projectId: string, consumerId: string, limit?: number, afterTaskId?: string): Promise<{ items: CollaborationBinding[]; nextCursor: string | null }>;
  recordIncoming(projectId: string, consumerId: string, candidate: IncomingChangeCandidate, sourceEventId: string, observedAtUtc: string): Promise<IncomingRecord>;
  listIncoming(projectId: string, consumerId: string, limit?: number, afterId?: string): Promise<{ items: IncomingRecord[]; nextCursor: string | null }>;
  getIncoming(projectId: string, incomingId: string, consumerId: string): Promise<IncomingRecord | null>;
  decideIncoming(value: IncomingDecision, consumerId: string): Promise<boolean>;
}
export interface ExternalActorResolver { resolve(projectId: string, platformUserId: string, sourceEventId: string): Promise<ExternalActorEvidence | null> }
