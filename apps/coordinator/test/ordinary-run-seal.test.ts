import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal, RuntimeRunRecord, Operation } from "@evoloop/contracts";
import type { Delivery } from "@evoloop/contracts/workflow";
import type { OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import { canonicalJson } from "@evoloop/core";
import { createOrdinaryRunSealer, type OrdinaryRunSealerDependencies } from "../src/ordinary-run-submission/seal.js";

const projectId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), sessionId = randomUUID();
const actor: Principal = { actorId: "ordinary-signer", projectIds: [projectId], permissions: ["read", "write"] };
const sealer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const run: RuntimeRunRecord = { projectId, id: runId, taskId, sessionId, taskRevisionId: randomUUID(), basisSetId: randomUUID(),
  operationId: randomUUID(), input: "fixed", inputHash: "a".repeat(64), state: "completed", version: 4,
  nativeTurnId: "turn", interruptRequested: false, resultSummary: "untrusted", actorId: actor.actorId,
  createdAt: "2026-10-29T00:00:00Z", updatedAt: "2026-10-29T00:00:00Z" };
const intent = { artifactRef: "repo:result", artifactRevision: "abc", contentHash: "b".repeat(64),
  technicalResult: "passed" as const, technicalEvidence: "tests", reason: "done" };
function submission(): OrdinaryRunSubmissionRecord { return { projectId, id: randomUUID(), runId, taskId, sessionId,
  taskRevisionId: run.taskRevisionId, runInputHash: run.inputHash, operationId: randomUUID(), commandHash: "c".repeat(64),
  deliveryOperationId: randomUUID(), deliveryIntent: intent, submittedBy: actor.actorId, state: "submitted", version: 1,
  expectedTaskVersion: null, terminalRunVersion: null, sealedBy: null, deliveryId: null, reason: null,
  createdAtUtc: run.createdAt, updatedAtUtc: run.createdAt }; }

function fixture(initial: OrdinaryRunSubmissionRecord | null = submission()) {
  let record = initial, currentRun = { ...run }, principal: Principal | null = actor;
  let taskVersion = 2, taskRevisionId = run.taskRevisionId, manual: Delivery[] = [];
  let operation: Operation | null = null, delivery: Delivery | null = null, executeMode: "normal" | "lost" | "missing" = "normal";
  let onTaskRead: (() => void) | null = null;
  const calls: { actorId: string; command: any }[] = [];
  const deps: OrdinaryRunSealerDependencies = {
    readSubmission: async () => record,
    updateSubmission: async (next, expected) => { if (!record || record.version !== expected) return false; record = next; return true; },
    readRun: async () => currentRun,
    resolveSubmittedActor: async () => principal,
    sealer, now: () => "2026-10-29T01:00:00Z",
    readDelivery: async () => delivery,
    workflow: {
      getTask: async () => { onTaskRead?.(); return { task: { projectId, id: taskId, version: taskVersion, currentRevisionId: taskRevisionId, state: "in_progress" }, deliveries: manual } as any; },
      getOperation: async () => operation,
      execute: async (who, command) => {
        calls.push({ actorId: who.actorId, command });
        if (executeMode === "missing") throw new Error("no response");
        delivery = { projectId, id: randomUUID(), taskId, taskRevisionId: randomUUID(), runId,
          ...intent, actorId: who.actorId, submittedByActorId: who.actorId,
          sourceRunVersion: currentRun.version, createdAt: run.updatedAt };
        operation = { projectId, id: command.operationId, actorId: who.actorId, commandType: command.type,
          commandHash: createHash("sha256").update(canonicalJson({ actorId: who.actorId, command })).digest("hex"),
          result: { status: "applied", operationId: command.operationId, entityId: taskId, revisionId: delivery.id }, createdAt: run.updatedAt };
        if (executeMode === "lost") throw new Error("response lost");
        return operation.result;
      },
    } as OrdinaryRunSealerDependencies["workflow"],
  };
  return { seal: createOrdinaryRunSealer(deps), calls, get record() { return record; }, get operation() { return operation; },
    setRun(value: Partial<RuntimeRunRecord>) { currentRun = { ...currentRun, ...value }; },
    setActor(value: Principal | null) { principal = value; }, setTask(version: number, revision = taskRevisionId) { taskVersion = version; taskRevisionId = revision; },
    onTaskRead(callback: () => void) { onTaskRead = callback; },
    setManual(value: Delivery[]) { manual = value; }, setOperation(value: Operation | null) { operation = value; },
    setDelivery(value: Delivery | null) { delivery = value; }, setMode(value: typeof executeMode) { executeMode = value; } };
}

test("terminal submission seals the original actor, command and actual Delivery", async () => {
  const f = fixture(); const id = f.record!.deliveryOperationId;
  const result = await f.seal(projectId, runId);
  assert.equal(result.status, "sealed"); assert.equal(f.record?.deliveryId, result.deliveryId);
  assert.equal(f.record?.terminalRunVersion, run.version); assert.equal(f.record?.expectedTaskVersion, 2);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.actorId, actor.actorId);
  assert.equal(f.calls[0]!.command.operationId, id); assert.equal(f.calls[0]!.command.expectedVersion, 2);
  assert.equal((await f.seal(projectId, runId)).reason, "ALREADY_SEALED"); assert.equal(f.calls.length, 1);
});

test("absent and nonterminal Runs cannot fabricate or execute a submission", async () => {
  assert.equal((await fixture(null).seal(projectId, runId)).status, "absent");
  const f = fixture(); f.setRun({ state: "unknown" });
  assert.equal((await f.seal(projectId, runId)).status, "pending"); assert.equal(f.calls.length, 0);
});

test("a failed Run cannot seal a passed technical result", async () => {
  const f = fixture(); f.setRun({ state: "failed" });
  assert.equal((await f.seal(projectId, runId)).reason, "FAILED_RUN_CANNOT_PASS_TECHNICAL_RESULT");
  assert.equal(f.record?.state, "blocked");
  assert.equal(f.calls.length, 0);
});

test("a terminal correction after the first Run read blocks the Delivery call", async () => {
  const f = fixture();
  f.onTaskRead(() => f.setRun({ state: "failed", version: run.version + 1 }));
  assert.equal((await f.seal(projectId, runId)).reason, "TERMINAL_RUN_VERSION_CHANGED");
  assert.equal(f.calls.length, 0);
});

test("revocation, binding changes, task changes and a manual Delivery block execution", async () => {
  const f = fixture(); f.setActor(null); assert.equal((await f.seal(projectId, runId)).reason, "SUBMITTED_ACTOR_UNAVAILABLE");
  f.setActor({ ...actor, actorId: "other" }); assert.equal((await f.seal(projectId, runId)).status, "pending");
  f.setActor(actor); f.setRun({ inputHash: "d".repeat(64) }); assert.equal((await f.seal(projectId, runId)).status, "pending");
  f.setRun({ inputHash: run.inputHash }); f.setTask(3, randomUUID()); assert.equal((await f.seal(projectId, runId)).status, "pending");
  f.setTask(2, run.taskRevisionId); f.setManual([{ runId } as Delivery]);
  assert.equal((await f.seal(projectId, runId)).status, "pending"); assert.equal(f.record?.state, "blocked"); assert.equal(f.calls.length, 0);
});

test("lost response and unknown recovery use only the original operation", async () => {
  const f = fixture(), id = f.record!.deliveryOperationId;
  f.setMode("missing"); assert.equal((await f.seal(projectId, runId)).status, "unknown");
  assert.equal(f.record?.state, "unknown"); f.setMode("lost");
  assert.equal((await f.seal(projectId, runId)).status, "sealed");
  assert.deepEqual(f.calls.map(c => c.command.operationId), [id, id]);
});

test("unknown recovery refuses a changed Task and terminal Run version", async () => {
  const f = fixture(); f.setMode("missing");
  assert.equal((await f.seal(projectId, runId)).status, "unknown");
  f.setTask(3); assert.equal((await f.seal(projectId, runId)).reason, "TASK_INPUT_OR_DELIVERY_CHANGED");
  assert.equal(f.calls.length, 1);
  f.setTask(2); f.setRun({ version: run.version + 1 });
  assert.equal((await f.seal(projectId, runId)).reason, "TERMINAL_RUN_VERSION_CHANGED");
  assert.equal(f.calls.length, 1);
});

test("a committed original Delivery does not seal after terminal observation version advances", async () => {
  const f = fixture(); assert.equal((await f.seal(projectId, runId)).status, "sealed");
  const pending = { ...f.record!, state: "unknown" as const, deliveryId: null, version: f.record!.version + 1 };
  const g = fixture(pending);
  g.setRun({ version: run.version + 1 });
  g.setOperation(f.operation);
  g.setDelivery({ projectId, id: f.record!.deliveryId!, taskId, taskRevisionId: randomUUID(), runId,
    ...intent, actorId: actor.actorId, submittedByActorId: actor.actorId,
    sourceRunVersion: run.version, createdAt: run.updatedAt });
  assert.equal((await g.seal(projectId, runId)).reason, "TERMINAL_RUN_VERSION_CHANGED");
  assert.equal(g.calls.length, 0, "recovery reads the prior operation without a second Delivery call");
});

test("readback rejects wrong command hash and refuses mismatched actual Delivery", async () => {
  const f = fixture(); assert.equal((await f.seal(projectId, runId)).status, "sealed");
  const s = { ...f.record!, state: "unknown" as const, deliveryId: null, version: f.record!.version + 1 };
  const g = fixture(s); g.setOperation({ ...f.operation!, commandHash: "0".repeat(64) });
  assert.equal((await g.seal(projectId, runId)).reason, "DELIVERY_OPERATION_MISMATCH");
  g.setOperation(f.operation); g.setDelivery({ projectId, id: f.record!.deliveryId!, taskId, taskRevisionId: randomUUID(), runId,
    ...intent, actorId: "manual", submittedByActorId: actor.actorId,
    sourceRunVersion: run.version, createdAt: run.updatedAt });
  assert.equal((await g.seal(projectId, runId)).reason, "DELIVERY_MISMATCH"); assert.equal(g.record?.state, "blocked");
});

test("a Delivery with the right writer but wrong signed author cannot be sealed", async () => {
  const f = fixture(); assert.equal((await f.seal(projectId, runId)).status, "sealed");
  const s = { ...f.record!, state: "unknown" as const, deliveryId: null, version: f.record!.version + 1 };
  const g = fixture(s); g.setOperation(f.operation);
  g.setDelivery({ projectId, id: f.record!.deliveryId!, taskId, taskRevisionId: randomUUID(), runId,
    ...intent, actorId: actor.actorId, submittedByActorId: "wrong-author",
    sourceRunVersion: run.version, createdAt: run.updatedAt });
  assert.equal((await g.seal(projectId, runId)).reason, "DELIVERY_MISMATCH");
});
