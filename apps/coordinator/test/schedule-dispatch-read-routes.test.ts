import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import { registerWorkManagementRoutes } from "../src/work-management/routes.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const scheduleId = "00000000-0000-4000-8000-000000000002";
const roleId = "00000000-0000-4000-8000-000000000003";

test("direct-dispatch facts have project-read routes and preserve dispatch pagination", async () => {
  const calls: unknown[] = [];
  const reader: Principal = { actorId: "reader", projectIds: [projectId], permissions: ["read"] };
  const policy = { projectId, scheduleId, mode: "direct", state: "active", version: 1 };
  const list = { projectId, roleId, version: 1, sessionIds: [] };
  const dispatchPage = { items: [], nextCursor: "next" };
  const empty = async () => [];
  const service = {
    listRoleRevisions: empty, listRoleReviews: empty, listRoleHandoffs: empty, listRoleSessionBindings: empty,
    listSchedules: empty, listScheduleRevisions: empty, listScheduleOccurrences: empty,
    getScheduleDispatchPolicy: async (who: Principal, project: string, id: string) => {
      calls.push(["policy", who.actorId, project, id]); return policy;
    },
    listScheduleDispatches: async (who: Principal, project: string, id: string, limit: number, cursor?: string) => {
      calls.push(["dispatches", who.actorId, project, id, limit, cursor]); return dispatchPage;
    },
    getRoleDirectDispatchList: async (who: Principal, project: string, id: string) => {
      calls.push(["list", who.actorId, project, id]); return list;
    },
  } as unknown as WorkflowService;
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = reader; });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: "INVALID_INPUT" });
    if (error instanceof DomainError) return reply.code(409).send({ code: error.code });
    return reply.code(503).send({ code: "RESULT_UNCONFIRMED" });
  });
  await registerWorkManagementRoutes(app, service);
  try {
    const policyRead = await app.inject({ url: `/api/projects/${projectId}/schedules/${scheduleId}/dispatch` });
    assert.equal(policyRead.statusCode, 200);
    assert.deepEqual(policyRead.json(), policy);
    const listRead = await app.inject({ url: `/api/projects/${projectId}/roles/${roleId}/direct-list` });
    assert.equal(listRead.statusCode, 200);
    assert.deepEqual(listRead.json(), list);
    const dispatches = await app.inject({ url: `/api/projects/${projectId}/schedules/${scheduleId}/dispatches?limit=2&cursor=next` });
    assert.equal(dispatches.statusCode, 200);
    assert.deepEqual(dispatches.json(), dispatchPage);
    assert.deepEqual(calls, [
      ["policy", "reader", projectId, scheduleId],
      ["list", "reader", projectId, roleId],
      ["dispatches", "reader", projectId, scheduleId, 2, "next"],
    ]);
    const invalid = await app.inject({ url: `/api/projects/${projectId}/schedules/${scheduleId}/dispatches?limit=101` });
    assert.equal(invalid.statusCode, 400);
    assert.equal(calls.length, 3, "invalid pagination never reaches storage");
  } finally { await app.close(); }
});
