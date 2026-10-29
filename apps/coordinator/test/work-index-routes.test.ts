import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { registerLeaderWorkRoutes } from "../src/work-management/leader-routes.ts";
import type { LeaderWorkIndexReader } from "../src/work-management/work-index.ts";
import { DomainError } from "@evoloop/contracts/ports";

test("work-management routes bind route identity and expose stable read/write commands", async t => {
  const projectId = randomUUID(), taskId = randomUUID(), operationId = randomUUID();
  let principal = { actorId: "leader", projectIds: [projectId], permissions: ["read", "write", "review"] as const };
  const reads: unknown[] = [], plans: unknown[] = [], dependencies: unknown[] = [], reviews: unknown[] = [];
  const reader: LeaderWorkIndexReader = {
    index: async (_principal, project, query) => { reads.push({ project, query }); return { items: [], nextCursor: null }; },
    task: async (_principal, project, projectedTaskId) => {
      reads.push({ project, taskId: projectedTaskId }); return { taskId: projectedTaskId };
    },
    changes: async (_principal, project, limit, cursor) => { reads.push({ project, limit, cursor }); return { items: [], nextCursor: null }; },
    setPlan: async (who, project, command) => { plans.push({ who, project, command }); return { status: "applied" }; },
    setDependencies: async (who, project, command) => { dependencies.push({ who, project, command }); return { status: "applied" }; },
    setReview: async (who, project, command) => { reviews.push({ who, project, command }); return { status: "applied" }; },
  };
  const service = { getProject: async () => ({ id: projectId }) };
  const app = Fastify();
  t.after(() => app.close());
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = principal as unknown as typeof request.principal; });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.code === "FORBIDDEN" ? 403 : 409).send({ code: error.code });
    throw error;
  });
  registerLeaderWorkRoutes(app, service, reader);

  const read = await app.inject({ method: "GET", url: `/api/projects/${projectId}/work-management/index?view=documents&limit=20` });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(reads[0], { project: projectId,
    query: { view: "documents", limit: 20, includeClosed: false } });
  const exact = await app.inject({ method: "GET",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}` });
  assert.equal(exact.statusCode, 200);
  assert.deepEqual(reads[1], { project: projectId, taskId });

  const plan = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/plan`,
    payload: { operationId, expectedTaskVersion: 1, expectedPlanVersion: 0, plannedStartAt: null,
      dueAt: null, priority: 2, reason: "Leader ordered this work" } });
  assert.equal(plan.statusCode, 200);
  assert.deepEqual((plans[0] as { command: { projectId: string; taskId: string } }).command.projectId, projectId);
  assert.deepEqual((plans[0] as { command: { taskId: string } }).command.taskId, taskId);

  const dependency = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/dependencies`,
    payload: { operationId: randomUUID(), expectedTaskVersion: 1, expectedDependencyVersion: 0,
      dependsOnTaskIds: [], reason: "No prerequisite remains" } });
  assert.equal(dependency.statusCode, 200);
  assert.equal((dependencies[0] as { command: { taskId: string } }).command.taskId, taskId);

  const review = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/review`,
    payload: { operationId: randomUUID(), expectedTaskVersion: 1, expectedTaskRevisionId: randomUUID(),
      expectedWorkChangeSequence: 8,
      decision: "deferred", reason: "Wait for the prerequisite" } });
  assert.equal(review.statusCode, 200);
  assert.equal((reviews[0] as { command: { decision: string } }).command.decision, "deferred");

  principal = { ...principal, permissions: ["read", "write"] as const };
  const denied = await app.inject({ method: "PUT",
    url: `/api/projects/${projectId}/work-management/tasks/${taskId}/plan`,
    payload: { operationId: randomUUID(), expectedTaskVersion: 1, expectedPlanVersion: 1,
      plannedStartAt: null, dueAt: null, priority: 2, reason: "Should require review authority" } });
  assert.equal(denied.statusCode, 403);
});
