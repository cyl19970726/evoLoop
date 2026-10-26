import type { DiscussionStatus, DiscussionTarget } from './discussions.js';
import type { ObservationMetadata, ObservationSource, SessionTarget } from './session-work.js';

/** Exactly one project-scoped filter. A Role membership alone never selects a Session path. */
export type AllocationRelationFilter =
  | { roleId: string; sessionKey?: never; discussionId?: never }
  | { sessionKey: string; roleId?: never; discussionId?: never }
  | { discussionId: string; roleId?: never; sessionKey?: never };
export type AllocationRelationQuery = AllocationRelationFilter & { limit: number; cursor?: string };
export type AllocationTargetStatus = 'current' | 'changed' | 'unavailable';
/** A read-time explanation, not a persisted Task state or proof of execution. */
export type AllocationTaskAcceptanceGap = 'no-assignment' | 'not-accepted' | 'different-task-revision' | 'unavailable';
export interface AllocationDiscussionSummary {
  id: string; version: number; status: DiscussionStatus; title: string;
  document: { id: string; revisionId: string };
  latestDecisionEventId: string | null;
}
export type AllocationRelation =
  | { kind: 'decision-target'; actionEventId: string; target: DiscussionTarget;
      targetStatus: AllocationTargetStatus;
      /** Task targets only: null means an exact-revision accepted path exists, possibly on another page. */
      taskAcceptanceGap?: AllocationTaskAcceptanceGap | null }
  | { kind: 'task-recipient'; taskActionEventId: string; task: { id: string; revisionId: string };
      assignment: { version: number; target: SessionTarget; acceptedAt: string;
        method: 'direct' | 'lead-observed'; actorId: string | null; observerActorId: string };
      taskRevisionStatus: AllocationTargetStatus;
      assignmentStatus: 'current' | 'historical' | 'unknown' };
export interface AllocationTrace {
  id: string; discussion: AllocationDiscussionSummary; decisionEventId: string;
  /** Fixed decision body, distinct from the Discussion's current Document head. */
  decisionDocumentRevisionId: string | null;
  relation: AllocationRelation; decisionIsLatest: boolean; sources: ObservationSource[];
}
export interface AllocationTracePage {
  items: AllocationTrace[]; nextCursor: string | null; resetRequired: boolean;
  /** Only populated for a Session filter; old aliases remain in assignment provenance. */
  canonicalSessionKey: string | null; metadata: ObservationMetadata;
}
export interface AllocationRelationsReader {
  list(query: AllocationRelationQuery): Promise<AllocationTracePage>;
}
