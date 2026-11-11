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
  // The decision names the hold the person looked at: a hold that was released and opened again in between is a new one nobody has seen.
  if (hold.id !== command.holdId) throw new DomainError('PROVIDER_HOLD_CHANGED', 'The active hold is not the one this release names; read it again', hold.version);
  if (hold.version !== command.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'Provider hold changed', hold.version);
  const resumed: string[] = [];
  const skipped: { sessionId: string; code: string }[] = [];
  // One Session's failure never undoes the others: each resume runs in its own savepoint, and any error (a database refusal too, not
  // only a domain one) becomes that Session's entry in `skipped`. Gates that a quota failure closed while the list was being
  // read are picked up by reading again, a bounded number of times, before the hold is released.
  const seen = new Set<string>();
  for (let pass = 0; pass < 3; pass++) {
    const pending = (await recovery.providerHoldImpact(command.provider)).filter(item => item.blockedByQuotaFailure && !seen.has(item.sessionId));
    if (!pending.length) break;
    for (const impact of pending) {
      seen.add(impact.sessionId);
      const gate = await recovery.getRecoveryGate(impact.sessionId);
      if (!gate || gate.phase !== 'blocked' || !gate.causeId) continue;
      try {
        await tx.savepoint(() => applySessionRecovery(tx, principal, { projectId: command.projectId, operationId: nextId(),
          type: 'runtime.session.recovery.resume', sessionId: impact.sessionId, expectedVersion: gate.version,
          expectedCauseId: gate.causeId!, resumeMessageId: gate.resumeMessageId, evidenceRef: command.evidenceRef,
          reason: `Provider hold released: ${command.reason}` }, now, nextId));
        resumed.push(impact.sessionId);
      } catch (error) {
        skipped.push({ sessionId: impact.sessionId, code: error instanceof DomainError ? error.code : 'RESUME_FAILED' });
      }
    }
  }
  await recovery.releaseProviderHold(hold.id, hold.version, principal.actorId, command.reason, { resumed, skipped }, now);
  return { result: { status: 'applied' as const, operationId: command.operationId, entityId: hold.id, version: hold.version + 1 },
    effects: [{ kind: command.type, entityId: hold.id, version: hold.version + 1 }] };
}
