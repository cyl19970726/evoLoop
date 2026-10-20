import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { Principal } from "@evoloop/contracts";
import type { DeliveryStore } from "@evoloop/contracts/delivery";
import type { WorkflowService } from "@evoloop/core";
import { registerCollaborationRoutes } from "../src/collaboration/routes.js";
import type { CollaborationRunner } from "../src/collaboration/runner.js";

test("status is readable without an integration grant, while private detail and writes are denied", async t => {
  const projectId = randomUUID(), eventId = randomUUID();
  const principal: Principal = { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
  let allowed = false, reads = 0, mutations = 0;
  const store = {
    list: async () => { reads++; return { items: [], nextCursor: null }; },
    listIncoming: async () => { reads++; return { items: [], nextCursor: null }; },
  } as unknown as DeliveryStore;
  const runner = {
    status: () => ({ configured: allowed, verifiedAtUtc: allowed ? "2026-10-20T09:00:00.000Z" : null, error: allowed ? null : "notAuthorized" }),
    retry: async () => { mutations++; return true; },
  } as unknown as CollaborationRunner;
  const app = Fastify(); t.after(() => app.close());
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = principal; });
  app.setErrorHandler((error, _request, reply) => reply.code(403).send({ code: "FORBIDDEN", message: error.message }));
  registerCollaborationRoutes(app, { runner, store, workflow: {} as WorkflowService, consumerId: "feishu", hasGrant: () => allowed });
  const status = await app.inject({ method: "GET", url: `/api/projects/${projectId}/collaboration` });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json(), { configured: false, verifiedAtUtc: null, error: "notAuthorized", deliveries: { items: [], nextCursor: null }, incoming: { items: [], nextCursor: null }, incomingPending: 0 });
  assert.equal(reads, 0, "status without grant cannot read private delivery or candidate rows");
  for (const [method, path] of [["GET", "deliveries"], ["GET", "incoming"], ["POST", `deliveries/${eventId}/retry`]] as const) {
    const response = await app.inject({ method, url: `/api/projects/${projectId}/collaboration/${path}`, payload: method === "POST" ? { reason: "retry" } : undefined });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(reads, 0); assert.equal(mutations, 0);
  allowed = true;
  assert.equal((await app.inject({ method: "GET", url: `/api/projects/${projectId}/collaboration` })).statusCode, 200);
  assert.equal(reads, 2);
});
