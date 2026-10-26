import { z } from "zod";
import { sessionTargetSchema, type SessionTarget } from "./session-work.js";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const base = { projectId: id, operationId: id };
export const sessionMessageCommands = [
  z.strictObject({ ...base, type: z.literal("session.message.post"), messageId: id,
    target: sessionTargetSchema, content: z.string().trim().min(1).max(16000),
    context: z.strictObject({ taskId: id, taskRevisionId: id }).optional(), replyToMessageId: id.optional() }),
  z.strictObject({ ...base, type: z.literal("session.message.cancel"), messageId: id,
    expectedVersion: z.number().int().positive(), reason: note }),
  z.strictObject({ ...base, type: z.literal("session.message.receipt"), messageId: id,
    stage: z.literal("read"), evidence: note }),
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
  failure: string | null; readOnlyPolicyFingerprint?: string | null; receiverActorId?: string | null;
  version: number; startedAt: string; updatedAt: string;
}
/** A separate, explicit ordinary-conversation grant. Business queue or Loop quotas do not satisfy it. */
export interface SessionMessageDispatchGrant {
  projectId: string; sessionId: string; senderActorId: string; receiverRoleId: string; receiverActorId: string;
  cwd: string; maxTurns: number; enabled: boolean;
}
export interface SessionMessageReader {
  getSessionMessage(id: string): Promise<SessionMessageRecord | null>;
  listSessionMessages(target: SessionTarget, limit: number, cursor?: string): Promise<{ items: SessionMessageRecord[]; nextCursor: string | null }>;
  listPendingSessionMessages(limit: number, offset?: number): Promise<SessionMessageRecord[]>;
  getSessionMessageProcessing(messageId: string): Promise<SessionMessageProcessing | null>;
  countSessionMessageTurns(sessionId: string, senderActorId: string): Promise<number>;
  mustYieldBusiness(sessionId:string):Promise<boolean>;
  hasActiveSessionMessage(sessionId:string):Promise<boolean>;
}
export interface SessionMessageTransaction extends SessionMessageReader {
  insertSessionMessage(value: SessionMessageRecord): Promise<void>;
  updateSessionMessage(value: SessionMessageRecord, expectedVersion: number): Promise<void>;
  insertSessionMessageProcessing(value: SessionMessageProcessing): Promise<void>;
  updateSessionMessageProcessing(value: SessionMessageProcessing, expectedVersion: number): Promise<void>;
  insertSessionMessageReadReceipt(messageId: string, actorId: string, evidence: string, at: string): Promise<void>;
  setSessionMessageBlockedReason(messageId:string,reason:string|null):Promise<void>;
  markSessionMessageSettled(sessionId:string,messageId:string,at:string):Promise<void>;
  /** Includes unresolved Task Runs and unresolved ordinary processing; preserves queue claim ownership. */
  assertSessionVacant(sessionId: string): Promise<void>;
}
