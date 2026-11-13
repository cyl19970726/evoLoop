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
  /** The Leader Session's running primary Turn for a packet to be added to: where it came from, how long it has run, how many packets already went into it. */
  steerFacts(projectId: string, sessionId: string): Promise<LeaderSteerFacts>;
  /** The direct input behind a steered packet (its ID is the packet's message ID), by what the runtime did with it. */
  directInput(projectId: string, inputId: string): Promise<{ state: string; nativeItemId: string | null; actualTurnId: string | null; expectedTurnId: string | null; reason: string | null; createdAt: string } | null>;
  /** How a message-started Turn ended: still running, or completed / failed / unknown. Null: no processing record has this Turn. */
  turnOutcome(projectId: string, sessionId: string, turnId: string): Promise<"running" | "completed" | "failed" | "unknown" | null>;
  message(projectId: string, messageId: string): Promise<{ id: string; version: number; state: string; senderActorId: string; nativeTurnId: string | null; processingState: string | null } | null>;
}

export interface LeaderSteerFacts {
  /** "message": a message (or direct start) is running the Turn; "run": a business Task Run is; "none": idle or not yet bound to a Turn. */
  source: "message" | "run" | "none"; turnId: string | null; elapsedSeconds: number | null; steeredPackets: number;
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
    steerFacts: (projectId, sessionId) => withStore(projectId, async (_store, client) => {
      const run = await client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2 AND state IN ('requested','dispatching','running','unknown') LIMIT 1`, [projectId, sessionId]);
      if (run.rowCount) return { source: "run" as const, turnId: null, elapsedSeconds: null, steeredPackets: 0 };
      const p = (await client.query(`SELECT native_turn_id,state,EXTRACT(EPOCH FROM (now()-started_at))::float AS elapsed FROM session_message_processing
        WHERE project_id=$1 AND session_id=$2 AND state IN ('dispatching','running','unknown') LIMIT 1`, [projectId, sessionId])).rows[0];
      if (!p || p.state !== "running" || !p.native_turn_id) return { source: "none" as const, turnId: null, elapsedSeconds: null, steeredPackets: 0 };
      const n = (await client.query(`SELECT count(*)::integer AS n FROM leader_notice_packet_attempt a JOIN session_direct_input d ON d.project_id=a.project_id AND d.input_id=a.direct_input_id
        JOIN leader_notice_packet k ON k.project_id=a.project_id AND k.packet_id=a.packet_id
        WHERE a.project_id=$1 AND a.method='steer' AND k.session_id=$2 AND k.state NOT IN ('withdrawn') AND d.expected_turn_id=$3 AND d.state IN ('accepted','unknown','attempted')`,
      [projectId, sessionId, p.native_turn_id])).rows[0].n;
      return { source: "message" as const, turnId: p.native_turn_id as string, elapsedSeconds: p.elapsed as number, steeredPackets: n as number };
    }),
    directInput: (projectId, inputId) => withStore(projectId, async (_store, client) => {
      const r = (await client.query(`SELECT state,native_item_id,actual_turn_id,expected_turn_id,reason,created_at FROM session_direct_input WHERE project_id=$1 AND input_id=$2`, [projectId, inputId])).rows[0];
      return r ? { state: r.state, nativeItemId: r.native_item_id, actualTurnId: r.actual_turn_id, expectedTurnId: r.expected_turn_id, reason: r.reason, createdAt: new Date(r.created_at).toISOString() } : null;
    }),
    turnOutcome: (projectId, sessionId, turnId) => withStore(projectId, async (_store, client) => {
      const r = (await client.query(`SELECT state FROM session_message_processing WHERE project_id=$1 AND session_id=$2 AND native_turn_id=$3`, [projectId, sessionId, turnId])).rows[0];
      if (!r) return null;
      return r.state === "running" || r.state === "dispatching" ? "running" : r.state === "completed" ? "completed" : r.state === "failed" ? "failed" : "unknown";
    }),
    message: (projectId, messageId) => withStore(projectId, async (_store, client) => {
      const r = (await client.query(`SELECT m.message_id,m.version,m.state,m.sender_actor_id,p.native_turn_id,p.state AS processing_state FROM session_message m
        LEFT JOIN session_message_processing p ON p.project_id=m.project_id AND p.message_id=m.message_id WHERE m.project_id=$1 AND m.message_id=$2`, [projectId, messageId])).rows[0];
      return r ? { id: r.message_id, version: r.version, state: r.state, senderActorId: r.sender_actor_id, nativeTurnId: r.native_turn_id, processingState: r.processing_state } : null;
    }),
  };
}
