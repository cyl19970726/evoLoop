import { z } from "zod";
import { sessionTargetSchema, type SessionTarget } from "./session-work.js";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const startIdentity = z.string().trim().min(1).max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = { projectId: id, operationId: id };
export const sessionMessageCommands = [
  z.strictObject({ ...base, type: z.literal("session.message.post"), messageId: id,
    target: sessionTargetSchema, content: z.string().trim().min(1).max(16000),
    context: z.strictObject({ taskId: id, taskRevisionId: id }).optional(), replyToMessageId: id.optional() }),
  z.strictObject({ ...base, type: z.literal("session.message.cancel"), messageId: id,
    expectedVersion: z.number().int().positive(), reason: note }),
  z.strictObject({ ...base, type: z.literal("session.message.receipt"), messageId: id,
    stage: z.literal("read"), evidence: note }),
  z.strictObject({ ...base, type: z.literal("session.message.reconcile"), messageId: id,
    sessionId: id, processingId: id, nativeTurnId: z.string().trim().min(1).max(256),
    expectedMessageVersion: z.number().int().positive(), expectedProcessingVersion: z.number().int().positive(), reason: note }),
  z.strictObject({ ...base, type: z.literal("session.message.interrupt"), messageId: id,
    sessionId: id, processingId: id, nativeTurnId: z.string().trim().min(1).max(256),
    expectedMessageVersion: z.number().int().positive(), expectedProcessingVersion: z.number().int().positive(), reason: note }),
  z.strictObject({ ...base, type: z.literal("session.message.manualStop"), messageId: id,
    sessionId: id, processingId: id, preflightId: id, nativeTurnId: z.string().trim().min(1).max(256),
    expectedMessageVersion: z.number().int().positive(), expectedProcessingVersion: z.number().int().positive(),
    oldCoordinatorPid: z.number().int().positive(), oldNativePid: z.number().int().positive(),
    oldCoordinatorStartIdentity: startIdentity, oldNativeStartIdentity: startIdentity,
    exitEvidenceRef: note, exitEvidenceHash: hash,
    observedNativeStatus: z.enum(["inProgress", "interrupted", "failed"]),
    observedThreadStatus: z.enum(["idle", "notLoaded"]),
    observedItemCount: z.number().int().nonnegative(), observedItemIdsHash: hash, reason: note }),
] as const;
export type SessionMessageCommand = z.infer<(typeof sessionMessageCommands)[number]>;
export type SessionMessageState = "queued" | "processing" | "replied" | "completed_without_reply" | "failed" | "unknown" | "cancelled" | "manual_pending";
export interface SessionMessageRecord {
  projectId: string; id: string; operationId: string; target: SessionTarget; senderActorId: string;
  content: string; context: { taskId: string; taskRevisionId: string } | null;
  replyToMessageId: string | null; state: SessionMessageState; version: number;
  blockedReason: string | null;
  readReceipt: { actorId: string; evidence: string; at: string } | null;
  createdAt: string; updatedAt: string;
}
export type SessionMessageProcessingState = "dispatching" | "running" | "unknown" | "completed" | "failed";
export interface SessionMessageProcessing {
  projectId: string; id: string; messageId: string; sessionId: string; operationId: string;
  state: SessionMessageProcessingState; nativeTurnId: string | null; response: string | null;
  /** Legacy field name retained for immutable processing records; new values identify the full Session admission profile. */
  failure: string | null; readOnlyPolicyFingerprint?: string | null; receiverActorId?: string | null;
  /** Fixed by the same transaction as the original processing's native-start permit. */
  nativeEnvironmentEpoch?: number | null;
  /** Durable one-shot request. An attempted native interrupt is never replayed after a lost response. */
  interruptOperationId?: string | null; interruptActorId?: string | null;
  interruptReason?: string | null; interruptRequestedAt?: string | null; interruptAttemptedAt?: string | null;
  version: number; startedAt: string; updatedAt: string;
}
/** Immutable reviewer evidence for stopping one original processing after external host inspection. */
export interface SessionMessageManualStopEvidence {
  projectId: string; messageId: string; processingId: string; sessionId: string; nativeTurnId: string;
  preflightId: string;
  operationId: string; actorId: string; reason: string; priorFailure: string | null;
  oldCoordinatorPid: number; oldNativePid: number;
  oldCoordinatorStartIdentity: string; oldNativeStartIdentity: string;
  exitEvidenceRef: string; exitEvidenceHash: string;
  observedNativeStatus: "inProgress" | "interrupted" | "failed";
  observedThreadStatus: "idle" | "notLoaded"; observedItemCount: number; observedItemIdsHash: string;
  recordedAt: string;
}
/** Immutable OS and DB identity anchor captured before the original owner stops. */
export interface SessionMessageManualStopPreflight {
  projectId: string; messageId: string; preflightId: string; processingId: string; sessionId: string;
  nativeTurnId: string; nativeThreadId: string; messageVersion: number; processingVersion: number;
  host: string; capturedByActorId: string; listenPort: number;
  oldCoordinatorPid: number; oldCoordinatorStartIdentity: string;
  oldNativePid: number; oldNativeStartIdentity: string;
  preStopEvidenceJson: string; preStopEvidenceHash: string;
  captureFileRef: string; captureFileHash: string; capturedAt: string;
}
/** A separate, explicit ordinary-conversation grant. Business queue or Loop quotas do not satisfy it. */
export interface SessionMessageDispatchGrant {
  projectId: string; sessionId: string; senderActorId: string; receiverRoleId: string; receiverActorId: string;
  cwd: string; maxTurns: number; enabled: boolean;
}
export interface SessionMessageReader {
  getSessionMessage(id: string): Promise<SessionMessageRecord | null>;
  getSessionMessages?(ids: string[]): Promise<SessionMessageRecord[]>;
  listSessionMessages(target: SessionTarget, limit: number, cursor?: string): Promise<{ items: SessionMessageRecord[]; nextCursor: string | null }>;
  /** Optional batch read used to build a conversation page without N+1 requests. */
  listSessionMessageProcessing?(messageIds: string[]): Promise<SessionMessageProcessing[]>;
  listPendingSessionMessages(limit: number, offset?: number): Promise<SessionMessageRecord[]>;
  getSessionMessageProcessing(messageId: string): Promise<SessionMessageProcessing | null>;
  getSessionMessageManualStopEvidence(messageId: string): Promise<SessionMessageManualStopEvidence | null>;
  getSessionMessageManualStopPreflight(messageId: string): Promise<SessionMessageManualStopPreflight | null>;
  countSessionMessageTurns(sessionId: string, senderActorId: string): Promise<number>;
  mustYieldBusiness(sessionId:string):Promise<boolean>;
  hasActiveSessionMessage(sessionId:string):Promise<boolean>;
}
export interface SessionMessageTransaction extends SessionMessageReader {
  insertSessionMessage(value: SessionMessageRecord): Promise<void>;
  updateSessionMessage(value: SessionMessageRecord, expectedVersion: number): Promise<void>;
  insertSessionMessageProcessing(value: SessionMessageProcessing): Promise<void>;
  updateSessionMessageProcessing(value: SessionMessageProcessing, expectedVersion: number): Promise<void>;
  insertSessionMessageManualStopEvidence(value: SessionMessageManualStopEvidence): Promise<void>;
  markSessionMessageInterruptAttempted(messageId: string, operationId: string, expectedVersion: number, at: string): Promise<boolean>;
  insertSessionMessageReadReceipt(messageId: string, actorId: string, evidence: string, at: string): Promise<void>;
  setSessionMessageBlockedReason(messageId:string,reason:string|null):Promise<void>;
  markSessionMessageSettled(sessionId:string,messageId:string,at:string):Promise<void>;
  /** Includes unresolved Task Runs and ordinary processing; close also checks queued messages. */
  assertSessionVacant(sessionId: string, includeQueued?: boolean): Promise<void>;
}
