/**
 * Provider-neutral runtime outcome errors.
 *
 * Every adapter reports a native operation with exactly one of these outcomes:
 * - RuntimeNotSentError: the request was provably never handed to the native transport;
 *   the caller may withdraw its durable intent and dispatch again.
 * - RuntimeServerError: the native side explicitly rejected the request.
 * - RuntimeUnknownError: the native side may have accepted the operation; never retry automatically.
 * - RuntimeProtocolError: a local precondition or verification failed (no native side effect is claimed).
 */

/** Unknown means the native side may have accepted an operation whose reply was lost. Never retry it automatically. */
export class RuntimeUnknownError extends Error {
  observedTurnId?: string;
  constructor(public readonly method: string, public readonly requestId: number | null, reason: string) {
    super(`${method}: outcome unknown (${reason})`); this.name = "RuntimeUnknownError";
  }
}

export class RuntimeProtocolError extends Error {
  constructor(message: string) { super(message); this.name = "RuntimeProtocolError"; }
}

/**
 * The request was rejected by a synchronous local check before any byte was written to the
 * native transport. Only an adapter may raise this, and only before its write call.
 * It extends RuntimeProtocolError so existing "local failure, nothing started" handling applies.
 */
export class RuntimeNotSentError extends RuntimeProtocolError {
  readonly notSent = true as const;
  constructor(public readonly method: string, reason: string) {
    super(`${method}: not sent (${reason})`); this.name = "RuntimeNotSentError";
  }
}

/**
 * The adapter's own in-flight admission refused a second write on one Thread. Nothing reached the
 * native transport, so the caller may retry the same durable intent once the first send settles.
 */
export class RuntimeLocalBusyError extends RuntimeNotSentError {
  constructor(method: string, reason: string) {
    super(method, reason); this.name = "RuntimeLocalBusyError";
  }
}

export type RuntimeServerErrorCategory = "rollout_not_found" | "thread_unavailable" | "writer_conflict" | "invalid_params" |
  "method_not_found" | "permission_denied" | "server_rejected";
export type RuntimeSteerRejection = "non_steerable_turn";

const objectOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The pinned App Server attaches `codexErrorInfo` to a Turn or RPC error. 0.167 serializes the
 * activeTurnNotSteerable variant as `{"activeTurnNotSteerable":{"turnKind":...}}`; a `type` tag is
 * accepted only as a defensive alternative. No free-text match decides this.
 */
function nonSteerableErrorInfo(data: unknown): boolean {
  const info = objectOf(objectOf(data)?.codexErrorInfo);
  if (!info) return false;
  return Object.hasOwn(info, "activeTurnNotSteerable") || info.type === "activeTurnNotSteerable";
}

const serverErrorCategory = (method: string, code: number, message: string): RuntimeServerErrorCategory => {
  // The pinned Codex writer-lock rejection occurs before this resume can start a Turn.
  if (method === "thread/resume" && code === -32600 &&
    /^thread [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} already has an active writer$/.test(message))
    return "writer_conflict";
  if (/rollout.{0,60}not found|not found.{0,60}rollout|no rollout found/i.test(message)) return "rollout_not_found";
  if (/permission|unauthorized|forbidden/i.test(message)) return "permission_denied";
  if (/thread.{0,60}(read|load)|(read|load).{0,60}thread/i.test(message)) return "thread_unavailable";
  if (code === -32602 || /invalid params/i.test(message)) return "invalid_params";
  if (code === -32601) return "method_not_found";
  return "server_rejected";
};

/** Stable protocol evidence only. The native error message can contain private paths or session material. */
export class RuntimeServerError extends RuntimeProtocolError {
  readonly category: RuntimeServerErrorCategory;
  readonly preTurnWriterConflict: boolean;
  readonly rejectedThreadId: string | null;
  /** A classified steer refusal only; never used as a generic retry signal. */
  readonly steerRejection: RuntimeSteerRejection | null;
  constructor(public readonly method: string, public readonly requestId: number, public readonly code: number,
    nativeMessage: string, requestedThreadId?: string, nativeData?: unknown) {
    const category = serverErrorCategory(method, code, nativeMessage);
    super(`${method}: native runtime rejected request (${category}, code ${code})`);
    this.name = "RuntimeServerError";
    this.category = category;
    const rejectedThreadId = category === "writer_conflict" ? nativeMessage.match(/^thread ([0-9a-f-]{36}) already has an active writer$/)?.[1] ?? null : null;
    this.rejectedThreadId = rejectedThreadId ?? null;
    this.preTurnWriterConflict = category === "writer_conflict" && rejectedThreadId === requestedThreadId;
    // Only the structured refusal, or 0.167's exact review/compaction wording, means the Turn kind
    // cannot take input. MisalignmentSteer is a continuation hint on a failed Turn, not a steer refusal.
    this.steerRejection = method !== "turn/steer" ? null :
      nonSteerableErrorInfo(nativeData) || /cannot steer (a )?(review|compact(ion)?) turn/i.test(nativeMessage)
        ? "non_steerable_turn" : null;
  }
}

/** Neutral operation names used in bounded fault and dispatch evidence. */
export type RuntimeOperation = "session.create" | "session.resume" | "session.archive" | "session.read" |
  "turn.start" | "turn.interrupt" | "history.read" | "compaction.start";
const operationByMethod: Record<string, RuntimeOperation> = {
  "thread/start": "session.create", "thread/resume": "session.resume", "thread/archive": "session.archive",
  "thread/read": "session.read", "turn/start": "turn.start", "turn/interrupt": "turn.interrupt",
  "thread/turns/list": "history.read", "thread/items/list": "history.read", "thread/compact/start": "compaction.start",
};
/** Map a provider method name to its neutral operation; null when the method is not a tracked operation. */
export function runtimeOperationOf(method: string): RuntimeOperation | null {
  if (Object.values(operationByMethod).includes(method as RuntimeOperation)) return method as RuntimeOperation;
  return operationByMethod[method] ?? null;
}
