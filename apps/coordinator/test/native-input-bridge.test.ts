import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import type { NativeInputCapture, NativeInputEvent, NativeInputRecord } from "@evoloop/contracts/native-input";
import type { RuntimePort } from "@evoloop/contracts/runtime";
import type { NativeInputService } from "@evoloop/core/native-input";
import { NativeInputBridge } from "../src/runtime/native-input.js";

const now = "2026-10-27T06:00:00.000Z";
function setup() {
  const projectId = randomUUID(), sessionId = randomUUID(), connectionId = randomUUID();
  const principal: Principal = { actorId: "human", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const session = { projectId, id: sessionId, state: "ready", nativeThreadId: "thread" } as RuntimeSessionRecord;
  const capture: NativeInputCapture = { projectId, sessionId, id: randomUUID(), connectionId, nativeRequestId: "rpc-1",
    threadId: "thread", turnId: "turn", itemId: "item", method: "item/tool/requestUserInput",
    questions: [{ id: "q", header: "选择", question: "使用哪一个？", isOther: false,
      options: [{ label: "A", description: "第一项" }, { label: "B", description: "第二项" }] }],
    isBlocking: true, supported: true, unavailableReason: null, observedAt: now };
  let record: NativeInputRecord | null = null, live = true, authority = true, writable = true, sends = 0, failSend = false;
  let beforeCapture: (() => void) | null = null;
  let listener: ((event: NativeInputEvent) => void | Promise<void>) | null = null;
  const service = {
    async capture(value: NativeInputCapture) {
      beforeCapture?.();
      record = { ...value, version: 1, state: "pending", source: { kind: "run", runId: randomUUID(), operationId: randomUUID(),
        actorId: "worker", taskId: randomUUID(), taskRevisionId: randomUUID() }, response: null, reason: null, createdAt: now, updatedAt: now };
      return record;
    },
    async closed(_project: string, id: string, connection: string, reason: string) {
      if (record?.id === id && record.connectionId === connection && !["resolved", "unavailable"].includes(record.state))
        record = { ...record, state: reason === "native_resolved" ? "resolved" : "unavailable", reason, version: record.version + 1 };
      return record;
    },
    async get() { return record; }, async list() { return record ? [record] : []; },
    async refreshSources() {}, async invalidateConnections(_project: string, connection: string) {
      if (record && record.connectionId !== connection) await service.closed(projectId, record.id, record.connectionId, "disconnected");
    },
    async pendingResponses() { return record?.state === "response_saved" && record.response?.outcome === "pending" ? [record] : []; },
    async claimResponse(_project: string, id: string, connection: string) {
      if (record?.id !== id || record.connectionId !== connection || record.response?.outcome !== "pending") return null;
      record = { ...record, response: { ...record.response, attemptedAt: now, outcome: "attempted" } }; return record;
    },
    async finishResponse(_project: string, _id: string, _connection: string, outcome: "submitted" | "unknown") {
      if (record?.response) record = { ...record, response: { ...record.response, outcome, submittedAt: outcome === "submitted" ? now : null } };
    },
  };
  const runtime = {
    nativeInputConnectionId: () => connectionId,
    onNativeInput(value: typeof listener) { listener = value; return () => { listener = null; }; },
    hasPendingInput: (id: string, connection: string) => live && id === capture.id && connection === connectionId,
    async respondToInput(id: string, connection: string, answers: Record<string, string[]>) {
      assert.equal(record?.response?.outcome, "attempted", "intent must be durable before the wire attempt");
      assert.equal(id, capture.id); assert.equal(connection, connectionId); assert.deepEqual(answers, { q: ["B"] });
      sends++; live = false;
      if (failSend) throw Error("unknown pipe write");
    },
  } as unknown as RuntimePort;
  const bridge = new NativeInputBridge({ service: service as unknown as NativeInputService,
    canWrite: () => writable, projects: async () => [projectId], principal: async () => principal,
    session: async () => session, executionAuthorized: async () => authority, now: () => now });
  bridge.attach(runtime);
  return { bridge, projectId, principal, session, capture, runtime, service,
    emit: async (event: NativeInputEvent) => { await listener?.(event); },
    get record() { return record; }, get sends() { return sends; },
    saveResponse() {
      assert.ok(record); record = { ...record, state: "response_saved", response: { operationId: randomUUID(), actorId: principal.actorId,
        answers: { q: ["B"] }, savedAt: now, attemptedAt: null, submittedAt: null, outcome: "pending" } };
    },
    stopLive() { live = false; }, revoke() { authority = false; }, loseLease() { writable = false; },
    failSend() { failSend = true; }, beforeCapture(action: () => void) { beforeCapture = action; },
  };
}

test("reply intent is sent once on the same connection and never restarts native work", async () => {
  const f = setup(); await f.emit({ type: "requested", request: f.capture });
  await f.bridge.requireReply(f.principal, f.projectId, f.capture.id);
  const view = (await f.bridge.views(f.principal, f.projectId, f.session.id))[0]!;
  assert.equal(view.canReply, true);
  assert.equal("nativeRequestId" in view, false); assert.equal("connectionId" in view, false);
  f.saveResponse(); await f.bridge.pump(f.projectId, [f.session]); await f.bridge.pump(f.projectId, [f.session]);
  assert.equal(f.sends, 1); assert.equal(f.record?.response?.outcome, "submitted");
  await f.emit({ type: "closed", projectId: f.projectId, id: f.capture.id, connectionId: f.capture.connectionId,
    reason: "native_resolved", observedAt: now });
  assert.equal(f.record?.state, "resolved"); assert.equal(f.record?.response?.outcome, "submitted");
});

test("a native resolution overtaking persistence cannot leave a dead question answerable", async () => {
  const f = setup(); f.beforeCapture(() => f.stopLive());
  await f.emit({ type: "requested", request: f.capture });
  assert.equal(f.record?.state, "unavailable"); assert.equal(f.record?.reason, "request_unavailable");
  await assert.rejects(() => f.bridge.requireReply(f.principal, f.projectId, f.capture.id));
  assert.equal(f.sends, 0);
});

test("uncertain send is recorded without replay even while the saved response remains visible", async () => {
  const f = setup(); await f.emit({ type: "requested", request: f.capture }); f.saveResponse(); f.failSend();
  await f.bridge.pump(f.projectId, [f.session]); await f.bridge.pump(f.projectId, [f.session]);
  assert.equal(f.sends, 1); assert.equal(f.record?.response?.outcome, "unknown");
});

test("revoked current execution authority blocks a reply saved under earlier authority", async () => {
  const f = setup(); await f.emit({ type: "requested", request: f.capture }); f.saveResponse(); f.revoke();
  await f.bridge.pump(f.projectId, [f.session]);
  assert.equal(f.sends, 0); assert.equal(f.record?.state, "unavailable");
  assert.equal(f.record?.reason, "authorization_revoked");
});

test("a read-only identity or lost coordinator lease cannot reply", async () => {
  const f = setup(); await f.emit({ type: "requested", request: f.capture });
  await assert.rejects(() => f.bridge.requireReply({ ...f.principal, permissions: ["read"] }, f.projectId, f.capture.id));
  f.loseLease(); await assert.rejects(() => f.bridge.requireReply(f.principal, f.projectId, f.capture.id));
  assert.equal(f.sends, 0);
});
