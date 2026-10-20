import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowService } from "@evoloop/core";
import { buildServer } from "../src/server.js";
import { authenticate, authConfigSchema } from "../src/auth.js";
import type { SchedulingPump } from "../src/scheduling/pump.js";
import { DomainError } from "@evoloop/contracts/ports";

const projectId = "00000000-0000-4000-8000-000000000001";
const token = "a".repeat(40);
const credentials = authConfigSchema.parse([{ token, actorId: "local-owner", projectIds: [projectId], permissions: ["read", "write", "review"] }]);
const workManagementQueries = {
  listRoles: async (principal: { actorId: string }) => ({ actorId: principal.actorId, items: [], nextCursor: null }),
  listRoleRevisions: async () => [], listRoleReviews: async () => [], listRoleHandoffs: async () => [],
  listRoleSessionBindings: async () => [], listSchedules: async () => [],
  listScheduleRevisions: async () => [], listScheduleOccurrences: async () => [],
};

test("identity comes from configured token and is not editable by the request", async () => {
  let calls = 0;
  const app = await buildServer({ credentials, service: { ...workManagementQueries, execute: async () => { calls++; throw Error("unexpected"); } } as unknown as WorkflowService });
  try {
    const noAuth = await app.inject({ method: "POST", url: "/api/commands", payload: { type: "project.create" } });
    assert.equal(noAuth.statusCode, 401);
    const forged = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` }, payload: { type: "project.create", projectId, operationId: "00000000-0000-4000-8000-000000000002", title: "Project", actorId: "admin" } });
    assert.equal(forged.statusCode, 400);
    assert.equal(calls, 0);
    const session = await app.inject({ url: "/api/session", headers: { authorization: `Bearer ${token}` } });
    assert.equal(session.json().principal.actorId, "local-owner");
    const roles = await app.inject({ url: `/api/projects/${projectId}/roles`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(roles.statusCode, 200);
    assert.equal(roles.json().actorId, "local-owner");
    assert.equal(session.json().capabilities.wiki, false);
    assert.equal(JSON.stringify(session.json()).includes(token), false);
  } finally { await app.close(); }
});

test("lost coordinator ownership refuses new writes before core executes", async () => {
  let calls = 0;
  const app = await buildServer({ credentials, service: { ...workManagementQueries, execute: async () => { calls++; throw Error("write reached core"); } } as unknown as WorkflowService, canWrite: () => false });
  try {
    const response = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` }, payload: {} });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "UNAVAILABLE");
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test("auth rejects malformed, short and duplicate credentials", () => {
  assert.equal(authenticate(undefined, credentials), null);
  assert.equal(authenticate("Bearer wrong", credentials), null);
  assert.equal(authenticate(`Basic ${token}`, credentials), null);
  assert.equal(authConfigSchema.safeParse([...credentials, ...credentials]).success, false);
  assert.equal(authConfigSchema.safeParse([{ ...credentials[0], token: "short" }]).success, false);
});

test("owner history and discussion queries preserve authenticated identity and project scope", async () => {
  const id = "00000000-0000-4000-8000-000000000003";
  const seen: unknown[][] = [];
  const query = async (...args: unknown[]) => { seen.push(args); return []; };
  const app = await buildServer({ credentials, service: { ...workManagementQueries,
    listTaskRevisions: query, listDiscussions: query, getDiscussion: query, listDiscussionEvents: query,
  } as unknown as WorkflowService });
  try {
    const paths = [`tasks/${id}/revisions`, "discussions?limit=10", `discussions/${id}`, `discussions/${id}/events`];
    for (const path of paths) {
      assert.equal((await app.inject({ url: `/api/projects/${projectId}/${path}` })).statusCode, 401);
      assert.equal((await app.inject({ url: `/api/projects/${projectId}/${path}`, headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    }
    assert.equal(seen.length, 4);
    for (const args of seen) {
      assert.equal((args[0] as { actorId: string }).actorId, "local-owner");
      assert.equal(args[1], projectId);
    }
    assert.equal(seen[1]![2], 10);
    assert.equal((await app.inject({ url: `/api/projects/${projectId}/tasks/not-an-id/revisions`, headers: { authorization: `Bearer ${token}` } })).statusCode, 400);
  } finally { await app.close(); }
});

test("schedule status scopes grants to the caller and active commands require an exact current grant", async () => {
  const otherProject = "00000000-0000-4000-8000-000000000099";
  const otherToken = "b".repeat(40);
  const identities = authConfigSchema.parse([...credentials,
    { token: otherToken, actorId: "other-reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }]);
  let enabled = true;
  const grant = { projectId, actorId: "local-owner", scopeId: "scope:daily", roleId: "temporary-role" };
  const grants = [grant, { ...grant, actorId: "other-reviewer" }, { ...grant, projectId: otherProject }];
  const executed: string[] = [];
  const service = { ...workManagementQueries,
    getProject: async (principal: { projectIds: string[] }, id: string) => {
      if (!principal.projectIds.includes(id)) throw new DomainError("FORBIDDEN", "foreign project");
      return { id };
    },
    execute: async (_principal: unknown, command: { type: string }) => {
      executed.push(command.type);
      return { status: "applied", operationId: "00000000-0000-4000-8000-000000000002", entityId: "00000000-0000-4000-8000-000000000003", version: 1 };
    },
  } as unknown as WorkflowService;
  const scheduling = { status: () => ({ state: enabled ? "idle" : "disabled", lastTickAt: null, lastError: null, lastCreated: 0 }) } as SchedulingPump;
  const app = await buildServer({ service, credentials: identities, scheduling,
    schedulingGrants: () => enabled ? grants : [] });
  const auth = { authorization: `Bearer ${token}` };
  const base = { type: "schedule.create", projectId, operationId: "00000000-0000-4000-8000-000000000002",
    scheduleId: "00000000-0000-4000-8000-000000000003", revisionId: "00000000-0000-4000-8000-000000000004",
    timezone: "UTC", rule: { kind: "daily", localTime: "09:00" }, misfire: { kind: "skip" }, overlap: "skip",
    template: { title: "Daily", goal: "Review", acceptance: "Evidence", owner: "temporary-role" },
    authorization: { scopeId: "scope:daily", roleId: "temporary-role", authorizedBy: "local-owner", expiresAtUtc: null },
    watermarkUtc: new Date().toISOString(), state: "active", reason: "reviewed" };
  try {
    const status = await app.inject({ url: `/api/projects/${projectId}/scheduling/status`, headers: auth });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json().grants, [grant]);
    const otherStatus = await app.inject({ url: `/api/projects/${projectId}/scheduling/status`,
      headers: { authorization: `Bearer ${otherToken}` } });
    assert.deepEqual(otherStatus.json().grants, [{ ...grant, actorId: "other-reviewer" }]);
    const foreign = await app.inject({ url: `/api/projects/${otherProject}/scheduling/status`, headers: auth });
    assert.equal(foreign.statusCode, 403);
    const active = await app.inject({ method: "POST", url: "/api/commands", headers: auth, payload: base });
    assert.equal(active.statusCode, 200);
    const wrongScope = await app.inject({ method: "POST", url: "/api/commands", headers: auth,
      payload: { ...base, authorization: { ...base.authorization, scopeId: "scope:other" } } });
    assert.equal(wrongScope.statusCode, 403);
    const { watermarkUtc: _watermarkUtc, ...revisable } = base;
    const revise = { ...revisable, type: "schedule.revise", expectedVersion: 1 };
    const wrongRole = await app.inject({ method: "POST", url: "/api/commands", headers: auth,
      payload: { ...revise, authorization: { ...base.authorization, roleId: "other-role" } } });
    assert.equal(wrongRole.statusCode, 403);
    enabled = false;
    const disabled = await app.inject({ url: `/api/projects/${projectId}/scheduling/status`, headers: auth });
    assert.deepEqual(disabled.json().grants, []);
    const denied = await app.inject({ method: "POST", url: "/api/commands", headers: auth, payload: base });
    assert.equal(denied.statusCode, 403);
    const pause = await app.inject({ method: "POST", url: "/api/commands", headers: auth,
      payload: { ...revise, state: "paused" } });
    assert.equal(pause.statusCode, 200);
    assert.deepEqual(executed, ["schedule.create", "schedule.revise"]);
  } finally { await app.close(); }
});
