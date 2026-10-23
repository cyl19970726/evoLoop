import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import type { OrchestrationDispatch, OrchestrationSubmission, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import { createWorkerSealer, type WorkerSealerDependencies } from "../src/orchestration/seal.js";

const projectId = randomUUID(), loopId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), sessionId = randomUUID(), roleId = "builder";
const worker: Principal = { actorId: "worker-signed", projectIds: [projectId], permissions: ["read", "write"] };
const controller: Principal = { actorId: "controller", projectIds: [projectId], permissions: ["read", "write", "review"] };
const signedAt = "2026-10-23T09:01:00.000Z";
const dispatch: OrchestrationDispatch = { projectId, id: randomUUID(), version: 4, loopId, inboxId: randomUUID(), sourceEventId: randomUUID(),
  taskId, taskVersion: 2, parentDispatchId: null, recipientRoleId: roleId, purpose: "build", authorizationScopeId: "scope",
  state: "accepted", claimToken: randomUUID(), leaseUntilUtc: null, runtimeRunId: runId, outcome: null, deliveryId: null,
  evidenceRef: null, reason: "work", requestedBy: "cognition", createdAtUtc: signedAt, updatedAtUtc: signedAt };
const run: RuntimeRunRecord = { projectId, id: runId, taskId, taskRevisionId: randomUUID(), basisSetId: randomUUID(), sessionId,
  operationId: randomUUID(), input: "fixed", inputHash: "a".repeat(64), state: "completed", version: 5, nativeTurnId: "turn",
  interruptRequested: false, resultSummary: "untrusted native text", actorId: worker.actorId, createdAt: signedAt, updatedAt: signedAt };
const issued = () => ({ principal: worker, wrapperPath: "/private/wrapper", metadataWithoutSecret: { actorId: worker.actorId,
  scope: { projectId, loopId, taskId, runId, sessionId, roleId, kind: "business" as const, allowedRoleIds: [roleId] },
  issuedAt: "2026-10-23T09:00:00.000Z", expiresAt: "2026-10-23T09:02:00.000Z", revokedAt: null } });
function fixture(intent: OrchestrationSubmission | OrchestrationWorkerDecision | null) {
  let submission = intent && "deliveryIntent" in intent ? intent : null;
  const decision = intent && "kind" in intent ? intent : null;
  const calls: {kind:string; actor:string; command:unknown}[] = [];
  let workflowOperation: any = null;
  const deps = {
    credential: { lookup: async () => issued() }, controller: async () => controller, now: () => "2026-10-23T09:03:00.000Z",
    orchestration: {
      getSubmissionForDispatch: async () => submission, getDecisionForDispatch: async () => decision,
      execute: async (principal: Principal, command: any) => { calls.push({kind:"orchestration",actor:principal.actorId,command});
        if (command.type === "worker.beginSeal" && submission) submission = { ...submission, version: submission.version + 1, state: "sealing", expectedTaskVersion: command.expectedTaskVersion, sealToken: command.sealToken, sealedBy: principal.actorId };
        return { entityType:"submission",entityId:submission?.id ?? "",version:submission?.version ?? 1,replayed:false };
      },
    },
    workflow: {
      getTask: async () => ({ task: { version: 2 } }),
      getOperation: async () => workflowOperation,
      execute: async (principal: Principal, command: any) => { calls.push({kind:"workflow",actor:principal.actorId,command});
        workflowOperation = { id: command.operationId, actorId: principal.actorId, result: { status:"applied", revisionId: randomUUID() } };
        return workflowOperation.result;
      },
    },
  } as unknown as WorkerSealerDependencies;
  return { deps, calls, setOperation(value:any) { workflowOperation=value; }, setCredential(lookup: any) { (deps.credential as any).lookup=lookup; },
    setWorkflowExecute(execute: any) { (deps.workflow as any).execute=execute; } };
}
function submission(): OrchestrationSubmission { return { projectId, id: randomUUID(), version: 1, dispatchId: dispatch.id, runId, taskId,
  taskRevisionId: run.taskRevisionId, runInputHash: run.inputHash, deliveryOperationId: randomUUID(),
  deliveryIntent: {artifactRef:"artifact",artifactRevision:"r1",contentHash:"b".repeat(64),technicalResult:"passed",technicalEvidence:"checks",reason:"finished"},
  agentObservation:"Model says work done, unverified", evidenceRefs:[], state:"submitted", submittedBy:worker.actorId, sealedBy:null,
  expectedTaskVersion:null, sealToken:null, deliveryId:null, reason:null, createdAtUtc:signedAt, updatedAtUtc:signedAt }; }

test("terminal sealer uses original worker actor and operation, never derives observation from final text", async () => {
  const s = submission(), f = fixture(s); const settle = createWorkerSealer(f.deps);
  const result = await settle(dispatch, run);
  assert.equal(result.status,"sealed"); assert.ok(result.deliveryId);
  assert.deepEqual(f.calls.map(c=>[c.kind,c.actor]), [["orchestration",controller.actorId],["workflow",worker.actorId],["orchestration",controller.actorId]]);
  const delivery = f.calls.find(c=>c.kind==="workflow")!.command as any;
  assert.equal(delivery.operationId,s.deliveryOperationId); assert.equal(delivery.runId,runId); assert.equal(delivery.expectedVersion,2);
  assert.equal(f.calls.some(c=>JSON.stringify(c.command).includes("observation.record")),false);
});

test("crash after beginSeal resumes the exact original PostgreSQL command", async () => {
  const s = { ...submission(), state:"sealing" as const, version:2, expectedTaskVersion:2, sealToken:randomUUID(), sealedBy:controller.actorId };
  const f = fixture(s); const result = await createWorkerSealer(f.deps)(dispatch,run);
  assert.equal(result.status,"sealed");
  const workflowCalls = f.calls.filter(call=>call.kind==="workflow"); assert.equal(workflowCalls.length,1);
  assert.equal((workflowCalls[0]!.command as any).operationId,s.deliveryOperationId);
});

test("unknown original operation retries only the same fixed PostgreSQL intent", async () => {
  const s = { ...submission(), state:"unknown" as const, version:3, expectedTaskVersion:2, sealToken:randomUUID(), sealedBy:controller.actorId };
  const f = fixture(s); const result = await createWorkerSealer(f.deps)(dispatch,run);
  assert.equal(result.status,"sealed");
  assert.equal(f.calls.filter(call=>call.kind==="workflow").length,1);
  assert.equal((f.calls.find(call=>call.kind==="workflow")!.command as any).operationId,s.deliveryOperationId);
});

test("committed response loss reads back the same operation and confirms once", async () => {
  const s=submission(), f=fixture(s), deliveryId=randomUUID();
  f.setWorkflowExecute(async (principal:Principal, command:any) => { f.calls.push({kind:"workflow",actor:principal.actorId,command});
    f.setOperation({id:command.operationId,actorId:principal.actorId,result:{status:"applied",revisionId:deliveryId}});
    throw new Error("response lost after commit"); });
  const result=await createWorkerSealer(f.deps)(dispatch,run);
  assert.deepEqual(result,{status:"sealed",deliveryId,reason:"AUTHORITATIVE_DELIVERY"});
  assert.equal(f.calls.filter(call=>call.kind==="workflow").length,1);
});

test("expired but signed credential can settle, revoked or mismatched scope cannot", async () => {
  const s = submission(), f = fixture(s);
  f.setCredential(async () => ({...issued(), metadataWithoutSecret:{...issued().metadataWithoutSecret,revokedAt:signedAt}}));
  assert.equal((await createWorkerSealer(f.deps)(dispatch,run)).status,"pending"); assert.equal(f.calls.length,0);
  f.setCredential(async () => ({...issued(), metadataWithoutSecret:{...issued().metadataWithoutSecret,scope:{...issued().metadataWithoutSecret.scope,taskId:randomUUID()}}}));
  assert.equal((await createWorkerSealer(f.deps)(dispatch,run)).status,"pending"); assert.equal(f.calls.length,0);
});

test("preterminal signed decision settles without Delivery; missing intent is accountable absence", async () => {
  const decision: OrchestrationWorkerDecision = { projectId,id:randomUUID(),dispatchId:dispatch.id,runId,taskId,kind:"waiting",reason:"dependency pending",evidenceRefs:[],actorId:worker.actorId,createdAtUtc:signedAt };
  const f=fixture(decision); const result=await createWorkerSealer(f.deps)(dispatch,run);
  assert.deepEqual(result,{status:"decision",decisionId:decision.id,outcome:"waiting",reason:decision.reason});
  assert.equal(f.calls.length,0);
  assert.equal((await createWorkerSealer(fixture(null).deps)(dispatch,run)).status,"absent");
});
