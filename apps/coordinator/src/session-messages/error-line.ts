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

/**
 * Whatever text an error carries may hold something private: a token, a path on this machine, a piece of the input. Redaction runs on every
 * summary that is written. Order matters: quoted text first (it can contain the rest), then secrets, then paths, then long opaque strings.
 */
export function redact(text: string): string {
  return text
    .replace(/(["'`])(?:(?!\1).){24,}?\1/g, "$1<quoted text withheld>$1")
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]+/g, "<jwt>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(token|secret|password|passwd|authorization|api[_-]?key|apikey|credential)s?\b(\s*[=:]\s*)[^\s,;)}\]]+/gi, "$1$2<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "<redacted>")
    .replace(/(?:[A-Za-z]:\\|\/)(?:Users|home|private|tmp|var|etc|opt|root|Library|mnt|srv|Volumes)(?:[\/\\][^\s"'`,;)}\]]*)?/g, "<path>")
    .replace(/\b[A-Fa-f0-9]{24,}\b/g, "<hex>")
    .replace(/\b[A-Za-z0-9+\/_-]{32,}={0,2}/g, "<opaque>");
}
/** Errors whose text the platform itself wrote: their summary is useful and stays (redacted). Any other error says only what kind it is. */
const platformAuthored = (error: unknown): boolean => error instanceof DomainError || (error as { name?: unknown } | null)?.name === "RuntimeServerError";

/** What to log for one failed message: the throttle key (message ID + error code) and the line; null when the error is a normal wait. */
export function messageErrorEntry(error: unknown, message?: Pick<SessionMessageRecord, "projectId" | "id" | "target" | "state"> | null): { key: string; line: string } | null {
  if (isExpectedWait(error)) return null;
  const code = errorCode(error);
  const text = platformAuthored(error) && error instanceof Error ? redact(oneLine(error.message, 4000)).slice(0, 200) : "";
  const session = message?.target.kind === "owned" ? message.target.sessionId : message?.target.kind ?? "unknown";
  const summary = text || (platformAuthored(error) ? "(no text)" : `(text withheld: ${typeof (error as { name?: unknown } | null)?.name === "string" ? String((error as { name: string }).name).slice(0, 60) : "not an Error"})`);
  return { key: `${message?.id ?? "unknown"}:${code}`,
    line: `Session message needs reconciliation: code=${code} message=${message?.id ?? "unknown"} session=${session} project=${message?.projectId ?? "unknown"} ` +
      `state=${message?.state ?? "unknown"} error=${summary}; inspect that message's saved processing record.` };
}
/** The log line only (kept for callers and tests that do not throttle). */
export const messageErrorLine = (error: unknown, message?: Pick<SessionMessageRecord, "projectId" | "id" | "target" | "state"> | null): string | null =>
  messageErrorEntry(error, message)?.line ?? null;

/**
 * One line per key per window, whatever the line says: the key is the message ID plus the error code, so an error text that changes on every
 * tick (a counter, a timestamp) is still one error. After the window the next line is written with the number held back; the latest text wins.
 */
export function keyedThrottledLog(write: (line: string) => void, windowMs = 60_000, now: () => number = Date.now) {
  const seen = new Map<string, { at: number; held: number; latest: string }>();
  return (key: string, line: string): void => {
    const time = now(), entry = seen.get(key);
    if (!entry) { seen.set(key, { at: time, held: 0, latest: line }); write(line); return; }
    entry.latest = line;
    if (time - entry.at < windowMs) { entry.held += 1; return; }
    const held = entry.held;
    seen.set(key, { at: time, held: 0, latest: line });
    write(held ? `${line} (${held} more of this error held back in the last ${Math.round(windowMs / 1000)}s)` : line);
  };
}
