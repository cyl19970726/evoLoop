/** A durable source event and its separate notification handoff. */
import { z } from "zod";

export const leaderNoticeRecoverySchema = z.strictObject({
  expectedOperationId: z.uuid(),
  newNoticeId: z.uuid(),
  newMessageId: z.uuid(),
  newOperationId: z.uuid(),
  reason: z.string().trim().min(1).max(4000),
}).refine(value => new Set([value.expectedOperationId, value.newNoticeId,
  value.newMessageId, value.newOperationId]).size === 4, "Recovery IDs must be distinct");

export type LeaderNoticeKind = "task_todo" | "delivery" | "observation" | "task_question" | "task_blocker" | "run_without_submission" | "run_submission_blocked";
export type LeaderNoticeState = "pending" | "linked" | "blocked";
export interface LeaderNoticeRecoveryLink {
  parentNoticeId: string | null;
  replacementNoticeId: string | null;
  dispositionActorId: string | null;
  dispositionReason: string | null;
}
export interface LeaderNotice {
  id: string;
  projectId: string;
  kind: LeaderNoticeKind;
  sourceEventId: string;
  taskId: string;
  taskRevisionId: string;
  sourceSessionId: string | null;
  sourceActorId: string | null;
  sourceRef: string;
  occurredAt: string;
  state: LeaderNoticeState;
  messageId: string;
  operationId: string;
  linkedSessionId: string | null;
  blockedReason: string | null;
  stale: boolean;
  messageState: string | null;
  messageBlockedReason: string | null;
  processingState: string | null;
  nativeTurnId: string | null;
  readAt: string | null;
  updatedAt: string;
  recovery?: LeaderNoticeRecoveryLink;
}
export interface LeaderNoticePage { items: LeaderNotice[]; nextCursor: string | null }
