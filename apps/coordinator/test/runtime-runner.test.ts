import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowService } from "@evoloop/core";
import type { RuntimeWorkflowService } from "@evoloop/core/runtime";
import type { RuntimeApprovalRequest, RuntimeBinding, RuntimePage, RuntimePort, RuntimeSessionSpec, RuntimeTurn } from "@evoloop/contracts/runtime";
import type { Principal, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import { RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { DomainError } from "@evoloop/contracts/ports";
import { RuntimeRunner } from "../src/runtime/runner.js";
import { currentSessionGrant } from "../src/orchestration/dynamic-admission.js";
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
  (runner as unknown as { input: () => Promise<{ input: string }> }).input = async () => ({ input: "fixed task input" });
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
  (runner as unknown as { input: () => Promise<{ input: string }> }).input = async () => ({ input: "fixed input" });
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
  (runner as unknown as { input: () => Promise<{ input: string }> }).input = async () => ({ input: "fixed task input" });
  try {
    await runner.start();
    assert.deepEqual(profiles, [{ actorId, sessionId: persisted.id, roleId: persisted.roleId,
      projectId, cwd: persisted.cwd, authorizationScope: persisted.authorizationScope,
      sandbox: persisted.sandbox, approvalPolicy: persisted.approvalPolicy, model: persisted.model }]);
    assert.equal(runtime.starts, 1);
    granted = false;
    await runner.recover();
    assert.equal(profiles.length, 1, "revocation cannot open another writer");
    assert.equal(runtime.starts, 1);
  } finally { await runner.stop(); }
});

test("registered Session restores its business profile after an ordinary message before the next Task Turn",async()=>{
  const persisted={...session,sandbox:'workspace-write' as const};
  const first:RuntimeRunRecord={...run,id:randomUUID(),state:'requested',nativeTurnId:null};
  const runs=[first];
  let readOnly=false,resumes=0,unknown=0;
  const runtime=Object.assign(new FakeRuntime(),{needsBusinessRestore:()=>readOnly});
  runtime.resume=async(binding,profile)=>{
    assert.equal(profile.sandbox,persisted.sandbox);
    assert.equal(profile.approvalPolicy,persisted.approvalPolicy);
    resumes++;readOnly=false;return binding;
  };
  runtime.startTurn=async()=>{
    assert.equal(readOnly,false,'ordinary restrictions must be restored before dispatch');
    return{id:`task-turn-${++runtime.starts}`,status:'inProgress'};
  };
  runtime.listTurns=async()=>({data:runs.filter(r=>r.nativeTurnId).map(r=>
    ({id:r.nativeTurnId!,status:'inProgress',completedAtUtc:null})),nextCursor:null});
  const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[persisted],
    listRuntimeRuns:async()=>runs,getRuntimeSession:async()=>persisted} as unknown as WorkflowService;
  const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),beginDispatch:async()=>{},
    bindTurn:async(_p:string,id:string,turn:RuntimeTurn)=>{
      const item=runs.find(r=>r.id===id)!;item.state='running';item.nativeTurnId=turn.id;return item;
    },markRunUnknown:async()=>{unknown++;}} as unknown as RuntimeWorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>runtime as unknown as RuntimePort & typeof runtime,
    workflow,trusted,principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
    canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  (runner as unknown as {input:()=>Promise<{input:string}>}).input=async()=>({input:'fixed Task input'});
  try{
    await runner.start();
    assert.equal(runtime.starts,1);assert.equal(resumes,1);
    first.state='completed';
    // The ordinary adapter retains this gate after its Turn settles, while the
    // runner still remembers the original business Session registration.
    readOnly=true;
    const next:RuntimeRunRecord={...run,id:randomUUID(),operationId:randomUUID(),state:'requested',nativeTurnId:null};
    runs.push(next);
    await runner.pump();
    assert.equal(runtime.starts,2);
    assert.equal(resumes,2);
    assert.equal(next.state,'running');
    assert.equal(unknown,0,'a missing local restore must never create an unknown business start');
  }finally{await runner.stop();}
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
  (runner as unknown as {input:()=>Promise<{input:string}>}).input=async()=>({input:"fixed task input"});
  try {
    await runner.start();
    assert.equal(runtime.starts,0);assert.deepEqual(profiles,[],"the matching static writer must not rehydrate a revoked dynamic Session");
    current=true;
    await runner.pump();
    assert.equal(runtime.starts,1);
    assert.deepEqual(profiles,[{actorId,sessionId:dynamicSession.id,roleId:dynamicSession.roleId,projectId,
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
  runtime.listTurns = async () => ({ data: [{ id: "turn-1", status: settled ? "completed" : "interrupted",
    completedAtUtc: settled ? "2026-10-20T12:14:44.000Z" : null }], nextCursor: null });
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
    settled = true;
    const result = await runner.reconcile({ ...reviewer, permissions: [...reviewer.permissions] }, projectId, observed.id, 4, "Native readback after transient projection");
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
    assert.equal(turnPages, 4); assert.equal(itemPages, 5);
  } finally { await runner.stop(); }
});

test("work trace requires reviewer authority and keeps unsupported and page limits explicit", async () => {
  const observed = { ...run, state: "completed" as const, nativeTurnId: "turn-1" };
  let originalGrant = true, nativeReads = 0;
  let ownedSession = session;
  const runtime = new FakeRuntime() as FakeRuntime & Pick<RuntimePort, "readWorkPage">;
  runtime.listTurns = async () => {
    nativeReads++;
    return { data: [{ id: "turn-1", status: "completed", completedAtUtc: "2026-10-20T12:14:44.000Z" }], nextCursor: null };
  };
  runtime.readWorkPage = async (_binding, _turnId, cursor) => {
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
