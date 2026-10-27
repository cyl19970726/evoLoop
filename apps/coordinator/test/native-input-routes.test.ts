import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import type { NativeInputBridge } from "../src/runtime/native-input.js";
import type { NativeObservationBridge } from "../src/runtime/native-observation.js";
import type { SessionObservationService } from "@evoloop/core/session-observation";
import { buildServer } from "../src/server.js";

test("native questions use authenticated project reads and live reply checks before journaling", async () => {
  const projectId = randomUUID(), sessionId = randomUUID(), inputRequestId = randomUUID(), token = "n".repeat(40);
  let allowed = true, writes = 0, viewReads = 0, journalled = false, liveChecks = 0;
  const identity = (p: Principal, project: string) => {
    assert.equal(p.actorId, "human");
    if (!p.projectIds.includes(project)) throw new DomainError("FORBIDDEN", "Wrong project");
  };
  const session = { key: `owned:${sessionId}`, target: { kind: "owned", sessionId }, capabilities: {} };
  const unknownResource = { value: null, unit: "unknown", source: null, scope: "session", observedAt: null,
    interval: null, unavailableReason: "没有证据" };
  const app = await buildServer({ credentials: [{ token, actorId: "human", projectIds: [projectId], permissions: ["read", "write", "review"] }],
    service: {
      listRoleRevisions: async () => [], listRoleReviews: async () => [],
      listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [],
      getProject: async (p: Principal, project: string) => { identity(p, project); return { id: project }; },
      getRuntimeSession: async (p: Principal, project: string) => { identity(p, project); return session; },
      getOperation: async () => journalled ? { actorId: "human", result: { status: "applied" } } : null,
      execute: async (p: Principal) => { identity(p, projectId); writes++; return { status: "applied" }; },
    } as unknown as WorkflowService,
    sessionWork: { snapshot: async (p: Principal, project: string) => { identity(p, project); return { session,
      resources: { configuredModel: unknownResource, actualModel: unknownResource, cost: unknownResource,
        inputTokens: unknownResource, outputTokens: unknownResource } }; },
      directory: async () => ({ items: [session] }) } as unknown as SessionObservationService,
    nativeInputs: {
      requireReply: async (p: Principal, project: string, id: string) => {
        liveChecks++;
        identity(p, project); assert.equal(id, inputRequestId);
        if (!allowed) throw new DomainError("NATIVE_INPUT_UNAVAILABLE", "Old connection");
      },
      views: async () => { viewReads++; return [{ id: inputRequestId, canReply: allowed }]; },
      one: async () => ({ id: inputRequestId, canReply: allowed }),
    } as unknown as NativeInputBridge,
    nativeObservation: { get: async () => ({ projectId, sessionId, freshness: "stale", staleReason: "disconnected",
      usage: { turnId: "exact-turn", observedAt: "2026-10-27T01:00:00.000Z", total: {
        inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 }, last: null } }) } as unknown as NativeObservationBridge,
  });
  const headers = { authorization: `Bearer ${token}` };
  const payload = { type: "session.input.reply", projectId, operationId: randomUUID(), inputRequestId,
    expectedVersion: 1, answers: { q: ["Actual choice"] } };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...payload, actorId: "other" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...payload, connectionId: randomUUID() } })).statusCode, 400);
    assert.equal(writes, 0);
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload })).statusCode, 200);
    assert.equal(writes, 1);
    allowed = false;
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...payload, operationId: randomUUID() } })).statusCode, 409);
    assert.equal(writes, 1, "a stale RPC must not get a new saved response");
    journalled = true;
    const checkedBeforeReplay = liveChecks;
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload })).statusCode, 200);
    assert.equal(liveChecks, checkedBeforeReplay, "saved operation recovery must reach the actor/hash journal without requiring a live RPC");
    const path = `/api/projects/${projectId}`;
    assert.equal((await app.inject({ headers, url: `${path}/session-work` })).statusCode, 200);
    assert.equal(viewReads, 0, "directory does not probe per-session native input");
    const snapshot = await app.inject({ headers, url: `${path}/session-work/${encodeURIComponent(session.key)}` });
    assert.equal(snapshot.statusCode, 200); assert.equal(snapshot.json().nativeInputRequests[0].canReply, false);
    assert.equal(snapshot.json().resources.inputTokens.value, 100);
    assert.equal(snapshot.json().resources.outputTokens.value, 20);
    assert.equal(snapshot.json().resources.inputTokens.observedAt, "2026-10-27T01:00:00.000Z");
    assert.match(snapshot.json().resources.inputTokens.unavailableReason, /过期/);
    assert.equal(snapshot.json().resources.cost.value, null); assert.equal(snapshot.json().resources.actualModel.value, null);
    const observation = await app.inject({ headers, url: `${path}/runtime/sessions/${sessionId}/observation` });
    assert.equal(observation.json().usage.total.totalTokens, 120);
    assert.equal((await app.inject({ headers, url: `${path}/runtime/sessions/${sessionId}/inputs` })).statusCode, 200);
    assert.equal((await app.inject({ headers, url: `${path}/session-inputs/${inputRequestId}` })).statusCode, 200);
    assert.equal((await app.inject({ headers, url: `/api/projects/${randomUUID()}/session-inputs/${inputRequestId}` })).statusCode, 403);
  } finally { await app.close(); }
});
