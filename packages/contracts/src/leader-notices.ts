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

/** Exact saved message intent, shared by the pump and rejection-journal verification. */
export function leaderNoticePostCommand(notice: Pick<LeaderNotice,"projectId"|"kind"|"sourceEventId"|
  "occurredAt"|"taskId"|"taskRevisionId"|"sourceActorId"|"sourceSessionId"|"sourceRef"|
  "operationId"|"messageId">, sessionId: string) {
  const label: Record<LeaderNoticeKind,string>={task_todo:"A Task was created for Leader triage",
    delivery:"A fixed Delivery was recorded",observation:"An independent use observation was recorded",
    task_question:"A Task recipient asked a question",task_blocker:"A Task recipient reported a blocker",
    run_without_submission:"A terminal Run has no signed submission",
    run_submission_blocked:"A signed Run submission cannot be sealed"};
  const content=`${label[notice.kind]}.\nSource event: ${notice.sourceEventId} at ${notice.occurredAt}`+
    `\nSource Task revision: ${notice.taskId}@${notice.taskRevisionId}`+
    `\nSource actor: ${notice.sourceActorId ?? "unverified"}; source Session: ${notice.sourceSessionId ?? "unverified"}`+
    `\nSource: ${notice.sourceRef}`+
    "\nThis is a historical source event that may have been superseded. Next responsibility: Leader reads the current Task, fixed source and any existing arrangement, then saves the next decision. This notice is not current acceptance, consumer use, or Task closure.";
  return {type:"session.message.post" as const,projectId:notice.projectId,
    operationId:notice.operationId,messageId:notice.messageId,
    target:{kind:"owned" as const,sessionId},
    context:{taskId:notice.taskId,taskRevisionId:notice.taskRevisionId},content};
}
