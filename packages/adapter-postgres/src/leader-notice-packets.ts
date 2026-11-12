import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import { judgeTodoNoticeInTransaction } from "./leader-result-notices.js";
import type { LeaderNoticeCandidate, LeaderNoticePacket, LeaderNoticePacketAttempt, LeaderNoticePacketItem, LeaderNoticePacketTransaction } from "@evoloop/contracts/leader-notice-packets";

type Row = QueryResultRow;
const iso = (value: Date | string | null): string | null => value === null ? null : value instanceof Date ? value.toISOString() : value;
const packetOf = (r: Row): LeaderNoticePacket => ({ projectId: r.project_id, id: r.packet_id, sessionId: r.session_id, itemCount: r.item_count,
  byteCount: r.byte_count, contentHash: r.content_hash, content: r.content, messageId: r.message_id, messageOperationId: r.message_operation_id, state: r.state, createdAt: iso(r.created_at)!, sentAt: iso(r.sent_at),
  deliveredAt: iso(r.delivered_at), endedAt: iso(r.ended_at) });
const itemOf = (r: Row): LeaderNoticePacketItem => ({ projectId: r.project_id, packetId: r.packet_id, noticeId: r.notice_id, position: r.position,
  state: r.state, readBefore: r.read_before, requeue: r.requeue, disposition: r.disposition, deferUntil: iso(r.defer_until),
  handledBy: r.handled_by, handledReason: r.handled_reason, withdrawnReason: r.withdrawn_reason, expectedTurnId: r.expected_turn_id,
  actualTurnId: r.actual_turn_id, evidence: r.evidence, version: r.version, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! });
/** What one packet message may carry (design: 8 KB); the database holds the same limit. */
export const PACKET_BYTE_LIMIT = 8192;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Candidates: a notice never packaged, a returned item (unknown, requeue), or a deferred one whose time has come. */
const CANDIDATES = `
  SELECT n.*, i.item_state, i.item_read_before, i.item_version, i.eligible_at,
    EXTRACT(EPOCH FROM (now() - COALESCE(i.eligible_at, n.occurred_at))) AS waited_seconds
  FROM leader_result_notice n
  LEFT JOIN LATERAL (
    SELECT x.state AS item_state, x.read_before AS item_read_before, x.version AS item_version,
      CASE WHEN x.state='handled' THEN x.defer_until ELSE x.updated_at END AS eligible_at,
      x.requeue, x.disposition, x.defer_until, p.state AS packet_state
    FROM leader_notice_packet_item x JOIN leader_notice_packet p ON p.project_id=x.project_id AND p.packet_id=x.packet_id
    WHERE x.project_id=n.project_id AND x.notice_id=n.notice_id ORDER BY x.created_at DESC, x.packet_id DESC LIMIT 1) i ON true
  WHERE n.project_id=$1 AND n.via_packet AND n.blocked_reason IS NULL AND n.state IN ('pending','linked')
    AND (i.item_state IS NULL
      OR (i.item_state='unknown' AND i.requeue AND i.packet_state<>'blocked')
      OR (i.item_state='handled' AND i.disposition='deferred' AND i.defer_until<=now()))`;

export class PgLeaderNoticePackets implements LeaderNoticePacketTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  async listLeaderNoticeCandidates(limit: number, offset = 0): Promise<LeaderNoticeCandidate[]> {
    const r = await this.client.query(`${CANDIDATES} ORDER BY COALESCE(i.eligible_at,n.occurred_at), n.notice_id LIMIT $2 OFFSET $3`, [this.projectId, limit, offset]);
    return r.rows.map(row => ({ noticeId: row.notice_id, kind: row.kind, sourceEventId: row.source_event_id, taskId: row.task_id,
      taskRevisionId: row.task_revision_id, sourceRef: row.source_ref, occurredAt: iso(row.occurred_at)!, sourceActorId: row.source_actor_id,
      sourceSessionId: row.source_session_id, state: row.state, readBefore: row.item_read_before === true, version: row.item_version ?? 0,
      waitedSeconds: Number(row.waited_seconds) }));
  }
  /** Seconds the earliest candidate has waited, by the database clock (null when there is none). */
  async earliestWaitSeconds(): Promise<number | null> {
    const r = await this.client.query(`SELECT EXTRACT(EPOCH FROM (now()-min(COALESCE(eligible_at,occurred_at)))) AS waited FROM (${CANDIDATES}) c`, [this.projectId]);
    return r.rows[0]?.waited === null || r.rows[0]?.waited === undefined ? null : Number(r.rows[0].waited);
  }
  async getLeaderNoticePacket(packetId: string): Promise<LeaderNoticePacket | null> {
    const r = await this.client.query("SELECT * FROM leader_notice_packet WHERE project_id=$1 AND packet_id=$2", [this.projectId, packetId]);
    return r.rows[0] ? packetOf(r.rows[0]) : null;
  }
  async getLeaderNoticePacketByMessage(messageId: string): Promise<LeaderNoticePacket | null> {
    const r = await this.client.query(`SELECT p.* FROM leader_notice_packet p JOIN leader_notice_packet_attempt a ON a.project_id=p.project_id AND a.packet_id=p.packet_id
      WHERE a.project_id=$1 AND a.message_id=$2`, [this.projectId, messageId]);
    return r.rows[0] ? packetOf(r.rows[0]) : null;
  }
  async listOpenLeaderNoticePackets(sessionId?: string): Promise<LeaderNoticePacket[]> {
    const r = await this.client.query(`SELECT * FROM leader_notice_packet WHERE project_id=$1 AND state IN ('building','sent','delivered','unknown')
      AND ($2::uuid IS NULL OR session_id=$2) ORDER BY created_at`, [this.projectId, sessionId ?? null]);
    return r.rows.map(packetOf);
  }
  async listBlockedLeaderNoticePackets(): Promise<LeaderNoticePacket[]> {
    return (await this.client.query("SELECT * FROM leader_notice_packet WHERE project_id=$1 AND state='blocked' ORDER BY created_at", [this.projectId])).rows.map(packetOf);
  }
  /** Copy the private-configuration switch: whether notices created from now on go by packet. */
  async setPacketMode(enabled: boolean): Promise<void> {
    await this.client.query(`INSERT INTO leader_notice_packet_mode(project_id,enabled) VALUES($1,$2)
      ON CONFLICT(project_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now() WHERE leader_notice_packet_mode.enabled IS DISTINCT FROM EXCLUDED.enabled`, [this.projectId, enabled]);
  }
  /** With the switch off, notices that no packet has touched yet go back to the one-notice-one-message path. */
  async revertUnpackedNotices(): Promise<number> {
    const r = await this.client.query(`UPDATE leader_result_notice n SET via_packet=false WHERE n.project_id=$1 AND n.via_packet AND n.state='pending' AND n.linked_session_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM leader_notice_packet_item x WHERE x.project_id=n.project_id AND x.notice_id=n.notice_id)`, [this.projectId]);
    return r.rowCount ?? 0;
  }
  async listLeaderNoticePacketItems(packetId: string): Promise<LeaderNoticePacketItem[]> {
    return (await this.client.query("SELECT * FROM leader_notice_packet_item WHERE project_id=$1 AND packet_id=$2 ORDER BY position", [this.projectId, packetId])).rows.map(itemOf);
  }
  async listLeaderNoticePacketAttempts(packetId: string): Promise<LeaderNoticePacketAttempt[]> {
    return (await this.client.query("SELECT * FROM leader_notice_packet_attempt WHERE project_id=$1 AND packet_id=$2 ORDER BY attempt", [this.projectId, packetId])).rows
      .map(r => ({ packetId: r.packet_id, attempt: r.attempt, method: r.method, operationId: r.operation_id, messageId: r.message_id, directInputId: r.direct_input_id, createdAt: iso(r.created_at)! }));
  }
  async getLeaderNoticeItem(noticeId: string): Promise<LeaderNoticePacketItem | null> {
    const r = await this.client.query("SELECT * FROM leader_notice_packet_item WHERE project_id=$1 AND notice_id=$2 ORDER BY created_at DESC, packet_id DESC LIMIT 1", [this.projectId, noticeId]);
    return r.rows[0] ? itemOf(r.rows[0]) : null;
  }

  async buildLeaderNoticePacket(input: Parameters<LeaderNoticePacketTransaction["buildLeaderNoticePacket"]>[0]): Promise<LeaderNoticePacket> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`leader-notice-packet:${this.projectId}:${input.sessionId}`]);
    const withdrawOnly = input.noticeIds.length === 0;
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > PACKET_BYTE_LIMIT) throw new DomainError("PACKET_TOO_LARGE", `A packet carries at most ${PACKET_BYTE_LIMIT} bytes`);
    if (withdrawOnly && input.withdraw.length > 20) throw new DomainError("PACKET_TOO_LARGE", "At most 20 stale items are recorded at a time");
    // The Session takes one packet at a time: the earlier one has to be read or returned first. Withdrawing stale items builds no message, so it is not held.
    if (!withdrawOnly && (await this.listOpenLeaderNoticePackets(input.sessionId)).length) throw new DomainError("PACKET_IN_FLIGHT", "An earlier packet for this Leader Session has not been settled");
    const candidates = new Map((await this.client.query(`${CANDIDATES}`, [this.projectId])).rows.map(r => [r.notice_id as string, r]));
    const wanted = new Set(input.noticeIds), gone = new Set(input.withdraw.map(w => w.noticeId));
    for (const noticeId of [...wanted, ...gone]) if (!candidates.has(noticeId)) throw new DomainError("NOTICE_NOT_PENDING", "A notice is no longer waiting to be sent");
    if (input.noticeIds.some(id => gone.has(id))) throw new DomainError("NOTICE_CONFLICT", "A notice cannot be both sent and withdrawn");
    // Staleness is judged here, in the transaction that decides: an item sent has to be current now; a todo withdrawn has to be out of date
    // now (and then the notice for the Task's current revision is queued, as on the one-notice-one-message path).
    for (const noticeId of input.noticeIds) {
      const row = candidates.get(noticeId)!;
      if (row.kind === "task_todo" && await judgeTodoNoticeInTransaction(this.client, this.projectId, row.task_id, row.task_revision_id, false))
        throw new DomainError("NOTICE_STALE", "A todo notice went out of date while the packet was built");
    }
    const withdraw: Array<{ noticeId: string; reason: string }> = [];
    for (const w of input.withdraw) {
      const row = candidates.get(w.noticeId)!;
      if (row.kind === "task_todo") {
        const reason = await judgeTodoNoticeInTransaction(this.client, this.projectId, row.task_id, row.task_revision_id, true);
        if (!reason) throw new DomainError("NOTICE_CURRENT", "A todo notice that is still current cannot be withdrawn");
        withdraw.push({ noticeId: w.noticeId, reason });
      } else withdraw.push(w);
    }
    if (!withdrawOnly) {
      // The earliest item has waited long enough (database time); a packet is not built early.
      const due = await this.client.query(`SELECT bool_or(now() >= COALESCE(eligible_at,occurred_at) + make_interval(secs => $2)) AS due
        FROM (${CANDIDATES}) c WHERE c.notice_id = ANY($3::uuid[])`, [this.projectId, input.debounceSeconds, input.noticeIds]);
      if (due.rows[0]?.due !== true) throw new DomainError("PACKET_NOT_DUE", "The earliest notice has not waited long enough");
    }
    // A packet of withdrawals only records the withdrawn items; no message exists, so it is born ended.
    await this.client.query(`INSERT INTO leader_notice_packet(project_id,packet_id,session_id,item_count,byte_count,content_hash,content,message_id,message_operation_id,state,created_at,ended_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [this.projectId, input.packetId, input.sessionId, withdrawOnly ? withdraw.length : input.noticeIds.length, bytes, sha(input.content), input.content,
      input.messageId, input.operationId, withdrawOnly ? "withdrawn" : "building", input.at, withdrawOnly ? input.at : null]);
    let position = 0;
    const link = async (noticeId: string) => {
      const row = candidates.get(noticeId)!;
      if (row.state === "pending") {
        // The first packet pins the recipient (the Leader Session) and links the notice to it.
        await this.client.query(`UPDATE leader_result_notice SET recipient_session_id=$3,receiver_role_id=$4,receiver_actor_id=$5,sender_actor_id=$6,
          linked_session_id=$3,state='linked',blocked_reason=NULL,updated_at=GREATEST(updated_at,$7) WHERE project_id=$1 AND notice_id=$2 AND state='pending'`,
        [this.projectId, noticeId, input.sessionId, input.recipient.receiverRoleId, input.recipient.receiverActorId, input.recipient.senderActorId, input.at]);
      }
    };
    for (const noticeId of input.noticeIds) {
      await link(noticeId);
      await this.client.query(`INSERT INTO leader_notice_packet_item(project_id,packet_id,notice_id,position,state,read_before,created_at,updated_at)
        VALUES($1,$2,$3,$4,'pending',$5,$6,$6)`, [this.projectId, input.packetId, noticeId, position++, candidates.get(noticeId)!.item_read_before === true, input.at]);
    }
    // Items found stale while packing never reach the Leader: they are recorded as withdrawn with the reason.
    for (const w of withdraw) {
      await link(w.noticeId);
      await this.client.query(`INSERT INTO leader_notice_packet_item(project_id,packet_id,notice_id,position,state,read_before,withdrawn_reason,created_at,updated_at)
        VALUES($1,$2,$3,$4,'withdrawn',$5,$6,$7,$7)`, [this.projectId, input.packetId, w.noticeId, position++, candidates.get(w.noticeId)!.item_read_before === true, w.reason, input.at]);
    }
    return (await this.getLeaderNoticePacket(input.packetId))!;
  }

  async markLeaderNoticePacketSent(packetId: string, at: string): Promise<LeaderNoticePacket> {
    const r = await this.client.query(`UPDATE leader_notice_packet SET state='sent',sent_at=COALESCE(sent_at,$3) WHERE project_id=$1 AND packet_id=$2 AND state IN ('building','sent') RETURNING *`,
      [this.projectId, packetId, at]);
    if (!r.rows[0]) throw new DomainError("PACKET_STATE", "Only a building packet can be marked sent");
    // The message exists now: the delivery attempt (a new Turn) is recorded against it.
    await this.client.query(`INSERT INTO leader_notice_packet_attempt(project_id,packet_id,attempt,method,operation_id,message_id,created_at)
      VALUES($1,$2,1,'new_turn',$3,$4,$5) ON CONFLICT DO NOTHING`, [this.projectId, packetId, r.rows[0].message_operation_id, r.rows[0].message_id, at]);
    return packetOf(r.rows[0]);
  }

  async observeLeaderNoticePacket(input: Parameters<LeaderNoticePacketTransaction["observeLeaderNoticePacket"]>[0]): Promise<LeaderNoticePacket> {
    const packet = (await this.client.query("SELECT * FROM leader_notice_packet WHERE project_id=$1 AND packet_id=$2 FOR UPDATE", [this.projectId, input.packetId])).rows[0];
    if (!packet) throw new DomainError("NOT_FOUND", "Packet was not found");
    const state = packet.state as string;
    const setItems = (from: string[], to: string, extra = "") => this.client.query(`UPDATE leader_notice_packet_item SET state=$3,actual_turn_id=COALESCE($5,actual_turn_id),
      evidence=COALESCE($6,evidence),version=version+1,updated_at=$4${extra} WHERE project_id=$1 AND packet_id=$2 AND state = ANY($7::text[])`,
      [this.projectId, input.packetId, to, input.at, input.turnId, input.evidence, from]);
    const setPacket = async (next: string, ended: boolean) => packetOf((await this.client.query(`UPDATE leader_notice_packet SET state=$3,
      delivered_at=CASE WHEN $3='delivered' THEN COALESCE(delivered_at,$4) ELSE delivered_at END,ended_at=CASE WHEN $5 THEN COALESCE(ended_at,$4) ELSE ended_at END
      WHERE project_id=$1 AND packet_id=$2 RETURNING *`, [this.projectId, input.packetId, next, input.at, ended])).rows[0]);
    if (["seen", "returned", "withdrawn", "recovered"].includes(state)) return packetOf(packet);   // already settled: a repeat changes nothing
    switch (input.outcome) {
      case "delivered":
        if (!["sent", "building", "unknown"].includes(state)) return packetOf(packet);
        await setItems(["pending"], "delivered", ",expected_turn_id=COALESCE(expected_turn_id,$5)");
        return setPacket("delivered", false);
      case "seen":
        await setItems(["pending", "delivered"], "seen");
        return setPacket("seen", true);
      case "unknown":
        return setPacket("unknown", false);     // never resent: a read-only look at the Turn decides later
      case "withdrawn":
        // The message was withdrawn (a person's message went first, the Leader Session changed, notices were switched off): the items wait for the next
        // packet; one whose Turn had already started may have been read.
        await this.client.query(`UPDATE leader_notice_packet_item SET state='unknown',requeue=true,read_before=(read_before OR state='delivered'),version=version+1,updated_at=$3,evidence=COALESCE($4,evidence)
          WHERE project_id=$1 AND packet_id=$2 AND state IN ('pending','delivered')`, [this.projectId, input.packetId, input.at, input.evidence]);
        return setPacket("withdrawn", true);
      case "failed": {
        // The Turn that read the packet failed. The items go back (marked "may already have been read" once a Turn had started),
        // but behind a closed recovery gate the packet is blocked and its items wait for an explicit recover.
        await this.client.query(`UPDATE leader_notice_packet_item SET state='unknown',requeue=true,read_before=(read_before OR $5),version=version+1,updated_at=$3,evidence=COALESCE($4,evidence)
          WHERE project_id=$1 AND packet_id=$2 AND state IN ('pending','delivered','seen')`, [this.projectId, input.packetId, input.at, input.evidence, input.turnStarted]);
        return setPacket(input.gateBlocked ? "blocked" : "returned", true);
      }
    }
  }

  async handleLeaderNoticeItem(input: Parameters<LeaderNoticePacketTransaction["handleLeaderNoticeItem"]>[0]): Promise<LeaderNoticePacketItem> {
    const item = (await this.client.query(`SELECT * FROM leader_notice_packet_item WHERE project_id=$1 AND notice_id=$2 ORDER BY created_at DESC, packet_id DESC LIMIT 1 FOR UPDATE`,
      [this.projectId, input.noticeId])).rows[0];
    if (!item) throw new DomainError("NOT_FOUND", "This notice was never in a packet");
    // The same decision repeated (same operation) returns what it did; any other repeat has to name the current version.
    if (item.last_operation_id === input.operationId) return itemOf(item);
    if (item.version !== input.expectedVersion) throw new DomainError("VERSION_CONFLICT", "The item changed since you read it", item.version);
    if (!["seen", "delivered"].includes(item.state)) throw new DomainError("ITEM_NOT_READ", "Only an item the Leader's Turn has read can be decided");
    if (input.disposition === "deferred" && !input.notBefore) throw new DomainError("NOT_BEFORE_REQUIRED", "A deferral names the time before which it must not come back");
    const r = await this.client.query(`UPDATE leader_notice_packet_item SET state='handled',disposition=$4,defer_until=$5,handled_by=$6,handled_reason=$7,
      last_operation_id=$8,version=version+1,updated_at=$9 WHERE project_id=$1 AND packet_id=$2 AND notice_id=$3 RETURNING *`,
    [this.projectId, item.packet_id, input.noticeId, input.disposition, input.disposition === "deferred" ? input.notBefore : null, input.actorId, input.reason, input.operationId, input.at]);
    return itemOf(r.rows[0]);
  }

  async recoverLeaderNoticePacket(input: Parameters<LeaderNoticePacketTransaction["recoverLeaderNoticePacket"]>[0]): Promise<LeaderNoticePacket> {
    const packet = (await this.client.query("SELECT * FROM leader_notice_packet WHERE project_id=$1 AND packet_id=$2 FOR UPDATE", [this.projectId, input.packetId])).rows[0];
    if (!packet) throw new DomainError("NOT_FOUND", "Packet was not found");
    if (packet.state === "recovered") return packetOf(packet);
    if (packet.state !== "blocked") throw new DomainError("PACKET_NOT_BLOCKED", "Only a blocked packet is recovered");
    const r = await this.client.query(`UPDATE leader_notice_packet SET state='recovered',ended_at=COALESCE(ended_at,$3) WHERE project_id=$1 AND packet_id=$2 RETURNING *`,
      [this.projectId, input.packetId, input.at]);
    return packetOf(r.rows[0]);
  }
}
