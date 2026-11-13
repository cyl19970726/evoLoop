import { DomainError } from "@evoloop/contracts/ports";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";

/**
 * What the message pump's error log says (defect d6dd0a1e). It used to write one fixed sentence for every error, dropping the error:
 * a reader of the log could not tell a real fault from a message that was only waiting. Now the line names the error code, the message,
 * the Session and the project, and a short summary of the error itself. It never carries the message text, a token or a configuration value:
 * only an ID, the error's class or code, and its own message cut short with newlines removed.
 */
const waits = new Set(["SESSION_BUSY", "PROVIDER_HELD", "MESSAGE_GRANT_MISSING", "MESSAGE_BUDGET_EXHAUSTED", "SESSION_NOT_READY", "MESSAGE_NOT_QUEUED",
  "SESSION_INPUT_BUSY", "DRAINING", "INSTANCE_DRAINING"]);

/** A stable short code for an error: a DomainError's code, a native JSON-RPC code, or the error's class name. */
export function errorCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  const e = error as { code?: unknown; name?: unknown } | null;
  if (e && typeof e.code === "string" && /^[A-Z0-9_]{2,60}$/.test(e.code)) return e.code;
  if (e && typeof e.code === "number") return `${typeof e.name === "string" ? e.name : "Error"}(${e.code})`;
  return typeof e?.name === "string" && e.name ? e.name : "Error";
}
/** Normal waiting is never a reconciliation error: the message stays queued and goes out in order. */
export function isExpectedWait(error: unknown): boolean {
  return waits.has(errorCode(error)) || (error as { name?: unknown } | null)?.name === "RuntimeLocalBusyError";
}
const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The log line for one failed message, or null when the error is a normal wait. Identical lines are throttled by the caller (log-throttle). */
export function messageErrorLine(error: unknown, message?: Pick<SessionMessageRecord, "projectId" | "id" | "target" | "state"> | null): string | null {
  if (isExpectedWait(error)) return null;
  const code = errorCode(error);
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const session = message?.target.kind === "owned" ? message.target.sessionId : message?.target.kind ?? "unknown";
  return `Session message needs reconciliation: code=${code} message=${message?.id ?? "unknown"} session=${session} project=${message?.projectId ?? "unknown"} ` +
    `state=${message?.state ?? "unknown"} error=${oneLine(text, 200) || "(no text)"}; inspect that message's saved processing record.`;
}
