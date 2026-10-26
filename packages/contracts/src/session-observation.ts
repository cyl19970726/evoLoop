import type { SessionKey, SessionTarget, SessionCapabilities, ObservationMetadata, ObservationSource } from "./session-work.js";
import type { SessionProfileRecord, TaskSessionAssignment } from "./session-assignments.js";

export interface ObservedRole {
  id: string;
  title: string;
  state: string;
  roleClass: "system" | "business" | null;
  templateKey: string | null;
  responsibility: string;
}
export interface ObservedTask {
  id: string;
  title: string;
  state: string;
  revisionId: string;
  owner: string;
  relation: "claimed" | "run" | "assigned" | "accepted" | "role-responsibility";
  source: ObservationSource;
}
export interface ObservedRun {
  id: string;
  taskId: string;
  state: string;
  updatedAt: string;
  source: ObservationSource;
}
export interface ObservedSession {
  key: SessionKey;
  target: SessionTarget;
  aliases: SessionTarget[];
  title: string;
  profile: SessionProfileRecord | null;
  kind: "owned" | "external";
  roles: ObservedRole[];
  membership: "current" | "historical" | "unclassified";
  membershipReason: string;
  runtimeState: string | null;
  /** Unknown external status is null, never a fabricated idle/ready state. */
  busy: boolean | null;
  currentTask: ObservedTask | null;
  latestBusinessRun: ObservedRun | null;
  lastProgressAt: string | null;
  capabilities: SessionCapabilities;
  source: ObservationSource;
  metadata: ObservationMetadata;
}
export interface SessionDirectory {
  items: ObservedSession[];
  nextCursor: string | null;
  /** Boundary from the same read snapshot, not the last event displayed. */
  observationCursor: string;
  metadata: ObservationMetadata;
  totals: { current: number; historical: number; unclassified: number };
  /** Project-wide aggregates, independent of the currently loaded directory page. */
  attention: { unansweredQuestions: number; pendingMessages: number; pendingAcceptance: number | null; unclassifiedSessions: number };
}
export interface SessionActivity {
  id: string;
  sequence: string;
  sessionKey: SessionKey;
  kind: string;
  summary: string;
  occurredAt: string | null;
  recordedAt: string;
  /** Persisted source actor; association with this Session does not make it the author. */
  actorId: string | null;
  /** Related Task context, not proof that this Session performed the activity. */
  taskId: string | null;
  importance: "important" | "detail";
  source: ObservationSource;
}
export interface SessionQueueItem {
  queueId: string;
  entryId: string;
  taskId: string;
  taskTitle: string;
  position: number;
  state: string;
  holdCode: string | null;
  holdReason: string | null;
  dependsOn: string[];
  source: ObservationSource;
}
export interface SessionResult {
  deliveryId: string;
  taskId: string;
  taskTitle: string;
  technicalResult: string;
  artifactRef: string;
  artifactRevision: string;
  contentHash: string;
  submittedAt: string;
  latestUse: { result: string; observer: string; observerKind: string; createdAt: string; source: ObservationSource } | null;
  source: ObservationSource;
}
export interface SessionQuestion {
  discussionId: string;
  taskId: string;
  taskRevisionId: string;
  questionEventId: string;
  recipientActorId: string;
  answered: boolean;
  source: ObservationSource;
}
export interface ObservedResource {
  value: number | string | null;
  unit: string;
  source: string | null;
  scope: "session" | "run" | "runtime-process";
  observedAt: string | null;
  interval: { from: string; to: string } | null;
  unavailableReason: string | null;
}
export interface SessionSnapshot {
  session: ObservedSession;
  observationCursor: string;
  currentWork: ObservedTask | null;
  assignments: Array<{ assignment: TaskSessionAssignment; task: ObservedTask; stale: boolean }>;
  /** Role ownership alone does not establish that this particular Session accepted the Task. */
  roleTasks: ObservedTask[];
  queue: SessionQueueItem[];
  results: SessionResult[];
  questions: SessionQuestion[];
  activity: SessionActivity[];
  resources: {
    configuredModel: ObservedResource;
    actualModel: ObservedResource;
    inputTokens: ObservedResource;
    outputTokens: ObservedResource;
    cost: ObservedResource;
    processMemory: ObservedResource;
  };
  metadata: ObservationMetadata;
}
export interface SessionActivityPage {
  items: SessionActivity[];
  nextCursor: string | null;
  metadata: ObservationMetadata;
}
export interface SessionObservationChange {
  id: string;
  sequence: string;
  operation: "invalidate";
  /** Empty means refresh the loaded directory; identity/lifecycle may have changed. */
  sessionKeys: SessionKey[];
  source: ObservationSource;
  recordedAt: string;
}
export interface SessionChanges {
  items: SessionObservationChange[];
  nextCursor: string;
  hasMore: boolean;
  resetRequired: boolean;
  metadata: ObservationMetadata;
}
export interface SessionObservationReader {
  directory(options: { limit: number; cursor?: string; search?: string; membership?: string }): Promise<SessionDirectory>;
  snapshot(key: SessionKey): Promise<SessionSnapshot | null>;
  history(key: SessionKey, options: { limit: number; cursor?: string; taskId?: string; importance?: "important" | "all" }): Promise<SessionActivityPage | null>;
  changes(options: { cursor: string; limit: number; key?: SessionKey }): Promise<SessionChanges>;
}
