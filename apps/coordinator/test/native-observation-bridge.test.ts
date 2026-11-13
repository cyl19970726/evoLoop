import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RuntimeEvent, RuntimePort, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { NativeObservationRecord, NativeObservationProjection } from "@evoloop/contracts/native-observation";
import { NativeObservationService } from "@evoloop/core/native-observation";
import { NativeObservationBridge } from "../src/runtime/native-observation.js";

function setup() {
  const projectId = randomUUID(), sessionId = randomUUID(), connectionId = randomUUID();
  let connected = true, eventListener: ((event: RuntimeEvent) => void) | undefined, disconnectListener: (() => void) | undefined;
  let record: NativeObservationRecord | null = null, writes = 0, resolveSource = false;
  const service = {
    async get() { return record; },
    async apply(value: NativeObservationProjection) { writes++; record = structuredClone({ ...value, version: (record?.version ?? 0) + 1 }); return record; },
    async invalidateConnections() {},
    async staleConnection() { if (record) record = { ...record, freshness: "stale", staleReason: "disconnected" }; },
    async refreshSource() {
      if (record?.currentTurn && resolveSource) record.currentTurn.source = { kind: "message", messageId: "message", processingId: "processing", operationId: "op", actorId: "sender" };
      return record;
    },
  };
  const runtime = { onEvent(listener: typeof eventListener) { eventListener = listener; return () => { eventListener = undefined; }; },
    onDisconnect(listener: () => void) { disconnectListener = listener; return () => { disconnectListener = undefined; }; },
    nativeInputConnectionId: () => connected ? connectionId : null,
  } as unknown as RuntimePort & { onDisconnect(listener: () => void): () => void };
  const bridge = new NativeObservationBridge({ service: service as unknown as NativeObservationService,
    session: async () => ({ id: sessionId, projectId, state: "ready", nativeThreadId: "owned" } as RuntimeSessionRecord),
    projects: async () => [projectId], canWrite: () => true, now: () => "2026-10-27T06:00:00.000Z" });
  bridge.attach(runtime);
  return { bridge, projectId, sessionId, connectionId,
    session: { id: sessionId, projectId, state: "ready" } as RuntimeSessionRecord,
    emit(method: string, params: Record<string, unknown>) { eventListener?.({ method, projectId, sessionId, threadId: "owned", params: { threadId: "owned", ...params } }); },
    disconnect() { connected = false; disconnectListener?.(); },
    bindSource() { resolveSource = true; }, get record() { return record; }, get writes() { return writes; },
  };
}

function ledgerSetup() {
  const projectId = randomUUID(), sessionId = randomUUID();
  let connectionId = randomUUID(), tick = 0;
  let eventListener: ((event: RuntimeEvent) => void) | undefined, disconnectListener: (() => void) | undefined;
  let record: NativeObservationRecord | null = null;
  const added: { day: string; delta: { inputTokens: number; outputTokens: number; cachedInputTokens: number } }[] = [];
  const tx = {
    nativeObservation: {
      get: async () => record,
      upsert: async (value: NativeObservationRecord) => { record = structuredClone(value); },
      invalidateConnections: async (_projectId: string, currentConnectionId: string) => {
        if (record && record.connectionId !== currentConnectionId) record = { ...record, freshness: "stale" };
        return record ? 1 : 0;
      },
      staleConnection: async (_projectId: string, staleConnectionId: string, reason: string) => {
        if (record?.connectionId !== staleConnectionId) return 0;
        record = { ...record, freshness: "stale", staleReason: reason };
        return 1;
      },
    },
    getRuntimeSession: async () => ({ id: sessionId, projectId, state: "ready", nativeThreadId: "owned" }),
    nativeInputs: { findSource: async () => null },
    usage: { addUsage: async (_projectId: string, _sessionId: string, day: string,
      delta: { inputTokens: number; outputTokens: number; cachedInputTokens: number }) => {
      added.push({ day, delta });
    } },
  };
  const service = new NativeObservationService({ uow: {
    transaction: async (_projectId: string, action: (value: unknown) => Promise<unknown>) => action(tx),
    read: async (_projectId: string, action: (value: unknown) => Promise<unknown>) => action(tx),
  } as never, clock: { now: () => "2026-11-10T00:00:00.000Z" } });
  const runtime = {
    onEvent(listener: typeof eventListener) { eventListener = listener; return () => { eventListener = undefined; }; },
    onDisconnect(listener: () => void) { disconnectListener = listener; return () => { disconnectListener = undefined; }; },
    nativeInputConnectionId: () => connectionId,
  } as unknown as RuntimePort & { onDisconnect(listener: () => void): () => void };
  const session = { id: sessionId, projectId, state: "ready", nativeThreadId: "owned" } as RuntimeSessionRecord;
  const bridge = new NativeObservationBridge({ service,
    session: async () => session, projects: async () => [projectId], canWrite: () => true,
    now: () => new Date(Date.UTC(2026, 10, 10, 0, 0, tick++)).toISOString() });
  bridge.attach(runtime);
  const usage = (total: number, last: number) => ({
    total: { inputTokens: total, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total },
    last: { inputTokens: last, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: last },
    modelContextWindow: null,
  });
  return {
    bridge, projectId, sessionId, session,
    async connect() { connectionId = randomUUID(); bridge.attach(runtime); await bridge.opened(); },
    disconnect() { disconnectListener?.(); },
    emit(method: string, params: Record<string, unknown>) {
      eventListener?.({
        method, projectId, sessionId, threadId: "owned", params: { threadId: "owned", ...params },
      });
    },
    token(turnId: string, total: number, last: number) {
      this.emit("thread/tokenUsage/updated", { turnId, tokenUsage: usage(total, last) });
    },
    async pump() { await bridge.pump(projectId, [session]); },
    get inputTokens() { return added.reduce((total, entry) => total + entry.delta.inputTokens, 0); },
    added,
  };
}

test("native events coalesce to one bounded current snapshot and usage is never summed", async () => {
  const f = setup(); await f.bridge.opened();
  f.emit("turn/started", { turn: { id: "A", status: "inProgress", startedAt: 100 } });
  assert.equal(f.bridge.current(f.projectId, f.sessionId)?.currentTurn?.id, "A");
  const tokenUsage = { total: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 }, last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, modelContextWindow: null };
  f.emit("thread/tokenUsage/updated", { turnId: "A", tokenUsage });
  f.emit("thread/tokenUsage/updated", { turnId: "A", tokenUsage });
  f.emit("item/reasoning/textDelta", { turnId: "A", text: "private reasoning must not enter projection" });
  assert.equal(f.writes, 0);
  await f.bridge.pump(f.projectId, [f.session]);
  assert.equal(f.writes, 1); assert.equal(f.record?.usage?.total.totalTokens, 120);
  assert.equal(f.record?.usage?.total.inputTokens, 100); assert.equal(f.record?.usage?.total.cachedInputTokens, 80);
  assert.equal(JSON.stringify(f.record).includes("private reasoning"), false);
  const view = await f.bridge.get(f.projectId, f.sessionId);
  assert.ok(view); assert.equal("connectionId" in view, false); assert.equal(view.currentTurn?.source, null);
  f.bindSource(); await f.bridge.pump(f.projectId, [f.session]);
  assert.equal((await f.bridge.get(f.projectId, f.sessionId))?.currentTurn?.source?.kind, "message");
});

test("disconnect flushes the last bounded facts then exposes them as stale", async () => {
  const f = setup(); await f.bridge.opened();
  f.emit("turn/started", { turn: { id: "A", status: "inProgress", startedAt: 100 } });
  f.emit("turn/diff/updated", { turnId: "A", diff: "observed diff" });
  f.disconnect(); await f.bridge.drain();
  assert.equal(f.bridge.current(f.projectId, f.sessionId), null);
  assert.equal(f.record?.diff?.text, "observed diff"); assert.equal(f.record?.freshness, "stale");
  const view = await f.bridge.get(f.projectId, f.sessionId);
  assert.equal(view?.freshness, "stale"); assert.equal(view?.staleReason, "connection_unavailable");
  const count = f.writes;
  f.emit("turn/started", { turn: { id: "late", status: "inProgress" } });
  await f.bridge.pump(f.projectId, [f.session]); assert.equal(f.writes, count);
});

test("an old Turn cannot replace current work items or terminal status", async () => {
  const f = setup(); await f.bridge.opened();
  f.emit("turn/started", { turn: { id: "A", status: "inProgress", startedAt: 100 } });
  f.emit("turn/completed", { turn: { id: "A", status: "completed", startedAt: 100 } });
  f.emit("turn/started", { turn: { id: "B", status: "inProgress", startedAt: 200 } });
  f.emit("item/completed", { turnId: "B", item: { id: "tool-B", type: "mcpToolCall", tool: "lookup", status: "completed" } });
  f.emit("item/started", { turnId: "B", item: { id: "tool-B", type: "mcpToolCall", tool: "lookup", status: "inProgress" } });
  f.emit("turn/started", { turn: { id: "A", status: "inProgress", startedAt: 100 } });
  f.emit("turn/diff/updated", { turnId: "A", diff: "old diff" });
  await f.bridge.pump(f.projectId, [f.session]);
  assert.equal(f.record?.currentTurn?.id, "B"); assert.equal(f.record?.items[0]?.status, "completed");
  assert.equal(f.record?.diff, null);
});

test("a reconnect keeps the persisted usage baseline before the next usage notification", async () => {
  const f = ledgerSetup();
  await f.connect();
  f.token("one", 100, 100);
  await f.pump();
  assert.equal(f.inputTokens, 100);

  f.disconnect();
  await f.bridge.drain();
  await f.connect();
  f.emit("turn/started", { turn: { id: "two", status: "inProgress", startedAt: 200 } });
  await f.pump();
  f.token("two", 150, 50);
  f.token("two", 200, 50);
  await f.pump();
  assert.equal(f.inputTokens, 200);
});

test("usage notifications coalesced into one pump keep every request across a reset", async () => {
  const f = ledgerSetup();
  await f.connect();
  f.token("one", 100, 100);
  await f.pump();

  f.emit("turn/started", { turn: { id: "two", status: "inProgress", startedAt: 200 } });
  f.token("two", 50, 50);
  f.token("two", 100, 50);
  await f.pump();
  assert.equal(f.inputTokens, 200);
});

test("a repeated cumulative notification with a new receive time is not charged twice", async () => {
  const f = ledgerSetup();
  await f.connect();
  f.token("one", 100, 100);
  f.token("one", 100, 100);
  await f.pump();
  assert.equal(f.inputTokens, 100);
});
