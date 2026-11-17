import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { FORWARDED_METHODS, FORWARDED_PATH, HUB_IDENTITY_HEADER, machineRequestMessage, type MachineCredentials } from "@evoloop/contracts";
import type { MachineCredentialSource } from "./credentials.js";

const MACHINE_CONTENT_TYPE = "application/vnd.evoloop-machine+json";
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT = 8;

export type ConnectorOptions = {
  credentials: MachineCredentialSource;
  /** The coordinator's own loopback address, e.g. http://127.0.0.1:4318. The only place a forwarded request is ever sent. */
  coordinatorUrl: string;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  /** Wait before reconnecting after a failure, growing to the larger value. */
  backoffMs?: { initial: number; max: number };
  /** How long a forwarded request may take on the coordinator before the connector answers 504. */
  requestTimeoutMs?: number;
  /** How often the connector looks for credentials while it has none. */
  idleCheckMs?: number;
};

type Frame = { t: string; [key: string]: unknown };

/** Whether `path` is one the Hub may forward: the shape check, and no dot segment, encoded slash or backslash. The Hub checked the same; this machine checks again. */
export function isForwardablePath(method: string, path: string): boolean {
  if (!(FORWARDED_METHODS as readonly string[]).includes(method) || !FORWARDED_PATH.test(path)) return false;
  const [pathname = ""] = path.split("?", 1);
  for (const segment of pathname.split("/").slice(1)) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return false; }
    if (segment === "" || decoded === "." || decoded === ".." || /[\\/\u0000-\u001f]/.test(decoded)) return false;
  }
  return true;
}

/**
 * The machine's end of the Hub link. It only ever connects *out* (nothing here listens); the Hub's requests come back on that one connection, and each goes
 * to this machine's own coordinator on loopback — a path the Hub's shape check and this one both allow, carrying the Hub's signed identity for that request.
 * The coordinator, not the connector, decides whether the identity is acceptable.
 */
export class HubConnector {
  private stopped = true;
  private loop: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private halt = new AbortController();
  private removedFor: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  state: "stopped" | "idle" | "connecting" | "online" | "removed" = "stopped";

  constructor(private readonly options: ConnectorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halt = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.halt.abort();
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
    this.state = "stopped";
  }

  private async run(): Promise<void> {
    const backoff = this.options.backoffMs ?? { initial: 1000, max: 30_000 };
    let delay = backoff.initial;
    while (!this.stopped) {
      const credentials = this.options.credentials.current();
      if (!credentials || this.removedFor === credentials.machineId) {
        this.state = credentials ? "removed" : "idle";
        await this.sleep(this.options.idleCheckMs ?? 2000);
        continue;
      }
      this.state = "connecting";
      const started = Date.now();
      try {
        await this.connect(credentials);
        delay = backoff.initial;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "connection failed";
        if (reason === "MACHINE_REMOVED") {
          this.removedFor = credentials.machineId;
          this.log("The Hub says this machine was removed; not reconnecting until it joins again.");
        } else if (!this.stopped) this.log(`Hub connection lost (${reason}); retrying.`);
        if (Date.now() - started > 30_000) delay = backoff.initial;
      }
      if (!this.stopped) {
        await this.sleep(delay);
        delay = Math.min(backoff.max, delay * 2);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      if (this.halt.signal.aborted) { clearTimeout(timer); resolve(); return; }
      this.halt.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private signed(credentials: MachineCredentials, action: string, body: string): Record<string, string> {
    const timestamp = String(Date.now()), nonce = randomUUID();
    const digest = createHash("sha256").update(body).digest("base64url");
    const signature = sign(null, Buffer.from(machineRequestMessage(credentials.machineId, action, timestamp, nonce, digest)), createPrivateKey(credentials.privateKey));
    return { "x-evoloop-machine": credentials.machineId, "x-evoloop-machine-time": timestamp, "x-evoloop-machine-nonce": nonce, "x-evoloop-machine-signature": signature.toString("base64url") };
  }

  private async post(credentials: MachineCredentials, action: string, body: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(new URL(`/api/machine/${action}`, credentials.hubOrigin), {
      method: "POST", headers: { ...this.signed(credentials, action, body), ...(body ? { "content-type": MACHINE_CONTENT_TYPE } : {}) },
      ...(body ? { body } : {}), ...(signal ? { signal } : {}), redirect: "manual",
    });
  }

  private async connect(credentials: MachineCredentials): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    const response = await this.post(credentials, "connect", "", controller.signal);
    if (response.status === 401) {
      const code = (await response.json().catch(() => null) as { error?: { code?: string } } | null)?.error?.code;
      throw new Error(code === "MACHINE_REMOVED" ? "MACHINE_REMOVED" : `Hub refused the connection (${code ?? 401})`);
    }
    if (!response.ok || !response.body) throw new Error(`Hub answered ${response.status}`);
    let heartbeatMs = 15_000;
    let lastFrameAt = Date.now();
    let beat: NodeJS.Timeout | null = null;
    const inflight = new Set<Promise<void>>();
    const stopTimers = () => { if (beat) clearInterval(beat); clearInterval(watchdog); };
    // The Hub pings; a link that goes quiet for three intervals is dead even if the socket says otherwise.
    const watchdog = setInterval(() => { if (Date.now() - lastFrameAt > heartbeatMs * 3) controller.abort(); }, 5000);
    watchdog.unref();
    try {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          let frame: Frame;
          try { frame = JSON.parse(line) as Frame; } catch { continue; }
          lastFrameAt = Date.now();
          if (frame.t === "hello") {
            this.state = "online";
            const interval = Number(frame.heartbeatMs);
            if (Number.isFinite(interval) && interval >= 100 && interval <= 120_000) heartbeatMs = interval;
            if (beat) clearInterval(beat);
            const sendBeat = () => {
              void this.post(credentials, "heartbeat", "{}").then(async answer => {
                if (!answer.ok) this.log(`Hub heartbeat refused (${answer.status} ${(await answer.text().catch(() => "")).slice(0, 120)})`);
              }).catch(error => this.log(`Hub heartbeat failed (${error instanceof Error ? error.message : "error"})`));
            };
            beat = setInterval(sendBeat, heartbeatMs);
            beat.unref();
            sendBeat();
          } else if (frame.t === "request") {
            if (inflight.size >= MAX_CONCURRENT) { void this.answer(credentials, frame, 429, "application/json", Buffer.from(JSON.stringify({ code: "CONNECTOR_BUSY", message: "The machine is handling too many forwarded requests." }))); continue; }
            const work = this.handle(credentials, frame).finally(() => inflight.delete(work));
            inflight.add(work);
          } else if (frame.t === "bye") {
            return;
          }
        }
      }
    } finally {
      stopTimers();
      this.state = this.stopped ? "stopped" : "connecting";
    }
  }

  private async handle(credentials: MachineCredentials, frame: Frame): Promise<void> {
    const method = typeof frame.method === "string" ? frame.method.toUpperCase() : "";
    const path = typeof frame.path === "string" ? frame.path : "";
    const identity = typeof frame.identity === "string" ? frame.identity : "";
    const json = (status: number, code: string, message: string) => this.answer(credentials, frame, status, "application/json", Buffer.from(JSON.stringify({ code, message })));
    if (!isForwardablePath(method, path)) return json(403, "FORWARD_PATH_REFUSED", "This machine only accepts the project API and the command endpoint.");
    if (!identity) { this.log("A forwarded request arrived without a signed identity and was refused here (401); it never reached the coordinator."); return json(401, "UNAUTHENTICATED", "转发身份未被接受。"); }
    const target = new URL(path, this.options.coordinatorUrl);
    // Belt and braces: whatever the path was, the request goes to this coordinator's own origin, nowhere else.
    if (target.origin !== new URL(this.options.coordinatorUrl).origin) return json(403, "FORWARD_PATH_REFUSED", "This machine only accepts the project API and the command endpoint.");
    const body = typeof frame.body === "string" ? Buffer.from(frame.body, "base64") : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 55_000);
    try {
      const local = await this.fetchImpl(target, {
        method, redirect: "manual", signal: controller.signal,
        headers: { [HUB_IDENTITY_HEADER]: identity, ...(body && typeof frame.contentType === "string" ? { "content-type": frame.contentType } : {}) },
        ...(body && method !== "GET" ? { body } : {}),
      });
      const answer = Buffer.from(await local.arrayBuffer());
      // The coordinator said no to the signed identity: the reason is in the coordinator's own log (Hub identity rejected: …); here only that it happened.
      if (local.status === 401) this.log("The coordinator refused a forwarded request's identity (401); its log says why.");
      if (answer.length > MAX_ANSWER_BYTES) return json(502, "ANSWER_TOO_LARGE", "The coordinator's answer is larger than the connector forwards.");
      await this.answer(credentials, frame, local.status, local.headers.get("content-type"), answer);
    } catch {
      await json(504, "COORDINATOR_UNAVAILABLE", "The coordinator did not answer.");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Hand the coordinator's answer to the Hub. If the Hub refuses it (non-2xx), say so in one line that carries the status and the size and never the body, and, unless the
   * answer was already the small error, send the Hub a small 502 (ANSWER_REJECTED) for the same request so it fails at once instead of waiting for its forward timeout.
   * Nothing is retried when the Hub says the request is no longer pending (404) or does not accept the machine's signature (401/403): another answer cannot change that.
   */
  private async answer(credentials: MachineCredentials, frame: Frame, status: number, contentType: string | null, body: Buffer, small = false): Promise<void> {
    const id = typeof frame.id === "string" ? frame.id : "";
    if (!id) return;
    try {
      const response = await this.post(credentials, "respond", JSON.stringify({ id, status, contentType, body: body.toString("base64") }));
      if (response.ok) return;
      const refused = response.status;
      await response.body?.cancel().catch(() => undefined);
      this.log(`A forwarded request's answer was refused by the Hub (HTTP ${refused}, ${body.length} bytes, answer status ${status}).`);
      if (small || refused === 404 || refused === 401 || refused === 403) return;
      const message = "The Hub did not accept the machine's answer; the request is failed here instead of waiting for its timeout.";
      await this.answer(credentials, frame, 502, "application/json", Buffer.from(JSON.stringify({ code: "ANSWER_REJECTED", message })), true);
    } catch {
      this.log("A forwarded request's answer could not be delivered to the Hub.");
    }
  }
}
