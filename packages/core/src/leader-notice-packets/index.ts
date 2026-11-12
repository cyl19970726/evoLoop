import type { AppliedResult, Principal } from "@evoloop/contracts";
import { DomainError, type Transaction } from "@evoloop/contracts/ports";
import type { LeaderNoticePacketCommand } from "@evoloop/contracts/leader-notice-packets";

type Effect = { kind: string; entityId: string; version: number };

/**
 * Leader notice packets (DEC-045 W1). The pump's steps (build, sent, observe) and the Leader's per-item decision are ordinary commands,
 * so each is journalled, replays safely and carries its own version check. All need review authority (checked by the caller).
 */
export async function applyLeaderNoticePacket(tx: Transaction, principal: Principal, command: LeaderNoticePacketCommand, now: string):
  Promise<{ result: AppliedResult; effects: Effect[] }> {
  const store = tx.leaderNoticePackets ?? (() => { throw new DomainError("CAPABILITY_UNAVAILABLE", "Leader notice packet storage is unavailable"); })();
  const ok = (entityId: string, version: number): { result: AppliedResult; effects: Effect[] } =>
    ({ result: { status: "applied", operationId: command.operationId, entityId, version }, effects: [{ kind: command.type, entityId, version }] });
  switch (command.type) {
    case "leader.noticePacket.build": {
      const session = await tx.getRuntimeSession(command.sessionId);
      if (!session || session.state !== "ready") throw new DomainError("SESSION_NOT_READY", "The Leader Session is not ready");
      const packet = await store.buildLeaderNoticePacket({ packetId: command.packetId, sessionId: command.sessionId, messageId: command.messageId,
        operationId: command.messageOperationId, content: command.content, noticeIds: command.noticeIds, withdraw: command.withdraw,
        debounceSeconds: command.debounceSeconds, recipient: command.recipient, at: now });
      return ok(packet.id, 1);
    }
    case "leader.noticePacket.sent": return ok((await store.markLeaderNoticePacketSent(command.packetId, now)).id, 1);
    case "leader.noticePacket.observe": {
      const packet = await store.observeLeaderNoticePacket({ packetId: command.packetId, outcome: command.outcome, turnId: command.turnId ?? null,
        turnStarted: command.turnStarted === true, gateBlocked: command.gateBlocked === true, evidence: command.evidence ?? null, at: now });
      return ok(packet.id, 1);
    }
    case "leader.notice.handle": {
      const item = await store.handleLeaderNoticeItem({ noticeId: command.noticeId, expectedVersion: command.expectedVersion, disposition: command.disposition,
        reason: command.reason, notBefore: command.notBefore ?? null, actorId: principal.actorId, operationId: command.operationId, at: now });
      return ok(item.noticeId, item.version);
    }
    case "leader.noticePacket.recover":
      return ok((await store.recoverLeaderNoticePacket({ packetId: command.packetId, reason: command.reason, actorId: principal.actorId, at: now })).id, 1);
  }
}
