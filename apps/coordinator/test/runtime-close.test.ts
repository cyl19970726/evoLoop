import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { WorkflowService } from "@evoloop/core";
import type { Operation, OutboxEvent, RuntimeRecordEvent, RuntimeSessionRecord } from "@evoloop/contracts";
import type { Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";
import type { RuntimeRunner } from "../src/runtime/runner.js";
import type { WorkerIdentity } from "../src/workers/types.js";
import type { WorkerGuardFacts } from "../src/workers/guard.js";

// Real HTTP authorization and core workflow; in-memory transaction fixture, not PostgreSQL/native archive.
async function fixture() {
  const projectId = randomUUID(), sessionId = randomUUID();
  const original: RuntimeSessionRecord = { projectId, id: sessionId, roleId: "temporary-experience",
    actorId: "original-controller", cwd: "/fixture/owned", authorizationScope: "candidate:temporary-experience",
    model: null, sandbox: "workspace-write", approvalPolicy: "on-request", state: "ready", version: 3,
    nativeThreadId: "original-thread", nativeSessionId: "original-session", operationId: randomUUID(),
    createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:00Z" };
  const state = { session: structuredClone(original), runs: [] as Array<{ sessionId: string; state: string }>,
    events: [] as RuntimeRecordEvent[], operations: [] as Operation[], outbox: [] as OutboxEvent[] };
  const tx = {
    getProject: async () => ({ id: projectId }),
    getOperation: async (id: string) => state.operations.find(item => item.id === id) ?? null,
    getRuntimeSession: async (id: string) => id === sessionId ? state.session : null,
    listRuntimeRuns: async () => state.runs,
    updateRuntimeSession: async (next: RuntimeSessionRecord) => { state.session = next; },
    appendRuntimeEvent: async (event: RuntimeRecordEvent) => { state.events.push(event); },
    insertOperation: async (operation: Operation) => { state.operations.push(operation); },
    appendOutbox: async (event: OutboxEvent) => { state.outbox.push(event); },
    savepoint: async (action: () => Promise<unknown>) => {
      const before = structuredClone(state);
      try { return await action(); } catch (error) { Object.assign(state, before); throw error; }
    },
  } as unknown as Transaction;
  const uow = { transaction: async (_project: string, action: (tx: Transaction) => Promise<unknown>) => action(tx),
    read: async (_project: string, action: (tx: Transaction) => Promise<unknown>) => action(tx) } as UnitOfWork;
  const service = new WorkflowService({ uow, ids: { next: randomUUID }, clock: { now: () => "2026-10-24T01:00:00Z" },
    hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const worker: WorkerIdentity = { principal: { actorId: "worker-temporary", projectIds: [projectId], permissions: ["read", "write"] },
    scope: { projectId, sessionId, loopId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
      roleId: "temporary-experience", kind: "business", allowedRoleIds: ["temporary-experience"] } };
  const facts = { loop: async () => ({ projectId, state: "active", goalId: randomUUID(), stageId: null,
    cognitiveRoleId: "planner", allowedBusinessRoleIds: [worker.scope.roleId] }) } as unknown as WorkerGuardFacts;
  const app = await buildServer({ service, credentials: [
    { token: "r".repeat(40), actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] },
    { token: "o".repeat(40), actorId: "readonly", projectIds: [projectId], permissions: ["read"] },
    { token: "f".repeat(40), actorId: "foreign-reviewer", projectIds: [randomUUID()], permissions: ["read", "write", "review"] },
  ], runtime: { status: () => ({ available: true, error: null }) } as RuntimeRunner,
  hasRuntimeGrant: () => false,
  workers: { authenticate: async header => header === `Bearer ${"w".repeat(40)}` ? worker : null, facts: () => facts } });
  const payload = { type: "runtime.session.close", projectId, operationId: randomUUID(), sessionId,
    expectedVersion: 3, reason: "Completed work; request closure" };
  const close = (token = "r", changes = {}) => app.inject({ method: "POST", url: "/api/commands",
    headers: { authorization: `Bearer ${token.repeat(40)}` }, payload: { ...payload, ...changes } });
  return { app, state, original, close, payload, worker };
}

test("reviewer close signs the requester, preserves original execution binding, and replays one operation", async () => {
  const f = await fixture();
  try {
    f.state.runs.push({ sessionId: f.original.id, state: "completed" });
    const accepted = await f.close();
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().status, "applied");
    assert.deepEqual((await f.close()).json(), accepted.json());
    assert.deepEqual(f.state.session, { ...f.original, state: "closing", version: 4,
      closeOperationId: f.payload.operationId, closeAttemptedAt: null, closeVerifiedAt: null,
      updatedAt: "2026-10-24T01:00:00Z" });
    assert.equal(f.state.events.length, 1);
    assert.equal(f.state.events[0]?.kind, "session.closeRequested");
    assert.equal(f.state.events[0]?.actorId, "reviewer");
    assert.equal(f.state.operations.length, 1);
    assert.equal(f.state.operations[0]?.actorId, "reviewer");
    assert.equal(f.state.outbox.length, 1);
    assert.equal((await f.close("r", { reason: "Different intent with same operation" })).json().code, "OPERATION_REUSED");
  } finally { await f.app.close(); }
});

test("readonly, foreign-project and scoped temporary workers cannot request close", async () => {
  const f = await fixture();
  try {
    for (const token of ["o", "f", "w"]) {
      const denied = await f.close(token);
      assert.equal(denied.statusCode, 403, denied.body);
    }
    // The worker allowlist still blocks close even if ordinary review permission were supplied.
    f.worker.principal.permissions.push("review");
    assert.equal((await f.close("w")).statusCode, 403);
    assert.deepEqual(f.state.session, f.original);
    assert.equal(f.state.events.length, 0);
    assert.equal(f.state.operations.length, 0);
  } finally { await f.app.close(); }
});

test("reviewer close retains active/unknown, readiness, binding and version guards", async t => {
  const cases = [
    ...["requested", "dispatching", "running", "unknown"].map(runState => ({ name: runState, code: "SESSION_BUSY", runState })),
    ...["reserved", "creating", "unknown", "closing", "closed"].map(sessionState => ({ name: `session ${sessionState}`, code: "SESSION_NOT_READY", sessionState })),
    { name: "missing thread", code: "SESSION_NOT_READY", missing: "nativeThreadId" },
    { name: "missing native session", code: "SESSION_NOT_READY", missing: "nativeSessionId" },
    { name: "stale version", code: "VERSION_CONFLICT", stale: true },
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const f = await fixture();
    try {
      if ("runState" in sample) f.state.runs.push({ sessionId: f.original.id, state: sample.runState });
      if ("sessionState" in sample) f.state.session.state = sample.sessionState as RuntimeSessionRecord["state"];
      if ("missing" in sample) f.state.session[sample.missing as "nativeThreadId" | "nativeSessionId"] = null;
      const before = structuredClone(f.state.session);
      const denied = await f.close("r", "stale" in sample ? { expectedVersion: 2 } : {});
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().code, sample.code);
      assert.deepEqual(f.state.session, before);
      assert.equal(f.state.events.length, 0);
      assert.equal(f.state.outbox.length, 0);
    } finally { await f.app.close(); }
  });
});
