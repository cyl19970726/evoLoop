import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowService } from "@evoloop/core";
import { RuntimeRunner } from "../src/runtime/runner.js";
import { buildServer } from "../src/server.js";
import { delegationTemplateHash, loadIntegrations, runtimeThreadConfigForSession } from "../src/configuration.js";

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

test("a bound dynamic Session cannot fall back to the same Role's static grant after revocation", async () => {
  let calls = 0, current = false;
  const service = { ...workManagementQueries,
    getRuntimeSession: async () => ({ projectId,id:sessionId,actorId:grant.actorId,roleId:grant.roleId,
      authorizationScope:grant.authorizationScope,cwd:grant.cwd,sandbox:grant.sandbox }),
    execute: async () => { calls++; return {status:"applied",operationId,entityId:sessionId,version:1}; },
  } as unknown as WorkflowService;
  const app = await buildServer({service,credentials:credentials as never,
    runtime:{status:()=>({available:true,error:null})} as RuntimeRunner,
    hasRuntimeGrant:()=>true,allowedRuntimeCwd:async()=>true,
    isDynamicSession:async()=>true,
    authorizeDynamicSession:async()=>current,
    authorizeDynamicRun:async()=>current});
  try {
    const reserveRun={type:"runtime.run.reserve",projectId,operationId:randomUUID(),sessionId,
      runId:randomUUID(),taskId:randomUUID(),expectedVersion:1,input:"Bounded task"};
    assert.equal((await app.inject({method:"POST",url:"/api/commands",headers,payload:command})).statusCode,403);
    assert.equal((await app.inject({method:"POST",url:"/api/commands",headers,payload:reserveRun})).statusCode,403);
    assert.equal(calls,0);
    current=true;
    assert.equal((await app.inject({method:"POST",url:"/api/commands",headers,payload:command})).statusCode,200);
    assert.equal((await app.inject({method:"POST",url:"/api/commands",headers,payload:reserveRun})).statusCode,200);
    assert.equal(calls,2);
  } finally { await app.close(); }
});

test("dynamic network access follows the exact Session binding despite a colliding static or expired template",async()=>{
  const spec={...grant,sessionId,model:"model",approvalPolicy:"on-request" as const};
  const staticTrue=[{...grant,sandbox:"workspace-write" as const,networkAccess:true}];
  assert.deepEqual(await runtimeThreadConfigForSession(staticTrue,{...spec,sandbox:"workspace-write"},null),
    {"sandbox_workspace_write.network_access":true});
  const dynamic={isDynamicSession:async()=>true,networkAccessForSession:async()=>false};
  assert.equal(await runtimeThreadConfigForSession(staticTrue,{...spec,sandbox:"workspace-write"},dynamic),undefined);
  assert.equal(await runtimeThreadConfigForSession(staticTrue,{...spec,sandbox:"workspace-write"},
    {...dynamic,networkAccessForSession:async()=>null}),undefined,
    "an expired other template or revoked binding cannot supply network permission");
  assert.deepEqual(await runtimeThreadConfigForSession([], {...spec,sandbox:"workspace-write"},
    {...dynamic,networkAccessForSession:async()=>true}),{"sandbox_workspace_write.network_access":true});
});

test("session close requires project review but no requester execution grant", async () => {
  let calls = 0, available = true;
  const service = { ...workManagementQueries,
    getRuntimeSession: async () => ({ id: sessionId, roleId: grant.roleId, authorizationScope: grant.authorizationScope,
      cwd: grant.cwd, sandbox: grant.sandbox }),
    execute: async () => { calls++; return { status: "applied", operationId, entityId: sessionId, version: 4 }; } } as unknown as WorkflowService;
  const runtime = { status: () => ({ available, error: null }) } as RuntimeRunner;
  const app = await buildServer({ service, credentials: credentials as never, runtime,
    hasRuntimeGrant: () => false });
  const payload = { type: "runtime.session.close", projectId, operationId, sessionId, expectedVersion: 3, reason: "Work complete" };
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${"w".repeat(40)}` }, payload })).statusCode, 403);
    available = false;
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload })).statusCode, 409);
    available = true;
    const reserve = { type: "runtime.run.reserve", projectId, operationId: randomUUID(), sessionId,
      runId: randomUUID(), taskId: randomUUID(), expectedVersion: 1, input: "Still needs execution authority" };
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload: reserve })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload: command })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...payload, projectId: randomUUID() } })).statusCode, 403);
    assert.equal(calls, 0);
    assert.equal((await app.inject({ method: "POST", url: "/api/commands", headers, payload })).statusCode, 200);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("delegation template is explicit, versioned, canonical and cannot inherit a static Role grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-delegation-config-"));
  try {
    const file = join(directory, "integration.json"), loopId = randomUUID(), goalId = randomUUID();
    const template = { id: randomUUID(), revision: 1, projectId, goalId, loopId,
      existingRoleIds: [randomUUID()], cognitionRoleIds: [], newRoleAllocation: null, firstTaskId: randomUUID(),
      actorId: "trial-worker", authorizationScopeId: "trial:one", decisionActorIds: ["cognition"],
      allowedChoices: ["temporary-assignment"], cwd, model: "test-model", sandbox: "read-only",
      networkAccess: false, approvalPolicy: "on-request", expiresAtUtc: "2030-01-01T00:00:00.000Z" };
    await writeFile(file, JSON.stringify({runtime:{enabled:true,grants:[grant],delegationTemplates:[template]}}));
    const loaded = await loadIntegrations(file);
    const selected = await loaded.getDelegationTemplate(projectId,template.id);
    assert.equal(selected?.hash,delegationTemplateHash(template as never));
    assert.equal(await loaded.getDelegationTemplate(randomUUID(),template.id),null);
    assert.equal(await loaded.getDelegationTemplate(projectId,randomUUID()),null);
    assert.equal(loaded.hasRuntimeGrant({...grant,roleId:template.existingRoleIds[0]}),false);
    await writeFile(file, JSON.stringify({runtime:{enabled:true,grants:[grant],delegationTemplates:[template,{...template,revision:2}]}}));
    await assert.rejects(loadIntegrations(file),/Invalid integration configuration/);
  } finally { await rm(directory,{recursive:true,force:true}); }
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
  const foreignProject=randomUUID(),foreignRun=randomUUID(),ownRun=randomUUID();
  const runtime={status:(scope?:string)=>({available:true,error:null,
    faults:[{projectId:scope===projectId?projectId:foreignProject,runId:scope===projectId?ownRun:foreignRun}]}),
    recover:async()=>{recovered++;}} as unknown as RuntimeRunner;
  const app=await buildServer({service,credentials:credentials as never,runtime,runtimeGrants:()=>[grant],allowedRuntimeCwds:()=>[cwd,"/private/another-actor"]});
  try{
    const writerHeaders={authorization:`Bearer ${"w".repeat(40)}`};
    const status=await app.inject({method:"GET",url:`/api/projects/${projectId}/runtime`,headers:writerHeaders});
    assert.deepEqual(status.json().allowedCwds,[]);assert.deepEqual(status.json().grants,[]);
    assert.deepEqual(status.json().faults,[{projectId,runId:ownRun}]);
    assert.doesNotMatch(status.body,new RegExp(foreignRun));
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

test("project read reviewer can inspect a bound trace without execution grant while reserve and reconcile stay denied", async () => {
  const runId = randomUUID();
  let reads = 0, mutations = 0;
  const traceToken = "q".repeat(40);
  const traceHeaders = { authorization: `Bearer ${traceToken}` };
  const service = { ...workManagementQueries,
    execute: async () => { mutations++; return { status: "applied" }; },
    getRuntimeRun: async () => ({ id: runId, sessionId }),
    getRuntimeSession: async () => ({ id: sessionId, roleId: grant.roleId, authorizationScope: grant.authorizationScope,
      cwd: grant.cwd, sandbox: grant.sandbox }) } as unknown as WorkflowService;
  const runtime = { status: () => ({ available: true, error: null }),
    trace: async (_principal: unknown, _projectId: string, _runId: string, cursor?: string) => {
      reads++; return { runId, cursor: cursor ?? null, source: "owned-native-history" };
    } } as unknown as RuntimeRunner;
  const app = await buildServer({ service, credentials: [...credentials,
    { token: traceToken, actorId: "trace-reviewer", projectIds: [projectId], permissions: ["read", "review"] }] as never,
    runtime, runtimeGrants: (_project, actor) => actor === "reviewer" ? [grant] : [], hasRuntimeGrant: scope => scope.actorId === "reviewer",
    allowedRuntimeCwd: async () => true });
  try {
    const url = `/api/projects/${projectId}/runtime/runs/${runId}/trace`;
    assert.equal((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${"w".repeat(40)}` } })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: `/api/projects/${randomUUID()}/runtime/runs/${runId}/trace`, headers: traceHeaders })).statusCode, 403);
    const accepted = await app.inject({ method: "GET", url: `${url}?cursor=page-2`, headers: traceHeaders });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().cursor, "page-2");
    const reserve = await app.inject({ method: "POST", url: "/api/commands", headers: traceHeaders, payload: { ...command, operationId: randomUUID() } });
    assert.equal(reserve.statusCode, 403);
    const reconcile = await app.inject({ method: "POST", url: `/api/projects/${projectId}/runtime/runs/${runId}/reconcile`, headers: traceHeaders,
      payload: { expectedVersion: 3, reason: "readback" } });
    assert.equal(reconcile.statusCode, 403);
    assert.equal(reads, 1);
    assert.equal(mutations, 0);
  } finally { await app.close(); }
});

test("closed Session keeps its Run metadata readable but denies trace through HTTP", async () => {
  const runId = randomUUID();
  let nativeReads = 0;
  const closedRun = { id: runId, projectId, sessionId, actorId: "reviewer", nativeTurnId: "owned-turn", state: "completed" };
  const closedSession = { id: sessionId, projectId, actorId: "reviewer", roleId: grant.roleId,
    authorizationScope: grant.authorizationScope, cwd, sandbox: grant.sandbox, state: "closed" };
  const service = { ...workManagementQueries, getRuntimeRun: async () => closedRun,
    getRuntimeSession: async () => closedSession } as unknown as WorkflowService;
  const reader = new RuntimeRunner({ runtimeFactory: () => ({
    readWorkPage: async () => { nativeReads++; throw new Error("Closed native history must not be read"); },
  }) as never, workflow: service, trusted: {} as never, principals: credentials as never,
  canWrite: () => false, allowedCwd: async () => true, hasGrant: () => true });
  const runtime = { status: () => ({ available: true, error: null }),
    trace: reader.trace.bind(reader) } as unknown as RuntimeRunner;
  const app = await buildServer({ service, credentials: credentials as never, runtime });
  try {
    const base = `/api/projects/${projectId}/runtime/runs/${runId}`;
    const metadata = await app.inject({ method: "GET", url: base, headers });
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.equal(metadata.json().state, "completed");
    const trace = await app.inject({ method: "GET", url: `${base}/trace`, headers });
    assert.equal(trace.statusCode, 403, trace.body);
    assert.equal(nativeReads, 0);
  } finally { await app.close(); }
});
