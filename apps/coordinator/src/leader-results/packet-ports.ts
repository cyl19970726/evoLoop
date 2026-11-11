import type { Pool } from "pg";
import { PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import type { LeaderNoticeCandidate, LeaderNoticePacket, LeaderNoticePacketAttempt } from "@evoloop/contracts/leader-notice-packets";
import { PgLeaderNoticePackets } from "@evoloop/adapter-postgres/leader-notice-packets";

/** Everything the packet pump reads. Writes go through ordinary commands, so they are journalled and replay safely. */
export interface LeaderPacketPorts {
  /** One page of waiting notices (earliest first) and how long the earliest of all has waited; page through to reach items behind stale or unknown ones. */
  candidates(projectId: string, page?: { limit: number; offset: number }): Promise<{ items: LeaderNoticeCandidate[]; earliestWaitSeconds: number | null }>;
  /** Open packets of the project; with a Session only that Session's. */
  openPackets(projectId: string, sessionId?: string): Promise<LeaderNoticePacket[]>;
  blockedPackets(projectId: string): Promise<LeaderNoticePacket[]>;
  /** Copy the private-configuration switch into the database (new notices follow it) and, when off, return unpacked notices to the old path. */
  syncMode(projectId: string, enabled: boolean): Promise<void>;
  attempt(projectId: string, packetId: string): Promise<LeaderNoticePacketAttempt | null>;
  packetByMessage(projectId: string, messageId: string): Promise<LeaderNoticePacket | null>;
  leaderState(projectId: string, sessionId: string, exceptMessageId?: string): Promise<{ busy: boolean; humanMessageQueued: boolean; gateOpen: boolean; gateBlocked: boolean }>;
  message(projectId: string, messageId: string): Promise<{ id: string; version: number; state: string; senderActorId: string; nativeTurnId: string | null; processingState: string | null } | null>;
}

/** The ports on the real database. */
export function pgLeaderPacketPorts(pool: Pool, uow: PostgresUnitOfWork): LeaderPacketPorts {
  const withStore = async <T>(projectId: string, fn: (store: PgLeaderNoticePackets, client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try { return await fn(new PgLeaderNoticePackets(client, projectId), client); } finally { client.release(); }
  };
  void uow;
  return {
    candidates: (projectId, page = { limit: 50, offset: 0 }) => withStore(projectId, async store => ({ items: await store.listLeaderNoticeCandidates(page.limit, page.offset), earliestWaitSeconds: await store.earliestWaitSeconds() })),
    openPackets: (projectId, sessionId) => withStore(projectId, store => store.listOpenLeaderNoticePackets(sessionId)),
    blockedPackets: projectId => withStore(projectId, store => store.listBlockedLeaderNoticePackets()),
    syncMode: (projectId, enabled) => withStore(projectId, async store => { await store.setPacketMode(enabled); if (!enabled) await store.revertUnpackedNotices(); }),
    attempt: (projectId, packetId) => withStore(projectId, async store => (await store.listLeaderNoticePacketAttempts(packetId)).at(-1) ?? null),
    packetByMessage: (projectId, messageId) => withStore(projectId, store => store.getLeaderNoticePacketByMessage(messageId)),
    leaderState: (projectId, sessionId, exceptMessageId) => withStore(projectId, async (_store, client) => {
      const busy = await client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2 AND state IN ('requested','dispatching','running','unknown')
        UNION ALL SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2 AND state IN ('dispatching','running','unknown')
          AND message_id IS DISTINCT FROM $3::uuid LIMIT 1`, [projectId, sessionId, exceptMessageId ?? null]);
      // A message a person sent that is still waiting: packet messages do not count, and neither do the two kinds the message pump skips
      // (blocked for want of its sender's grant; superseded by a Run stop and not yet confirmed): they cannot start however long they wait.
      const human = await client.query(`SELECT 1 FROM session_message m WHERE m.project_id=$1 AND m.session_id=$2 AND m.target_kind='owned' AND m.state='queued'
        AND (m.blocked_reason IS NULL OR m.blocked_reason NOT LIKE 'MESSAGE_GRANT_MISSING:%')
        AND (m.superseded_at IS NULL OR m.superseded_confirmed_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM leader_notice_packet_attempt a WHERE a.project_id=m.project_id AND a.message_id=m.message_id)
        AND NOT EXISTS(SELECT 1 FROM leader_result_notice n WHERE n.project_id=m.project_id AND n.message_id=m.message_id AND n.state='linked' AND NOT n.via_packet) LIMIT 1`, [projectId, sessionId]);
      const gate = (await client.query("SELECT phase FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2", [projectId, sessionId])).rows[0]?.phase as string | undefined;
      return { busy: !!busy.rowCount, humanMessageQueued: !!human.rowCount, gateOpen: gate === undefined || gate === "open", gateBlocked: gate === "blocked" };
    }),
    message: (projectId, messageId) => withStore(projectId, async (_store, client) => {
      const r = (await client.query(`SELECT m.message_id,m.version,m.state,m.sender_actor_id,p.native_turn_id,p.state AS processing_state FROM session_message m
        LEFT JOIN session_message_processing p ON p.project_id=m.project_id AND p.message_id=m.message_id WHERE m.project_id=$1 AND m.message_id=$2`, [projectId, messageId])).rows[0];
      return r ? { id: r.message_id, version: r.version, state: r.state, senderActorId: r.sender_actor_id, nativeTurnId: r.native_turn_id, processingState: r.processing_state } : null;
    }),
  };
}
