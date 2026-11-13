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

/** Recovery by packet (the form for notices that travel in packets) or, unchanged, of one blocked notice that predates packets. */
export const leaderNoticeRecoveryRequestSchema = z.union([leaderNoticeRecoverySchema, z.strictObject({ reason: z.string().trim().min(1).max(4000) })]);

/** Every kind of Leader notice that exists as a row. `observation` is the kind of notices created before observations were told apart by result. */
export const leaderNoticeKinds = ["task_todo", "delivery", "observation", "observation_used", "observation_failed", "task_question", "task_blocker",
  "run_without_submission", "run_submission_blocked", "task_attention", "acceptance_blocked", "line_entry_suspended", "line_confirmation_returned"] as const;
export type LeaderNoticeKind = (typeof leaderNoticeKinds)[number];

/**
 * How a notice reaches the Leader (DEC-045 W5). `immediate`: sent at the next moment the Leader can take it, without the 60 second debounce and ahead of
 * digest notices; it is still held by a busy Leader, a closed recovery gate and a person's message waiting, and a packet still carries at most 20 items
 * and 8 KB. `digest`: travels in the next packet after the debounce. `record_only` events are not notices: see {@link LeaderEventRecord}.
 * This table is the contract; the database derives the same level from the kind (`leader_result_notice.level`) and a test keeps them equal.
 */
export type LeaderNoticeLevel = "immediate" | "digest";
const immediateKinds: ReadonlySet<LeaderNoticeKind> = new Set<LeaderNoticeKind>(["acceptance_blocked", "run_submission_blocked", "run_without_submission",
  "task_question", "task_blocker", "observation_failed", "line_entry_suspended"]);
export const noticeLevelOf = (kind: LeaderNoticeKind): LeaderNoticeLevel => immediateKinds.has(kind) ? "immediate" : "digest";

/** An event that only gets recorded: it wakes no one. Read from the `leader_event_record` view (`GET /api/projects/:id/leader-records`). */
export type LeaderEventRecordKind = "run_stopped" | "attention_resolved" | "notice_withdrawn" | "line_entry_appended" | "line_entry_started" | "line_entry_ended";
export interface LeaderEventRecord { kind: LeaderEventRecordKind; sourceEventId: string; taskId: string; sourceRef: string; occurredAt: string }
export interface LeaderEventRecordPage { items: LeaderEventRecord[]; nextCursor: string | null }
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
  /** How it reaches the Leader; follows from the kind. */
  level: LeaderNoticeLevel;
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
  /** True for notices that travel in packets (created while the packet switch was on); their message fields above are unused. */
  viaPacket?: boolean;
  /** The notice's latest packet item: where it is on its way to the Leader and what the Leader decided. */
  packet?: LeaderNoticePacketStatus | null;
}
export interface LeaderNoticePacketStatus {
  packetId: string; packetState: string; itemState: string; readBefore: boolean; disposition: "handled" | "deferred" | null;
  deferUntil: string | null; withdrawnReason: string | null; itemVersion: number;
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
    run_submission_blocked:"A signed Run submission cannot be sealed",
    observation_used:"An independent use observation recorded that the Delivery was used",
    observation_failed:"An independent use observation recorded that the Delivery was not usable",
    line_entry_suspended:"A Session line entry cannot start and was suspended",
    line_confirmation_returned:"A Session returned its execution confirmation for a Task",
    task_attention:"A current Task attention item needs a Leader follow-up",
    acceptance_blocked:"An acceptance handoff is blocked and needs a Leader decision"};
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
