import type { RuntimeEvent, RuntimePort, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { NativeObservationRecord } from "@evoloop/contracts/native-observation";
import { NativeObservationService, reduceNativeObservation } from "@evoloop/core/native-observation";

type ObservableRuntime = RuntimePort & { onDisconnect(listener: (reason: string) => void): () => void };
type Entry = { value: NativeObservationRecord; sequence: number; dirty: boolean };
export type NativeObservationView = Omit<NativeObservationRecord, "connectionId">;
const keyOf = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

/** Current-state coalescing inside the existing runner; no native history mirror or independent timer. */
export class NativeObservationBridge {
  private runtime: ObservableRuntime | null = null;
  private connectionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private disconnect: (() => void) | null = null;
  private entries = new Map<string, Entry>();
  private errors = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly deps: { service: NativeObservationService; canWrite(): boolean;
    projects(): Promise<string[]>; session(projectId: string, sessionId: string): Promise<RuntimeSessionRecord | null>; now(): string }) {}

  attach(runtime: ObservableRuntime): void {
    this.detach(); this.runtime = runtime; this.entries.clear(); this.errors.clear(); this.connectionId = null;
    this.unsubscribe = runtime.onEvent(event => this.observe(runtime, event));
    this.disconnect = runtime.onDisconnect(() => {
      const connectionId = this.connectionId;
      if (runtime !== this.runtime || !connectionId) return;
      this.connectionId = null;
      if (!this.deps.canWrite()) return;
      // Persist the last bounded facts before marking the connection stale. Serialize behind any in-flight flush.
      this.enqueue(async () => {
        for (const entry of this.entries.values()) {
          if (entry.value.connectionId !== connectionId || !entry.dirty) continue;
          const value = { ...entry.value, freshness: "stale" as const, staleReason: "disconnected" };
          try { await this.save(entry, value); }
          catch { this.errors.add(keyOf(value.projectId, value.sessionId)); }
        }
        for (const projectId of await this.deps.projects())
          await this.deps.service.staleConnection(projectId, connectionId, "disconnected");
      });
    });
  }
  async opened(): Promise<void> {
    const connectionId = this.runtime?.nativeInputConnectionId?.();
    if (!connectionId || !this.deps.canWrite()) return;
    await this.drain();
    for (const projectId of await this.deps.projects())
      await this.deps.service.invalidateConnections(projectId, connectionId);
    this.connectionId = connectionId;
  }
  private observe(runtime: ObservableRuntime, event: RuntimeEvent): void {
    if (runtime !== this.runtime || !this.deps.canWrite() || !event.projectId || !event.sessionId || !event.threadId) return;
    const connectionId = runtime.nativeInputConnectionId?.();
    if (!connectionId || connectionId !== this.connectionId) return;
    const key = keyOf(event.projectId, event.sessionId), prior = this.entries.get(key);
    try {
      const value = reduceNativeObservation(prior?.value ?? null, { projectId: event.projectId, sessionId: event.sessionId,
        threadId: event.threadId, connectionId, method: event.method, params: event.params, observedAt: this.deps.now() });
      if (value) this.entries.set(key, { value, sequence: (prior?.sequence ?? 0) + 1, dirty: true });
    } catch { this.errors.add(key); }
  }
  private enqueue(work: () => Promise<void>): void {
    this.writes = this.writes.then(work).catch(() => {
      for (const key of this.entries.keys()) this.errors.add(key);
    });
  }
  private async save(entry: Entry, value = entry.value): Promise<void> {
    const sequence = entry.sequence, key = keyOf(value.projectId, value.sessionId);
    const saved = await this.deps.service.apply(value);
    const current = this.entries.get(key);
    if (current === entry && current.sequence === sequence) { current.value = saved; current.dirty = false; }
    this.errors.delete(key);
  }
  async pump(projectId: string, sessions: RuntimeSessionRecord[]): Promise<void> {
    if (!this.connectionId || !this.deps.canWrite()) return;
    const connectionId = this.connectionId;
    this.enqueue(async () => {
      if (!this.deps.canWrite()) return;
      const ready = new Set(sessions.filter(session => session.state === "ready").map(session => session.id));
      for (const [key, entry] of this.entries) {
        if (entry.value.projectId !== projectId) continue;
        if (!ready.has(entry.value.sessionId)) { this.entries.delete(key); continue; }
        if (entry.value.connectionId !== connectionId || !entry.dirty) continue;
        try { await this.save(entry); } catch { this.errors.add(key); }
      }
      for (const session of sessions) {
        const key = keyOf(projectId, session.id);
        try {
          const saved = await this.deps.service.refreshSource(projectId, session.id);
          const entry = this.entries.get(key);
          if (entry && !entry.dirty && saved?.connectionId === connectionId) entry.value = saved;
        } catch { this.errors.add(key); }
      }
    });
    await this.drain();
  }
  async get(projectId: string, sessionId: string): Promise<NativeObservationView | null> {
    const value = await this.deps.service.get(projectId, sessionId);
    if (!value) return null;
    const { connectionId, ...view } = value;
    const session = await this.deps.session(projectId, sessionId);
    if (!session || session.state !== "ready" || session.nativeThreadId !== value.threadId)
      return { ...view, freshness: "stale", staleReason: "session_unavailable" };
    if (connectionId !== this.runtime?.nativeInputConnectionId?.() || !this.deps.canWrite())
      return { ...view, freshness: "stale", staleReason: "connection_unavailable" };
    if (this.errors.has(keyOf(projectId, sessionId)))
      return { ...view, freshness: "stale", staleReason: "projection_unavailable" };
    return view;
  }
  async drain(): Promise<void> { await this.writes; }
  detach(): void { this.unsubscribe?.(); this.disconnect?.(); this.unsubscribe = null; this.disconnect = null; this.runtime = null; }
}
