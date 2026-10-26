import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { z } from "zod";
import type { SessionObservationService } from "@evoloop/core/session-observation";
import { registerSessionWorkRoutes } from "../src/session-work/routes.ts";
import type { ObservedSession } from "@evoloop/contracts/session-observation";

const projectId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const linkId = "00000000-0000-4000-8000-000000000003";
const base = `/api/projects/${projectId}`;
const sessionKey = `external:${linkId}`;

test("Session work routes parse bounded query parameters and pass the authenticated principal", async () => {
  const app = Fastify();
  const seen: unknown[][] = [];
  const principal = { actorId: "reader", projectIds: [projectId], permissions: ["read"] };
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = principal; });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof z.ZodError ? 400 : 500).send({ code: "INVALID_INPUT" }));
  const capture = async (...args: unknown[]) => { seen.push(args); return { items: [] }; };
  registerSessionWorkRoutes(app, { directory: capture, changes: capture, snapshot: capture, history: capture,
    profile: capture, profileHistory: capture, assignment: capture, assignmentHistory: capture } as unknown as SessionObservationService);
  try {
    const directory = await app.inject({ url: `${base}/session-work?limit=20&membership=current&search=design` });
    assert.equal(directory.statusCode, 200);
    assert.equal(seen[0]?.[0], principal);
    assert.equal(seen[0]?.[1], projectId);
    assert.deepEqual(seen[0]?.[2], { limit: 20, membership: "current", search: "design" });
    assert.equal((await app.inject({ url: `${base}/session-work?limit=51` })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}/session-work/changes` })).statusCode, 400);
    assert.equal((await app.inject({ url: `${base}/session-work/${sessionKey}/activities?taskId=${taskId}&importance=important` })).statusCode, 200);
    assert.equal((await app.inject({ url: `${base}/session-work/${sessionKey}/profile/history?cursor=2` })).statusCode, 200);
    assert.equal((await app.inject({ url: `${base}/tasks/${taskId}/assignment/history?cursor=2` })).statusCode, 200);
  } finally { await app.close(); }
});


test("execution projection is awaited for the selected snapshot and never probed per directory row", async () => {
  const app = Fastify();
  const principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] as Array<"read" | "write"> };
  const session = { key: sessionKey, capabilities: {} } as ObservedSession;
  let executionReads = 0;
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = principal; });
  registerSessionWorkRoutes(app, {
    directory: async () => ({ items: [session], nextCursor: null }),
    snapshot: async () => ({ session }),
  } as unknown as SessionObservationService, (_principal, value) => value, async (reader, project, value) => {
    assert.equal(reader, principal); assert.equal(project, projectId); assert.equal(value, session);
    executionReads++;
    return { ...value, capabilities: { ...value.capabilities, ordinaryExecution: {
      state: "disabled", reasonCode: "SESSION_MESSAGES_DISABLED", reason: "Disabled", observedAt: "2026-10-27T00:00:00.000Z",
    } } };
  });
  try {
    assert.equal((await app.inject({ url: `${base}/session-work` })).statusCode, 200);
    assert.equal(executionReads, 0, "directory pagination must not load current execution configuration once per row");
    const response = await app.inject({ url: `${base}/session-work/${sessionKey}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().session.capabilities.ordinaryExecution.state, "disabled");
    assert.equal(executionReads, 1);
  } finally { await app.close(); }
});
