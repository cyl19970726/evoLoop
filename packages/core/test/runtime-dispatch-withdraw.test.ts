import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeRunRecord } from "@evoloop/contracts";
import type { Transaction } from "@evoloop/contracts/ports";
import { RuntimeWorkflowService } from "../src/runtime/service.ts";

const projectId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";

function fixture(run: Partial<RuntimeRunRecord>, provider: "codex" | "claude" = "codex") {
  const state = {
    run: { projectId, id: runId, taskId: "t", taskRevisionId: "r", basisSetId: "b", sessionId,
      operationId: "00000000-0000-4000-8000-000000000004", input: "bounded", inputHash: "h", state: "dispatching",
      version: 4, nativeTurnId: null, interruptRequested: false, resultSummary: null, actorId: "a",
      createdAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z", ...run } as RuntimeRunRecord,
    events: [] as { kind: string; detail: string }[], outbox: 0, usage: [] as unknown[][],
  };
  const tx = {
    getRuntimeRun: async () => state.run,
    updateRuntimeRun: async (next: RuntimeRunRecord, expected: number) => {
      assert.equal(expected, state.run.version); state.run = next;
    },
    appendRuntimeEvent: async (event: { kind: string; detail: string }) => { state.events.push(event); },
    appendOutbox: async () => { state.outbox++; },
    getRuntimeSession: async () => ({ runtimeProvider: provider }),
    usage: { addUsage: async (...args: unknown[]) => { state.usage.push(args); } },
  } as unknown as Transaction;
  let seq = 10;
  const service = new RuntimeWorkflowService({ uow: { transaction: async (_p, action) => action(tx),
    read: async (_p, action) => action(tx) } as never, clock: { now: () => "2026-11-08T00:01:00.000Z" },
    ids: { next: () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}` } } as never);
  return { state, service };
}

test("a proven unsent start returns the Run to requested with an auditable event", async () => {
  const { state, service } = fixture({});
  const next = await service.withdrawDispatch(projectId, runId, "native_not_sent");
  assert.equal(next.state, "requested");
  assert.equal(next.version, 5);
  assert.equal(next.operationId, "00000000-0000-4000-8000-000000000004", "the original operation is kept for the next dispatch");
  assert.deepEqual(state.events.map(event => event.kind), ["run.dispatchWithdrawn"]);
  assert.match(state.events[0]!.detail, /not sent.*native_not_sent/);
});

for (const [name, run] of [
  ["a Run that is not dispatching", { state: "requested" }],
  ["a Run with a bound native Turn", { nativeTurnId: "turn-1" }],
  ["a Run that already holds pre-turn proof", { preTurnProof: { status: "attempting" } }],
] as const) {
  test(`withdraw refuses ${name}`, async () => {
    const { state, service } = fixture(run as Partial<RuntimeRunRecord>);
    await assert.rejects(service.withdrawDispatch(projectId, runId, "native_not_sent"), /only an unstarted dispatching Run/);
    assert.equal(state.events.length, 0);
  });
}

test("provider usage and cost are recorded only on the terminal status of the bound Turn", async () => {
  const { state, service } = fixture({ state: "running", nativeTurnId: "turn-1" });
  const usage = { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 50 };
  await service.recordTurn(projectId, runId, "turn-1", "running", null, { itemsDigest: "d1", usage, costUsd: 0.01 });
  assert.equal(state.run.usage, undefined, "a running checkpoint never carries accounting");
  assert.equal(state.run.costUsd, undefined);
  await service.recordTurn(projectId, runId, "turn-1", "completed", "done", { usage, costUsd: 0.0123 });
  assert.deepEqual(state.run.usage, usage);
  assert.equal(state.run.costUsd, 0.0123);
  assert.equal(state.outbox, 1);
});

test("invalid provider accounting is rejected before any write", async () => {
  const { state, service } = fixture({ state: "running", nativeTurnId: "turn-1" });
  await assert.rejects(service.recordTurn(projectId, runId, "turn-1", "completed", null,
    { usage: { inputTokens: -1, outputTokens: 0 } }), /non-negative token counts/);
  await assert.rejects(service.recordTurn(projectId, runId, "turn-1", "completed", null,
    { costUsd: Number.NaN }), /non-negative amount/);
  assert.equal(state.run.state, "running");
  assert.equal(state.events.length, 0);
});

test("a Claude Run records uncached input, cache reads and cache creation as one inclusive input count", async () => {
  const { state, service } = fixture({ state: "running", nativeTurnId: "turn-1" }, "claude");
  await service.recordTurn(projectId, runId, "turn-1", "completed", "done", {
    usage: { inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 8_000, cacheCreationInputTokens: 2_000 },
    costUsd: 0.25,
  });
  assert.deepEqual(state.usage, [[projectId, sessionId, "2026-11-08",
    { inputTokens: 11_000, outputTokens: 500, cachedInputTokens: 10_000, costUsd: 0.25, costReported: true }]]);
});
