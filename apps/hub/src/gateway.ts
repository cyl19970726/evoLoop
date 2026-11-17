import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { HubError } from "./errors.js";

export type ForwardRequest = {
  method: string;
  /** Always `/api/projects/<uuid>/...` or `/api/commands`: validated by the caller, checked again by the machine. */
  path: string;
  identity: string;
  contentType: string | null;
  body: Buffer | null;
};
export type ForwardResponse = { status: number; contentType: string | null; body: Buffer };

type Pending = { resolve(value: ForwardResponse): void; reject(error: HubError): void; timer: NodeJS.Timeout };
type Connection = {
  id: string;
  machineId: string;
  /** A random ID the connector makes once per process; null for a connector that does not send one (an older release). Never a secret. */
  instanceId: string | null;
  out: Writable;
  pending: Map<string, Pending>;
  connectedAt: number;
  lastBeatAt: number;
  closed: boolean;
};

/** What the gateway tells the Hub's log about a machine's connection. Machine and instance IDs only: nothing here is a key or a token. */
export type GatewayEvent = {
  type: "attached" | "reattached_same_process" | "replaced_stale" | "conflict" | "dropped";
  machineId: string; connectionId?: string; instance?: string | null; existingInstance?: string | null;
  /** For a conflict or a stale replacement: how long since the existing connection last beat, and how long it has been up. */
  existingBeatAgeMs?: number; existingUpMs?: number; conflictCount?: number; reason?: string;
};
export type GatewayOptions = { heartbeatMs: number; forwardTimeoutMs: number; maxResponseBytes: number; now?: () => number; onEvent?: (event: GatewayEvent) => void };
export type ConflictRecord = { count: number; lastAt: string; lastInstance: string | null; existingInstance: string | null };

/**
 * The live half of machine state: one open streaming connection per machine, opened by the machine (so the machine listens on nothing), and the
 * requests waiting on it. In memory by design: a restarted Hub has no connections until its machines reconnect (they do, by themselves), and a
 * request in flight when it dies fails; nothing the machine already runs depends on it.
 */
export class Gateway {
  private readonly connections = new Map<string, Connection>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  private readonly pingTimer: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? Date.now;
    this.pingTimer = setInterval(() => this.ping(), options.heartbeatMs);
    this.pingTimer.unref();
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const connection of [...this.connections.values()]) this.drop(connection, "hub_shutdown");
  }

  /**
   * Register the machine's connection. At most one connection per machine is live:
   * - the same process reconnecting (same instance ID) replaces its own old link at once (its link broke before the Hub noticed);
   * - a different process while the existing connection is still alive (it beat within three intervals) is refused with MACHINE_CONNECTION_CONFLICT and the
   *   existing connection is left alone: two processes on one credential would otherwise replace each other every second and answer each other's requests;
   * - a different process after the existing connection has gone quiet takes over (the old process is gone or its link is dead), so nothing stays locked.
   * A connector that sends no instance ID (an older release) is treated as a different process from any other, and as the same as no one: it may replace a link that
   * has gone quiet, and is refused while another is alive.
   */
  attach(machineId: string, open: Writable | (() => Writable), instanceId: string | null = null): { connectionId: string; detach(): void } {
    const previous = this.connections.get(machineId);
    let type: GatewayEvent["type"] = "attached";
    if (previous && !previous.closed) {
      const age = this.now() - previous.lastBeatAt;
      const sameProcess = previous.instanceId !== null && previous.instanceId === instanceId;
      const alive = age <= this.options.heartbeatMs * 3;
      if (!sameProcess && alive) {
        const known = this.conflicts.get(machineId);
        const record: ConflictRecord = { count: (known?.count ?? 0) + 1, lastAt: new Date(this.now()).toISOString(), lastInstance: instanceId, existingInstance: previous.instanceId };
        this.conflicts.set(machineId, record);
        this.options.onEvent?.({ type: "conflict", machineId, instance: instanceId, existingInstance: previous.instanceId, existingBeatAgeMs: age, existingUpMs: this.now() - previous.connectedAt, conflictCount: record.count });
        throw new HubError(409, "MACHINE_CONNECTION_CONFLICT",
          "Another process is already connected as this machine. A machine's credentials belong to one coordinator; this connection was refused and the existing one was not replaced.");
      }
      type = sameProcess ? "reattached_same_process" : "replaced_stale";
      this.options.onEvent?.({ type, machineId, instance: instanceId, existingInstance: previous.instanceId, existingBeatAgeMs: age, existingUpMs: this.now() - previous.connectedAt });
      this.drop(previous, sameProcess ? "replaced" : "replaced_stale");
    }
    // The stream is opened only once the connection is admitted, so a refusal is an ordinary error reply.
    const out = typeof open === "function" ? open() : open;
    const connection: Connection = { id: randomUUID(), machineId, instanceId, out, pending: new Map(), connectedAt: this.now(), lastBeatAt: this.now(), closed: false };
    this.connections.set(machineId, connection);
    if (type === "attached") this.options.onEvent?.({ type, machineId, connectionId: connection.id, instance: instanceId });
    this.write(connection, { t: "hello", machineId, heartbeatMs: this.options.heartbeatMs });
    return { connectionId: connection.id, detach: () => this.drop(connection, "machine_closed") };
  }

  /** The conflicts the gateway has refused for this machine since the Hub started (memory only: the Hub's log is the durable record). */
  conflictRecord(machineId: string): ConflictRecord | null { return this.conflicts.get(machineId) ?? null; }

  online(machineId: string): boolean {
    const connection = this.connections.get(machineId);
    return !!connection && !connection.closed && this.now() - connection.lastBeatAt <= this.options.heartbeatMs * 3;
  }

  connectedAt(machineId: string): string | null {
    const connection = this.connections.get(machineId);
    return connection && !connection.closed ? new Date(connection.connectedAt).toISOString() : null;
  }

  /** A heartbeat counts for the connection of the process that sent it; another process's beat does not keep a connection alive. */
  beat(machineId: string, instanceId: string | null = null): boolean {
    const connection = this.connections.get(machineId);
    if (!connection || connection.closed) return false;
    if (connection.instanceId !== null && instanceId !== null && connection.instanceId !== instanceId) return false;
    connection.lastBeatAt = this.now();
    return true;
  }

  /** Close the machine's connection at once (the machine was removed). */
  disconnect(machineId: string, reason: string): void {
    const connection = this.connections.get(machineId);
    if (connection) this.drop(connection, reason);
  }

  async forward(machineId: string, request: ForwardRequest): Promise<ForwardResponse> {
    const connection = this.connections.get(machineId);
    if (!connection || connection.closed || !this.online(machineId)) {
      throw new HubError(503, "MACHINE_OFFLINE", "The machine this project runs on is not connected to the Hub.");
    }
    const id = randomUUID();
    return new Promise<ForwardResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new HubError(504, "MACHINE_TIMEOUT", "The machine did not answer in time."));
      }, this.options.forwardTimeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      this.write(connection, { t: "request", id, method: request.method, path: request.path, identity: request.identity,
        contentType: request.contentType, body: request.body ? request.body.toString("base64") : null });
    });
  }

  /** The machine's answer. Only the connection the request went out on may answer it. */
  respond(machineId: string, answer: { id: string; status: number; contentType: string | null; body: Buffer }, instanceId: string | null = null): boolean {
    const connection = this.connections.get(machineId);
    const pending = connection?.pending.get(answer.id);
    if (!connection || !pending) return false;
    if (connection.instanceId !== null && instanceId !== null && connection.instanceId !== instanceId) return false;
    if (answer.body.length > this.options.maxResponseBytes) {
      clearTimeout(pending.timer);
      connection.pending.delete(answer.id);
      pending.reject(new HubError(502, "MACHINE_RESPONSE_TOO_LARGE", "The machine's answer is larger than the Hub forwards."));
      return true;
    }
    clearTimeout(pending.timer);
    connection.pending.delete(answer.id);
    pending.resolve({ status: answer.status, contentType: answer.contentType, body: answer.body });
    return true;
  }

  private ping(): void {
    for (const connection of this.connections.values()) {
      // A machine that has not beaten for three intervals is not online; its link may be half open, so end it and let the machine reconnect.
      if (this.now() - connection.lastBeatAt > this.options.heartbeatMs * 3) this.drop(connection, "heartbeat_lost");
      else this.write(connection, { t: "ping", at: new Date(this.now()).toISOString() });
    }
  }

  private write(connection: Connection, frame: Record<string, unknown>): void {
    if (connection.closed) return;
    try {
      connection.out.write(`${JSON.stringify(frame)}\n`);
    } catch {
      this.drop(connection, "write_failed");
    }
  }

  private drop(connection: Connection, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    if (this.connections.get(connection.machineId) === connection) this.connections.delete(connection.machineId);
    if (reason !== "replaced" && reason !== "replaced_stale") this.options.onEvent?.({ type: "dropped", machineId: connection.machineId, connectionId: connection.id, instance: connection.instanceId, reason });
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HubError(502, "MACHINE_DISCONNECTED", "The machine disconnected before it answered."));
    }
    connection.pending.clear();
    try {
      connection.out.write(`${JSON.stringify({ t: "bye", reason })}\n`);
      connection.out.end();
    } catch { /* already closed */ }
  }
}
