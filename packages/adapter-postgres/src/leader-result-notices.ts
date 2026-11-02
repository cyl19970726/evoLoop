import type { Pool } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { LeaderNotice, LeaderNoticeKind, LeaderNoticePage, LeaderNoticeState } from "@evoloop/contracts/leader-notices";

export interface LeaderNoticeListOptions { taskId?: string; limit: number; cursor?: string }
export interface LeaderNoticeRecipient {
  sessionId: string; receiverRoleId: string; receiverActorId: string; senderActorId: string;
}
export type LeaderResultNotice = LeaderNotice & { recipient: LeaderNoticeRecipient | null };
export type LeaderResultNoticePage = Omit<LeaderNoticePage, "items"> & { items: LeaderResultNotice[] };

type Row = Record<string, unknown>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const notice = (row: Row): LeaderResultNotice => ({
  id: String(row.notice_id), projectId: String(row.project_id), kind: row.kind as LeaderNoticeKind,
  sourceEventId: String(row.source_event_id), taskId: String(row.task_id), taskRevisionId: String(row.task_revision_id),
  sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
  sourceActorId: row.source_actor_id === null ? null : String(row.source_actor_id),
  sourceRef: String(row.source_ref), occurredAt: iso(row.occurred_at), state: row.state as LeaderNoticeState,
  messageId: String(row.message_id), operationId: String(row.operation_id),
  linkedSessionId: row.linked_session_id ? String(row.linked_session_id) : null,
  blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason), updatedAt: iso(row.updated_at),
  stale: row.stale === true,
  messageState: row.message_state === null ? null : String(row.message_state),
  processingState: row.processing_state === null ? null : String(row.processing_state),
  nativeTurnId: row.native_turn_id === null ? null : String(row.native_turn_id),
  readAt: row.read_at === null ? null : iso(row.read_at),
  messageBlockedReason: row.message_blocked_reason === null ? null : String(row.message_blocked_reason),
  recipient: row.recipient_session_id ? { sessionId: String(row.recipient_session_id),
    receiverRoleId: String(row.receiver_role_id), receiverActorId: String(row.receiver_actor_id),
    senderActorId: String(row.sender_actor_id) } : null,
});

interface Position { version: 1; projectId: string; taskId: string | null; order: "recent" | "pending" | "blocked"; occurredAt: string; id: string }
function position(cursor: string | undefined, projectId: string, taskId: string | null,
  order: Position["order"]): Position | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Position;
    if (parsed.version !== 1 || parsed.projectId !== projectId || parsed.taskId !== taskId || parsed.order !== order ||
      !Number.isFinite(Date.parse(parsed.occurredAt)) || !/^[0-9a-f-]{36}$/i.test(parsed.id)) throw new Error("scope");
    return parsed;
  } catch { throw new DomainError("INVALID_CURSOR", "Leader notice cursor does not match this project and Task"); }
}

const noticeFrom = `n.*,t.current_revision_id IS DISTINCT FROM n.task_revision_id AS stale,
  m.state AS message_state,m.blocked_reason AS message_blocked_reason,
  p.state AS processing_state,p.native_turn_id,rr.recorded_at AS read_at
  FROM leader_result_notice n
  JOIN task t ON t.project_id=n.project_id AND t.task_id=n.task_id
  LEFT JOIN session_message m ON m.project_id=n.project_id AND m.message_id=n.message_id
  LEFT JOIN session_message_processing p ON p.project_id=m.project_id AND p.message_id=m.message_id
  LEFT JOIN LATERAL (SELECT recorded_at FROM session_message_read_receipt r
    WHERE r.project_id=m.project_id AND r.message_id=m.message_id
    ORDER BY recorded_at DESC LIMIT 1) rr ON true`;
function bounded(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("INVALID_PAGE", "Leader notice limit must be 1..100");
  return limit;
}

async function page(pool: Pool, projectId: string, options: LeaderNoticeListOptions,
  state: "all" | "pending" | "blocked"): Promise<LeaderResultNoticePage> {
  const limit = bounded(options.limit), taskId = options.taskId ?? null;
  const order = state === "all" ? "recent" : state;
  const after = position(options.cursor, projectId, taskId, order);
  const compare = state === "all" ? "<" : ">";
  const direction = state === "all" ? "DESC" : "ASC";
  const result = await pool.query(`SELECT ${noticeFrom}
    WHERE n.project_id=$1 AND ($2::uuid IS NULL OR n.task_id=$2::uuid)
      AND ($3::timestamptz IS NULL OR (n.occurred_at,n.notice_id)${compare}($3::timestamptz,$4::uuid))
      AND ($5::text='all' OR (n.state=$5::text AND
        (n.kind<>'task_todo' OR t.current_revision_id=n.task_revision_id)))
    ORDER BY n.occurred_at ${direction},n.notice_id ${direction} LIMIT $6`,
  [projectId, taskId, after?.occurredAt ?? null, after?.id ?? null, state, limit + 1]);
  const items = result.rows.slice(0, limit).map(notice);
  const last = items.at(-1);
  return { items, nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify({
    version: 1, projectId, taskId, order, occurredAt: last.occurredAt, id: last.id,
  } satisfies Position)).toString("base64url") : null };
}

export function listLeaderNotices(pool: Pool, projectId: string, options: LeaderNoticeListOptions): Promise<LeaderResultNoticePage> {
  return page(pool, projectId, options, "all");
}

export function listPendingLeaderNotices(pool: Pool, projectId: string, limit: number): Promise<LeaderResultNotice[]>;
export function listPendingLeaderNotices(pool: Pool, projectId: string,
  options: {limit: number; cursor?: string}): Promise<LeaderResultNoticePage>;
export async function listPendingLeaderNotices(pool: Pool, projectId: string,
  limitOrOptions: number | {limit: number; cursor?: string}): Promise<LeaderResultNotice[] | LeaderResultNoticePage> {
  const result = await page(pool, projectId, typeof limitOrOptions === "number"
    ? {limit: limitOrOptions} : limitOrOptions, "pending");
  return typeof limitOrOptions === "number" ? result.items : result;
}

/** Recovery scan for current blocked notices; the pump decides when a fixed recipient is usable again. */
export function listBlockedLeaderNotices(pool: Pool, projectId: string,
  options: {limit: number; cursor?: string}): Promise<LeaderResultNoticePage> {
  return page(pool, projectId, options, "blocked");
}

async function current(pool: Pool, projectId: string, id: string): Promise<LeaderResultNotice> {
  const result = await pool.query(`SELECT ${noticeFrom}
    WHERE n.project_id=$1 AND n.notice_id=$2`, [projectId, id]);
  if (!result.rows[0]) throw new DomainError("NOTICE_NOT_FOUND", "Leader notice was not found in this project");
  return notice(result.rows[0]);
}

/** A recoverable admission reason. It clears when the same fixed notice becomes eligible. */
export async function setLeaderNoticePendingReason(pool: Pool, projectId: string, id: string,
  reason: string | null): Promise<LeaderResultNotice> {
  const value = reason?.trim() || null;
  if (value && (!/^[A-Z0-9_:]{1,160}$/.test(value)))
    throw new DomainError("INVALID_REASON", "Leader notice reason must be a safe category");
  const result = await pool.query(`UPDATE leader_result_notice SET blocked_reason=$3,updated_at=now()
    WHERE project_id=$1 AND notice_id=$2 AND state='pending'
      AND blocked_reason IS DISTINCT FROM $3 RETURNING notice_id`, [projectId, id, value]);
  if (result.rows[0]) return current(pool, projectId, id);
  const prior = await current(pool, projectId, id);
  if (prior.state === "pending" && prior.blockedReason === value) return prior;
  throw new DomainError("NOTICE_STATE_CONFLICT", "Only a pending notice can change its admission reason");
}

export async function markLeaderNoticeBlocked(pool: Pool, projectId: string, id: string, reason: string): Promise<LeaderResultNotice> {
  const trimmed = reason.trim();
  if (!trimmed) throw new DomainError("INVALID_REASON", "A blocked notice needs a reason");
  const result = await pool.query(`UPDATE leader_result_notice SET state='blocked',blocked_reason=$3,updated_at=now()
    WHERE project_id=$1 AND notice_id=$2 AND state='pending' RETURNING notice_id`, [projectId, id, trimmed]);
  if (result.rows[0]) return current(pool, projectId, id);
  const prior = await current(pool, projectId, id);
  if (prior.state === "blocked" && prior.blockedReason === trimmed) return prior;
  throw new DomainError("NOTICE_STATE_CONFLICT", "Leader notice already has a different disposition");
}

/** Reconsider a blocked notice after configuration or receiver recovery. Fixed IDs are retained. */
export async function requeueLeaderNotice(pool: Pool, projectId: string, id: string): Promise<LeaderResultNotice> {
  const result = await pool.query(`UPDATE leader_result_notice SET state='pending',blocked_reason=NULL,updated_at=now()
    WHERE project_id=$1 AND notice_id=$2 AND state='blocked' RETURNING notice_id`, [projectId, id]);
  if (result.rows[0]) return current(pool, projectId, id);
  const prior = await current(pool, projectId, id);
  if (prior.state === "pending") return prior;
  throw new DomainError("NOTICE_STATE_CONFLICT", "Linked Leader notice cannot be requeued");
}

export async function linkLeaderNoticeMessage(pool: Pool, projectId: string, id: string,
  messageId: string, sessionId: string): Promise<LeaderResultNotice> {
  const result = await pool.query(`UPDATE leader_result_notice n SET state='linked',linked_session_id=$4,updated_at=now()
    WHERE n.project_id=$1 AND n.notice_id=$2 AND n.state='pending' AND n.message_id=$3
      AND n.recipient_session_id=$4
      AND EXISTS (SELECT 1 FROM session_message m WHERE m.project_id=n.project_id
        AND m.message_id=n.message_id AND m.operation_id=n.operation_id AND m.target_kind='owned'
        AND m.session_id=$4 AND m.sender_actor_id=n.sender_actor_id
        AND m.context_task_id=n.task_id AND m.context_task_revision_id=n.task_revision_id)
    RETURNING n.notice_id`, [projectId, id, messageId, sessionId]);
  if (result.rows[0]) return current(pool, projectId, id);
  const prior = await current(pool, projectId, id);
  if (prior.messageId !== messageId) throw new DomainError("NOTICE_MESSAGE_MISMATCH", "Message ID must equal the notice's fixed ID");
  if (prior.state === "linked" && prior.linkedSessionId === sessionId) return prior;
  if (prior.state !== "pending") throw new DomainError("NOTICE_STATE_CONFLICT", "Leader notice already has a different disposition");
  throw new DomainError("NOTICE_MESSAGE_UNCONFIRMED", "The fixed owned message and Task context must be saved before linking");
}

export async function getLeaderNoticeByMessageId(pool: Pool, projectId: string,
  messageId: string): Promise<LeaderResultNotice | null> {
  const result = await pool.query(`SELECT ${noticeFrom}
    WHERE n.project_id=$1 AND n.message_id=$2`, [projectId, messageId]);
  return result.rows[0] ? notice(result.rows[0]) : null;
}

/** A previous Leader's native processing/unknown notice blocks a replacement target. */
export async function hasInFlightLeaderNoticeMessage(pool: Pool, projectId: string,
  sessionId: string): Promise<boolean> {
  const result = await pool.query(`SELECT EXISTS(SELECT 1 FROM leader_result_notice n
    JOIN session_message m ON m.project_id=n.project_id AND m.message_id=n.message_id
    WHERE n.project_id=$1 AND n.recipient_session_id<>$2
      AND m.state IN ('processing','unknown')) AS busy`, [projectId, sessionId]);
  return result.rows[0]?.busy === true;
}

/** Pin one exact sender and owned recipient before attempting the saved command. */
export async function pinLeaderNoticeRecipient(pool: Pool, projectId: string, id: string,
  recipient: LeaderNoticeRecipient): Promise<LeaderResultNotice | null> {
  const result = await pool.query(`UPDATE leader_result_notice n SET recipient_session_id=$3,
    receiver_role_id=$4,receiver_actor_id=$5,sender_actor_id=$6,updated_at=now()
    WHERE n.project_id=$1 AND n.notice_id=$2 AND n.state='pending' AND n.recipient_session_id IS NULL
      AND (n.kind<>'task_todo' OR EXISTS (SELECT 1 FROM task t
        WHERE t.project_id=n.project_id AND t.task_id=n.task_id
        AND t.current_revision_id=n.task_revision_id))
      AND EXISTS (SELECT 1 FROM runtime_session s WHERE s.project_id=n.project_id AND s.session_id=$3
        AND s.role_id=$4 AND s.state='ready')
    RETURNING n.notice_id`, [projectId, id, recipient.sessionId, recipient.receiverRoleId,
      recipient.receiverActorId, recipient.senderActorId]);
  if (result.rows[0]) return current(pool, projectId, id);
  const prior = await pool.query("SELECT 1 FROM leader_result_notice WHERE project_id=$1 AND notice_id=$2", [projectId, id]);
  return prior.rows[0] ? current(pool, projectId, id) : null;
}
