import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowService } from "@evoloop/core";
import type { RuntimeWorkflowService } from "@evoloop/core/runtime";
import type { RuntimeApprovalRequest, RuntimeBinding, RuntimePage, RuntimePort, RuntimeProvider, RuntimeSessionSpec, RuntimeTurn } from "@evoloop/contracts/runtime";
import type { SessionProfileRecord } from "@evoloop/contracts/session-assignments";
import type { Principal, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import type { WorkspaceRuntimeUpdate } from "@evoloop/contracts/session-timeline";
import type { UnitOfWork } from "@evoloop/contracts/ports";
import type { SessionObservationService } from "@evoloop/core/session-observation";
import { RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError } from "@evoloop/adapter-codex-app-server";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeRunner, type ManagedRuntime } from "../src/runtime/runner.js";
import { ProviderRoutedRuntime } from "../src/runtime/routed.js";
import { SessionTimelineService } from "../src/session-timeline/index.js";
import { currentSessionGrant } from "../src/orchestration/dynamic-admission.js";
import { grantAllowsModel } from "../src/configuration.js";
import { loopIntentId } from "../src/orchestration/runner.js";

const projectId = randomUUID();
const actorId = "reviewer";
const session: RuntimeSessionRecord = {
  projectId, id: randomUUID(), roleId: "temporary-role", cwd: "/tmp/evoloop-fixture", authorizationScope: "task:bounded",
  model: null, sandbox: "read-only", approvalPolicy: "on-request", state: "ready", version: 3,
  nativeThreadId: "owned-thread", nativeSessionId: "owned-session", operationId: randomUUID(), actorId,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const run: RuntimeRunRecord = {
  projectId, id: randomUUID(), taskId: randomUUID(), taskRevisionId: randomUUID(), basisSetId: randomUUID(),
  sessionId: session.id, operationId: randomUUID(), input: "bounded input", inputHash: "hash", state: "unknown",
  version: 3, nativeTurnId: null, interruptRequested: false, resultSummary: null, actorId,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

test("compaction uses current static authority and never settles a dynamic origin with historical authority", async () => {
  const revisionId=randomUUID(),dispatchId=randomUUID();
  const owner={...session,id:loopIntentId(dispatchId,"session"),actorId:"leader",roleId:randomUUID(),
    cwd:"/tmp/compact-owner",authorizationScope:"project",model:"gpt-6-astra",
    sandbox:"danger-full-access" as const,approvalPolicy:"never" as const,version:4,
    executionProfile:{revision:{projectId,sessionId:"",revisionId,version:2,model:"gpt-6-astra",
      reasoningEffort:"max",sandbox:"danger-full-access",approvalPolicy:"never",
      cwd:"/tmp/compact-owner",authorizationScope:"project",provenance:"revised",
      previousRevisionId:null,operationId:randomUUID(),actorId:"leader",reason:"active profile",
      evidenceRef:null,createdAt:new Date().toISOString()},activeRevisionId:revisionId,
      activationState:"active",activationOperationId:randomUUID(),attemptedAt:new Date().toISOString(),
      activationEvidence:null}} as RuntimeSessionRecord;
  owner.executionProfile!.revision.sessionId=owner.id;
  const reviewer:Principal={actorId:"maintainer",projectIds:[projectId],permissions:["read","write","review"]};
  const grant={projectId,actorId:reviewer.actorId,roleId:owner.roleId,
    authorizationScope:owner.authorizationScope,cwd:owner.cwd,sandbox:owner.sandbox,
    model:"gpt-6-sol",models:["gpt-6-astra"],approvalPolicy:owner.approvalPolicy};
  let currentGrant=true,cwdAllowed=true,dynamic=false,dynamicCurrent=false,registered=0;
  const persisted={query:async()=>({rows:dynamic?[{dispatch_id:dispatchId}]:[]})} as never;
  const runtime=new FakeRuntime();runtime.ready=true;
  runtime.registerBinding=async()=>{registered++;};
  const workflow={getRuntimeSession:async()=>owner} as unknown as WorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort & FakeRuntime,
    workflow,trusted:{} as RuntimeWorkflowService,principals:[reviewer],canWrite:()=>true,
    allowedCwd:async()=>cwdAllowed,canSettleOwned:async()=>dynamic,ownedCwd:async()=>true,
    hasGrant:(scope,record)=>currentSessionGrant(persisted,record!,()=>currentGrant&&
      Object.entries(scope).every(([key,value])=>key==='model'
        ? grantAllowsModel(grant,value as string)
        : grant[key as keyof typeof grant]===value),async()=>dynamicCurrent)});
  Object.assign(runner,{available:true});
  const check=()=>runner.compactionBinding(reviewer,projectId,owner.id,owner.version,owner.nativeThreadId!);
  await check();assert.equal(registered,1,"valid static Session reaches the original owner");
  currentGrant=false;await assert.rejects(check,/grant/);currentGrant=true;
  cwdAllowed=false;await assert.rejects(check,/grant/);cwdAllowed=true;
  for(const changed of [{actorId:"foreign"},{projectIds:[randomUUID()]},
    {permissions:["read"] as Principal["permissions"]}])
    await assert.rejects(()=>runner.compactionBinding({...reviewer,...changed},projectId,owner.id,
      owner.version,owner.nativeThreadId!),/Compaction|grant/);
  for(const key of ["roleId","authorizationScope","cwd","sandbox","approvalPolicy","model"] as const){
    const previous=owner[key];(owner as unknown as Record<string,unknown>)[key]=key==="model"?"other-model":"other-value";
    await assert.rejects(check,/Compaction|grant|profile/);
    (owner as unknown as Record<string,unknown>)[key]=previous;
  }
  dynamic=true;dynamicCurrent=false;
  await assert.rejects(check,/grant/,"historical settlement cannot authorize a dynamic start");
  dynamicCurrent=true;await check();
  assert.equal(registered,2,"current dynamic admission can reach the original owner");
});

class FakeRuntime {
  ready = false;
  starts = 0;
  creates = 0;
  disconnectListeners = new Set<(reason: string) => void>();
  approvalListeners = new Set<(request: RuntimeApprovalRequest) => void | Promise<void>>();
  async open() { this.ready = true; }
  async close() { this.ready = false; this.disconnect("closed"); }
  isReady() { return this.ready; }
  onDisconnect(listener: (reason: string) => void) { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
  onApprovalRequest(listener: (request: RuntimeApprovalRequest) => void | Promise<void>) { this.approvalListeners.add(listener); return () => this.approvalListeners.delete(listener); }
  async emitApproval(request: RuntimeApprovalRequest) { for (const listener of this.approvalListeners) await listener(request); }
  disconnect(reason: string) { this.ready = false; for (const listener of this.disconnectListeners) listener(reason); }
  async registerBinding(_binding: RuntimeBinding) {}
  async create() { this.creates++; return { sessionId: session.id, projectId, roleId: session.roleId,
    cwd: session.cwd, authorizationScope: session.authorizationScope, nativeThreadId: "owned-thread",
    nativeSessionId: "owned-session", owner: "evoloop-codex-app-server" as const }; }
  async resume(binding: RuntimeBinding, _spec: RuntimeSessionSpec) { return binding; }
  async inspect(_binding: RuntimeBinding): Promise<unknown> { return { thread: { id: session.nativeThreadId, sessionId: session.nativeSessionId, cwd: session.cwd, source: "appServer" } }; }
  async listTurns(): Promise<RuntimePage<RuntimeTurn>> { return { data: [], nextCursor: null }; }
  async listItems(): Promise<RuntimePage<unknown>> { return { data: [], nextCursor: null }; }
  async startTurn() { this.starts++; throw Error("unknown start must not replay"); }
}

test('runtime status exposes bounded native child loss without treating it as a Turn result',()=>{
  const diagnostic={startId:randomUUID(),pid:1234,startedAtUtc:'2026-11-06T00:00:00.000Z',
    observedAtUtc:'2026-11-06T00:01:00.000Z',stopReason:'stdout_closed' as const,
    firstLossAtUtc:'2026-11-06T00:01:00.000Z',firstLossReason:'stdout_closed' as const,
    exitObserved:false,exitedAtUtc:null,exitCode:null,exitSignal:null,nativeTurnOutcome:'unknown' as const};
  const native=Object.assign(new FakeRuntime(),{listChildDiagnostics:()=>[diagnostic]});
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort&typeof native,
    workflow:{} as WorkflowService,trusted:{} as RuntimeWorkflowService,principals:[],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  assert.equal(runner.status(projectId).available,false);
  assert.deepEqual(runner.status(projectId).nativeChildDiagnostics,[diagnostic]);
});

test('native child diagnostic survives replacement of its adapter',async()=>{
  const diagnostic={startId:randomUUID(),pid:1234,startedAtUtc:'2026-11-06T00:00:00.000Z',
    observedAtUtc:'2026-11-06T00:01:00.000Z',stopReason:'process_exited' as const,
    firstLossAtUtc:'2026-11-06T00:00:59.000Z',firstLossReason:'stdout_closed' as const,
    exitObserved:true,exitedAtUtc:'2026-11-06T00:01:00.000Z',exitCode:1,exitSignal:null,nativeTurnOutcome:'unknown' as const};
  let created=0;
  const runner=new RuntimeRunner({runtimeFactory:()=>{
    created++;
    return Object.assign(new FakeRuntime(),{listChildDiagnostics:()=>created===1?[diagnostic]:[]});
  },workflow:{} as WorkflowService,trusted:{} as RuntimeWorkflowService,principals:[],
  canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try{
    await runner.recover();
    assert.equal(created,2);
    assert.deepEqual(runner.status(projectId).nativeChildDiagnostics,[diagnostic]);
  }finally{await runner.stop();}
});

test('runtime status reloads persisted child loss after coordinator restart',async()=>{
  const diagnostic={startId:randomUUID(),pid:1234,startedAtUtc:'2026-11-06T00:00:00.000Z',
    observedAtUtc:'2026-11-06T00:01:00.000Z',stopReason:'process_exited' as const,
    firstLossAtUtc:'2026-11-06T00:00:59.000Z',firstLossReason:'stdout_closed' as const,
    exitObserved:true,exitedAtUtc:'2026-11-06T00:01:00.000Z',exitCode:1,exitSignal:null,nativeTurnOutcome:'unknown' as const};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[],
    listRuntimeRuns:async()=>[]} as unknown as WorkflowService;
  const earlier={...diagnostic,observedAtUtc:diagnostic.firstLossAtUtc,
    stopReason:'stdout_closed' as const,exitObserved:false,exitedAtUtc:null,exitCode:null};
  const trusted={recentNativeChildDiagnostics:async()=>[
    {detail:JSON.stringify(diagnostic)},{detail:JSON.stringify(earlier)},
    {detail:JSON.stringify({...diagnostic,startId:randomUUID(),privateMessage:'secret'})},
    {detail:JSON.stringify({...diagnostic,startId:randomUUID(),pid:-1})}],
    recoverDispatching:async()=>({sessions:[],runs:[]})} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>new FakeRuntime(),workflow,trusted,
    principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try{
    await runner.start();
    assert.deepEqual(runner.status(projectId).nativeChildDiagnostics,[diagnostic]);
  }finally{await runner.stop();}
});

test('runtime status retains confirmed exit when projects saved equal-time loss snapshots',async()=>{
  const otherProjectId=randomUUID();
  const diagnostic={startId:randomUUID(),pid:1234,startedAtUtc:'2026-11-06T00:00:00.000Z',
    observedAtUtc:'2026-11-06T00:01:00.000Z',stopReason:'process_exited' as const,
    firstLossAtUtc:'2026-11-06T00:01:00.000Z',firstLossReason:'stdout_closed' as const,
    exitObserved:true,exitedAtUtc:'2026-11-06T00:01:01.000Z',exitCode:1,exitSignal:null,nativeTurnOutcome:'unknown' as const};
  const loss={...diagnostic,stopReason:'stdout_closed' as const,exitObserved:false,
    exitedAtUtc:null,exitCode:null};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[],
    listRuntimeRuns:async()=>[]} as unknown as WorkflowService;
  const trusted={recentNativeChildDiagnostics:async(project:string)=>
    project===otherProjectId?[{detail:JSON.stringify(loss)}]:[{detail:JSON.stringify(diagnostic)}],
    recoverDispatching:async()=>({sessions:[],runs:[]})} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>new FakeRuntime(),workflow,trusted,
    principals:[{actorId,projectIds:[otherProjectId,projectId],permissions:['read','write','review']}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try{
    await runner.start();
    assert.deepEqual(runner.status(projectId).nativeChildDiagnostics,[diagnostic]);
  }finally{await runner.stop();}
});

test('native loss callback persists a diagnostic before replacing the child',async()=>{
  const diagnostic={startId:randomUUID(),pid:1234,startedAtUtc:'2026-11-06T00:00:00.000Z',
    observedAtUtc:'2026-11-06T00:01:00.000Z',stopReason:'process_exited' as const,
    firstLossAtUtc:'2026-11-06T00:00:59.000Z',firstLossReason:'stdout_closed' as const,
    exitObserved:true,exitedAtUtc:'2026-11-06T00:01:00.000Z',exitCode:1,exitSignal:null,nativeTurnOutcome:'unknown' as const};
  let created=0,persisted=0,flushed=0;
  let notify:((value:typeof diagnostic)=>void|Promise<void>)|null=null;
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[],
    listRuntimeRuns:async()=>[]} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),
    recordNativeChildDiagnostic:async(_project:string,value:typeof diagnostic)=>{
      assert.equal(_project,projectId);assert.deepEqual(value,diagnostic);persisted++;}
  } as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>{
    created++;
    return Object.assign(new FakeRuntime(),{
      onChildDiagnostic:(listener:typeof notify)=>{notify=listener;return()=>{notify=null;}},
      flushChildDiagnostics:async()=>{flushed++;},listChildDiagnostics:()=>created===1?[diagnostic]:[]});
  },workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
  canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try{
    await runner.start();
    await notify?.(diagnostic);
    assert.equal(persisted,1);
    runner.nativeAdapter().isReady = () => false;
    await runner.recover();
    assert.equal(flushed,1);
    assert.deepEqual(runner.status(projectId).nativeChildDiagnostics,[diagnostic]);
  }finally{await runner.stop();}
});

test("owned Session names follow the newest business profile across creation, edits and native failures", async () => {
  const owned: RuntimeSessionRecord = { ...session, id: randomUUID(), state: "reserved",
    nativeThreadId: null, nativeSessionId: null };
  let profile: SessionProfileRecord | null = { projectId, target: { kind: "owned", sessionId: owned.id },
    version: 1, displayName: "方案设计", purpose: "", membership: "current", tenure: "temporary",
    actorId, reason: "initial", updatedAt: new Date().toISOString() };
  let reject = false, loseReply = false;
  class NamingRuntime extends FakeRuntime {
    name: string | null = null;
    writes: string[] = [];
    onWrite: ((name: string) => void) | null = null;
    override async create() { return { ...await super.create(), sessionId: owned.id }; }
    async readThreadName(binding: RuntimeBinding) {
      assert.equal(binding.sessionId, owned.id);
      assert.equal(binding.nativeThreadId, "owned-thread");
      return this.name;
    }
    async setThreadName(binding: RuntimeBinding, name: string) {
      assert.equal(binding.sessionId, owned.id);
      this.writes.push(name);
      if (reject) throw new RuntimeServerError("thread/name/set", 1, -32000, "private rejection");
      this.onWrite?.(name);
      this.name = name;
      if (loseReply) throw new RuntimeUnknownError("thread/name/set", 2, "lost reply");
    }
  }
  const native = new NamingRuntime();
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [owned],
    listRuntimeRuns: async () => [] } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    beginSessionCreate: async () => {}, bindSession: async (_project: string, id: string, binding: RuntimeBinding) => {
      assert.equal(id, owned.id); owned.state = "ready";
      owned.nativeThreadId = binding.nativeThreadId; owned.nativeSessionId = binding.nativeSessionId;
    } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => native as unknown as RuntimePort & NamingRuntime,
    workflow, trusted, profileForSession: async (_principal, current) => current.id === owned.id ? profile : null,
    principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    assert.equal(owned.state, "ready");
    assert.deepEqual(native.writes, ["方案设计"], "the preexisting profile names the exact newly bound Thread");
    await runner.pump();
    assert.equal(native.name, "方案设计");
    assert.deepEqual(native.writes, ["方案设计"], "an unchanged profile cannot cause repeated native writes");
    profile = { ...profile!, version: 2, displayName: "方案设计 · 更新" };
    await runner.pump();
    profile = { ...profile, version: 3, displayName: "最终名称" };
    await runner.pump();
    assert.deepEqual(native.writes, ["方案设计", "方案设计 · 更新", "最终名称"]);
    reject = true;
    profile = { ...profile, version: 4, displayName: "被拒名称" };
    await runner.pump(); await runner.pump();
    assert.equal(native.writes.filter(name => name === "被拒名称").length, 1);
    assert.equal(native.name, "最终名称");
    assert.equal(runner.status(projectId).faults.find(f => f.phase === "session_name_sync")?.sessionId, owned.id);
    reject = false;
    native.disconnect("fixture reconnect");
    await runner.recover();
    assert.equal(native.name, "被拒名称", "reconnection compares native state before retrying the current profile");
    loseReply = true;
    profile = { ...profile, version: 5, displayName: "恢复名称" };
    await runner.pump();
    assert.equal(native.name, "恢复名称", "lost acknowledgement is settled by exact native readback");
    assert.equal(runner.status(projectId).faults.find(f => f.phase === "session_name_sync"), undefined);
    loseReply = false;
    profile = { ...profile, version: 6, displayName: "中途旧名" };
    native.onWrite = name => {
      if (name === "中途旧名") profile = { ...profile!, version: 7, displayName: "最终最新名" };
    };
    await runner.pump(); await runner.pump();
    assert.equal(native.name, "最终最新名", "a newer profile wins after an older native request completes");
    assert.equal(native.starts, 0);
    profile = { ...profile, version: 8, target: { kind: "external", linkId: randomUUID() }, displayName: "外部名称" };
    await runner.pump();
    assert.equal(native.name, "最终最新名", "an external target cannot rename the owned Thread");
    owned.state = "closed";
    profile = { ...profile, version: 9, target: { kind: "owned", sessionId: owned.id }, displayName: "关闭后名称" };
    await runner.pump();
    assert.equal(native.name, "最终最新名");
  } finally { await runner.stop(); }
});

test("a profile added after the owned Thread is ready names that same Thread without a Turn", async () => {
  let profile: SessionProfileRecord | null = null;
  class ReadyThread extends FakeRuntime {
    name: string | null = null;
    async readThreadName(binding: RuntimeBinding) { assert.equal(binding.nativeThreadId, session.nativeThreadId); return this.name; }
    async setThreadName(binding: RuntimeBinding, name: string) {
      assert.equal(binding.nativeThreadId, session.nativeThreadId); this.name = name;
    }
  }
  const native = new ReadyThread();
  const runner = new RuntimeRunner({ runtimeFactory: () => native as unknown as RuntimePort & ReadyThread,
    workflow: { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
      listRuntimeRuns: async () => [] } as unknown as WorkflowService,
    trusted: { recoverDispatching: async () => ({ sessions: [], runs: [] }) } as unknown as RuntimeWorkflowService,
    profileForSession: async () => profile,
    principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    assert.equal(native.name, null);
    profile = { projectId, target: { kind: "owned", sessionId: session.id }, version: 1,
      displayName: "绑定后命名", purpose: "", membership: "current", tenure: "temporary",
      actorId, reason: "late profile", updatedAt: new Date().toISOString() };
    await runner.pump();
    assert.equal(native.name, "绑定后命名");
    assert.equal(native.starts, 0);
  } finally { await runner.stop(); }
});

test("a project lookup failure is retained, while a genuinely absent project is skipped", async () => {
  const runtime = new FakeRuntime();
  let absent = false;
  const workflow = { getProject: async () => {
    if (absent) throw new DomainError("NOT_FOUND", "Project was not found");
    throw new Error("database connection failed with secret=private");
  } } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }) } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    assert.deepEqual(runner.status(projectId).faults.map(fault => [fault.phase,fault.projectId]), [["project_scan",projectId]]);
    assert.doesNotMatch(JSON.stringify(runner.status(projectId)), /secret=private/);
    absent = true;
    await runner.pump();
    assert.equal(runner.status(projectId).faults.length, 1, "a missing project does not prove that an earlier outage recovered");
  } finally { await runner.stop(); }
});

test("closing session archives once, verifies identity, and restart only reads after uncertain acknowledgement", async () => {
  const closing: RuntimeSessionRecord = { ...session, state: "closing", closeOperationId: randomUUID(), closeAttemptedAt: null };
  class ArchiveRuntime extends FakeRuntime {
    archives = 0;
    archived = false;
    loseAck = false;
    async isThreadArchived(binding: RuntimeBinding) {
      assert.equal(binding.nativeThreadId, closing.nativeThreadId);
      return this.archived;
    }
    async archiveThread(_binding: RuntimeBinding) {
      this.archives++;
      if (this.loseAck) throw Error("ack lost");
      this.archived = true;
    }
  }
  const runtime = new ArchiveRuntime();
  let confirms = 0;
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [closing],
    listRuntimeRuns: async () => [] } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    markSessionArchiveAttempt: async () => { closing.closeAttemptedAt = new Date().toISOString(); },
    confirmSessionClosed: async () => { confirms++; closing.state = "closed"; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & ArchiveRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    assert.equal(runtime.archives, 1); assert.equal(confirms, 1); assert.equal(closing.state, "closed");
  } finally { await runner.stop(); }

  closing.state = "closing"; closing.closeAttemptedAt = null;
  const lost = new ArchiveRuntime(); lost.loseAck = true;
  const again = new RuntimeRunner({ runtimeFactory: () => lost as unknown as RuntimePort & ArchiveRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await again.start();
    assert.equal(lost.archives, 1); assert.equal(closing.state, "closing");
    assert.deepEqual(again.status(projectId).faults.map(fault=>[fault.sessionId,fault.phase,fault.category]),
      [[closing.id,"session_close","unknown_outcome"]]);
    await again.pump();
    assert.equal(lost.archives, 1);
    assert.equal(again.status(projectId).faults.length,1,"an unverified archive remains attributable to its Session");
    lost.archived = true;
    await again.pump();
    assert.equal(confirms, 2); assert.equal(closing.state, "closed");
    assert.equal(again.status(projectId).faults.length,0,"only verified closure clears its Session fault");
  } finally { await again.stop(); }

  closing.state = "closing"; closing.closeAttemptedAt = null;
  class ForeignRuntime extends ArchiveRuntime {
    override async inspect(_binding: RuntimeBinding): Promise<unknown> { throw Error("native binding mismatch"); }
  }
  const foreign = new ForeignRuntime();
  const reject = new RuntimeRunner({ runtimeFactory: () => foreign as unknown as RuntimePort & ForeignRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await reject.start();
    assert.equal(foreign.archives, 0);
    assert.equal(closing.closeAttemptedAt, null);
    assert.equal(closing.state, "closing");
  } finally { await reject.stop(); }
});

test("fresh runner retains an unverified prior archive attempt until exact native readback", async () => {
  const closeOperationId = randomUUID();
  const closing: RuntimeSessionRecord = { ...session, state: "closing", version: 5,
    closeOperationId, closeAttemptedAt: new Date().toISOString(), closeVerifiedAt: null };
  let archived = false, reads = 0, archives = 0, confirms = 0, inspections = 0;
  class EmptyThreadRuntime extends FakeRuntime {
    async isThreadArchived(binding: RuntimeBinding) {
      assert.equal(binding.nativeThreadId, closing.nativeThreadId);
      assert.equal(binding.nativeSessionId, closing.nativeSessionId);
      reads++;
      return archived;
    }
    async archiveThread() { archives++; throw new Error("must not retry an attempted archive"); }
    override async inspect(_binding: RuntimeBinding) { inspections++; throw new Error("must not inspect for replay"); }
  }
  const native = new EmptyThreadRuntime();
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [closing],
    listRuntimeRuns: async () => [] } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    markSessionArchiveAttempt: async () => { throw new Error("attempt marker must not repeat"); },
    confirmSessionClosed: async (_project: string, binding: RuntimeBinding, operationId: string) => {
      assert.equal(operationId, closeOperationId);
      assert.equal(binding.sessionId, closing.id);
      assert.equal(binding.nativeThreadId, closing.nativeThreadId);
      confirms++; closing.state = "closed";
    } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => native as unknown as RuntimePort & EmptyThreadRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    assert.equal(closing.state, "closing");
    assert.deepEqual(runner.status(projectId).faults.map(f => [f.sessionId, f.phase, f.category]),
      [[closing.id, "session_close", "unknown_outcome"]]);
    await runner.pump();
    assert.deepEqual(runner.status(projectId).faults.map(f => f.category), ["unknown_outcome"]);
    assert.equal(archives, 0); assert.equal(inspections, 0); assert.equal(confirms, 0);
    assert.ok(reads >= 2);
    archived = true;
    await runner.pump();
    assert.equal(confirms, 1); assert.equal(closing.state, "closed");
    assert.equal(runner.status(projectId).faults.length, 0);
    assert.equal(archives, 0);
  } finally { await runner.stop(); }
});

test("readback failure after a durable archive attempt remains unknown and cannot replay", async t => {
  for (const sample of [
    { name: "fresh runner first read times out", alreadyAttempted: true,
      error: new RuntimeUnknownError("thread/list", 8, "private reply lost") },
    { name: "empty archive acknowledgement then post-read is rejected", alreadyAttempted: false,
      error: new RuntimeServerError("thread/list", 8, -32600, "private native read rejection") },
  ] as const) await t.test(sample.name, async () => {
    const closing: RuntimeSessionRecord = { ...session, state: "closing", closeOperationId: randomUUID(),
      closeAttemptedAt: sample.alreadyAttempted ? new Date().toISOString() : null };
    let reads = 0, archives = 0, marks = 0, confirms = 0, inspections = 0;
    class ReadFailureRuntime extends FakeRuntime {
      async isThreadArchived() {
        reads++;
        if (sample.alreadyAttempted || reads === 2) throw sample.error;
        return false;
      }
      async archiveThread() { archives++; } // Native's empty acknowledgement proves nothing.
      override async inspect(binding: RuntimeBinding) { inspections++; return super.inspect(binding); }
    }
    const native = new ReadFailureRuntime();
    const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [closing],
      listRuntimeRuns: async () => [] } as unknown as WorkflowService;
    const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
      markSessionArchiveAttempt: async () => { marks++; closing.closeAttemptedAt = new Date().toISOString(); },
      confirmSessionClosed: async () => { confirms++; } } as unknown as RuntimeWorkflowService;
    const runner = new RuntimeRunner({ runtimeFactory: () => native as unknown as RuntimePort & ReadFailureRuntime,
      workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
      canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
    try {
      await runner.start();
      assert.equal(closing.state, "closing"); assert.equal(confirms, 0);
      assert.equal(archives, sample.alreadyAttempted ? 0 : 1);
      assert.equal(marks, sample.alreadyAttempted ? 0 : 1);
      assert.equal(inspections, sample.alreadyAttempted ? 0 : 1);
      assert.deepEqual(runner.status(projectId).faults.map(f => [f.phase, f.category]),
        [["session_close", "unknown_outcome"]]);
      assert.doesNotMatch(JSON.stringify(runner.status(projectId)), /private reply|private native/);
      await runner.pump();
      assert.equal(archives, sample.alreadyAttempted ? 0 : 1);
      assert.equal(marks, sample.alreadyAttempted ? 0 : 1);
      assert.equal(confirms, 0);
      assert.deepEqual(runner.status(projectId).faults.map(f => f.category), ["unknown_outcome"]);
    } finally { await runner.stop(); }
  });
});

test("failed archive precheck stops before durable attempt or native write", async () => {
  const closing: RuntimeSessionRecord = { ...session, state: "closing", closeOperationId: randomUUID(), closeAttemptedAt: null };
  let archives = 0, marks = 0, inspections = 0, confirms = 0;
  class FailedPrecheckRuntime extends FakeRuntime {
    async isThreadArchived() { throw new RuntimeUnknownError("thread/list", 8, "precheck unavailable"); }
    async archiveThread() { archives++; }
    override async inspect(_binding: RuntimeBinding) { inspections++; return {}; }
  }
  const native = new FailedPrecheckRuntime();
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [closing],
    listRuntimeRuns: async () => [] } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    markSessionArchiveAttempt: async () => { marks++; }, confirmSessionClosed: async () => { confirms++; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => native as unknown as RuntimePort & FailedPrecheckRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try { await runner.start(); assert.equal(closing.state, "closing"); assert.equal(closing.closeAttemptedAt, null);
    assert.equal(archives, 0); assert.equal(marks, 0); assert.equal(inspections, 0); assert.equal(confirms, 0);
  } finally { await runner.stop(); }
});

test("archive failure keeps a redacted rejection or unknown timeout category without replay", async t => {
  for (const sample of [
    { name: "explicit native rejection", error: new RuntimeServerError("thread/archive", 7, -32600,
      "rollout not found; path=/private/session/body; token=private-token; secret=private"), category: "native_rejected", readbackFails: false },
    { name: "explicit rejection followed by failed readback", error: new RuntimeServerError("thread/archive", 7, -32600,
      "rollout not found; path=/private/session/body; token=private-token; secret=private"), category: "native_rejected", readbackFails: true },
    { name: "response timeout", error: new RuntimeUnknownError("thread/archive", 7, "reply unavailable; secret=private"),
      category: "unknown_outcome", readbackFails: false },
  ] as const) await t.test(sample.name, async () => {
    const closing: RuntimeSessionRecord = { ...session, state: "closing", closeOperationId: randomUUID(), closeAttemptedAt: null };
    let archives = 0, confirms = 0, reads = 0;
    class FailureRuntime extends FakeRuntime {
      async isThreadArchived() {
        reads++;
        if (sample.readbackFails && reads > 1) throw new RuntimeUnknownError("thread/list", 8, "private readback");
        return false;
      }
      async archiveThread() { archives++; throw sample.error; }
    }
    const native = new FailureRuntime();
    const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [closing],
      listRuntimeRuns: async () => [] } as unknown as WorkflowService;
    const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
      markSessionArchiveAttempt: async () => { closing.closeAttemptedAt = new Date().toISOString(); },
      confirmSessionClosed: async () => { confirms++; } } as unknown as RuntimeWorkflowService;
    const runner = new RuntimeRunner({ runtimeFactory: () => native as unknown as RuntimePort & FailureRuntime,
      workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
      canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
    try {
      await runner.start();
      assert.equal(archives, 1); assert.equal(confirms, 0); assert.equal(closing.state, "closing");
      assert.deepEqual(runner.status(projectId).faults.map(f => [f.phase, f.category]), [["session_close", sample.category]]);
      const fault = runner.status(projectId).faults[0]!;
      if (sample.error instanceof RuntimeServerError) {
        assert.equal(fault.nativeMethod, "thread/archive");
        assert.equal(fault.nativeCode, -32600);
        assert.equal(fault.nativeCategory, "rollout_not_found");
      } else {
        assert.equal(fault.nativeMethod, undefined);
        assert.equal(fault.nativeCode, undefined);
        assert.equal(fault.nativeCategory, undefined);
      }
      assert.doesNotMatch(JSON.stringify(runner.status(projectId)), /rollout not found|reply unavailable|private|token=|secret=|\/private\/session\/body/);
      await runner.pump();
      assert.equal(archives, 1,"persisted attempt never replays");
      assert.equal(runner.status(projectId).faults[0]?.category, sample.category);
      if (sample.error instanceof RuntimeServerError)
        assert.equal(runner.status(projectId).faults[0]?.nativeCategory, "rollout_not_found");
    } finally { await runner.stop(); }
  });
});

test("runtime faults retain exact Run ownership, redact errors, and clear only the recovered Run",async()=>{
  const otherProject=randomUUID();
  const sessionA={...session,id:randomUUID()},sessionA2={...session,id:randomUUID()},
    sessionB={...session,projectId:otherProject,id:randomUUID()};
  const runA={...run,id:randomUUID(),sessionId:sessionA.id,nativeTurnId:"turn-a",state:"unknown" as const},
    runA2={...run,id:randomUUID(),sessionId:sessionA2.id,nativeTurnId:"turn-a2",state:"running" as const},
    runB={...run,projectId:otherProject,id:randomUUID(),sessionId:sessionB.id,nativeTurnId:"turn-b",state:"unknown" as const};
  const sessions=[sessionA,sessionA2,sessionB],runs=[runA,runA2,runB];
  let failA=true,failB=true,settleA2=false;
  class DiagnosticRuntime extends FakeRuntime {
    override async listTurns(binding:RuntimeBinding):Promise<RuntimePage<RuntimeTurn>> {
      if (binding.sessionId===sessionA.id&&failA || binding.sessionId===sessionB.id&&failB)
        throw new Error("secret=do-not-project; stack=private");
      const turnId=binding.sessionId===sessionA.id?"turn-a":binding.sessionId===sessionB.id?"turn-b":"turn-a2";
      return {data:[{id:turnId,status:binding.sessionId===sessionA2.id&&!settleA2?"inProgress":"completed",
        ...(binding.sessionId===sessionA2.id&&!settleA2?{}:{completedAtUtc:new Date().toISOString()})}],nextCursor:null};
    }
  }
  const native=new DiagnosticRuntime();
  const workflow={getProject:async()=>({id:projectId}),
    listRuntimeSessions:async(_p:Principal,p:string)=>sessions.filter(s=>s.projectId===p),
    listRuntimeRuns:async(_p:Principal,p:string)=>runs.filter(r=>r.projectId===p),
    getRuntimeSession:async(_p:Principal,p:string,id:string)=>sessions.find(s=>s.projectId===p&&s.id===id)!} as unknown as WorkflowService;
  const trusted=({recoverDispatching:async()=>({sessions:[],runs:[]}),
    recordTurn:async(p:string,id:string)=>{const matched=runs.find(r=>r.projectId===p&&r.id===id)!;matched.state="completed";}}) as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort & DiagnosticRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId,otherProject],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try {
    await runner.start();
    assert.deepEqual(runner.status(projectId).faults.map(f=>[f.projectId,f.sessionId,f.runId,f.phase]),
      [[projectId,sessionA.id,runA.id,"run_reconcile"]]);
    assert.deepEqual(runner.status(otherProject).faults.map(f=>f.runId),[runB.id]);
    assert.equal(runner.status().faults.length,0,"unscoped health cannot reveal project Run IDs");
    assert.doesNotMatch(JSON.stringify(runner.status(projectId)),/secret|private|turn-b|"runId":"undefined"/);
    settleA2=true;await runner.pump();
    assert.equal(runA2.state,"completed");
    assert.deepEqual(runner.status(projectId).faults.map(f=>f.runId),[runA.id],
      "an unrelated successful Run cannot clear an unknown Run");
    failA=false;await runner.pump();
    assert.equal(runA.state,"completed");
    assert.equal(runner.status(projectId).faults.length,0);
    assert.deepEqual(runner.status(otherProject).faults.map(f=>f.runId),[runB.id]);
  }finally{await runner.stop();}
});

test("an admission skip cannot erase an earlier Run fault; its persisted terminal state can",async()=>{
  const requested={...run,id:randomUUID(),state:"requested" as RuntimeRunRecord["state"],nativeTurnId:null};
  let permitted=true;
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[session],
    listRuntimeRuns:async()=>[requested],getRuntimeSession:async()=>{throw new Error("private API token");}} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]})} as unknown as RuntimeWorkflowService;
  const native=new FakeRuntime();
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort & FakeRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true,mayDispatchRun:async()=>permitted});
  try {
    await runner.start();
    assert.deepEqual(runner.status(projectId).faults.map(f=>f.runId),[requested.id]);
    permitted=false;await runner.pump();
    assert.deepEqual(runner.status(projectId).faults.map(f=>f.runId),[requested.id]);
    assert.doesNotMatch(JSON.stringify(runner.status(projectId)),/private API token/);
    requested.state="failed";await runner.pump();
    assert.equal(runner.status(projectId).faults.length,0);
  }finally{await runner.stop();}
});

test("only an exact running Turn readback clears a transient reconcile fault before terminal",async()=>{
  const active={...run,id:randomUUID(),state:"running" as RuntimeRunRecord["state"],nativeTurnId:"owned-turn"};
  const native=new FakeRuntime();
  let failRead=true,turnStatus="inProgress",completedAtUtc:string|null=null,settled=0;
  native.listTurns=async()=>{
    if(failRead)throw new Error("private list failure");
    return {data:[{id:"owned-turn",status:turnStatus,completedAtUtc}],nextCursor:null};
  };
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[session],
    listRuntimeRuns:async()=>[active],getRuntimeSession:async()=>session} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),
    recordTurn:async()=>{settled++;active.state="completed";return active;}} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort & FakeRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try{
    await runner.start();
    assert.deepEqual(runner.status(projectId).faults.map(f=>f.runId),[active.id]);
    failRead=false;await runner.pump();
    assert.deepEqual(runner.status(projectId).faults,[],"the same persisted running Turn is readable again");
    assert.equal(settled,0);
    active.state="unknown";failRead=true;await runner.pump();
    failRead=false;await runner.pump();
    assert.deepEqual(runner.status(projectId).faults.map(f=>f.runId),[active.id],"durable unknown is not healed by an active Turn");
    turnStatus="interrupted";await runner.pump();
    assert.deepEqual(runner.status(projectId).faults.map(f=>f.runId),[active.id],"interrupted without completion time is not terminal");
    turnStatus="completed";completedAtUtc=new Date().toISOString();await runner.pump();
    assert.equal(settled,1);
    assert.deepEqual(runner.status(projectId).faults,[]);
    assert.equal(native.starts,0);
  }finally{await runner.stop();}
});

test("close uses the original actor and exact grant, refusing missing authority or cwd without native writes", async t => {
  const originalGrant = { projectId, actorId, roleId: session.roleId, authorizationScope: session.authorizationScope,
    cwd: session.cwd, sandbox: session.sandbox, model: session.model, approvalPolicy: session.approvalPolicy };
  const cases = [
    { name: "original grant", grant: originalGrant, archive: true },
    { name: "missing grant", grant: null },
    { name: "requester grant only", grant: { ...originalGrant, actorId: "close-requester" } },
    { name: "foreign project grant", grant: { ...originalGrant, projectId: randomUUID() } },
    { name: "different role", grant: { ...originalGrant, roleId: "another-role" } },
    { name: "different scope", grant: { ...originalGrant, authorizationScope: "all" } },
    { name: "different cwd", grant: { ...originalGrant, cwd: "/other" } },
    { name: "different sandbox", grant: { ...originalGrant, sandbox: "workspace-write" } },
    { name: "missing original principal", grant: originalGrant, missingPrincipal: true },
    { name: "cwd denied", grant: originalGrant, denyCwd: true },
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const closing: RuntimeSessionRecord = { ...session, state: "closing", closeOperationId: randomUUID(), closeAttemptedAt: null };
    const binding: RuntimeBinding = { owner: "evoloop-codex-app-server", projectId, sessionId: session.id,
      roleId: session.roleId, authorizationScope: session.authorizationScope, cwd: session.cwd,
      nativeThreadId: session.nativeThreadId!, nativeSessionId: session.nativeSessionId!,
      resumeProfile:{actorId:session.actorId,model:session.model,sandbox:session.sandbox,approvalPolicy:session.approvalPolicy} };
    const calls: string[] = [];
    class ArchiveRuntime extends FakeRuntime {
      archived = false;
      override async registerBinding(actual: RuntimeBinding) { assert.deepEqual(actual, binding); calls.push("register"); }
      override async inspect(actual: RuntimeBinding) { assert.deepEqual(actual, binding); calls.push("inspect"); return {}; }
      async isThreadArchived(actual: RuntimeBinding) { assert.deepEqual(actual, binding); calls.push("read"); return this.archived; }
      async archiveThread(actual: RuntimeBinding) { assert.deepEqual(actual, binding); calls.push("archive"); this.archived = true; }
    }
    const runtime = new ArchiveRuntime();
    const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [closing],
      listRuntimeRuns: async () => [] } as unknown as WorkflowService;
    const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
      markSessionArchiveAttempt: async () => { calls.push("mark"); closing.closeAttemptedAt = new Date().toISOString(); },
      confirmSessionClosed: async () => { calls.push("confirm"); closing.state = "closed"; } } as unknown as RuntimeWorkflowService;
    const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & ArchiveRuntime,
      workflow, trusted, principals: [
        { actorId: "close-requester", projectIds: [projectId], permissions: ["read", "write", "review"] },
        ...("missingPrincipal" in sample ? [] : [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as Principal["permissions"] }]),
      ], canWrite: () => true, allowedCwd: async () => !("denyCwd" in sample),
      hasGrant: actual => {
        assert.deepEqual(actual, originalGrant, "never substitute the close requester for the Session actor");
        return sample.grant !== null && Object.entries(originalGrant).every(([key, value]) =>
          sample.grant![key as keyof typeof originalGrant] === value);
      } });
    try {
      await runner.start();
      await runner.pump();
      assert.equal(closing.actorId, actorId);
      if ("archive" in sample) {
        assert.deepEqual(calls, ["register", "read", "inspect", "mark", "archive", "read", "confirm"]);
        assert.equal(closing.state, "closed");
      } else {
        assert.deepEqual(calls, []);
        assert.equal(closing.state, "closing");
        assert.equal(closing.closeAttemptedAt, null);
      }
    } finally { await runner.stop(); }
  });
});

test("reserved session waits at admission and creates one native thread after resume", async () => {
  const reserved: RuntimeSessionRecord = { ...session, state: "reserved", nativeThreadId: null, nativeSessionId: null };
  const runtime = new FakeRuntime();
  let permitted = false, beginCalls = 0;
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [reserved],
    listRuntimeRuns: async () => [] } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    beginSessionCreate: async () => { beginCalls++; },
    bindSession: async () => { reserved.state = "ready"; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    mayCreateSession: async () => permitted });
  try {
    await runner.start();
    assert.equal(runtime.creates, 0);
    assert.equal(beginCalls, 0);
    assert.equal(reserved.state, "reserved");
    permitted = true;
    await runner.pump(); await runner.pump();
    assert.equal(runtime.creates, 1);
    assert.equal(beginCalls, 1);
  } finally { await runner.stop(); }
});

test("requested Run waits without native start or state mutation, then uses its original operation once", async () => {
  const requested = { ...run, state: "requested" as const, nativeTurnId: null };
  const runtime = new FakeRuntime();
  let permitted = false, beginCalls = 0, bindCalls = 0;
  const seenOperations: string[] = [];
  runtime.startTurn = async (_binding: RuntimeBinding, _input: string, operationId: string) => {
    runtime.starts++; seenOperations.push(operationId); return { id: "turn-managed", status: "inProgress" };
  };
  runtime.listTurns = async () => ({ data: [{ id: "turn-managed", status: "inProgress" }], nextCursor: null });
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [requested], getRuntimeSession: async () => session } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    beginDispatch: async () => { beginCalls++; },
    bindTurn: async () => { bindCalls++; return { ...requested, state: "running", nativeTurnId: "turn-managed" }; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    mayDispatchRun: async () => permitted });
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: "fixed task input", protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
  try {
    await runner.start();
    assert.equal(runtime.starts, 0);
    assert.equal(beginCalls, 0);
    assert.equal(requested.state, "requested");
    permitted = true;
    await runner.pump();
    assert.equal(runtime.starts, 1);
    assert.equal(beginCalls, 1);
    assert.equal(bindCalls, 1);
    assert.deepEqual(seenOperations, [requested.operationId]);
  } finally { await runner.stop(); }
});

test("drain mode: a requested Run is not started while held (queued untouched) and starts once released", async () => {
  const requested = { ...run, state: "requested" as const, nativeTurnId: null };
  const runtime = new FakeRuntime();
  let held = true, beginCalls = 0, bindCalls = 0;
  const seenOperations: string[] = [];
  runtime.startTurn = async (_binding: RuntimeBinding, _input: string, operationId: string) => {
    runtime.starts++; seenOperations.push(operationId); return { id: "turn-managed", status: "inProgress" };
  };
  runtime.listTurns = async () => ({ data: [{ id: "turn-managed", status: "inProgress" }], nextCursor: null });
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [requested], getRuntimeSession: async () => session } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    beginDispatch: async () => { beginCalls++; },
    bindTurn: async () => { bindCalls++; return { ...requested, state: "running", nativeTurnId: "turn-managed" }; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    mayDispatchRun: async () => !held /* the composition in main.ts: drain.holdNewStarts() */ });
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: "fixed task input", protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
  try {
    await runner.start();
    assert.equal(runtime.starts, 0);
    assert.equal(beginCalls, 0);
    assert.equal(requested.state, "requested", "queued untouched, not failed or dropped");
    held = false;
    await runner.pump();
    assert.equal(runtime.starts, 1);
    assert.equal(beginCalls, 1);
    assert.equal(bindCalls, 1);
    assert.deepEqual(seenOperations, [requested.operationId]);
  } finally { await runner.stop(); }
});

test("lost execution profile resume needs original Thread readback and a separate recovery decision", async () => {
  const oldRevisionId=randomUUID(),revisionId=randomUUID(),profileOperationId=randomUUID();
  const oldRevision={projectId,sessionId:session.id,revisionId:oldRevisionId,version:1,model:"old-model",
    sandbox:session.sandbox,approvalPolicy:session.approvalPolicy,cwd:session.cwd,
    authorizationScope:session.authorizationScope,provenance:"reserved" as const,
    previousRevisionId:null,operationId:randomUUID(),actorId,reason:"initial",evidenceRef:null,
    createdAt:new Date().toISOString()};
  const revision={...oldRevision,revisionId,version:2,model:"new-model",provenance:"revised" as const,
    previousRevisionId:oldRevisionId,operationId:profileOperationId};
  const revisedSession:RuntimeSessionRecord={...session,model:"new-model",executionProfile:{revision,
    activeRevisionId:oldRevisionId,activationState:"pending",activationOperationId:null,attemptedAt:null,
    activationEvidence:null}};
  const requested:RuntimeRunRecord={...run,id:randomUUID(),state:"requested",nativeTurnId:null,
    executionProfile:{revisionId,version:2,model:"new-model",sandbox:session.sandbox,
      approvalPolicy:session.approvalPolicy,cwd:session.cwd,authorizationScope:session.authorizationScope,
      provenance:"revised"}};
  class ProfileRuntime extends FakeRuntime {
    resumes=0;readbacks=0;confirmed=false;
    async activateExecutionProfile(_current:RuntimeBinding,target:RuntimeSessionSpec){
      this.resumes++;
      assert.equal(target.model,"new-model");
      throw new RuntimeUnknownError("thread/resume",null,"reply lost");
    }
    async inspectExecutionProfileActivation(current:RuntimeBinding,target:RuntimeSessionSpec){
      this.readbacks++;
      assert.equal(current.nativeThreadId,session.nativeThreadId);
      return this.confirmed?{...current,resumeProfile:{...current.resumeProfile!,model:target.model!,
        executionProfileRevisionId:revisionId}}:null;
    }
  }
  const runtime=new ProfileRuntime();let permits=0,dispatches=0,resumeGranted=false;
  runtime.startTurn=async (_binding:RuntimeBinding,_input:string,_operation:string,profile?:typeof requested.executionProfile)=>{
    assert.equal(profile?.revisionId,revisionId);runtime.starts++;return{id:"recovered-turn",status:"inProgress"};
  };
  runtime.listTurns=async()=>({data:[{id:"recovered-turn",status:"inProgress"}],nextCursor:null});
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[revisedSession],
    listRuntimeRuns:async()=>[requested],getRuntimeSession:async()=>revisedSession} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),
    getExecutionProfileRevision:async()=>oldRevision,
    beginExecutionProfileActivation:async()=>{permits++;return permits===1;},
    settleExecutionProfileActivation:async (_p:string,_s:string,_r:string,state:string)=>{
      revisedSession.executionProfile!.activationState=state as "unknown"|"active";
      if(state==="active")revisedSession.executionProfile!.activeRevisionId=revisionId;
      if(state==="unknown")resumeGranted=false;
    },
    canStartRecoveredRun:async()=>resumeGranted,
    beginDispatch:async()=>{dispatches++;},
    bindTurn:async()=>{requested.state="running";requested.nativeTurnId="recovered-turn";return requested;},
  } as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort&ProfileRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true,mayDispatchRun:async()=>true});
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: "same fixed Task input", protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 21 });
  try{
    await runner.start();
    assert.equal(runtime.resumes,0,"a blocked gate cannot activate a pending profile");
    assert.equal(permits,0);assert.equal(runtime.starts,0);assert.equal(dispatches,0);
    resumeGranted=true;
    await runner.pump();
    assert.equal(runtime.resumes,1);assert.equal(runtime.starts,0);assert.equal(dispatches,0);
    await runner.pump();
    assert.equal(runtime.resumes,1);assert.equal(runtime.readbacks,1);assert.equal(runtime.starts,0);
    runtime.confirmed=true;
    await runner.pump();
    assert.equal(runtime.resumes,1);assert.equal(runtime.readbacks,2);
    assert.equal(runtime.starts,0);assert.equal(dispatches,0,"readback is not a recovery decision");
    resumeGranted=true;
    await runner.pump();
    assert.equal(runtime.starts,1);assert.equal(dispatches,1);
    assert.equal(revisedSession.executionProfile?.activeRevisionId,revisionId);
  }finally{await runner.stop();}
});

for(const rejection of ["native rejection","zero-Turn guard","unclassified protocol error"] as const)
test(`profile activation ${rejection} never dispatches or replays the fixed requested Run`, async () => {
  const oldRevisionId=randomUUID(),revisionId=randomUUID(),profileOperationId=randomUUID();
  const oldRevision={projectId,sessionId:session.id,revisionId:oldRevisionId,version:1,model:"old-model",
    sandbox:session.sandbox,approvalPolicy:session.approvalPolicy,cwd:session.cwd,
    authorizationScope:session.authorizationScope,provenance:"reserved" as const,
    previousRevisionId:null,operationId:randomUUID(),actorId,reason:"initial",evidenceRef:null,
    createdAt:new Date().toISOString()};
  const revisedSession:RuntimeSessionRecord={...session,model:"new-model",executionProfile:{
    revision:{...oldRevision,revisionId,version:2,model:"new-model",provenance:"revised",
      previousRevisionId:oldRevisionId,operationId:profileOperationId},
    activeRevisionId:oldRevisionId,activationState:"pending",activationOperationId:null,
    attemptedAt:null,activationEvidence:null}};
  const fixed={revisionId,version:2,model:"new-model",sandbox:session.sandbox,
    approvalPolicy:session.approvalPolicy,cwd:session.cwd,authorizationScope:session.authorizationScope,
    provenance:"revised" as const};
  const requested:RuntimeRunRecord={...run,id:randomUUID(),state:"requested",nativeTurnId:null,
    executionProfile:fixed};
  class RejectedProfileRuntime extends FakeRuntime {
    resumes=0;readbacks=0;
    async activateExecutionProfile(){this.resumes++;
      if(rejection==="zero-Turn guard")throw new RuntimeProtocolError("EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED: zero-turn Thread has no rollout");
      if(rejection==="unclassified protocol error")throw new RuntimeProtocolError("unexpected reply after activation");
      throw new RuntimeServerError("thread/resume",7,-32602,"profile denied");}
    async inspectExecutionProfileActivation(){this.readbacks++;return null;}
  }
  const runtime=new RejectedProfileRuntime();let permits=0,dispatches=0,rejections=0;
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[revisedSession],
    listRuntimeRuns:async()=>[requested],getRuntimeSession:async()=>revisedSession} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),
    getExecutionProfileRevision:async()=>oldRevision,
    beginExecutionProfileActivation:async()=>{permits++;return true;},
    settleExecutionProfileActivation:async (_p:string,_s:string,_r:string,state:string)=>{
      revisedSession.executionProfile!.activationState=state as "rejected"|"unknown";
    },
    rejectDispatch:async (_p:string,id:string)=>{assert.equal(id,requested.id);rejections++;requested.state="failed";},
    beginDispatch:async()=>{dispatches++;},
  } as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort&RejectedProfileRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true,mayDispatchRun:async()=>true});
  try{
    await runner.start();
    assert.equal(permits,1);assert.equal(runtime.resumes,1);assert.equal(runtime.readbacks,0);
    const uncertain=rejection==="unclassified protocol error";
    assert.equal(runtime.starts,0);assert.equal(dispatches,0);assert.equal(rejections,uncertain?0:1);
    assert.equal(revisedSession.executionProfile!.activationState,uncertain?"unknown":"rejected");
    assert.equal(requested.state,uncertain?"requested":"failed");assert.deepEqual(requested.executionProfile,fixed);
    assert.equal(revisedSession.executionProfile?.activeRevisionId,oldRevisionId);
    await runner.pump();
    assert.equal(runtime.resumes,1);assert.equal(runtime.starts,0);assert.equal(rejections,uncertain?0:1);
  }finally{await runner.stop();}
});

test("late admission denial after preflight leaves the requested Run untouched", async () => {
  const requested = { ...run, state: "requested" as const, nativeTurnId: null };
  const runtime = new FakeRuntime();
  let checks = 0, beginCalls = 0;
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [requested], getRuntimeSession: async () => session } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    beginDispatch: async () => { beginCalls++; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    mayDispatchRun: async () => ++checks % 2 === 1 });
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: "fixed input", protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 11 });
  try {
    await runner.start();
    assert.equal(checks, 2);
    assert.equal(beginCalls, 0);
    assert.equal(runtime.starts, 0);
    assert.equal(requested.state, "requested");
  } finally { await runner.stop(); }
});

test("transport disconnect closes admission; explicit recovery reconciles unknown run without replay", async () => {
  const instances: FakeRuntime[] = [];
  let recoveries = 0;
  const workflow = {
    getProject: async () => ({ id: projectId }),
    listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [run],
    getRuntimeSession: async () => session,
  } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => { recoveries++; return { sessions: [], runs: [] }; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({
    runtimeFactory: () => { const value = new FakeRuntime(); instances.push(value); return value as unknown as RuntimePort & FakeRuntime; },
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
  });
  try {
    await runner.start();
    assert.equal(runner.status().available, true);
    instances[0]!.disconnect("child exited");
    assert.equal(runner.status().available, false);
    await runner.recover();
    assert.equal(runner.status().available, true);
    assert.equal(instances.length, 2);
    assert.equal(recoveries, 2);
    assert.equal(instances.reduce((total, item) => total + item.starts, 0), 0);
  } finally { await runner.stop(); }
});

test("with several runtimes, recovery replaces only the one that lost its connection", async () => {
  const codex = new FakeRuntime(), claude = new FakeRuntime();
  const built: Array<{ provider: RuntimeProvider; runtime: FakeRuntime }> = [];
  const recovered: RuntimeProvider[][] = [];
  let claudeCloses = 0;
  const originalClose = claude.close.bind(claude);
  claude.close = async () => { claudeCloses++; await originalClose(); };
  const routed = new ProviderRoutedRuntime(new Map<RuntimeProvider, ManagedRuntime>([
    ["codex", codex as unknown as ManagedRuntime], ["claude", claude as unknown as ManagedRuntime]]), "codex", provider => {
    const runtime = new FakeRuntime(); built.push({ provider, runtime }); return runtime as unknown as ManagedRuntime;
  });
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [], listRuntimeRuns: async () => [] } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async (_projectId: string, providers: RuntimeProvider[]) => {
    recovered.push([...providers]); return { sessions: [], runs: [] }; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => routed, workflow, trusted,
    principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    assert.deepEqual(recovered, [["codex", "claude"]]);
    codex.disconnect("child exited");
    assert.equal(runner.status().available, false, "losing Codex pauses the whole runner");
    await runner.recover();
    assert.equal(runner.status().available, true);
    assert.deepEqual(built.map(entry => entry.provider), ["codex"], "only Codex is rebuilt");
    assert.equal(claudeCloses, 0, "Claude, and the Turns its processes run, are not closed");
    assert.equal(claude.isReady(), true);
    assert.deepEqual(recovered.at(-1), ["codex"], "only the replaced runtime's dispatches are reconciled");
    // The runner's disconnect listener moved to the new Codex instance.
    built[0]!.runtime.disconnect("second loss");
    assert.equal(runner.status().available, false);
    await runner.recover();
    assert.deepEqual(built.map(entry => entry.provider), ["codex", "codex"]);
    assert.equal(claudeCloses, 0);
  } finally { await runner.stop(); }
});

test("workspace listeners follow the owned adapter across explicit recovery",async()=>{
  class WorkspaceRuntime extends FakeRuntime {
    workspaceListeners=new Set<(event:WorkspaceRuntimeUpdate)=>void>();
    onWorkspaceUpdate(listener:(event:WorkspaceRuntimeUpdate)=>void){this.workspaceListeners.add(listener);
      return()=>this.workspaceListeners.delete(listener)}
    emitWorkspace(event:WorkspaceRuntimeUpdate){for(const listener of this.workspaceListeners)listener(event)}
  }
  const instances:WorkspaceRuntime[]=[];
  const principal:Principal={actorId,projectIds:[projectId],permissions:['read','write','review']};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[],listRuntimeRuns:async()=>[],
    getRuntimeSession:async()=>session} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]})} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>{const runtime=new WorkspaceRuntime();instances.push(runtime);
    return runtime as unknown as RuntimePort&WorkspaceRuntime},workflow,trusted,principals:[principal],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  const uow={read:async(_project:string,fn:(reader:unknown)=>Promise<unknown>)=>fn({
    getRuntimeSession:async()=>session,nativeInputs:{findSources:async()=>new Map()}})} as unknown as UnitOfWork;
  const observation={snapshot:async()=>({session:{key:`owned:${session.id}`,
    target:{kind:'owned',sessionId:session.id},title:'Fixture Session'}})} as unknown as SessionObservationService;
  const timeline=new SessionTimelineService({uow,observation,runner});
  const seen:string[]=[];const unsubscribe=runner.onWorkspaceUpdate(event=>seen.push(event.turnId??''));
  const reasons:string[]=[];const unsubscribeDisconnect=runner.onWorkspaceDisconnect(reason=>reasons.push(reason));
  const event=(turnId:string):WorkspaceRuntimeUpdate=>({projectId,sessionId:session.id,
    threadId:session.nativeThreadId!,turnId,observedAt:new Date().toISOString(),kind:'turn',
    turn:{id:turnId,state:'running',startedAt:null,completedAt:null,origin:null}});
  const read=()=>timeline.updates(principal,projectId,`owned:${session.id}`);
  try{
    await runner.start();
    const first=instances[0]!;first.emitWorkspace(event('turn-a'));
    const live=await read();assert.equal(live.freshness,'live');assert.deepEqual(seen,['turn-a']);
    first.disconnect('child exited');
    assert.deepEqual(reasons,['child exited']);
    await runner.recover();
    assert.equal(reasons.length,2,'replacement resets the existing timeline subscription');
    const second=instances[1]!;
    const cold=await timeline.updates(principal,projectId,`owned:${session.id}`,live.cursor);
    assert.notEqual(cold.freshness,'live');assert.equal(cold.resetRequired,true);
    first.emitWorkspace(event('late-a'));assert.deepEqual(seen,['turn-a']);
    second.emitWorkspace(event('turn-b'));
    assert.deepEqual(seen,['turn-a','turn-b']);
    const resumed=await read();assert.equal(resumed.freshness,'live');
    assert.ok(resumed.turns.some(turn=>turn.id==='turn-b'));
    unsubscribe();second.emitWorkspace(event('turn-c'));
    assert.deepEqual(seen,['turn-a','turn-b']);
    assert.ok((await read()).turns.some(turn=>turn.id==='turn-c'));
    second.emitWorkspace({projectId,sessionId:session.id,threadId:session.nativeThreadId!,turnId:'turn-c',
      observedAt:new Date().toISOString(),kind:'entry',entry:{id:'owned-failed-tool',kind:'tool',turnId:'turn-c',
        nativeItemId:'owned-item',nativeKind:'commandExecution',author:{kind:'native',id:null,label:'Tool'},origin:null,
        occurredAt:null,observedAt:new Date().toISOString(),freshness:'live',truncated:false,name:'Command',summary:'Read file',
        state:'failed',durationMs:5,exitCode:1,detailAvailable:true,detailReason:null,
        detail:{input:'private-owned-input',output:'private-owned-output',error:null,resources:[]}}});
    const projected=await read(),ownedTool=projected.entries.find(entry=>entry.nativeItemId==='owned-item');
    assert.equal(ownedTool?.kind==='tool'&&ownedTool.detailAvailable,true,
      'the real Runner listener path preserves availability for a reviewer after live dispatch');
    assert.doesNotMatch(JSON.stringify(projected),/private-owned-input|private-owned-output/);
    const restricted=await timeline.updates({...principal,permissions:['read']},projectId,`owned:${session.id}`);
    assert.equal(restricted.entries.some(entry=>entry.kind==='tool'&&entry.detailAvailable),false);
    const reread=await read();
    assert.equal(reread.entries.some(entry=>entry.kind==='tool'&&entry.detailAvailable),true,
      'a restricted reader does not alter the owner buffer for the next authorized reader');
    unsubscribeDisconnect();second.disconnect('second child exited');
    assert.equal(reasons.length,2,'unsubscribed disconnect listener receives no later child event');
    assert.equal(instances.reduce((total,runtime)=>total+runtime.starts,0),0);
  }finally{unsubscribe();unsubscribeDisconnect();timeline.close();await runner.stop()}
});

test("creating-session approval receipt labels native identity unverified", async () => {
  const creating = { ...session, state: "creating" as const, nativeThreadId: null, nativeSessionId: null };
  const receipts: string[] = [];
  let receiptUnavailable = true;
  let runtime!: FakeRuntime;
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [creating],
    listRuntimeRuns: async () => [], getRuntimeSession: async () => creating } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    recordSessionApprovalDeclined: async (_projectId: string, _sessionId: string, _threadId: string,
      _turnId: string | null, detail: string) => {
        if (receiptUnavailable) throw new Error("secret=approval-receipt");
        receipts.push(detail);
      } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => (runtime = new FakeRuntime()) as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    await assert.rejects(() => runtime.emitApproval({ id: 800, method: "item/commandExecution/requestApproval", params: {},
      threadId: "unverified-thread", projectId, sessionId: session.id }), /Approval evidence unavailable/);
    assert.deepEqual(runner.status(projectId).faults.map(fault => [fault.sessionId,fault.phase]),
      [[session.id,"approval_receipt"]]);
    assert.doesNotMatch(JSON.stringify(runner.status(projectId)), /secret=approval-receipt/);
    receiptUnavailable = false;
    await runner.recover();
    assert.equal(receipts.length, 1);
    assert.match(receipts[0]!, /unbound request observed during create; native identity not yet verified/);
    assert.deepEqual(runner.status(projectId).faults, []);
  } finally { await runner.stop(); }
});

test("handoff reads terminal answers while preserving phase-unknown legacy output", async()=>{
  const {finalMessages}=await import("../src/runtime/runner.js");
  assert.deepEqual(finalMessages([{type:"agentMessage",phase:"commentary",text:"I will investigate"},{type:"agentMessage",phase:"final_answer",text:"Observed actual failure"}]),["Observed actual failure"]);
  assert.deepEqual(finalMessages([{type:"agentMessage",text:"Legacy final"}]),["Legacy final"]);
  // Reasoning and thinking Items never become the answer that results and notices carry.
  assert.deepEqual(finalMessages([{type:"reasoning",summary:["private plan"],content:["raw chain"]},{type:"reasoning",source:"thinking",text:"Claude thought"},
    {type:"agentMessage",phase:"final_answer",text:"Answer"}]),["Answer"]);
  assert.deepEqual(finalMessages([{type:"reasoning",text:"only thinking"}]),[]);
  assert.deepEqual(finalMessages([{type:"agentMessage",phase:"commentary",text:"No final yet"}]),[]);
});

test("transient interrupted history without completion time cannot settle a bound run", async () => {
  const active = { ...run, state: "running" as const, nativeTurnId: "turn-1" };
  const recorded: string[] = [];
  const runtime = new FakeRuntime();
  let reads = 0;
  runtime.listTurns = async () => ({ data: [{ id: "turn-1", status: ++reads === 1 ? "interrupted" : "completed",
    completedAtUtc: reads === 1 ? null : "2026-10-20T12:14:44.000Z" }], nextCursor: null });
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [active], getRuntimeSession: async () => session } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    recordTurn: async (_projectId: string, _runId: string, _turnId: string, status: string) => { recorded.push(status); return active; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    mayDispatchRun: async () => false });
  runtime.listItems = async () =>
    ({ data: [{ id: "message-1", type: "agentMessage", phase: "final_answer", text: "Done" }], nextCursor: null });
  try {
    await runner.start();
    assert.equal(reads, 1);
    assert.deepEqual(recorded, []);
    await runner.pump();
    assert.deepEqual(recorded, ["completed"]);
    assert.equal(runtime.starts, 0);
  } finally { await runner.stop(); }
});

test("restart dispatches a reserved Run with the original Session profile and never replays it", async () => {
  const persisted = { ...session, model: "gpt-6-astra", sandbox: "workspace-write" as const };
  const active: RuntimeRunRecord = { ...run, state: "requested", nativeTurnId: null };
  const runtime = new FakeRuntime();
  const profiles: unknown[] = [];
  runtime.resume = async (binding, profile) => { profiles.push(profile); return binding; };
  runtime.startTurn = async () => { runtime.starts++; return { id: "owned-turn", status: "inProgress" }; };
  runtime.listTurns = async () => ({ data: [{ id: "owned-turn", status: "inProgress", completedAtUtc: null }], nextCursor: null });
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [persisted],
    listRuntimeRuns: async () => [active], getRuntimeSession: async () => persisted } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }), beginDispatch: async () => {},
    bindTurn: async () => { active.state = "running"; active.nativeTurnId = "owned-turn"; return active; } } as unknown as RuntimeWorkflowService;
  let granted = true;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true,
    hasGrant: (scope) => granted && scope.actorId === actorId && scope.roleId === persisted.roleId &&
      scope.authorizationScope === persisted.authorizationScope && scope.cwd === persisted.cwd &&
      scope.sandbox === persisted.sandbox && scope.model === persisted.model &&
      scope.approvalPolicy === persisted.approvalPolicy,
    mayDispatchRun: async () => granted });
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: "fixed task input", protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
  try {
    await runner.start();
    assert.deepEqual(profiles, [{ actorId, sessionId: persisted.id, roleId: persisted.roleId,
      projectId, provider: "codex", cwd: persisted.cwd, authorizationScope: persisted.authorizationScope,
      sandbox: persisted.sandbox, approvalPolicy: persisted.approvalPolicy, model: persisted.model }]);
    assert.equal(runtime.starts, 1);
    granted = false;
    await runner.recover();
    assert.equal(profiles.length, 1, "revocation cannot open another writer");
    assert.equal(runtime.starts, 1);
  } finally { await runner.stop(); }
});

test("registered full Session keeps the same execution profile across conversations and Task Turns",async()=>{
  const persisted={...session,sandbox:'danger-full-access' as const,approvalPolicy:'never' as const};
  const first:RuntimeRunRecord={...run,id:randomUUID(),state:'requested',nativeTurnId:null};
  const runs=[first];
  let resumes=0,unknown=0,canStart=true;
  const runtime=new FakeRuntime();
  runtime.resume=async(binding,profile)=>{
    assert.equal(profile.sandbox,persisted.sandbox);
    assert.equal(profile.approvalPolicy,persisted.approvalPolicy);
    resumes++;return binding;
  };
  runtime.startTurn=async()=>{
    return{id:`task-turn-${++runtime.starts}`,status:'inProgress'};
  };
  runtime.listTurns=async()=>({data:runs.filter(r=>r.nativeTurnId).map(r=>
    ({id:r.nativeTurnId!,status:'inProgress',completedAtUtc:null})),nextCursor:null});
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[persisted],
    listRuntimeRuns:async()=>runs,getRuntimeSession:async()=>persisted} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),beginDispatch:async()=>{},
    canStartRecoveredRun:async()=>canStart,
    bindTurn:async(_p:string,id:string,turn:RuntimeTurn)=>{
      const item=runs.find(r=>r.id===id)!;item.state='running';item.nativeTurnId=turn.id;return item;
    },markRunUnknown:async()=>{unknown++;}} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort & typeof runtime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: 'fixed Task input', protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
  try{
    await runner.start();
    assert.equal(runtime.starts,1);assert.equal(resumes,1);
    first.state='completed';
    // A completed conversation keeps the same full Session profile and registration.
    const next:RuntimeRunRecord={...run,id:randomUUID(),operationId:randomUUID(),state:'requested',nativeTurnId:null};
    runs.push(next);
    canStart=false;
    await runner.pump();
    assert.equal(runtime.starts,1);assert.equal(resumes,1,
      'blocked Task must not start another Turn');
    canStart=true;
    await runner.pump();
    assert.equal(runtime.starts,2);
    assert.equal(resumes,1,'a conversation does not create a permission restore cycle');
    assert.equal(next.state,'running');
    assert.equal(unknown,0,'normal profile reuse does not invent an unknown result');
  }finally{await runner.stop();}
});

test("two runners with a positive gate hint restore and start only after the single durable dispatch winner",async()=>{
  const requested:RuntimeRunRecord={...run,id:randomUUID(),state:'requested',nativeTurnId:null};
  const events:string[]=[];let arrivals=0,claimed=false,resumes=0,starts=0;
  let release!:()=>void;
  const bothAtPermit=new Promise<void>(resolve=>{release=resolve;});
  const makeRuntime=()=>{
    const native=new FakeRuntime();
    native.resume=async binding=>{events.push('resume');resumes++;return binding;};
    native.startTurn=async()=>{events.push('turn');starts++;return{id:'one-turn',status:'inProgress'};};
    native.listTurns=async()=>({data:[{id:'one-turn',status:'inProgress',completedAtUtc:null}],nextCursor:null});
    return native;
  };
  const workflow={getRuntimeSession:async()=>session} as unknown as WorkflowService;
  const trusted={canStartRecoveredRun:async()=>true,
    beginDispatch:async()=>{
      arrivals++;if(arrivals===2)release();await bothAtPermit;
      if(claimed)throw new DomainError('RUN_NOT_REQUESTED','other runner already owns dispatch');
      claimed=true;events.push('permit');
    },
    bindTurn:async()=>({...requested,state:'running' as const,nativeTurnId:'one-turn'}),
  } as unknown as RuntimeWorkflowService;
  const principal={actorId,projectIds:[projectId],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
  const runners=[makeRuntime(),makeRuntime()].map(native=>{
    const value=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort&FakeRuntime,
      workflow,trusted,principals:[principal],canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
    (value as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: 'fixed Task input', protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
    return value;
  });
  const process=(value:RuntimeRunner)=>
    (value as unknown as {process:(p:Principal,r:RuntimeRunRecord)=>Promise<boolean>}).process(principal,requested);
  const outcomes=await Promise.allSettled(runners.map(process));
  assert.equal(outcomes.filter(result=>result.status==='rejected').length,1);
  assert.equal(arrivals,2);assert.equal(resumes,1);assert.equal(starts,1);
  assert.deepEqual(events,['permit','resume','turn']);
});

test("lost business-profile restore acknowledgement makes the Run unknown without Turn or resume replay",async()=>{
  const revisionId=randomUUID(),originalSnapshot={revisionId,version:1,model:'old-model',
    sandbox:session.sandbox,approvalPolicy:session.approvalPolicy,cwd:session.cwd,
    authorizationScope:session.authorizationScope,provenance:'reserved' as const};
  const activeSession:RuntimeSessionRecord={...session,model:'old-model',executionProfile:{
    revision:{projectId,sessionId:session.id,revisionId,version:1,model:'old-model',
      sandbox:session.sandbox,approvalPolicy:session.approvalPolicy,cwd:session.cwd,
      authorizationScope:session.authorizationScope,provenance:'reserved',previousRevisionId:null,
      operationId:randomUUID(),actorId,reason:'fixed',evidenceRef:null,createdAt:new Date().toISOString()},
    activeRevisionId:revisionId,activationState:'active',activationOperationId:null,
    attemptedAt:null,activationEvidence:null}};
  const requested:RuntimeRunRecord={...run,id:randomUUID(),state:'requested',nativeTurnId:null,
    executionProfile:originalSnapshot};
  const originalOperation=requested.operationId;
  const native=new FakeRuntime();let resumes=0,permits=0,unknowns=0,unknownReason='';
  native.resume=async()=>{resumes++;throw new RuntimeUnknownError('thread/resume',null,'reply lost');};
  native.startTurn=async()=>{native.starts++;throw new Error('Turn must not start after lost resume');};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[activeSession],
    listRuntimeRuns:async()=>[requested],getRuntimeSession:async()=>activeSession} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),canStartRecoveredRun:async()=>true,
    beginDispatch:async()=>{permits++;},markRunUnknown:async(_p:string,_id:string,reason:string)=>{
      unknowns++;unknownReason=reason;requested.state='unknown';},
  } as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort&FakeRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: 'fixed Task input', protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
  try{
    await runner.start();
    assert.equal(permits,1);assert.equal(resumes,1);assert.equal(unknowns,1);assert.equal(native.starts,0);
    await runner.pump();
    assert.equal(permits,1);assert.equal(resumes,1);assert.equal(native.starts,0);
    assert.equal(requested.operationId,originalOperation);
    assert.deepEqual(requested.executionProfile,originalSnapshot);
    assert.match(unknownReason,/Business profile restoration/);
    assert.match(unknownReason,/did not call Task turn\/start/);
    assert.match(unknownReason,/native_outcome_unknown; method=thread\/resume/);
    assert.equal(runner.status(projectId).faults[0]?.phase,'business_profile_restore');
    assert.equal(runner.status(projectId).faults[0]?.nativeMethod,'thread/resume');
  }finally{await runner.stop();}
});

for (const failure of ['resume_rejected','turn_start_unknown','binding_failed'] as const) {
  test(`dispatch diagnostics distinguish ${failure} without replaying its original operation`,async()=>{
    const requested:RuntimeRunRecord={...run,id:randomUUID(),operationId:randomUUID(),state:'requested',nativeTurnId:null};
    const originalInput=requested.input,originalHash=requested.inputHash,originalOperation=requested.operationId;
    const runtime=new FakeRuntime();let resumes=0,permits=0,rejections=0,unknowns=0,unknownReason='';
    const nativePrivateDetail='private native path and task text must not be persisted';
    runtime.resume=async binding=>{
      resumes++;
      if(failure==='resume_rejected')throw new RuntimeServerError('thread/resume',7,-32602,nativePrivateDetail);
      return binding;
    };
    runtime.startTurn=async()=>{
      runtime.starts++;
      if(failure==='turn_start_unknown')throw new RuntimeUnknownError('turn/start',8,nativePrivateDetail);
      return{id:'task-turn-replied',status:'inProgress'};
    };
    const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[session],
      listRuntimeRuns:async()=>[requested],getRuntimeSession:async()=>session} as unknown as WorkflowService;
    const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),canStartRecoveredRun:async()=>true,
      beginDispatch:async()=>{permits++;requested.state='dispatching';},
      rejectDispatch:async(_p:string,id:string,_reason:string,proof:unknown)=>{
        assert.equal(id,requested.id);
        assert.deepEqual(proof,{kind:'native_resume_rejected',operationId:originalOperation,code:-32602,category:'invalid_params'});
        rejections++;requested.state='failed';
      },
      bindTurn:async()=>{throw new Error('binding persistence unavailable');},
      markRunUnknown:async(_p:string,id:string,reason:string)=>{
        assert.equal(id,requested.id);unknowns++;unknownReason=reason;requested.state='unknown';
      },
    } as unknown as RuntimeWorkflowService;
    const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort&FakeRuntime,
      workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
      canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
    (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: 'fixed Task input', protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
    try{
      await runner.start();
      const fault=runner.status(projectId).faults[0]!;
      assert.equal(permits,1);assert.equal(resumes,1);
      if(failure==='resume_rejected'){
        assert.equal(requested.state,'failed');assert.equal(runtime.starts,0);
        assert.equal(rejections,1);assert.equal(unknowns,0);
        assert.equal(fault.phase,'business_profile_restore');assert.equal(fault.category,'native_rejected');
        assert.equal(fault.nativeMethod,'thread/resume');assert.equal(fault.nativeCode,-32602);
        assert.equal(fault.nativeCategory,'invalid_params');
      }else{
        assert.equal(requested.state,'unknown');assert.equal(runtime.starts,1);
        assert.equal(rejections,0);assert.equal(unknowns,1);
        assert.equal(fault.phase,failure==='turn_start_unknown'?'run_start':'run_bind');
        assert.match(unknownReason,failure==='turn_start_unknown'?/Task turn\/start outcome was not confirmed/:/returned a Turn but its binding receipt was not saved/);
      }
      assert.doesNotMatch(JSON.stringify({fault,unknownReason}),new RegExp(nativePrivateDetail));
      await runner.pump();
      assert.equal(permits,1);assert.equal(resumes,1);
      assert.equal(runtime.starts,failure==='resume_rejected'?0:1);
      assert.equal(requested.operationId,originalOperation);
      assert.equal(requested.input,originalInput);assert.equal(requested.inputHash,originalHash);
    }finally{await runner.stop();}
  });
}

test('a competing native writer does not turn a reserved Task Run into a business failure',async()=>{
  const requested:RuntimeRunRecord={...run,id:randomUUID(),operationId:randomUUID(),state:'requested',nativeTurnId:null};
  const writerThreadId=randomUUID(),ownedSession={...session,nativeThreadId:writerThreadId};
  const native=new FakeRuntime();let resumes=0,permits=0,rejections=0,unknowns=0,reason='';
  native.resume=async()=>{resumes++;throw new RuntimeServerError('thread/resume',7,-32600,
    `thread ${writerThreadId} already has an active writer`,writerThreadId);};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[ownedSession],
    listRuntimeRuns:async()=>[requested],getRuntimeSession:async()=>ownedSession} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),canStartRecoveredRun:async()=>true,
    beginDispatch:async()=>{permits++;requested.state='dispatching';},
    rejectDispatch:async()=>{rejections++;requested.state='failed';},
    markRunUnknown:async(_p:string,_id:string,value:string)=>{unknowns++;reason=value;requested.state='unknown';}
  } as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort&FakeRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: 'fixed Task input', protocol: 'evoloop-lightweight-v1', contentHash: 'a'.repeat(64), byteLength: 16 });
  try{
    await runner.start();
    assert.deepEqual([permits,resumes,native.starts,rejections,unknowns],[1,1,0,0,1]);
    assert.match(reason,/writer/i);
    await runner.pump();
    assert.deepEqual([permits,resumes,native.starts,rejections,unknowns],[1,1,0,0,1]);
    assert.equal(requested.state,'unknown');
  }finally{await runner.stop();}
});

test('a reviewed pre-turn Run continues its original operation once, while unknown without proof stays read-only',async()=>{
  const original:RuntimeRunRecord={...run,id:randomUUID(),state:'unknown',nativeTurnId:null,
    preTurnProof:{threadId:session.nativeThreadId!,operationId:run.operationId,requestId:7,code:-32600,
      inputHash:'a'.repeat(64),observedAtUtc:new Date().toISOString(),status:'approved',
      decisionOperationId:randomUUID(),reviewerActorId:'reviewer',evidenceRef:'handoff:1'}};
  let saved=original,claims=0,starts=0,resumes=0;
  const native=new FakeRuntime();native.ready=true;
  native.resume=async binding=>{resumes++;return binding;};
  native.startTurn=async(_binding,_input,operationId)=>{assert.equal(operationId,original.operationId);starts++;return{id:'one-turn',status:'inProgress',completedAtUtc:null};};
  native.listTurns=async()=>({data:[{id:'one-turn',status:'inProgress',completedAtUtc:null}],nextCursor:null});
  const workflow={getRuntimeSession:async()=>session} as unknown as WorkflowService;
  const trusted={claimPreTurnContinuation:async()=>{claims++;saved={...saved,preTurnProof:{...saved.preTurnProof!,status:'attempting'}};return saved;},
    bindTurn:async()=>{saved={...saved,state:'running',nativeTurnId:'one-turn'};return saved;}} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as RuntimePort&FakeRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  (runner as unknown as {lightweightInput:()=>Promise<{input:string;protocol:string;contentHash:string;byteLength:number}>}).lightweightInput=
    async()=>({input:'fixed Task input',protocol:'evoloop-lightweight-v1',contentHash:'a'.repeat(64),byteLength:16});
  const process=(value:RuntimeRunRecord)=>(runner as unknown as {process:(p:Principal,r:RuntimeRunRecord)=>Promise<boolean>}).process(
    {actorId,projectIds:[projectId],permissions:['read','write','review']},value);
  await process(original);await process(saved);
  assert.deepEqual([claims,resumes,starts],[1,1,1]);
  const unknownWithoutProof={...original,id:randomUUID(),preTurnProof:null};
  native.listTurns=async()=>({data:[],nextCursor:null});
  await process(unknownWithoutProof);
  assert.deepEqual([claims,resumes,starts],[1,1,1]);
});

test("rehydration of a bound dynamic Session ignores a colliding static grant until current dynamic authority returns",async()=>{
  const dispatchId=randomUUID(),dynamicSession={...session,id:loopIntentId(dispatchId,"session"),
    model:"gpt-6-astra",sandbox:"workspace-write" as const};
  const requested={...run,id:loopIntentId(dispatchId,"run"),sessionId:dynamicSession.id,state:"requested" as const,nativeTurnId:null};
  const persisted={query:async()=>({rows:[{dispatch_id:dispatchId}]})} as never;
  let current=false;
  const runtime=new FakeRuntime();
  const profiles:RuntimeSessionSpec[]=[];
  runtime.resume=async (binding,profile)=>{profiles.push(profile);return binding;};
  runtime.startTurn=async()=>{runtime.starts++;return {id:"dynamic-turn",status:"inProgress"};};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[dynamicSession],
    listRuntimeRuns:async()=>[requested],getRuntimeSession:async()=>dynamicSession} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),beginDispatch:async()=>{},
    bindTurn:async()=>{requested.state="running";requested.nativeTurnId="dynamic-turn";return requested;}} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort & FakeRuntime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,
    hasGrant:(_scope,record)=>currentSessionGrant(persisted,record!,()=>true,async()=>current),
    mayDispatchRun:async()=>current});
  (runner as unknown as { lightweightInput: () => Promise<{ input: string; protocol: string; contentHash: string; byteLength: number }> }).lightweightInput = async () => ({ input: "fixed task input", protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
  try {
    await runner.start();
    assert.equal(runtime.starts,0);assert.deepEqual(profiles,[],"the matching static writer must not rehydrate a revoked dynamic Session");
    current=true;
    await runner.pump();
    assert.equal(runtime.starts,1);
    assert.deepEqual(profiles,[{actorId,sessionId:dynamicSession.id,roleId:dynamicSession.roleId,projectId,provider:"codex",
      cwd:dynamicSession.cwd,authorizationScope:dynamicSession.authorizationScope,sandbox:"workspace-write",
      approvalPolicy:dynamicSession.approvalPolicy,model:dynamicSession.model}]);
  } finally {await runner.stop();}
});

test("admission denial does not block terminal reconciliation of an unknown bound Turn", async () => {
  const uncertain = { ...run, state: "unknown" as const, nativeTurnId: "turn-known" };
  const runtime = new FakeRuntime();
  runtime.listTurns = async () => ({ data: [{ id: "turn-known", status: "completed",
    completedAtUtc: "2026-10-23T12:00:00.000Z" }], nextCursor: null });
  runtime.listItems = async () => ({ data: [{ type: "agentMessage", phase: "final_answer", text: "Finished" }], nextCursor: null });
  const recorded: string[] = [];
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [uncertain], getRuntimeSession: async () => session } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    recordTurn: async (_projectId: string, _runId: string, _turnId: string, status: string) => { recorded.push(status); return uncertain; } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true,
    mayDispatchRun: async () => false });
  try {
    await runner.start();
    assert.deepEqual(recorded, ["completed"]);
    assert.equal(runtime.starts, 0);
  } finally { await runner.stop(); }
});

test("explicit reviewer readback corrects only a settled owned turn without replay", async () => {
  const observed = { ...run, state: "interrupted" as const, nativeTurnId: "turn-1", version: 4 };
  const runtime = new FakeRuntime();
  let settled = false;
  let oldTurn = false;
  runtime.listTurns = async (_binding, cursor) => oldTurn && cursor !== "old-page" ?
    { data: [], nextCursor: cursor ? "old-page" : "middle-page" } :
    { data: [{ id: "turn-1", status: settled ? "completed" : "interrupted",
      completedAtUtc: settled ? "2026-10-20T12:14:44.000Z" : null }], nextCursor: null };
  runtime.listItems = async () => ({ data: [{ id: "message-1", type: "agentMessage", phase: "final_answer", text: "Finished" }], nextCursor: null });
  const calls: unknown[][] = [];
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [observed], getRuntimeSession: async () => session,
    getRuntimeRun: async () => observed } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    reconcileTerminalObservation: async (...args: unknown[]) => { calls.push(args); return { ...observed, state: "completed", version: 5 }; } } as unknown as RuntimeWorkflowService;
  const reviewer = { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as const };
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    await assert.rejects(() => runner.reconcile({ actorId: "outsider", projectIds: [projectId], permissions: ["read", "review"] }, projectId, observed.id, 4, "review"), /authority/);
    await assert.rejects(() => runner.reconcile({ ...reviewer, permissions: [...reviewer.permissions] }, projectId, observed.id, 4, "review"), /no settled terminal/);
    assert.equal(calls.length, 0);
    oldTurn = true;
    const partial = await runner.reconcile({ ...reviewer, permissions: [...reviewer.permissions] }, projectId, observed.id, 4, "review");
    assert.deepEqual(partial, { status: "partial", changed: false, projectId, runId: observed.id,
      nativeTurnId: "turn-1", expectedVersion: 4, nextTurnCursor: "old-page", reason: "review" });
    assert.equal(calls.length, 0, "partial readback never invokes the trusted write");
    settled = true;
    const result = await runner.reconcile({ ...reviewer, permissions: [...reviewer.permissions] }, projectId, observed.id, 4, "Native readback after transient projection", "old-page");
    assert.ok("state" in result);
    assert.equal(result.state, "completed");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[2], "turn-1");
    assert.equal(calls[0]?.[3], "completed");
    const expectedItems = [{ id: "message-1", type: "agentMessage", phase: "final_answer", text: "Finished" }];
    assert.deepEqual(calls[0]?.[5], { itemsDigest: createHash("sha256").update(JSON.stringify(expectedItems)).digest("hex"),
      completedAtUtc: "2026-10-20T12:14:44.000Z" });
    assert.equal(runtime.starts, 0);
  } finally { await runner.stop(); }
});

test("read-only history and result page owned data without native resume or turn replay", async () => {
  const observed = { ...run, state: "completed" as const, nativeTurnId: "turn-1" };
  const runtime = new FakeRuntime();
  let resumes = 0, registrations = 0, inspections = 0, turnPages = 0, itemPages = 0;
  runtime.resume = async () => { resumes++; throw new Error("native resume unavailable"); };
  runtime.registerBinding = async () => { registrations++; };
  runtime.inspect = async () => { inspections++; return { thread: { id: session.nativeThreadId, sessionId: session.nativeSessionId, cwd: session.cwd } }; };
  runtime.listTurns = async (_binding: RuntimeBinding, cursor?: string) => {
    turnPages++;
    return cursor ? { data: [{ id: "turn-1", status: "completed" }], nextCursor: null } :
      { data: [{ id: "turn-2", status: "completed" }], nextCursor: "turn-page-2" };
  };
  runtime.listItems = async (_binding: RuntimeBinding, turnId: string, cursor?: string) => {
    itemPages++;
    if (turnId === "turn-2") return { data: [], nextCursor: null };
    return cursor ? { data: [{ id: "final", type: "agentMessage", phase: "final_answer", text: "Owned final" }], nextCursor: null } :
      { data: [{ id: "commentary", type: "agentMessage", phase: "commentary", text: "Working" }], nextCursor: "item-page-2" };
  };
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [observed], getRuntimeSession: async () => session,
    getRuntimeRun: async () => observed } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }) } as unknown as RuntimeWorkflowService;
  const reviewer = { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as ("read" | "write" | "review")[] };
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [reviewer], canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    const history = await runner.history(reviewer, projectId, session.id);
    const result = await runner.result(reviewer, projectId, observed.id);
    assert.equal(history.turns.length, 2);
    assert.deepEqual(result.messages, ["Owned final"]);
    assert.equal(result.finalPhaseConfirmed, true);
    assert.equal(result.source, "owned-native-history");
    assert.equal(resumes, 0); assert.equal(runtime.starts, 0);
    assert.equal(registrations, 2); assert.equal(inspections, 2);
    assert.equal(turnPages, 2, "only the directory history view lists Turns"); assert.equal(itemPages, 5);
  } finally { await runner.stop(); }
});

test("work trace requires reviewer authority and keeps unsupported and page limits explicit", async () => {
  const observed = { ...run, state: "completed" as const, nativeTurnId: "turn-1" };
  let originalGrant = true, nativeReads = 0;
  let oldTurn = false;
  let ownedSession = session;
  const runtime = new FakeRuntime() as FakeRuntime & Pick<RuntimePort, "readWorkPage">;
  runtime.listTurns = async (_binding, cursor) => {
    nativeReads++;
    if (oldTurn) return { data: cursor === "old-page" ? [{ id: "turn-1", status: "completed", completedAtUtc: "2026-10-20T12:14:44.000Z" }] : [],
      nextCursor: cursor === "old-page" ? null : cursor ? "old-page" : "middle-page" };
    return { data: [{ id: "turn-1", status: "completed", completedAtUtc: "2026-10-20T12:14:44.000Z" }], nextCursor: null };
  };
  runtime.readWorkPage = async (_binding, turnId, cursor) => {
    assert.equal(turnId, "turn-1");
    nativeReads++;
    return {
      data: [{ id: cursor ? "cmd-2" : "cmd-1", kind: "command", name: "echo", status: "completed", exitCode: 0,
        text: null, output: "ok", error: null, artifactRefs: [], startedAtUtc: null, completedAtUtc: null, durationMs: 5, truncated: false }],
      nextCursor: cursor ? "page-3" : "page-2", unsupportedCount: cursor ? 0 : 1, truncated: false,
    };
  };
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [observed], getRuntimeSession: async () => ownedSession,
    getRuntimeRun: async () => observed } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }) } as unknown as RuntimeWorkflowService;
  const executor = { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as ("read" | "write" | "review")[] };
  const reviewer = { actorId: "trace-reviewer", projectIds: [projectId], permissions: ["read", "review"] as ("read" | "review")[] };
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [executor, reviewer], canWrite: () => true, allowedCwd: async () => true,
    hasGrant: scope => scope.actorId === actorId && originalGrant,
    canSettleOwned: async () => true, ownedCwd: async () => true });
  try {
    await runner.start();
    await assert.rejects(() => runner.trace({ ...reviewer, permissions: ["read"] }, projectId, observed.id), /读取和复核权限/);
    await assert.rejects(() => runner.trace({ ...reviewer, projectIds: [randomUUID()] }, projectId, observed.id), /读取和复核权限/);
    const trace = await runner.trace(reviewer, projectId, observed.id);
    assert.equal(trace.source, "owned-native-history");
    assert.equal(trace.unsupportedCount, 1);
    assert.equal(trace.nextCursor, "page-3");
    assert.equal(trace.truncated, true);
    assert.equal(trace.completeness, "partial");
    assert.equal(runtime.starts, 0);
    oldTurn = true;
    const partial = await runner.trace(reviewer, projectId, observed.id);
    assert.equal(partial.nativeTurnId, "turn-1");
    assert.equal(partial.turn, null);
    assert.deepEqual(partial.turnMetadata, { status: "partial", nextTurnCursor: "old-page" });
    assert.equal(partial.items.length, 2, "bound Items remain readable before Turn metadata is reached");
    const continued = await runner.trace(reviewer, projectId, observed.id, undefined, undefined, partial.turnMetadata.nextTurnCursor!);
    assert.equal(continued.turn?.id, "turn-1");
    const beforeRevocation = nativeReads;
    originalGrant = false;
    await assert.rejects(() => runner.trace(reviewer, projectId, observed.id), /授权已失效/);
    assert.equal(nativeReads, beforeRevocation, "historical owned settlement cannot grant trace access");
    originalGrant = true;
    ownedSession = { ...session, nativeThreadId: null };
    await assert.rejects(() => runner.trace(reviewer, projectId, observed.id), /原生读取或归属校验失败/);
  } finally { await runner.stop(); }
});

test("disabled orchestration cannot start or trace a bound dynamic Session through a colliding static grant",async()=>{
  const dispatchId=randomUUID();
  const boundSession={...session,id:loopIntentId(dispatchId,"session")};
  const pending={...run,id:randomUUID(),sessionId:boundSession.id,state:"requested" as const};
  const terminal={...run,id:randomUUID(),sessionId:boundSession.id,state:"completed" as const,nativeTurnId:"turn-1"};
  const persisted={query:async()=>({rows:[{dispatch_id:dispatchId}]})} as never;
  const runtime=new FakeRuntime() as FakeRuntime & Pick<RuntimePort,"readWorkPage">;
  let nativeReads=0,rejected=0;
  runtime.registerBinding=async()=>{nativeReads++;};
  runtime.listTurns=async()=>{nativeReads++;return {data:[],nextCursor:null};};
  runtime.readWorkPage=async()=>{nativeReads++;return {data:[],nextCursor:null,unsupportedCount:0,truncated:false};};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[boundSession],
    listRuntimeRuns:async()=>[pending,terminal],getRuntimeSession:async()=>boundSession,
    getRuntimeRun:async()=>terminal} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),rejectDispatch:async()=>{rejected++;}} as unknown as RuntimeWorkflowService;
  const reviewer={actorId,projectIds:[projectId],permissions:["read","write","review"] as ("read"|"write"|"review")[]};
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort & FakeRuntime,
    workflow,trusted,principals:[reviewer],canWrite:()=>true,allowedCwd:async()=>true,
    hasGrant:(_scope,source)=>source ? currentSessionGrant(persisted,source,()=>true) : true});
  try {
    await runner.start();
    assert.equal(rejected,1,"new Run remains rejected despite a colliding static grant");
    assert.equal(runtime.starts,0);
    await assert.rejects(()=>runner.trace(reviewer,projectId,terminal.id),/授权已失效/);
    assert.equal(nativeReads,0,"trace cannot inspect or page native history after origin denial");
  } finally { await runner.stop(); }
});

test("managed worker trace checks its own bound Run, exact fixed authority, and live source grant", async () => {
  const target={...run,id:randomUUID(),state:"completed" as const,nativeTurnId:"turn-1"};
  const readerSession={...session,id:randomUUID(),roleId:"researcher",nativeThreadId:"reader-thread",nativeSessionId:"reader-session"};
  const reader={...run,id:randomUUID(),sessionId:readerSession.id,nativeTurnId:"reader-turn",state:"running" as const};
  const worker={actorId:"worker-fixture",projectIds:[projectId],permissions:["read","write"] as ("read"|"write")[]};
  const identity={principal:worker,scope:{projectId,loopId:randomUUID(),taskId:reader.taskId,runId:reader.id,
    sessionId:readerSession.id,roleId:readerSession.roleId,kind:"business" as const,allowedRoleIds:[readerSession.roleId]}};
  const runtime=new FakeRuntime() as FakeRuntime & Pick<RuntimePort,"readWorkPage">;
  runtime.listTurns=async()=>({data:[{id:"turn-1",status:"completed",completedAtUtc:"2026-10-20T12:14:44.000Z"}],nextCursor:null});
  runtime.readWorkPage=async()=>({data:[],nextCursor:null,unsupportedCount:0,truncated:false});
  let fixed=true,sourceGrant=true,readerGrant=true,readerState=readerSession.state,
    sourceState=session.state,readerTurn=reader.nativeTurnId;
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[],listRuntimeRuns:async()=>[],
    getRuntimeRun:async(_p:unknown,_project:string,id:string)=>id===reader.id?{...reader,nativeTurnId:readerTurn}:target,
    getRuntimeSession:async(_p:unknown,_project:string,id:string)=>id===readerSession.id?
      {...readerSession,state:readerState}:{...session,state:sourceState}} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]})} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as RuntimePort & FakeRuntime,workflow,trusted,
    principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,
    hasGrant:async(scope,boundSession)=>scope.roleId===readerSession.roleId
      ? boundSession?.id===readerSession.id && readerGrant
      : boundSession?.id===session.id && sourceGrant,
    workerTraceAuthority:async(_identity,targetId)=>fixed && targetId===target.id});
  try {
    await runner.start();
    assert.equal((await runner.trace(worker,projectId,target.id,undefined,identity)).runId,target.id);
    fixed=false;
    await assert.rejects(runner.trace(worker,projectId,target.id,undefined,identity),/固定依据/);
    fixed=true;readerTurn=null;
    await assert.rejects(runner.trace(worker,projectId,target.id,undefined,identity),/固定依据/);
    readerTurn=reader.nativeTurnId;readerState="closed" as typeof readerSession.state;
    await assert.rejects(runner.trace(worker,projectId,target.id,undefined,identity),/固定依据/);
    readerState=readerSession.state;sourceGrant=false;
    await assert.rejects(runner.trace(worker,projectId,target.id,undefined,identity),/授权已失效/);
    sourceGrant=true;readerGrant=false;
    await assert.rejects(runner.trace(worker,projectId,target.id,undefined,identity),/固定依据/);
    readerGrant=true;sourceState="closed" as typeof session.state;
    await assert.rejects(runner.trace(worker,projectId,target.id,undefined,identity),/授权已失效/);
    await assert.rejects(runner.trace(worker,projectId,target.id),/读取和复核权限/);
  } finally {await runner.stop();}
});

test("native read rejection reports a read-specific error without private protocol text", async () => {
  const observed = { ...run, state: "completed" as const, nativeTurnId: "turn-1" };
  const runtime = new FakeRuntime();
  runtime.listTurns = async () => ({ data: [{ id: "turn-1", status: "completed" }], nextCursor: null });
  runtime.listItems = async () => { throw new RuntimeServerError("thread/items/list", 17, -32000, "private native path and material"); };
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [observed], getRuntimeSession: async () => session,
    getRuntimeRun: async () => observed } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }) } as unknown as RuntimeWorkflowService;
  const reviewer = { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as ("read" | "write" | "review")[] };
  const runner = new RuntimeRunner({ runtimeFactory: () => runtime as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [reviewer], canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    await assert.rejects(() => runner.result(reviewer, projectId, observed.id), error => {
      assert.equal((error as { code?: string }).code, "RUNTIME_READ_UNAVAILABLE");
      assert.match((error as Error).message, /原生读取 thread\/items\/list 被拒绝/);
      assert.doesNotMatch((error as Error).message, /private native path/);
      return true;
    });
    assert.equal(runtime.starts, 0);
  } finally { await runner.stop(); }
});


test("recovery cannot replace an owned child until close confirms its exit",async()=>{
  class ExitRuntime extends FakeRuntime {
    exitConfirmed=false;
    async close(){if(!this.exitConfirmed)throw new Error("Owned child exit is unconfirmed");await super.close();}
  }
  const original=new ExitRuntime(),replacement=new FakeRuntime();let factories=0;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]})} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>{factories++;return factories===1?original:replacement;},
    workflow:{} as WorkflowService,trusted,principals:[],canWrite:()=>true,
    allowedCwd:async()=>true,hasGrant:()=>true});
  try{
    await runner.start();original.disconnect("lost transport");
    await assert.rejects(runner.recover(),/exit is unconfirmed/);
    assert.equal(factories,1,"a second writer cannot be instantiated after a failed close");
    assert.equal(replacement.isReady(),false);assert.equal(runner.nativeStartsAvailable(),false);
    original.exitConfirmed=true;
    await runner.recover();assert.equal(factories,2);assert.equal(replacement.isReady(),true);
  }finally{original.exitConfirmed=true;await runner.stop();}
});

test("a versioned full profile activates on the original idle Thread without manufacturing a Task Run",async()=>{
  const oldRevisionId=randomUUID(),revisionId=randomUUID(),operationId=randomUUID();
  const previous={projectId,sessionId:session.id,revisionId:oldRevisionId,version:1,model:"gpt-6-sol",
    sandbox:"read-only" as const,approvalPolicy:"on-request" as const,cwd:session.cwd,
    authorizationScope:session.authorizationScope,provenance:"legacy_session_identity" as const,
    previousRevisionId:null,operationId:randomUUID(),actorId,reason:"historical profile",evidenceRef:null,
    createdAt:new Date().toISOString()};
  const revision={...previous,revisionId,version:2,previousRevisionId:oldRevisionId,operationId,
    sandbox:"danger-full-access" as const,approvalPolicy:"never" as const,provenance:"revised" as const};
  const target:RuntimeSessionRecord={...session,model:revision.model,sandbox:revision.sandbox,approvalPolicy:revision.approvalPolicy,
    executionProfile:{revision,activeRevisionId:oldRevisionId,activationState:"pending",activationOperationId:null,
      attemptedAt:null,activationEvidence:null}};
  let activations=0,permits=0;
  const runtime=Object.assign(new FakeRuntime(),{
    activateExecutionProfile:async(current:RuntimeBinding,spec:RuntimeSessionSpec)=>{
      activations++;assert.equal(current.nativeThreadId,target.nativeThreadId);
      assert.equal(current.resumeProfile?.sandbox,"read-only");assert.equal(spec.sandbox,"danger-full-access");
      assert.equal(spec.approvalPolicy,"never");return {...current,resumeProfile:{...current.resumeProfile!,
        sandbox:spec.sandbox,approvalPolicy:spec.approvalPolicy,executionProfileRevisionId:revisionId}};
    },inspectExecutionProfileActivation:async()=>null});
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[target],listRuntimeRuns:async()=>[]} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),getExecutionProfileRevision:async()=>previous,
    beginExecutionProfileActivation:async()=>{permits++;return true;},
    settleExecutionProfileActivation:async(_p:string,_s:string,id:string,state:"active")=>{
      assert.equal(id,revisionId);target.executionProfile!.activationState=state;target.executionProfile!.activeRevisionId=id;}} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime,workflow,trusted,
    principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try{await runner.start();await runner.pump();assert.equal(permits,1);assert.equal(activations,1);
    assert.equal(target.executionProfile?.activationState,"active");assert.equal(runtime.starts,0);assert.equal(runtime.creates,0);
    assert.equal(target.nativeThreadId,session.nativeThreadId);
  }finally{await runner.stop();}
});


test("a known old Run result reads its own Item pages without scanning the Thread's 1000+ Turns",async()=>{
  const historical={...run,state:"completed" as const,nativeTurnId:"older-known-turn",version:4};
  const runtime=new FakeRuntime();let turnPages=0,itemPages=0,resumes=0;
  runtime.listTurns=async()=>{turnPages++;return{data:Array.from({length:100},(_,index)=>({id:`recent-${turnPages}-${index}`,status:"completed"})),nextCursor:`older-${turnPages}`};};
  runtime.listItems=async(binding:RuntimeBinding,turnId:string,cursor?:string)=>{
    assert.equal(binding.nativeThreadId,session.nativeThreadId);assert.equal(turnId,historical.nativeTurnId);itemPages++;
    return cursor?{data:[{type:"agentMessage",phase:"final_answer",text:"Original fixed result"}],nextCursor:null}:
      {data:[{type:"agentMessage",phase:"commentary",text:"Earlier progress"}],nextCursor:"items-page-2"};
  };
  runtime.resume=async binding=>{resumes++;return binding;};
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[session],listRuntimeRuns:async()=>[],
    getRuntimeRun:async()=>historical,getRuntimeSession:async()=>session} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]})} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime,workflow,trusted,
    principals:[{actorId,projectIds:[projectId],permissions:["read","write","review"]}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  try{
    await runner.start();
    const result=await runner.result({actorId,projectIds:[projectId],permissions:["read"]},projectId,historical.id);
    assert.deepEqual(result.messages,["Original fixed result"]);assert.equal(result.finalPhaseConfirmed,true);
    assert.equal(result.source,"owned-native-history");assert.equal(turnPages,0);assert.equal(itemPages,2);
    assert.equal(runtime.starts,0);assert.equal(resumes,0);assert.equal(historical.nativeTurnId,"older-known-turn");
  }finally{await runner.stop();}
});
