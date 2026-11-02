/** A durable source event and its separate notification handoff. */
export type LeaderNoticeKind = "task_todo" | "delivery" | "observation" | "task_question" | "task_blocker" | "run_without_submission" | "run_submission_blocked";
export type LeaderNoticeState = "pending" | "linked" | "blocked";
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
}
export interface LeaderNoticePage { items: LeaderNotice[]; nextCursor: string | null }
