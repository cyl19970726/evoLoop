import { record } from "./receipts.js";

/** A read-only view. Preserve the service's separate state sources and unknowns. */
export function sessionStatus(snapshot: unknown, detail?: unknown, requestedMessageId?: string): unknown {
  const root = record(snapshot), session = record(root?.session);
  if (!session || typeof session.key !== "string") throw new Error("Session snapshot has no verifiable key.");
  const native = record(root?.nativeObservation), turn = record(native?.currentTurn);
  const result: Record<string, unknown> = {
    session: { key: session.key, runtimeState: session.runtimeState ?? null, busy: session.busy ?? null,
      lastProgressAt: session.lastProgressAt ?? null },
    native: native ? { freshness: native.freshness ?? null, status: native.status ?? null,
      observedAt: native.observedAt ?? null, lastEventAt: native.lastEventAt ?? null,
      turnId: turn?.id ?? null, turnStatus: turn?.status ?? null } : null,
    message: null,
    guidance: "Connection freshness, native Turn status, last activity and persisted message processing are separate facts. Read the exact Turn and message before any recovery decision.",
  };
  if (detail !== undefined) {
    const message = record(record(detail)?.message), processing = record(record(detail)?.processing);
    const manualStop = record(record(detail)?.manualStop);
    const target = record(message?.target);
    const targetId = target?.kind === "owned" ? target.sessionId : target?.kind === "external" ? target.linkId : null;
    const expectedKey = target && typeof target.kind === "string" && typeof targetId === "string"
      ? `${target.kind}:${targetId}` : null;
    const aliases = Array.isArray(session.aliases) ? session.aliases : [];
    const acceptedKeys = new Set([session.key, ...aliases.map(alias => {
      const item = record(alias);
      return item?.kind === "owned" ? `owned:${item.sessionId}` : item?.kind === "external" ? `external:${item.linkId}` : null;
    })]);
    if (!message || !expectedKey || !acceptedKeys.has(expectedKey)) throw new Error("Message target does not match the selected Session.");
    const wrongMessage = requestedMessageId !== undefined && message.id !== requestedMessageId;
    const wrongProcessing = processing !== null && (
      processing.messageId !== undefined && processing.messageId !== message.id ||
      target?.kind === "owned" && processing.sessionId !== undefined && processing.sessionId !== targetId);
    if (wrongMessage || wrongProcessing)
      throw new Error("Message processing identity does not match the requested original.");
    result.message = { id: message.id ?? null, target: expectedKey, state: message.state ?? null, version: message.version ?? null,
      updatedAt: message.updatedAt ?? null,
      processing: processing ? { id: processing.id ?? null, state: processing.state ?? null,
        version: processing.version ?? null, nativeTurnId: processing.nativeTurnId ?? null,
        updatedAt: processing.updatedAt ?? null, interruptOperationId: processing.interruptOperationId ?? null,
        interruptRequestedAt: processing.interruptRequestedAt ?? null,
        interruptAttemptedAt: processing.interruptAttemptedAt ?? null } : null,
      manualStop: manualStop ? { operationId: manualStop.operationId ?? null,
        actorId: manualStop.actorId ?? null, recordedAt: manualStop.recordedAt ?? null,
        nativeStatus: manualStop.observedNativeStatus ?? null,
        oldOwnerExitEvidenceRef: manualStop.exitEvidenceRef ?? null } : null };
  }
  return result;
}
