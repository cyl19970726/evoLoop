/** Stable local/remote identity and last confirmed two-sided baseline. Stored by evoLoop. */
export interface CollaborationBinding {
  entityId: string;
  remoteRecordId: string;
  localVersion: number;
  remoteOperationId: string;
  remoteVersion: number;
  remoteModifiedTime: string | null;
  confirmedTitle: string;
  confirmedStatus: string;
}

/** The coordinator must revalidate current authorization and persist this outbox intent before sending. */
export interface ProjectionIntent {
  entityId: string;
  localVersion: number;
  operationId: string;
  title: string;
  status: string;
  /** `unknown` forbids a fresh create or update until reconciliation. */
  deliveryState: "not-sent" | "unknown";
}

export type ProjectionObservation =
  | { state: "confirmed"; binding: CollaborationBinding }
  | { state: "unknown"; reason: string }
  | { state: "conflict"; reason: string; remoteRecordId?: string }
  | { state: "rate-limited"; retryAfterSeconds: number | null };

export interface RemoteTaskRecord {
  recordId: string;
  entityId: string | null;
  localVersion: number | null;
  operationId: string | null;
  title: string | null;
  status: string | null;
  modifiedTime: string | null;
}

export interface RemotePage {
  records: RemoteTaskRecord[];
  nextCursor: string | null;
}

export interface ExternalActorEvidence {
  platformUserId: string;
  projectActorId: string;
  sourceEventId: string;
  verified: boolean;
}

/** Candidate only. Core decides identity, permission, version, and legal transition. */
export interface IncomingChangeCandidate {
  entityId: string;
  remoteRecordId: string;
  observedLocalVersion: number;
  observedRemoteOperationId: string;
  observedRemoteModifiedTime: string | null;
  actor: ExternalActorEvidence | null;
  patch: { title?: string; status?: string };
  reviewOnly: boolean;
  reason: string | null;
}

export interface CollaborationConnector {
  project(intent: ProjectionIntent, binding: CollaborationBinding | null): Promise<ProjectionObservation>;
  reconcile(intent: ProjectionIntent, binding: CollaborationBinding | null): Promise<ProjectionObservation>;
  listRemote(cursor?: string): Promise<RemotePage>;
  incoming(record: RemoteTaskRecord, binding: CollaborationBinding, actor: ExternalActorEvidence | null): IncomingChangeCandidate;
}
