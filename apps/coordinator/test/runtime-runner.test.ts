import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowService } from "@evoloop/core";
import type { RuntimeWorkflowService } from "@evoloop/core/runtime";
import type { RuntimeApprovalRequest, RuntimeBinding, RuntimePage, RuntimePort, RuntimeTurn } from "@evoloop/contracts/runtime";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import { RuntimeRunner } from "../src/runtime/runner.js";

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
  async resume(binding: RuntimeBinding) { return binding; }
  async listTurns(): Promise<RuntimePage<RuntimeTurn>> { return { data: [], nextCursor: null }; }
  async listItems(): Promise<RuntimePage<unknown>> { return { data: [], nextCursor: null }; }
  async startTurn() { this.starts++; throw Error("unknown start must not replay"); }
}

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
  let runtime!: FakeRuntime;
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [creating],
    listRuntimeRuns: async () => [], getRuntimeSession: async () => creating } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }),
    recordSessionApprovalDeclined: async (_projectId: string, _sessionId: string, _threadId: string,
      _turnId: string | null, detail: string) => { receipts.push(detail); } } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => (runtime = new FakeRuntime()) as unknown as RuntimePort & FakeRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  try {
    await runner.start();
    await runtime.emitApproval({ id: 800, method: "item/commandExecution/requestApproval", params: {},
      threadId: "unverified-thread", projectId, sessionId: session.id });
    assert.equal(receipts.length, 1);
    assert.match(receipts[0]!, /unbound request observed during create; native identity not yet verified/);
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
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
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
