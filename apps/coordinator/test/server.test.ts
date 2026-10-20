import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowService } from "@evoloop/core";
import { buildServer } from "../src/server.js";
import { authenticate, authConfigSchema } from "../src/auth.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const token = "a".repeat(40);
const credentials = authConfigSchema.parse([{ token, actorId: "local-owner", projectIds: [projectId], permissions: ["read", "write", "review"] }]);

test("identity comes from configured token and is not editable by the request", async () => {
  let calls = 0;
  const app = await buildServer({ credentials, service: { execute: async () => { calls++; throw Error("unexpected"); } } as unknown as WorkflowService });
  try {
    const noAuth = await app.inject({ method: "POST", url: "/api/commands", payload: { type: "project.create" } });
    assert.equal(noAuth.statusCode, 401);
    const forged = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` }, payload: { type: "project.create", projectId, operationId: "00000000-0000-4000-8000-000000000002", title: "Project", actorId: "admin" } });
    assert.equal(forged.statusCode, 400);
    assert.equal(calls, 0);
    const session = await app.inject({ url: "/api/session", headers: { authorization: `Bearer ${token}` } });
    assert.equal(session.json().principal.actorId, "local-owner");
    assert.equal(session.json().capabilities.wiki, false);
    assert.equal(JSON.stringify(session.json()).includes(token), false);
  } finally { await app.close(); }
});

test("lost coordinator ownership refuses new writes before core executes", async () => {
  const app = await buildServer({ credentials, service: {} as WorkflowService, canWrite: () => false });
  try {
    const response = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` }, payload: {} });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "UNAVAILABLE");
  } finally { await app.close(); }
});

test("auth rejects malformed, short and duplicate credentials", () => {
  assert.equal(authenticate(undefined, credentials), null);
  assert.equal(authenticate("Bearer wrong", credentials), null);
  assert.equal(authenticate(`Basic ${token}`, credentials), null);
  assert.equal(authConfigSchema.safeParse([...credentials, ...credentials]).success, false);
  assert.equal(authConfigSchema.safeParse([{ ...credentials[0], token: "short" }]).success, false);
});
