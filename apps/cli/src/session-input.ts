import { record } from "./receipts.js";

/** What the person or agent is told about one input to a Session. Never a claim that the agent read it. */
export type InputOutcome = "inserted" | "started" | "queued" | "queued_after_change" | "rejected" | "unknown";

const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;

/**
 * The result of a direct input receipt in the words the workbench uses:
 * inserted into the current Turn, a Turn started on an idle Session, saved as a queued message because the Turn
 * changed (with the reason), refused, or not yet known.
 */
export function directInputOutcome(receipt: unknown): { outcome: InputOutcome; reason: string | null; summary: string } {
  const value = record(receipt);
  const state = text(value?.state), mode = text(value?.mode), reason = text(value?.reason);
  if (state === "accepted") return mode === "start"
    ? { outcome: "started", reason: null, summary: "Session was idle: a new Turn was started with this input (runtime accepted; not proof the agent read it)." }
    : { outcome: "inserted", reason: null, summary: "Inserted into the current Turn (runtime accepted; not proof the agent read it)." };
  if (state === "rejected" && text(value?.queuedMessageId))
    return { outcome: "queued_after_change", reason, summary: `Not inserted: the Turn changed. Saved as one queued message with the same ID. ${reason ?? ""}`.trim() };
  if (state === "rejected") return { outcome: "rejected", reason, summary: `Refused; nothing was sent. ${reason ?? ""}`.trim() };
  return { outcome: "unknown", reason, summary: "Outcome not yet known; read the same input ID (session input show) before doing anything else." };
}

/** A queued ordinary message in the same vocabulary; `processing` decides whether it is still waiting. */
export function queuedMessageOutcome(detail: unknown): { outcome: InputOutcome; messageState: string | null; summary: string } {
  const message = record(record(detail)?.message), state = text(message?.state);
  return { outcome: "queued", messageState: state,
    summary: state === "queued" ? "Saved as a queued message; it is handled in order after the current Turn."
      : `Saved as a message; its state is now ${state ?? "unknown"}.` };
}

/** Which authorization the sender lacks, from the capability the service reads for this sender. */
export function missingForInsert(capability: unknown): string | null {
  const value = record(capability);
  if (!value || value.available === true) return null;
  const code = text(value.reasonCode) ?? "UNKNOWN", detail = text(value.detail);
  const words: Record<string, string> = {
    FORBIDDEN: "project read and write permission for this identity",
    DIRECT_GRANT_MISSING: detail ?? "direct input grant and ordinary message grant for this sender and Session",
    DIRECT_STEER_DISABLED: "direct input grant with steer (insert into the running Turn) for this sender",
    DIRECT_START_DISABLED: "direct input grant with start (open a Turn on an idle Session) for this sender",
    NATIVE_UNAVAILABLE: "a connected native runtime (service side, not a grant)",
    NATIVE_STEER_UNAVAILABLE: "a runtime version that can add input to a running Turn (service side, not a grant)",
    SESSION_BUSY: "a running Turn that accepts input (the current work does not)",
    SESSION_INPUT_BUSY: "a moment: another input is being sent; retry with the same IDs",
    NATIVE_TURN_NOT_ACTIVE: "an active Turn (it just ended; queue instead, or retry)",
    MESSAGE_BUDGET_EXHAUSTED: "remaining direct Turn budget in the grant",
  };
  return `${code}: ${words[code] ?? "see reasonCode"}`;
}
