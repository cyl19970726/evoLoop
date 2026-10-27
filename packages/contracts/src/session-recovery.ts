import { z } from 'zod';

const id=z.uuid(), text=z.string().trim().min(1).max(4000), version=z.number().int().positive();
const base={projectId:id,operationId:id};
export const sessionRecoveryCommands=[
  z.strictObject({...base,type:z.literal('runtime.session.executionProfile.revise'),sessionId:id,
    expectedVersion:version,expectedExecutionProfileRevisionId:id,model:text,
    sandbox:z.literal('danger-full-access').default('danger-full-access'),
    approvalPolicy:z.literal('never').default('never'),evidenceRef:text,reason:text}),
  z.strictObject({...base,type:z.literal('runtime.session.recovery.resume'),sessionId:id,
    expectedVersion:version,expectedCauseId:id,resumeMessageId:id.nullable(),evidenceRef:text,reason:text}),
];
export type SessionRecoveryCommand=z.infer<typeof sessionRecoveryCommands[number]>;
export type RecoveryPhase='open'|'blocked'|'retrying'|'message_pending'|'awaiting_acceptance';
export type ExecutionProfileActivation='active'|'pending'|'attempting'|'unknown'|'rejected';

/** Configured launch policy. This is not provider-reported per-Turn model telemetry. */
export interface ExecutionProfileSnapshot {
  revisionId:string;version:number;model:string|null;sandbox:'read-only'|'workspace-write'|'danger-full-access';
  approvalPolicy:'on-request'|'untrusted'|'never';cwd:string;authorizationScope:string;
  provenance:'reserved'|'legacy_session_identity'|'revised';
}
export interface ExecutionProfileRevision extends ExecutionProfileSnapshot {
  projectId:string;sessionId:string;previousRevisionId:string|null;operationId:string;
  actorId:string;reason:string;evidenceRef:string|null;createdAt:string;
}
export interface SessionExecutionProfile {
  revision:ExecutionProfileRevision;activationState:ExecutionProfileActivation;
  /** Last positively confirmed native configuration, retained while a new target is pending/unknown. */
  activeRevisionId:string|null;
  activationOperationId:string|null;attemptedAt:string|null;activationEvidence:string|null;
}
export interface SessionRecoveryGate {
  projectId:string;sessionId:string;version:number;phase:RecoveryPhase;
  causeKind:'run'|'message'|'execution_profile'|null;causeId:string|null;causeState:string|null;
  reason:string;queueId:string|null;claimId:string|null;retryRunId:string|null;
  /** Chosen under the failure's Session lock; a later message cannot replace this one. */
  resumeMessageId:string|null;decisionOperationId:string|null;updatedAt:string;
}
export interface SessionRecoveryDecision {
  projectId:string;id:string;sessionId:string;kind:'retry_failed'|'resume';
  expectedGateVersion:number;causeId:string;sourceRunId:string|null;sourceInputHash:string|null;
  retryRunId:string|null;resumeMessageId:string|null;actorId:string;reason:string;
  evidenceRef:string;createdAt:string;
}
/** Bounded read model for human observation; no command permission is inferred from this view. */
export interface SessionRecoveryView {
  sessionId:string;executionProfile:SessionExecutionProfile|null;gate:SessionRecoveryGate|null;
  decisions:SessionRecoveryDecision[];
  queues:Array<{queueId:string;version:number;adoptedVersion:number|null;maxRuns:number;attemptsUsed:number;attemptsRemaining:number}>;
  nextAction:'reconcile_original_operation'|'review_recovery_decision'|'await_authorized_retry'|
    'await_original_message'|'record_delivery_use_and_accepted_release'|'dispatch_authorized_business_attempt'|'normal_work';
  partial:boolean;observedAtUtc:string;
}
export interface SessionRecoveryReader {
  /** Persisted native origin, checked on the transaction's existing connection. */
  isDynamicSession(sessionId:string):Promise<boolean>;
  getRecoveryGate(sessionId:string):Promise<SessionRecoveryGate|null>;
  getExecutionProfileRevision(sessionId:string,revisionId:string):Promise<ExecutionProfileRevision|null>;
  listRecoveryDecisions(sessionId:string,limit?:number):Promise<SessionRecoveryDecision[]>;
}
export interface SessionRecoveryTransaction extends SessionRecoveryReader {
  lockRecoveryGate(sessionId:string):Promise<SessionRecoveryGate>;
  /** All callers are inside the existing project transaction; persistence rechecks CAS and native vacancy. */
  adoptExecutionProfile(revision:ExecutionProfileRevision,expectedSessionVersion:number):Promise<void>;
  beginExecutionProfileActivation(sessionId:string,revisionId:string,operationId:string):Promise<boolean>;
  settleExecutionProfileActivation(sessionId:string,revisionId:string,state:'active'|'unknown'|'rejected',evidence:string):Promise<void>;
  saveRecoveryDecision(decision:SessionRecoveryDecision,next:SessionRecoveryGate,expectedVersion:number):Promise<void>;
  assertStartupAllowed(sessionId:string,kind:'run'|'message',id:string):Promise<void>;
}
