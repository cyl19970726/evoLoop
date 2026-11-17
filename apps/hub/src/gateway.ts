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
  out: Writable;
  pending: Map<string, Pending>;
  connectedAt: number;
  lastBeatAt: number;
  closed: boolean;
};

export type GatewayOptions = { heartbeatMs: number; forwardTimeoutMs: number; maxResponseBytes: number; now?: () => number };

/**
 * The live half of machine state: one open streaming connection per machine, opened by the machine (so the machine listens on nothing), and the
 * requests waiting on it. In memory by design: a restarted Hub has no connections until its machines reconnect (they do, by themselves), and a
 * request in flight when it dies fails; nothing the machine already runs depends on it.
 */
export class Gateway {
  private readonly connections = new Map<string, Connection>();
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

  /** Register the machine's connection. A newer one replaces the older (a machine that lost its link reconnects before the Hub noticed). */
  attach(machineId: string, out: Writable): { connectionId: string; detach(): void } {
    const previous = this.connections.get(machineId);
    if (previous) this.drop(previous, "replaced");
    const connection: Connection = { id: randomUUID(), machineId, out, pending: new Map(), connectedAt: this.now(), lastBeatAt: this.now(), closed: false };
    this.connections.set(machineId, connection);
    this.write(connection, { t: "hello", machineId, heartbeatMs: this.options.heartbeatMs });
    return { connectionId: connection.id, detach: () => this.drop(connection, "machine_closed") };
  }

  online(machineId: string): boolean {
    const connection = this.connections.get(machineId);
    return !!connection && !connection.closed && this.now() - connection.lastBeatAt <= this.options.heartbeatMs * 3;
  }

  connectedAt(machineId: string): string | null {
    const connection = this.connections.get(machineId);
    return connection && !connection.closed ? new Date(connection.connectedAt).toISOString() : null;
  }

  beat(machineId: string): boolean {
    const connection = this.connections.get(machineId);
    if (!connection || connection.closed) return false;
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
  respond(machineId: string, answer: { id: string; status: number; contentType: string | null; body: Buffer }): boolean {
    const connection = this.connections.get(machineId);
    const pending = connection?.pending.get(answer.id);
    if (!connection || !pending) return false;
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
