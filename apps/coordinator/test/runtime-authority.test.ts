import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowService } from "@evoloop/core";
import type { RuntimeRunner } from "../src/runtime/runner.js";
import { buildServer } from "../src/server.js";
import { loadIntegrations } from "../src/configuration.js";

const projectId = randomUUID();
const sessionId = randomUUID();
const operationId = randomUUID();
const token = "r".repeat(40);
const cwd = process.cwd();
const grant = { projectId, actorId: "reviewer", roleId: "temporary-role", authorizationScope: "task:bounded",
  cwd, sandbox: "read-only" as const };
const credentials = [
  { token, actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] as const },
  { token: "w".repeat(40), actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] as const },
];
const headers = { authorization: `Bearer ${token}` };
const command = { type: "runtime.session.reserve", projectId, operationId, sessionId,
  roleId: grant.roleId, authorizationScope: grant.authorizationScope, cwd, sandbox: grant.sandbox,
  approvalPolicy: "on-request" };
const workManagementQueries = {
  listRoles: async () => ({ items: [], nextCursor: null }), listRoleRevisions: async () => [],
  listRoleReviews: async () => [], listRoleHandoffs: async () => [], listRoleSessionBindings: async () => [],
  listSchedules: async () => [], listScheduleRevisions: async () => [], listScheduleOccurrences: async () => [],
};

test("runtime config grants are exact and reviewer-only reservation does not call core when denied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-runtime-config-"));
  try {
    const file = join(directory, "integration.json");
    await writeFile(file, JSON.stringify({ runtime: { enabled: true, grants: [grant] } }));
    const config = await loadIntegrations(file);
    assert.equal(config.hasRuntimeGrant(grant), true);
    assert.equal(config.hasRuntimeGrant({ ...grant, sandbox: "workspace-write" }), false);
    assert.equal(config.hasRuntimeGrant({ ...grant, actorId: "writer" }), false);
    assert.deepEqual(config.allowedRuntimeCwds(projectId), [cwd]);
    assert.equal(await config.allowedRuntimeCwd(projectId, cwd), true);
    let calls = 0;
    const service = { ...workManagementQueries, execute: async () => { calls++; return { status: "applied", operationId, entityId: sessionId, version: 1 }; } } as unknown as WorkflowService;
    const runtime = { status: () => ({ available: true, error: null }) } as RuntimeRunner;
    const app = await buildServer({ service, credentials: credentials as never, runtime,
      allowedRuntimeCwd: config.allowedRuntimeCwd, allowedRuntimeCwds: config.allowedRuntimeCwds,
      hasRuntimeGrant: config.hasRuntimeGrant });
    try {
      const writer = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${"w".repeat(40)}` }, payload: command });
      assert.equal(writer.statusCode, 403);
      const changedScope = await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...command, authorizationScope: "all" } });
      assert.equal(changedScope.statusCode, 403);
      const changedSandbox = await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...command, sandbox: "workspace-write" } });
      assert.equal(changedSandbox.statusCode, 403);
      assert.equal(calls, 0);
      const allowed = await app.inject({ method: "POST", url: "/api/commands", headers, payload: command });
      assert.equal(allowed.statusCode, 200, allowed.body);
      assert.equal(calls, 1);
    } finally { await app.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("session close command requires project review and exact execution grant", async () => {
  let calls = 0, granted = true;
  const service = { ...workManagementQueries,
    getRuntimeSession: async () => ({ id: sessionId, roleId: grant.roleId, authorizationScope: grant.authorizationScope,
      cwd: grant.cwd, sandbox: grant.sandbox }),
    execute: async () => { calls++; return { status: "applied", operationId, entityId: sessionId, version: 4 }; } } as unknown as WorkflowService;
  const runtime = { status: () => ({ available: true, error: null }) } as RuntimeRunner;
  const app = await buildServer({ service, credentials: credentials as never, runtime,
    hasRuntimeGrant: scope => granted && scope.projectId === projectId && scope.actorId === "reviewer" &&
      scope.roleId === grant.roleId && scope.authorizationScope === grant.authorizationScope && scope.cwd === cwd && scope.sandbox === grant.sandbox });
  const payload = { type: "runtime.session.close", projectId, operationId, sessionId, expectedVersion: 3, reason: "Work complete" };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${"w".repeat(40)}` }, payload })).statusCode, 403);
    granted = false;
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload })).statusCode, 403);
    granted = true;
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...payload, projectId: randomUUID() } })).statusCode, 403);
    assert.equal(calls, 0);
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload })).statusCode, 200);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("reviewer recovery endpoint is explicit and checks project authority", async () => {
  let recovered = 0;
  const service = { ...workManagementQueries, getProject: async () => ({ id: projectId }) } as unknown as WorkflowService;
  const runtime = { status: () => ({ available: false, error: "disconnected" }), recover: async () => { recovered++; } } as unknown as RuntimeRunner;
  const app = await buildServer({ service, credentials: credentials as never, runtime, runtimeGrants:(p,a)=>a==="reviewer"?[grant]:[] });
  try {
    const url = `/api/projects/${projectId}/runtime/recover`;
    const denied = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${"w".repeat(40)}` } });
    assert.equal(denied.statusCode, 403);
    assert.equal(recovered, 0);
    const allowed = await app.inject({ method: "POST", url, headers });
    assert.equal(allowed.statusCode, 200);
    assert.equal(recovered, 1);
  } finally { await app.close(); }
});

test("runtime status hides another actor cwd and healthy recovery cannot restart the global process",async()=>{
  let recovered=0;
  const service={...workManagementQueries,getProject:async()=>({id:projectId})} as unknown as WorkflowService;
  const runtime={status:()=>({available:true,error:null}),recover:async()=>{recovered++;}} as unknown as RuntimeRunner;
  const app=await buildServer({service,credentials:credentials as never,runtime,runtimeGrants:()=>[grant],allowedRuntimeCwds:()=>[cwd,"/private/another-actor"]});
  try{
    const writerHeaders={authorization:`Bearer ${"w".repeat(40)}`};
    const status=await app.inject({method:"GET",url:`/api/projects/${projectId}/runtime`,headers:writerHeaders});
    assert.deepEqual(status.json().allowedCwds,[]);assert.deepEqual(status.json().grants,[]);
    assert.equal((await app.inject({method:"POST",url:`/api/projects/${projectId}/runtime/recover`,headers:writerHeaders})).statusCode,403);
    assert.equal((await app.inject({method:"POST",url:`/api/projects/${projectId}/runtime/recover`,headers})).statusCode,200);
    assert.equal(recovered,0);
  }finally{await app.close();}
});

test("explicit terminal reconciliation requires review and the exact current session grant", async () => {
  const runId = randomUUID();
  let available = true;
  let granted = true;
  let sessionScope = grant.authorizationScope;
  const calls: Array<{ actorId: string; version: number; reason: string }> = [];
  const service = { ...workManagementQueries,
    getRuntimeRun: async () => ({ id: runId, sessionId }),
    getRuntimeSession: async () => ({ id: sessionId, roleId: grant.roleId, authorizationScope: sessionScope,
      cwd: grant.cwd, sandbox: grant.sandbox }) } as unknown as WorkflowService;
  const runtime = { status: () => ({ available, error: null }),
    reconcile: async (principal: { actorId: string }, _projectId: string, _runId: string, version: number, reason: string) => {
      calls.push({ actorId: principal.actorId, version, reason });
      return { id: runId, version: version + 1, state: "completed" };
    } } as unknown as RuntimeRunner;
  const app = await buildServer({ service, credentials: credentials as never, runtime,
    runtimeGrants: () => granted ? [grant] : [] });
  const url = `/api/projects/${projectId}/runtime/runs/${runId}/reconcile`;
  const payload = { expectedVersion: 4, reason: "Verified completedAt in owned native history" };
  try {
    const writer = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${"w".repeat(40)}` }, payload });
    assert.equal(writer.statusCode, 403);
    granted = false;
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 403);
    granted = true;
    sessionScope = "task:other";
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 403);
    sessionScope = grant.authorizationScope;
    available = false;
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 409);
    available = true;
    const accepted = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(calls, [{ actorId: "reviewer", version: 4, reason: payload.reason }]);
  } finally { await app.close(); }
});
