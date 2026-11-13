import { z } from "zod";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const base = { projectId: id, operationId: id };

/** The Leader's notices travel in packets; these commands are the packet's own steps and the Leader's per-item decision. All need review. */
export const leaderNoticePacketCommands = [
  // Built by the notice pump once the earliest item has waited: members are re-checked here, in the dispatch transaction.
  z.strictObject({ ...base, type: z.literal("leader.noticePacket.build"), sessionId: id, packetId: id, messageId: id, messageOperationId: id,
    content: z.string().min(1).max(8192),
    recipient: z.strictObject({ receiverRoleId: z.string().trim().min(1).max(240), receiverActorId: z.string().trim().min(1).max(240), senderActorId: z.string().trim().min(1).max(240) }),
    // With no noticeIds only the stale items are withdrawn (no packet is built); content and message ids are then unused.
    noticeIds: z.array(id).max(20), debounceSeconds: z.number().int().min(0).max(3600).default(60),
    withdraw: z.array(z.strictObject({ noticeId: id, reason: note })).max(100).default([]) }).refine(value => value.noticeIds.length + value.withdraw.length > 0, "Nothing to build or withdraw"),
  z.strictObject({ ...base, type: z.literal("leader.noticePacket.sent"), packetId: id }),
  // W2: the packet went into the Leader's running Turn as a direct input instead of a new message. The input ID is the packet's message ID.
  z.strictObject({ ...base, type: z.literal("leader.noticePacket.steered"), packetId: id, directInputId: id, inputOperationId: id }),
  z.strictObject({ ...base, type: z.literal("leader.noticePacket.observe"), packetId: id,
    outcome: z.enum(["delivered", "seen", "failed", "unknown", "withdrawn"]), turnId: z.string().trim().min(1).max(256).optional(),
    turnStarted: z.boolean().optional(), gateBlocked: z.boolean().optional(), evidence: note.optional() }),
  // The Leader's decision about one item. The version makes a repeat harmless: a stale version is refused, the same operation replays.
  z.strictObject({ ...base, type: z.literal("leader.notice.handle"), noticeId: id, expectedVersion: z.number().int().positive(),
    disposition: z.enum(["handled", "deferred"]), reason: note, notBefore: z.iso.datetime({ offset: true }).optional() }),
  z.strictObject({ ...base, type: z.literal("leader.noticePacket.recover"), packetId: id, reason: note }),
] as const;
/** Recovery of one blocked packet by the Leader (`leader.notice.recover` for a packet id); the packet's items then wait for the next packet. */
export const leaderNoticePacketRecoverySchema = z.strictObject({ reason: note });
export type LeaderNoticePacketCommand = z.infer<(typeof leaderNoticePacketCommands)[number]>;

export type LeaderNoticePacketState = "building" | "sent" | "delivered" | "seen" | "blocked" | "unknown" | "returned" | "withdrawn" | "recovered";
export type LeaderNoticeItemState = "pending" | "delivered" | "seen" | "handled" | "withdrawn" | "unknown";
export interface LeaderNoticePacket {
  projectId: string; id: string; sessionId: string; itemCount: number; byteCount: number; contentHash: string; content: string; messageId: string; messageOperationId: string;
  state: LeaderNoticePacketState; createdAt: string; sentAt: string | null; deliveredAt: string | null; endedAt: string | null;
}
export interface LeaderNoticePacketAttempt {
  packetId: string; attempt: number; method: "new_turn" | "steer"; operationId: string; messageId: string | null; directInputId: string | null; createdAt: string;
}
export interface LeaderNoticePacketItem {
  projectId: string; packetId: string; noticeId: string; position: number; state: LeaderNoticeItemState;
  readBefore: boolean; requeue: boolean; disposition: "handled" | "deferred" | null; deferUntil: string | null;
  handledBy: string | null; handledReason: string | null; withdrawnReason: string | null;
  expectedTurnId: string | null; actualTurnId: string | null; evidence: string | null; version: number; createdAt: string; updatedAt: string;
}
/** A notice that can go into the next packet, with how long it has waited by the database clock. */
export interface LeaderNoticeCandidate {
  noticeId: string; kind: string; /** immediate notices are first in line and do not wait for the debounce */ level: "immediate" | "digest"; sourceEventId: string; taskId: string; taskRevisionId: string; sourceRef: string; occurredAt: string;
  sourceActorId: string | null; sourceSessionId: string | null; state: "pending" | "linked"; readBefore: boolean; waitedSeconds: number; version: number;
}

export interface LeaderNoticePacketReader {
  listLeaderNoticeCandidates(limit: number, offset?: number): Promise<LeaderNoticeCandidate[]>;
  /** Packets that stopped behind a closed recovery gate (the Leader recovers them by packet id). */
  listBlockedLeaderNoticePackets(): Promise<LeaderNoticePacket[]>;
  getLeaderNoticePacket(packetId: string): Promise<LeaderNoticePacket | null>;
  getLeaderNoticePacketByMessage(messageId: string): Promise<LeaderNoticePacket | null>;
  /** Open packets of the project; with a Session id only that Session's. */
  listOpenLeaderNoticePackets(sessionId?: string): Promise<LeaderNoticePacket[]>;
  listLeaderNoticePacketItems(packetId: string): Promise<LeaderNoticePacketItem[]>;
  listLeaderNoticePacketAttempts(packetId: string): Promise<LeaderNoticePacketAttempt[]>;
  getLeaderNoticeItem(noticeId: string): Promise<LeaderNoticePacketItem | null>;
}
export interface LeaderNoticePacketTransaction extends LeaderNoticePacketReader {
  /** The Leader Session's recipient pin for a notice; the packet links the notice to that Session. */
  buildLeaderNoticePacket(input: { packetId: string; sessionId: string; messageId: string; operationId: string; content: string; noticeIds: string[];
    withdraw: Array<{ noticeId: string; reason: string }>; debounceSeconds: number; recipient: { receiverRoleId: string; receiverActorId: string; senderActorId: string }; at: string }): Promise<LeaderNoticePacket>;
  markLeaderNoticePacketSent(packetId: string, at: string): Promise<LeaderNoticePacket>;
  /** The packet went into a running Turn as direct input `directInputId` (attempt method steer); the packet is then sent. */
  markLeaderNoticePacketSteered(input: { packetId: string; directInputId: string; inputOperationId: string; at: string }): Promise<LeaderNoticePacket>;
  observeLeaderNoticePacket(input: { packetId: string; outcome: "delivered" | "seen" | "failed" | "unknown" | "withdrawn"; turnId: string | null;
    turnStarted: boolean; gateBlocked: boolean; evidence: string | null; at: string }): Promise<LeaderNoticePacket>;
  handleLeaderNoticeItem(input: { noticeId: string; expectedVersion: number; disposition: "handled" | "deferred"; reason: string; notBefore: string | null;
    actorId: string; operationId: string; at: string }): Promise<LeaderNoticePacketItem>;
  recoverLeaderNoticePacket(input: { packetId: string; reason: string; actorId: string; at: string }): Promise<LeaderNoticePacket>;
}
