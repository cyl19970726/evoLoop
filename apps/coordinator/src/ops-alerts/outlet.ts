import { execFile } from "node:child_process";

/**
 * The one general outlet for alerts that must reach a person outside the workbench (Task 5da8b6d9). Which channel a person actually reads is decided
 * in private configuration, not here: a webhook (an HTTP POST of the alert as JSON, which most chat and paging tools accept directly or through a
 * relay) or a local command (the alert as JSON on its standard input, for anything else). Both are bounded by a timeout and neither throws:
 * the pump records the failure and the thing being reported is not touched.
 */
export type AlertOutletConfig =
  | { kind: "webhook"; url: string; headers: Record<string, string>; timeoutMs: number }
  | { kind: "command"; argv: string[]; timeoutMs: number };

export interface AlertMessage {
  schema: "evoloop.alert.v1";
  projectId: string;
  /** Stable for one episode: the same key means the same alert, so a receiver can de-duplicate or thread on it. */
  key: string;
  kind: "provider_hold" | "stall";
  event: "opened" | "resolved";
  /** One-paragraph Chinese text, ready to show as a message body. */
  text: string;
  /** The same facts, structured. */
  facts: Record<string, unknown>;
}

export interface OutletResult { ok: boolean; error?: string }

export async function sendAlert(outlet: AlertOutletConfig, message: AlertMessage, fetcher: typeof fetch = fetch): Promise<OutletResult> {
  const body = JSON.stringify(message);
  try {
    if (outlet.kind === "webhook") {
      const response = await fetcher(outlet.url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8", ...outlet.headers }, body,
        signal: AbortSignal.timeout(outlet.timeoutMs), redirect: "error" });
      // The body of the answer is not read or kept: it can echo what was sent, or something private of the receiver.
      return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
    }
    const [file, ...args] = outlet.argv;
    return await new Promise<OutletResult>(done => {
      const child = execFile(file!, args, { timeout: outlet.timeoutMs, maxBuffer: 64 * 1024, shell: false, windowsHide: true, env: { PATH: process.env.PATH ?? "" } },
        error => done(error ? { ok: false, error: `command failed: ${(error as NodeJS.ErrnoException).code ?? error.name}${(error as { killed?: boolean }).killed ? " (timed out)" : ""}` } : { ok: true }));
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(body);
    });
  } catch (error) {
    // The error's own text can carry the URL (and so a token in it): only its kind is kept.
    const name = (error as { name?: string })?.name ?? "Error";
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timed out" : `request failed: ${name}` };
  }
}
