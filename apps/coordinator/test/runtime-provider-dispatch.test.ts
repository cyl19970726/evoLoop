import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { WorkflowService } from "@evoloop/core";
import type { RuntimeWorkflowService } from "@evoloop/core/runtime";
import { RuntimeNotSentError, type RuntimeBinding, type RuntimePage, type RuntimePort, type RuntimeProvider,
  type RuntimeSessionSpec, type RuntimeTurn } from "@evoloop/contracts/runtime";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import { RuntimeRunner } from "../src/runtime/runner.js";

const projectId = randomUUID();
const actorId = "reviewer";
const baseSession: RuntimeSessionRecord = {
  projectId, id: randomUUID(), roleId: "temporary-role", cwd: "/tmp/evoloop-fixture", authorizationScope: "task:bounded",
  model: null, sandbox: "read-only", approvalPolicy: "on-request", state: "ready", version: 3,
  nativeThreadId: "owned-thread", nativeSessionId: "owned-session", operationId: randomUUID(), actorId,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const requestedRun = (session: RuntimeSessionRecord): RuntimeRunRecord => ({
  projectId, id: randomUUID(), taskId: randomUUID(), taskRevisionId: randomUUID(), basisSetId: randomUUID(),
  sessionId: session.id, operationId: randomUUID(), input: "bounded input", inputHash: "hash", state: "requested",
  version: 3, nativeTurnId: null, interruptRequested: false, resultSummary: null, actorId,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

class ProviderRuntime {
  ready = false; starts = 0; resumed: RuntimeBinding[] = [];
  startFailures = 0;
  constructor(private readonly id: RuntimeProvider | undefined) {}
  capabilities() { return this.id ? { provider: this.id } as never : undefined as never; }
  async open() { this.ready = true; }
  async close() { this.ready = false; }
  isReady() { return this.ready; }
  onDisconnect() { return () => {}; }
  onApprovalRequest() { return () => {}; }
  async registerBinding() {}
  async create(): Promise<RuntimeBinding> { throw Error("no create in this test"); }
  async resume(binding: RuntimeBinding, _spec: RuntimeSessionSpec) { this.resumed.push(binding); return binding; }
  async inspect(): Promise<unknown> { return {}; }
  async listTurns(): Promise<RuntimePage<RuntimeTurn>> { return { data: [], nextCursor: null }; }
  async listItems(): Promise<RuntimePage<unknown>> { return { data: [], nextCursor: null }; }
  async startTurn(): Promise<RuntimeTurn> {
    this.starts++;
    if (this.startFailures-- > 0) throw new RuntimeNotSentError("turn/start", "transport closed before write");
    return { id: "native-turn", status: "inProgress" };
  }
}

function harness(native: ProviderRuntime, session: RuntimeSessionRecord, run: RuntimeRunRecord) {
  const calls = { permits: 0, withdrawn: [] as string[], unknown: 0, bound: 0 };
  const workflow = { getProject: async () => ({ id: projectId }), listRuntimeSessions: async () => [session],
    listRuntimeRuns: async () => [run], getRuntimeSession: async () => session } as unknown as WorkflowService;
  const trusted = { recoverDispatching: async () => ({ sessions: [], runs: [] }), canStartRecoveredRun: async () => true,
    beginDispatch: async () => { calls.permits++; run.state = "dispatching"; },
    withdrawDispatch: async (_p: string, id: string, detail: string) => {
      assert.equal(id, run.id); calls.withdrawn.push(detail); run.state = "requested";
    },
    markRunUnknown: async () => { calls.unknown++; run.state = "unknown"; },
    bindTurn: async (_p: string, _id: string, turn: RuntimeTurn) => {
      calls.bound++; run.state = "running"; run.nativeTurnId = turn.id; return run;
    },
  } as unknown as RuntimeWorkflowService;
  const runner = new RuntimeRunner({ runtimeFactory: () => native as unknown as RuntimePort & ProviderRuntime,
    workflow, trusted, principals: [{ actorId, projectIds: [projectId], permissions: ["read", "write", "review"] }],
    canWrite: () => true, allowedCwd: async () => true, hasGrant: () => true });
  (runner as unknown as { lightweightInput: () => Promise<unknown> }).lightweightInput = async () =>
    ({ input: "fixed Task input", protocol: "evoloop-lightweight-v1", contentHash: "a".repeat(64), byteLength: 16 });
  return { runner, calls };
}

test("a start proven unsent returns the Run to requested and the next pump dispatches it once more", async () => {
  const session = { ...baseSession }, run = requestedRun(session);
  const native = new ProviderRuntime("codex"); native.startFailures = 1;
  const { runner, calls } = harness(native, session, run);
  try {
    await runner.start();
    assert.deepEqual([calls.permits, native.starts, calls.unknown, calls.bound], [1, 1, 0, 0]);
    assert.deepEqual(calls.withdrawn, ["native_not_sent"]);
    assert.equal(run.state, "requested");
    const fault = runner.status(projectId).faults[0]!;
    assert.equal(fault.phase, "run_start");
    assert.doesNotMatch(JSON.stringify(fault), /transport closed before write/, "native detail stays out of durable evidence");
    await runner.pump();
    assert.deepEqual([calls.permits, native.starts, calls.unknown, calls.bound], [2, 2, 0, 1]);
    assert.equal(run.state, "running");
  } finally { await runner.stop(); }
});

for (const [runtimeProvider, sessionProvider] of [["codex", "claude"], ["claude", "codex"], [undefined, "claude"]] as const) {
  test(`a ${runtimeProvider ?? "legacy"} runner never touches a ${sessionProvider} Session or its Runs`, async () => {
    const session = { ...baseSession, ...(sessionProvider === "claude" ? { runtimeProvider: sessionProvider } : {}) };
    const run = requestedRun(session);
    const native = new ProviderRuntime(runtimeProvider);
    const { runner, calls } = harness(native, session, run);
    try {
      await runner.start();
      await runner.pump();
      assert.deepEqual([calls.permits, native.starts, native.resumed.length], [0, 0, 0]);
      assert.equal(run.state, "requested");
    } finally { await runner.stop(); }
  });
}

test("a claude runner drives its own Session with the claude owner binding", async () => {
  const session: RuntimeSessionRecord = { ...baseSession, runtimeProvider: "claude" };
  const run = requestedRun(session);
  const native = new ProviderRuntime("claude");
  const { runner, calls } = harness(native, session, run);
  try {
    await runner.start();
    assert.equal(calls.permits, 1);
    assert.equal(native.starts, 1);
    assert.ok(native.resumed.length >= 1);
    assert.ok(native.resumed.every(binding => binding.owner === "evoloop-claude-agent-sdk"));
  } finally { await runner.stop(); }
});
