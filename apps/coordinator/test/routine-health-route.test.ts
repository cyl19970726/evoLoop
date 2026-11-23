import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";
import { registerWorkManagementRoutes } from "../src/work-management/routes.js";

const projectId = "00000000-0000-4000-8000-000000000001";

test("the routine health table is one project-read route", async () => {
  const calls: unknown[] = [];
  const health = { projectId, items: [], observedAt: "2026-11-23T00:00:00.000Z", complete: true };
  const service = new Proxy({
    getRoutineHealth: async (who: Principal, project: string) => { calls.push([who.actorId, project]); return health; },
  }, { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => { throw new Error(`unused ${String(key)}`); }) }) as unknown as WorkflowService;
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = { actorId: "reader", projectIds: [projectId], permissions: [] }; });
  await registerWorkManagementRoutes(app, service);
  try {
    const read = await app.inject({ url: `/api/projects/${projectId}/routine-health` });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), health);
    assert.deepEqual(calls, [["reader", projectId]]);
  } finally { await app.close(); }
});
