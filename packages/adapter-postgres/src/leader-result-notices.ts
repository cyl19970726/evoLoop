import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { DomainError } from "@evoloop/contracts/ports";
import type { LeaderNotice, LeaderNoticeKind, LeaderNoticePage, LeaderNoticeState,
  LeaderNoticeRecoveryLink } from "@evoloop/contracts/leader-notices";
import { leaderNoticePostCommand } from "@evoloop/contracts/leader-notices";

export interface LeaderNoticeListOptions { taskId?: string; limit: number; cursor?: string }
export interface LeaderNoticeRecipient {
  sessionId: string; receiverRoleId: string; receiverActorId: string; senderActorId: string;
}
export type LeaderResultNotice = LeaderNotice & { recipient: LeaderNoticeRecipient | null; recovery?: LeaderNoticeRecoveryLink };
export type RecoveredLeaderNotice = LeaderResultNotice & { recovery: LeaderNoticeRecoveryLink };
export type LeaderResultNoticePage = Omit<LeaderNoticePage, "items"> & { items: LeaderResultNotice[] };

type Row = Record<string, unknown>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string,unknown>)
    .filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const encoded=JSON.stringify(value);
  if(encoded===undefined)throw new DomainError("INVALID_COMMAND","Unsupported notice command value");
  return encoded;
}
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
  recovery: recoveryLink(row),
});

const recoveryLink = (row: Row): LeaderNoticeRecoveryLink => ({
  parentNoticeId: row.recovery_parent_notice_id === null ? null : String(row.recovery_parent_notice_id),
  replacementNoticeId: row.recovery_replacement_notice_id === null ? null : String(row.recovery_replacement_notice_id),
  dispositionActorId: row.recovery_actor_id === null ? null : String(row.recovery_actor_id),
  dispositionReason: row.recovery_reason === null ? null : String(row.recovery_reason),
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
        ($5::text='pending' OR n.kind<>'task_todo' OR t.current_revision_id=n.task_revision_id)))
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

export function getLeaderNotice(pool: Pool, projectId: string, noticeId: string): Promise<LeaderResultNotice> {
  return current(pool, projectId, noticeId);
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
    WHERE project_id=$1 AND notice_id=$2 AND state='blocked' AND recovery_replacement_notice_id IS NULL
      AND blocked_reason NOT LIKE 'MESSAGE_POST_REJECTED:%' RETURNING notice_id`, [projectId, id]);
  if (result.rows[0]) return current(pool, projectId, id);
  const prior = await current(pool, projectId, id);
  if (prior.state === "pending") return prior;
  throw new DomainError("NOTICE_STATE_CONFLICT", "Rejected or replaced Leader notice cannot be requeued");
}

/** Explicitly replace one confirmed rejected post; the old notice and operation remain blocked and immutable. */
export async function recoverRejectedLeaderNotice(pool: Pool, projectId: string, originalNoticeId: string,
  expectedOperationId: string, newNoticeId: string, newMessageId: string, newOperationId: string,
  dispositionActorId: string, reason: string): Promise<RecoveredLeaderNotice> {
  const actor = dispositionActorId.trim(), explanation = reason.trim();
  if (!actor || actor.length > 200 || !explanation || explanation.length > 4000)
    throw new DomainError("INVALID_RECOVERY_DISPOSITION", "Recovery needs a reviewer actor and a reason of at most 4000 characters");
  if (new Set([originalNoticeId, expectedOperationId, newNoticeId, newMessageId, newOperationId]
    .map(id => id.toLowerCase())).size !== 5)
    throw new DomainError("INVALID_RECOVERY_IDS", "Recovery needs distinct original, notice, message and operation IDs");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const originalResult = await client.query(`SELECT n.*,o.actor_id AS recorded_sender,o.command_type,o.command_hash,
      o.result->>'status' AS operation_status,o.result->>'code' AS rejection_code,
      o.result->>'operationId' AS result_operation_id,
      m.state AS message_state,p.state AS processing_state
      FROM leader_result_notice n
      LEFT JOIN operation_journal o ON o.project_id=n.project_id AND o.operation_id=n.operation_id
      LEFT JOIN session_message m ON m.project_id=n.project_id AND m.message_id=n.message_id
      LEFT JOIN session_message_processing p ON p.project_id=n.project_id AND p.message_id=n.message_id
      WHERE n.project_id=$1 AND n.notice_id=$2 FOR UPDATE OF n`, [projectId, originalNoticeId]);
    const original = originalResult.rows[0];
    if (!original) throw new DomainError("NOTICE_NOT_FOUND", "Leader notice was not found in this project");
    if (original.operation_id !== expectedOperationId)
      throw new DomainError("NOTICE_OPERATION_MISMATCH", "The original notice operation changed");
    if (original.recovery_replacement_notice_id !== null) {
      if (original.recovery_replacement_notice_id !== newNoticeId || original.recovery_actor_id !== actor ||
        original.recovery_reason !== explanation)
        throw new DomainError("NOTICE_RECOVERY_CONFLICT", "This rejected notice already has a different replacement");
      const replay = await client.query(`SELECT ${noticeFrom}
        WHERE n.project_id=$1 AND n.notice_id=$2 AND n.recovery_parent_notice_id=$3
          AND n.message_id=$4 AND n.operation_id=$5`,
        [projectId, newNoticeId, originalNoticeId, newMessageId, newOperationId]);
      if (!replay.rows[0]) throw new DomainError("NOTICE_RECOVERY_CONFLICT", "Replacement IDs do not match the saved disposition");
      await client.query("COMMIT");
      return { ...notice(replay.rows[0]), recovery: recoveryLink(replay.rows[0]) };
    }
    const fixedCommand=original.recipient_session_id && original.sender_actor_id
      ? leaderNoticePostCommand({projectId:String(original.project_id),kind:original.kind as LeaderNoticeKind,
          sourceEventId:String(original.source_event_id),occurredAt:iso(original.occurred_at),
          taskId:String(original.task_id),taskRevisionId:String(original.task_revision_id),
          sourceActorId:original.source_actor_id===null?null:String(original.source_actor_id),
          sourceSessionId:original.source_session_id===null?null:String(original.source_session_id),
          sourceRef:String(original.source_ref),operationId:String(original.operation_id),
          messageId:String(original.message_id)},String(original.recipient_session_id)):null;
    const fixedHash=fixedCommand?createHash("sha256").update(canonical({
      actorId:original.sender_actor_id,command:fixedCommand})).digest("hex"):null;
    if (original.state !== "blocked" || original.blocked_reason !== `MESSAGE_POST_REJECTED:${original.rejection_code}` ||
      original.rejection_code === null || original.recorded_sender !== original.sender_actor_id ||
      original.command_type !== "session.message.post" || original.operation_status !== "rejected" ||
      original.result_operation_id !== original.operation_id || original.command_hash !== fixedHash)
      throw new DomainError("NOTICE_RECOVERY_UNCONFIRMED", "The original message post needs a matching saved rejection");
    if (["queued", "processing", "unknown"].includes(original.message_state) ||
      ["dispatching", "running", "unknown"].includes(original.processing_state))
      throw new DomainError("NOTICE_MESSAGE_IN_FLIGHT", "The original message is still in flight");
    await client.query(`INSERT INTO leader_result_notice(project_id,notice_id,kind,source_event_id,task_id,
      task_revision_id,source_session_id,source_actor_id,source_ref,occurred_at,message_id,operation_id,
      recovery_parent_notice_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$13,$10,$11,$12)`,
      [projectId,newNoticeId,original.kind,original.source_event_id,original.task_id,
        original.task_revision_id,original.source_session_id,original.source_actor_id,original.source_ref,
        newMessageId,newOperationId,originalNoticeId,original.occurred_at]);
    await client.query(`UPDATE leader_result_notice SET recovery_replacement_notice_id=$3,
      recovery_actor_id=$4,recovery_reason=$5,updated_at=now()
      WHERE project_id=$1 AND notice_id=$2 AND state='blocked' AND recovery_replacement_notice_id IS NULL`,
      [projectId,originalNoticeId,newNoticeId,actor,explanation]);
    const created = await client.query(`SELECT ${noticeFrom} WHERE n.project_id=$1 AND n.notice_id=$2`,
      [projectId,newNoticeId]);
    await client.query("COMMIT");
    return { ...notice(created.rows[0]!), recovery: recoveryLink(created.rows[0]!) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
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

/** Retire a pending todo that has no saved post. Task locking keeps the
 * current revision fixed while its replacement and historical disposition
 * are committed together. */
export async function disposeStalePendingTodo(pool: Pool, projectId: string,
  noticeId: string): Promise<"disposed"|"current"|"posted"|"linked"> {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[projectId]);
    const origin=await client.query(`SELECT task_id,message_id FROM leader_result_notice
      WHERE project_id=$1 AND notice_id=$2 AND kind='task_todo'`,[projectId,noticeId]);
    if(!origin.rows[0])throw new DomainError("NOTICE_IDENTITY_MISMATCH","Todo notice was not found");
    const task=await client.query(`SELECT t.state,t.current_revision_id,r.actor_id,r.created_at
      FROM task t JOIN task_revision r ON r.project_id=t.project_id AND r.task_id=t.task_id
        AND r.revision_id=t.current_revision_id
      WHERE t.project_id=$1 AND t.task_id=$2 FOR UPDATE OF t`,[projectId,origin.rows[0].task_id]);
    if(!task.rows[0])throw new DomainError("TASK_UNAVAILABLE","Todo source Task is unavailable");
    const old=await client.query(`SELECT * FROM leader_result_notice
      WHERE project_id=$1 AND notice_id=$2 FOR UPDATE`,[projectId,noticeId]);
    const notice=old.rows[0];
    if(notice?.state!=="pending"){
      await client.query("COMMIT");return "current";
    }
    const saved=await client.query(`SELECT * FROM session_message WHERE project_id=$1 AND message_id=$2`,
      [projectId,notice.message_id]);
    if(saved.rowCount){
      const message=saved.rows[0];
      const fixed=notice.recipient_session_id&&notice.sender_actor_id
        ? leaderNoticePostCommand({projectId,kind:notice.kind as LeaderNoticeKind,
            sourceEventId:String(notice.source_event_id),occurredAt:iso(notice.occurred_at),
            taskId:String(notice.task_id),taskRevisionId:String(notice.task_revision_id),
            sourceActorId:notice.source_actor_id===null?null:String(notice.source_actor_id),
            sourceSessionId:notice.source_session_id===null?null:String(notice.source_session_id),
            sourceRef:String(notice.source_ref),operationId:String(notice.operation_id),
            messageId:String(notice.message_id)},String(notice.recipient_session_id)):null;
      const operation=await client.query(`SELECT actor_id,command_type,command_hash,result->>'status' AS status
        FROM operation_journal WHERE project_id=$1 AND operation_id=$2`,[projectId,notice.operation_id]);
      const journal=operation.rows[0];
      if(fixed&&journal?.actor_id===notice.sender_actor_id&&journal.command_type==='session.message.post'&&
        journal.status==='applied'&&journal.command_hash===createHash('sha256').update(canonical({
          actorId:notice.sender_actor_id,command:fixed})).digest('hex')&&
        message.operation_id===notice.operation_id&&message.sender_actor_id===notice.sender_actor_id&&
        message.target_kind==='owned'&&message.session_id===notice.recipient_session_id&&
        message.context_task_id===notice.task_id&&message.context_task_revision_id===notice.task_revision_id&&
        message.content===fixed.content){
        await client.query(`UPDATE leader_result_notice SET state='linked',linked_session_id=$3,updated_at=now()
          WHERE project_id=$1 AND notice_id=$2 AND state='pending'`,
          [projectId,noticeId,notice.recipient_session_id]);
        await client.query("COMMIT");return "linked";
      }
      await client.query("COMMIT");return "posted";
    }
    const t=task.rows[0];
    const currentRevision=String(t.current_revision_id);
    const assignment=await client.query(`SELECT EXISTS(SELECT 1 FROM task_session_assignment
      WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND state<>'released') AS assigned`,
      [projectId,origin.rows[0].task_id,currentRevision]);
    const arranged=assignment.rows[0]?.assigned===true;
    if(t.state==="todo"&&currentRevision===notice.task_revision_id&&!arranged){
      await client.query("COMMIT");return "current";
    }
    const refresh=t.state==="todo"&&currentRevision!==notice.task_revision_id&&!arranged&&
      !await hasCurrentTodoReview(client,projectId,origin.rows[0].task_id,currentRevision);
    if(refresh)await enqueueCurrentTodo(client,projectId,origin.rows[0].task_id,currentRevision,t);
    const reason=t.state!=="todo"?"TODO_SOURCE_NOT_TODO":
      arranged?"TODO_SOURCE_ASSIGNED":refresh?"TODO_SOURCE_SUPERSEDED_REFRESHED":"TODO_SOURCE_SUPERSEDED_HANDLED";
    await client.query(`UPDATE leader_result_notice SET state='blocked',blocked_reason=$3,updated_at=now()
      WHERE project_id=$1 AND notice_id=$2 AND state='pending'`,[projectId,noticeId,reason]);
    await client.query("COMMIT");
    return "disposed";
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function hasCurrentTodoReview(client: import("pg").PoolClient, projectId:string,
  taskId:string, revisionId:string):Promise<boolean>{
  const result=await client.query(`SELECT EXISTS(SELECT 1 FROM leader_work_review r
    JOIN task t ON t.project_id=r.project_id AND t.task_id=r.task_id
      AND t.version=r.task_version AND t.current_revision_id=r.task_revision_id
    WHERE r.project_id=$1 AND r.task_id=$2 AND r.task_revision_id=$3
      AND NOT EXISTS(SELECT 1 FROM leader_work_change c
        WHERE c.project_id=r.project_id AND c.sequence>r.reviewed_change_sequence
          AND c.entity_kind<>'review' AND (c.task_id=r.task_id OR
            (c.entity_kind IN ('task','closure','queue') AND EXISTS(
              SELECT 1 FROM task_dependency d WHERE d.project_id=r.project_id
                AND d.task_id=r.task_id AND d.depends_on_task_id=c.task_id))))) AS reviewed`,
    [projectId,taskId,revisionId]);
  return result.rows[0]?.reviewed===true;
}

async function enqueueCurrentTodo(client: import("pg").PoolClient, projectId:string,
  taskId:string, revisionId:string, revision:{actor_id:string;created_at:Date}):Promise<void>{
  await client.query(`INSERT INTO leader_result_notice(project_id,kind,source_event_id,task_id,
    task_revision_id,source_session_id,source_actor_id,source_ref,occurred_at)
    VALUES($1,'task_todo',$3,$2,$3,NULL,$4,$5,$6)
    ON CONFLICT DO NOTHING`,
    [projectId,taskId,revisionId,revision.actor_id,`task:${taskId}@${revisionId}`,revision.created_at]);
}

/** Retire only the queued, never-started message for a superseded todo source.
 * The old linked notice remains evidence of the original post. Its message
 * records the disposition; a still-unarranged current todo receives one
 * source-revision-bound notice in the same transaction. */
export async function disposeStaleTodoMessage(pool: Pool, projectId: string,
  noticeId: string, messageId: string): Promise<"disposed"|"in_flight"|"current"> {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[projectId]);
    const origin=await client.query(`SELECT task_id FROM leader_result_notice
      WHERE project_id=$1 AND notice_id=$2 AND message_id=$3 AND kind='task_todo'`,
      [projectId,noticeId,messageId]);
    if(!origin.rows[0])throw new DomainError("NOTICE_IDENTITY_MISMATCH","Todo notice and message do not match");
    // Task writers also take this row lock, so the observed current revision
    // cannot move between disposition and optional replacement creation.
    const task=await client.query(`SELECT t.state,t.current_revision_id,r.actor_id,r.created_at
      FROM task t JOIN task_revision r ON r.project_id=t.project_id AND r.task_id=t.task_id
        AND r.revision_id=t.current_revision_id
      WHERE t.project_id=$1 AND t.task_id=$2 FOR UPDATE OF t`,[projectId,origin.rows[0].task_id]);
    if(!task.rows[0])throw new DomainError("TASK_UNAVAILABLE","Todo source Task is unavailable");
    const old=await client.query(`SELECT state,task_revision_id,recipient_session_id,sender_actor_id
      FROM leader_result_notice WHERE project_id=$1 AND notice_id=$2 AND message_id=$3 FOR UPDATE`,
      [projectId,noticeId,messageId]);
    const notice=old.rows[0];
    if(!notice||notice.state!=="linked"||!notice.recipient_session_id||!notice.sender_actor_id){
      await client.query("COMMIT");return "current";
    }
    const message=await client.query(`SELECT state,version,session_id,sender_actor_id,context_task_id,
      context_task_revision_id FROM session_message WHERE project_id=$1 AND message_id=$2 FOR UPDATE`,
      [projectId,messageId]);
    const saved=message.rows[0];
    if(!saved||saved.state!=="queued"){
      await client.query("COMMIT");return "in_flight";
    }
    if(saved.session_id!==notice.recipient_session_id||saved.sender_actor_id!==notice.sender_actor_id||
      saved.context_task_id!==origin.rows[0].task_id||
      saved.context_task_revision_id!==notice.task_revision_id)
      throw new DomainError("NOTICE_IDENTITY_MISMATCH","Saved todo message differs from its fixed notice");
    const started=await client.query(`SELECT EXISTS(SELECT 1 FROM session_message_processing
      WHERE project_id=$1 AND message_id=$2) AS started`,[projectId,messageId]);
    if(started.rows[0]?.started){
      await client.query("COMMIT");return "in_flight";
    }
    const t=task.rows[0];
    const currentRevision=String(t.current_revision_id);
    const assignment=await client.query(`SELECT EXISTS(SELECT 1 FROM task_session_assignment
      WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND state<>'released') AS assigned`,
      [projectId,origin.rows[0].task_id,currentRevision]);
    const arranged=assignment.rows[0]?.assigned===true;
    if(t.state==="todo"&&currentRevision===notice.task_revision_id&&!arranged){
      await client.query("COMMIT");return "current";
    }
    const refresh=t.state==="todo"&&currentRevision!==notice.task_revision_id&&!arranged&&
      !await hasCurrentTodoReview(client,projectId,origin.rows[0].task_id,currentRevision);
    const reason=t.state!=="todo"?"TODO_SOURCE_NOT_TODO":
      arranged?"TODO_SOURCE_ASSIGNED":refresh?"TODO_SOURCE_SUPERSEDED_REFRESHED":"TODO_SOURCE_SUPERSEDED_HANDLED";
    if(refresh)await enqueueCurrentTodo(client,projectId,origin.rows[0].task_id,currentRevision,t);
    const changed=await client.query(`UPDATE session_message SET state='cancelled',version=version+1,
      blocked_reason=$4,updated_at=now() WHERE project_id=$1 AND message_id=$2
      AND state='queued' AND version=$3`,
      [projectId,messageId,saved.version,reason]);
    if(changed.rowCount!==1)throw new DomainError("VERSION_CONFLICT","Todo message changed during disposition");
    await client.query("COMMIT");
    return "disposed";
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
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
