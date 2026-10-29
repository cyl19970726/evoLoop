import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkflowService } from "@evoloop/core";
import { RuntimeRunner } from "../src/runtime/runner.js";
import { buildServer } from "../src/server.js";
import { delegationTemplateHash, hasExactEngineeringActionGrant, loadIntegrations, runtimeThreadConfig, runtimeThreadConfigForSession } from "../src/configuration.js";
import { currentSessionGrant, isBoundDynamicSession } from "../src/orchestration/dynamic-admission.js";
import { loopIntentId } from "../src/orchestration/runner.js";

const projectId = randomUUID();
const sessionId = randomUUID();
const operationId = randomUUID();
const token = "r".repeat(40);
const cwd = process.cwd();
const grant = { projectId, actorId: "reviewer", roleId: "temporary-role", authorizationScope: "task:bounded",
  cwd, sandbox: "danger-full-access" as const, approvalPolicy: "never" as const };
const credentials = [
  { token, actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] as const },
  { token: "w".repeat(40), actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] as const },
];
const headers = { authorization: `Bearer ${token}` };
const command = { type: "runtime.session.reserve", projectId, operationId, sessionId,
  roleId: grant.roleId, authorizationScope: grant.authorizationScope, cwd, sandbox: grant.sandbox,
  approvalPolicy: "never" };

test("runtime protocol version defaults to the reviewed 0.164 schema and preserves explicit legacy configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-runtime-version-"));
  const file = join(directory, "integrations.json");
  try {
    await writeFile(file, JSON.stringify({runtime:{enabled:true,grants:[]}}));
    assert.equal((await loadIntegrations(file)).runtime?.protocolVersion, "0.164.0-alpha.11.1");
    await writeFile(file, JSON.stringify({runtime:{enabled:true,protocolVersion:"0.164.0-alpha.11.1",grants:[]}}));
    assert.equal((await loadIntegrations(file)).runtime?.protocolVersion, "0.164.0-alpha.11.1");
    await writeFile(file, JSON.stringify({runtime:{enabled:true,protocolVersion:"0.165.0",grants:[]}}));
    await assert.rejects(loadIntegrations(file), /Invalid integration configuration/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("resident queue business actor bindings have one actor per project and Role", async () => {
  const directory=await mkdtemp(join(tmpdir(),"evoloop-queue-binding-"));
  try {
    const file=join(directory,"integrations.json"),roleId=randomUUID();
    const binding={projectId,roleId,actorId:"worker-a"};
    await writeFile(file,JSON.stringify({residentQueue:{enabled:true,roleActors:[binding,
      {...binding,projectId:randomUUID(),actorId:"worker-b"}]}}));
    assert.equal((await loadIntegrations(file)).residentQueue?.roleActors.length,2);
    await writeFile(file,JSON.stringify({residentQueue:{enabled:true,roleActors:[binding,
      {...binding,actorId:"worker-b"}]}}));
    await assert.rejects(loadIntegrations(file),/Invalid integration configuration/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test("engineering action grant matches the actual project as well as scope, hash and expiry",()=>{
  const otherProjectId=randomUUID();
  const principal={actorId:"executor",projectIds:[projectId,otherProjectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
  const action={type:"action_request" as const,requestId:randomUUID(),executorActorId:principal.actorId,
    actionType:"pr.create" as const,scope:{repository:"evoLoop",worktree:"/tmp/evoloop-action",
      paths:["packages/core/src/index.ts"],commit:"abc123"},inputHash:"a".repeat(64),
    reason:"Create reviewed PR",authorityEvidence:"Current grant",expiresAt:"2026-10-26T00:00:00Z",
    acceptance:"PR URL",detail:{documentId:randomUUID(),revisionId:randomUUID()}};
  const grant={projectId:otherProjectId,actorId:principal.actorId,actionType:action.actionType,
    repository:action.scope.repository,worktree:action.scope.worktree,paths:action.scope.paths,
    commit:action.scope.commit,inputHash:action.inputHash,expiresAt:"2026-10-27T00:00:00Z"};
  const now=Date.parse("2026-10-25T00:00:00Z");
  assert.equal(hasExactEngineeringActionGrant([grant],principal,action,projectId,now),false,
    "a B-only grant cannot approve an A action for a multi-project executor");
  const current={...grant,projectId};
  assert.equal(hasExactEngineeringActionGrant([current],principal,action,projectId,now),true);
  assert.equal(hasExactEngineeringActionGrant([current],{...principal,projectIds:[otherProjectId]},action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,repository:"other"}],principal,action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,worktree:"/tmp/other"}],principal,action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,commit:"different"}],principal,action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,pullRequest:"pr-1"}],principal,action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,inputHash:"b".repeat(64)}],principal,action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,paths:["other.ts"]}],principal,action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,expiresAt:"2026-10-25T00:00:00Z"}],principal,action,projectId,now),false);
  assert.equal(hasExactEngineeringActionGrant([{...current,expiresAt:"2026-10-25T12:00:00Z"}],principal,action,projectId,now),false,
    "grant must also outlive the fixed action request");
});
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
      listRuntimeModels:async()=>({status:"available",models:["gpt-6"],error:null,observedAtUtc:new Date().toISOString()}),
      allowedRuntimeCwd: config.allowedRuntimeCwd, allowedRuntimeCwds: config.allowedRuntimeCwds,
      hasRuntimeGrant: config.hasRuntimeGrant });
    try {
      const writer = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${"w".repeat(40)}` }, payload: command });
      assert.equal(writer.statusCode, 403);
      const changedScope = await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...command, authorizationScope: "all" } });
      assert.equal(changedScope.statusCode, 403);
      const changedSandbox = await app.inject({ method: "POST", url: "/api/commands", headers, payload: { ...command, sandbox: "workspace-write" } });
      assert.equal(changedSandbox.statusCode, 400);
      assert.equal(calls, 0);
      const allowed = await app.inject({ method: "POST", url: "/api/commands", headers, payload: command });
      assert.equal(allowed.statusCode, 200, allowed.body);
      assert.equal(calls, 1);
    } finally { await app.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy model and bounded models remain exact within one full execution grant",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"evoloop-model-grants-"));
  try{
    const file=join(directory,"integrations.json");
    await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[{...grant,model:"gpt-6",
      models:["deepseek/deepseek-flash","kimi-code-cn/k3.1-pro"]}]}}));
    const config=await loadIntegrations(file);
    for(const model of ["gpt-6","deepseek/deepseek-flash","kimi-code-cn/k3.1-pro"])
      assert.equal(config.hasRuntimeGrant({...grant,model}),true,model);
    for(const model of ["deepseek/deepseek-v4-pro","DeepSeek/deepseek-flash",null])
      assert.equal(config.hasRuntimeGrant({...grant,model}),false,String(model));
    assert.equal(config.hasRuntimeGrant({...grant,model:"gpt-6",actorId:"other"}),false);
    assert.equal(config.hasRuntimeGrant({...grant,model:"gpt-6",cwd:"/tmp/other"}),false);
    assert.equal(config.hasRuntimeGrant({...grant,model:"gpt-6",sandbox:"workspace-write"}),false);
    await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[{...grant,model:"gpt-6"}]}}));
    const legacy=await loadIntegrations(file);
    assert.equal(legacy.hasRuntimeGrant({...grant,model:"gpt-6"}),true);
    assert.equal(legacy.hasRuntimeGrant({...grant,model:"deepseek/deepseek-flash"}),false);
    await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[{...grant,models:["*"]}]}}));
    await assert.rejects(loadIntegrations(file),/Invalid integration configuration/);
  }finally{await rm(directory,{recursive:true,force:true});}
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

test("orchestration disabled still classifies a persisted dynamic Session before static reserve and current grants",async()=>{
  const dispatchId=randomUUID(),boundSessionId=loopIntentId(dispatchId,"session");
  const persisted={query:async()=>({rows:[{dispatch_id:dispatchId}]})} as never;
  const bound={projectId,id:boundSessionId},ordinary={projectId,id:randomUUID()};
  assert.equal(await currentSessionGrant(persisted,bound,()=>true),false,
    "a colliding static grant cannot authorize the bound Session without dynamic admission");
  assert.equal(await currentSessionGrant(persisted,ordinary,()=>true),true);
  assert.equal(await currentSessionGrant(persisted,bound,()=>true,async()=>true),true,
    "an enabled exact dynamic admission remains available");
  assert.equal(await currentSessionGrant(persisted,bound,()=>true,async()=>false),false);
  assert.equal(await runtimeThreadConfigForSession([{...grant,sandbox:"workspace-write",networkAccess:true}],
    {...command,sessionId:boundSessionId,actorId:grant.actorId,model:null,sandbox:"workspace-write"},
    {isDynamicSession:(project,session)=>isBoundDynamicSession(persisted,project,session),
      networkAccessForSession:async()=>null}),undefined,
    "a disabled dynamic authorizer cannot inherit static native network settings");
  const app=await buildServer({service:{...workManagementQueries,
    getRuntimeSession:async()=>({projectId,id:boundSessionId,actorId:grant.actorId,roleId:grant.roleId,
      authorizationScope:grant.authorizationScope,cwd:grant.cwd,sandbox:grant.sandbox}),
    execute:async()=>{throw Error("a bound dynamic command reached core");}} as unknown as WorkflowService,
    credentials:credentials as never,runtime:{status:()=>({available:true,error:null})} as RuntimeRunner,
    hasRuntimeGrant:()=>true,allowedRuntimeCwd:async()=>true,
    isDynamicSession:(project,session)=>isBoundDynamicSession(persisted,project,session)});
  try {
    const reserveSession={...command,sessionId:boundSessionId};
    const reserveRun={type:"runtime.run.reserve",projectId,operationId:randomUUID(),sessionId:boundSessionId,
      runId:randomUUID(),taskId:randomUUID(),expectedVersion:1,input:"Bounded task"};
    assert.equal((await app.inject({method:"POST",url:"/api/commands",headers,payload:reserveSession})).statusCode,403);
    assert.equal((await app.inject({method:"POST",url:"/api/commands",headers,payload:reserveRun})).statusCode,403);
  } finally { await app.close(); }
});

test("dynamic network access follows the exact Session binding despite a colliding static or expired template",async()=>{
  const spec={...grant,sessionId,model:"model",approvalPolicy:"on-request" as const};
  const staticTrue=[{...grant,sandbox:"workspace-write" as const,model:"model",approvalPolicy:"on-request" as const,networkAccess:true}];
  assert.deepEqual(await runtimeThreadConfigForSession(staticTrue,{...spec,sandbox:"workspace-write"},null),
    {"sandbox_workspace_write.network_access":true});
  assert.equal(await runtimeThreadConfigForSession(staticTrue,{...spec,model:"other-model",sandbox:"workspace-write"},null),undefined);
  assert.equal(await runtimeThreadConfigForSession(staticTrue,{...spec,approvalPolicy:"untrusted",sandbox:"workspace-write"},null),undefined);
  const dynamic={isDynamicSession:async()=>true,networkAccessForSession:async()=>false};
  assert.deepEqual(await runtimeThreadConfigForSession(staticTrue,{...spec,sandbox:"workspace-write"},dynamic),
    {"sandbox_workspace_write.network_access":false});
  assert.equal(await runtimeThreadConfigForSession(staticTrue,{...spec,sandbox:"workspace-write"},
    {...dynamic,networkAccessForSession:async()=>null}),undefined,
    "an expired other template or revoked binding cannot supply network permission");
  assert.deepEqual(await runtimeThreadConfigForSession([], {...spec,sandbox:"workspace-write"},
    {...dynamic,networkAccessForSession:async()=>true}),{"sandbox_workspace_write.network_access":true});
  assert.deepEqual(runtimeThreadConfig([{...staticTrue[0]!,networkAccess:false}],{...spec,sandbox:"workspace-write"}),
    {"sandbox_workspace_write.network_access":false});
  assert.equal(runtimeThreadConfig([],{...spec,sandbox:"workspace-write"}),undefined);
});

test("reloaded static profile downgrades workspace network and rejects withdrawn or changed grants",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"evoloop-resume-profile-"));
  try {
    const file=join(directory,"integrations.json");
    const profile={...grant,sandbox:"workspace-write" as const,model:"fixture-model",
      approvalPolicy:"on-request" as const,networkAccess:true};
    const spec={...profile,sessionId,actorId:profile.actorId};
    const load=async (grants:unknown[])=>{await writeFile(file,JSON.stringify({runtime:{enabled:true,grants}}));return loadIntegrations(file);};
    const allowed=await load([profile]);
    assert.equal(allowed.hasRuntimeGrant(spec),true);
    assert.deepEqual(runtimeThreadConfig(allowed.runtime!.grants,spec),{"sandbox_workspace_write.network_access":true});
    const downgraded=await load([{...profile,networkAccess:false}]);
    assert.equal(downgraded.hasRuntimeGrant(spec),true);
    assert.deepEqual(runtimeThreadConfig(downgraded.runtime!.grants,spec),{"sandbox_workspace_write.network_access":false});
    assert.equal(downgraded.hasRuntimeGrant({...spec,model:"other-model"}),false);
    assert.equal(downgraded.hasRuntimeGrant({...spec,approvalPolicy:"untrusted"}),false);
    const revoked=await load([]);
    assert.equal(revoked.hasRuntimeGrant(spec),false);
    assert.equal(runtimeThreadConfig(revoked.runtime!.grants,spec),undefined);
  } finally {await rm(directory,{recursive:true,force:true});}
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


test("current grants default to full execution while legacy missing fields retain their original limits",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"evoloop-full-defaults-")),file=join(directory,"integrations.json");
  const {sandbox:_sandbox,approvalPolicy:_approval,...identity}=grant;
  const load=async (value:unknown)=>{await writeFile(file,JSON.stringify({runtime:{enabled:true,grants:[value]}}));return loadIntegrations(file);};
  try{
    const current=(await load(identity)).runtime!.grants[0]!;
    assert.equal(current.sandbox,"danger-full-access");assert.equal(current.approvalPolicy,"never");assert.equal(current.networkAccess,true);
    const legacy=(await load({...identity,sandbox:"workspace-write"})).runtime!.grants[0]!;
    assert.equal(legacy.approvalPolicy,"on-request");assert.equal(legacy.networkAccess,false);
    for(const invalid of [{...identity,sandbox:"danger-full-access",networkAccess:false},
      {...identity,sandbox:"danger-full-access",approvalPolicy:"on-request"}])
      await assert.rejects(load(invalid),/Invalid integration configuration/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
