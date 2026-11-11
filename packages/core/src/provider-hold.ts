import type { Principal } from '@evoloop/contracts';
import { DomainError, type Transaction } from '@evoloop/contracts/ports';
import type { ProviderHoldCommand } from '@evoloop/contracts/provider-hold';
import { applySessionRecovery } from './session-recovery.js';

/**
 * One decision frees a held provider: the hold is released and every Session whose gate was closed by the hold's quota or
 * authentication failure is resumed through the same audited recovery path an individual resume uses, so each Session
 * keeps its own decision record. A Session that cannot resume (busy, changed, not ready) is reported with the refusal
 * code and stays blocked for its own explicit resume; it does not block the others.
 */
export async function applyProviderHoldRelease(tx: Transaction, principal: Principal, command: ProviderHoldCommand,
  now: string, nextId: () => string) {
  if (!principal.actorId || !principal.projectIds.includes(command.projectId) ||
    !principal.permissions.includes('write') || !principal.permissions.includes('review') || principal.actorId.startsWith('worker-'))
    throw new DomainError('FORBIDDEN', 'Releasing a provider hold requires the project reviewer, not a runtime worker');
  const recovery = tx.recovery;
  if (!recovery) throw new DomainError('NOT_FOUND', 'Session recovery persistence unavailable');
  const hold = await recovery.getActiveProviderHold(command.provider);
  if (!hold) throw new DomainError('PROVIDER_NOT_HELD', `${command.provider} has no active hold`);
  if (hold.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Provider hold changed', hold.version);
  const resumed: string[] = [];
  const skipped: { sessionId: string; code: string }[] = [];
  for (const impact of await recovery.providerHoldImpact(command.provider)) {
    if (!impact.blockedByQuotaFailure) continue;
    const gate = await recovery.getRecoveryGate(impact.sessionId);
    if (!gate || gate.phase !== 'blocked' || !gate.causeId) continue;
    try {
      await applySessionRecovery(tx, principal, { projectId: command.projectId, operationId: nextId(),
        type: 'runtime.session.recovery.resume', sessionId: impact.sessionId, expectedVersion: gate.version,
        expectedCauseId: gate.causeId, resumeMessageId: gate.resumeMessageId, evidenceRef: command.evidenceRef,
        reason: `Provider hold released: ${command.reason}` }, now, nextId);
      resumed.push(impact.sessionId);
    } catch (error) {
      // Refusals are decided before any write, so the others still go through.
      if (!(error instanceof DomainError)) throw error;
      skipped.push({ sessionId: impact.sessionId, code: error.code });
    }
  }
  await recovery.releaseProviderHold(hold.id, hold.version, principal.actorId, command.reason, { resumed, skipped }, now);
  return { result: { status: 'applied' as const, operationId: command.operationId, entityId: hold.id, version: hold.version + 1 },
    effects: [{ kind: command.type, entityId: hold.id, version: hold.version + 1 }] };
}
