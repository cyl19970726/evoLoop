import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RuntimeEvent, RuntimePort, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { NativeObservationRecord, NativeObservationProjection } from "@evoloop/contracts/native-observation";
import type { NativeObservationService } from "@evoloop/core/native-observation";
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

test("native events coalesce to one bounded current snapshot and usage is never summed", async () => {
  const f = setup(); await f.bridge.opened();
  f.emit("turn/started", { turn: { id: "A", status: "inProgress", startedAt: 100 } });
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
