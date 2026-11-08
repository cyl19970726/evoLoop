import assert from "node:assert/strict";
import test from "node:test";
import { assertIsolatedConnectorRoutes, connectorRouteSchema, connectorSourceKey,
  versionedConnectorRouteSchema, type ConnectorRoute } from "../src/message-connectors.js";

const route = (conversationId: string, sessionId: string): ConnectorRoute => ({
  projectId: "11111111-1111-4111-8111-111111111111",
  bindingId: "22222222-2222-4222-8222-222222222222",
  source: { provider: "wechat", connectionId: "test-account", conversationId },
  conversationLabel: `Conversation ${conversationId}`,
  conversationKind: "group",
  targetSessionId: sessionId, targetThreadId: "thread-test", targetActorId: "recipient", senderActorId: "connector",
  owner: "test-owner", epoch: 1, sessionRef: "test-session", state: "active",
  mode: "standard", readScope: "project", sendTargets: [conversationId], senderIds: ["member-a"],
  internalTargets: [],
  capabilities: { history: true, search: false, subscribe: true, sendText: true, sendMedia: false, receipt: "local_observed" },
  policyHash: "a".repeat(64),
});

test("different conversations cannot share one native Session context", () => {
  const a = route("group-a", "33333333-3333-4333-8333-333333333333");
  const b = route("group-b", a.targetSessionId);
  assert.throws(() => assertIsolatedConnectorRoutes([a, b]), /CONNECTOR_SESSION_CONTEXT_SHARED/);
  assert.doesNotThrow(() => assertIsolatedConnectorRoutes([a, { ...b, targetSessionId: "44444444-4444-4444-8444-444444444444" }]));
});

test("one source cannot have two automatic drivers", () => {
  const a = route("group-a", "33333333-3333-4333-8333-333333333333");
  assert.throws(() => assertIsolatedConnectorRoutes([a, { ...a, targetSessionId: "44444444-4444-4444-8444-444444444444" }]),
    /CONNECTOR_SOURCE_ALREADY_BOUND/);
  assert.throws(() => assertIsolatedConnectorRoutes([a, { ...a,
    projectId: "55555555-5555-4555-8555-555555555555",
    targetSessionId: "44444444-4444-4444-8444-444444444444" }]),
    /CONNECTOR_SOURCE_ALREADY_BOUND/);
  assert.doesNotThrow(() => assertIsolatedConnectorRoutes([{ ...a, state: "disabled" },
    { ...a, targetSessionId: "44444444-4444-4444-8444-444444444444" }]));
});

test("capability combinations are provider independent", () => {
  const a = route("group-a", "33333333-3333-4333-8333-333333333333");
  assert.doesNotThrow(() => assertIsolatedConnectorRoutes([{ ...a, source: { ...a.source, provider: "discord" },
    capabilities: { history: true, search: true, subscribe: false, sendText: false, sendMedia: false, receipt: "none" } }]));
});

test("standard route requires exact source send target and distinct target lists", () => {
  const a = route("group-a", "33333333-3333-4333-8333-333333333333");
  assert.equal(versionedConnectorRouteSchema.parse({ ...a, version: 1 }).mode,"standard");
  assert.throws(() => connectorRouteSchema.parse({ ...a, sendTargets: ["other"] }),/source conversation/);
  assert.throws(() => connectorRouteSchema.parse({ ...a, sendTargets: ["group-a","group-a"] }),/Duplicate/);
  assert.throws(() => connectorRouteSchema.parse({ ...a, internalTargets: [a.targetSessionId,a.targetSessionId] }),/Duplicate/);
  assert.equal(connectorRouteSchema.parse({ ...a, mode:"restricted", sendTargets:[] }).mode,"restricted");
  assert.throws(() => connectorRouteSchema.parse({ ...a, conversationLabel:"" }),/too small|at least/i);
  assert.throws(() => connectorRouteSchema.parse({ ...a, conversationKind:"channel" } as never));
  assert.throws(() => connectorRouteSchema.parse({ ...a, senderIds:[] }),/too small|at least/i);
  assert.throws(() => connectorRouteSchema.parse({ ...a, targetThreadId:"" }),/Invalid|too small/i);
  assert.throws(() => connectorRouteSchema.parse({ ...a, readScope:"documents" } as never));
});

test("source key keeps provider, connection, conversation, delivery and event distinct", () => {
  const base = { source: { provider: "wechat", connectionId: "account-1", conversationId: "group-a" },
    deliveryId: 7, cursorStart: 10, cursorEnd: 12, eventCursor: 11, participantId: "member-a", replyToEventCursor: null };
  assert.notEqual(connectorSourceKey(base), connectorSourceKey({ ...base, source: { ...base.source, conversationId: "group-b" } }));
  assert.notEqual(connectorSourceKey(base), connectorSourceKey({ ...base, eventCursor: 12 }));
  assert.throws(() => connectorSourceKey({ ...base, cursorEnd: 9 }), /CONNECTOR_CURSOR_RANGE/);
});
