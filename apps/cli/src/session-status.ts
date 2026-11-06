import { record } from "./receipts.js";

type RuntimeRead = { state: "ok"; value: unknown } | { state: "failed" };
const stopReasons = new Set(["adapter_closed", "stdout_closed", "process_exited", "spawn_error", "protocol_error"]);
const utc = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
/** Read only the newest diagnostic's stable fields; never copy native text or arbitrary API keys. */
function latestChildDiagnostic(value: unknown): Record<string, unknown> | null {
  const raw = Array.isArray(value) ? record(value[0]) : null;
  if (!raw || typeof raw.startId !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.startId) ||
    !utc(raw.startedAtUtc) || !utc(raw.observedAtUtc) || !utc(raw.firstLossAtUtc) ||
    typeof raw.firstLossReason !== "string" || !stopReasons.has(raw.firstLossReason) ||
    typeof raw.stopReason !== "string" || !stopReasons.has(raw.stopReason) ||
    typeof raw.exitObserved !== "boolean" || raw.exitedAtUtc !== null && !utc(raw.exitedAtUtc) ||
    raw.pid !== null && (typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid < 1) ||
    raw.exitCode !== null && (typeof raw.exitCode !== "number" || !Number.isSafeInteger(raw.exitCode) || raw.exitCode < 0) ||
    raw.exitSignal !== null && (typeof raw.exitSignal !== "string" || !/^SIG[A-Z0-9]{1,20}$/.test(raw.exitSignal)) ||
    raw.nativeTurnOutcome !== "unknown") return null;
  return { scope: "last_recorded_child_loss", startId: raw.startId, pid: raw.pid,
    startedAtUtc: raw.startedAtUtc, observedAtUtc: raw.observedAtUtc,
    firstLossAtUtc: raw.firstLossAtUtc, firstLossReason: raw.firstLossReason,
    stopReason: raw.stopReason, exitObserved: raw.exitObserved, exitedAtUtc: raw.exitedAtUtc,
    exitCode: raw.exitCode, exitSignal: raw.exitSignal, nativeTurnOutcome: "unknown" };
}

/** A read-only view. Preserve the service's separate state sources and unknowns. */
export function sessionStatus(snapshot: unknown, detail?: unknown, requestedMessageId?: string,
  runtimeRead?: RuntimeRead): unknown {
  const root = record(snapshot), session = record(root?.session);
  if (!session || typeof session.key !== "string") throw new Error("Session snapshot has no verifiable key.");
  const native = record(root?.nativeObservation), turn = record(native?.currentTurn);
  const source = record(turn?.source), recentRun = record(session.latestBusinessRun);
  const runtime = runtimeRead?.state === "ok" ? record(runtimeRead.value) : null;
  const runtimeAvailable = runtimeRead?.state === "ok" && typeof runtime?.available === "boolean"
    ? runtime.available : null;
  const runtimeReadStatus = runtimeRead?.state === "failed" ? "failed"
    : runtimeRead?.state === "ok" ? runtimeAvailable === null ? "invalid" : "confirmed" : "not_read";
  const nativeSource = source?.kind === "run" && typeof source.runId === "string"
    ? { kind: "run", id: source.runId, taskId: source.taskId ?? null }
    : source?.kind === "message" && typeof source.messageId === "string"
      ? { kind: "message", id: source.messageId, processingId: source.processingId ?? null } : null;
  const result: Record<string, unknown> = {
    session: { key: session.key, runtimeState: session.runtimeState ?? null, busy: session.busy ?? null,
      lastProgressAt: session.lastProgressAt ?? null,
      latestBusinessRun: recentRun && typeof recentRun.id === "string"
        ? { id: recentRun.id, taskId: recentRun.taskId ?? null, state: recentRun.state ?? null,
          updatedAt: recentRun.updatedAt ?? null, scope: "latest_persisted_run" } : null },
    native: native ? { freshness: native.freshness ?? null, status: native.status ?? null,
      staleReason: native.staleReason ?? null, observedAt: native.observedAt ?? null,
      lastEventAt: native.lastEventAt ?? null, turnId: turn?.id ?? null,
      turnStatus: turn?.status ?? null, turnSource: nativeSource } : null,
    runtime: { available: runtimeAvailable, readStatus: runtimeReadStatus,
      latestChildDiagnostic: runtimeReadStatus === "confirmed"
        ? latestChildDiagnostic(runtime?.nativeChildDiagnostics) : null },
    writerControl: { state: "unknown", source: "read_only_native_observation",
      observedAt: native?.observedAt ?? null, freshness: native?.freshness ?? null,
      reason: "Native thread/read and connection freshness do not identify the current writer; confirm the original Thread with an authorized handoff and native execution evidence." },
    message: null,
    guidance: runtimeAvailable === false
      ? "HTTP Session snapshot is readable, but native runtime reports unavailable. PG ready/running and the last native Turn do not prove current execution; reconcile exact original IDs."
      : runtimeAvailable === null
        ? "Native runtime availability is unknown because its status read failed or was invalid. PG ready/running and the last native Turn do not prove current execution."
        : native?.freshness === "stale"
          ? "Native observation is stale. Its last Turn and the latest persisted Run do not prove current execution; read the exact original Run, Turn and message before recovery."
          : "PG Session/Run state, native Turn, connection freshness and message processing are separate facts. The latest Run is historical until its exact Turn is checked.",
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
