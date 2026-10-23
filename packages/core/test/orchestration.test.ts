import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { DelegationTemplate, LoopPolicyRevision, RuntimeRoleBinding } from "@evoloop/contracts/division";
import type { OrchestrationCommand, OrchestrationDispatch, OrchestrationEvent, OrchestrationInbox, OrchestrationLoop, OrchestrationOperation, OrchestrationSubmission, OrchestrationWorkerDecision, OrchestrationWorkflowOperationFact, OrchestrationObservationFact, OrchestrationDeliveryFact, OrchestrationIssueFact, OrchestrationReader, OrchestrationSourceFact, OrchestrationStore, OrchestrationTransaction } from "@evoloop/contracts/orchestration";
import { OrchestrationError, OrchestrationService } from "../src/orchestration/index.js";

const projectId = randomUUID(), goalId = randomUUID(), stageId = randomUUID(), loopId = randomUUID(), cognitiveRoleId = randomUUID(), workerRoleId = randomUUID(), taskId = randomUUID(), scopeId = randomUUID();
const at = "2026-10-23T09:00:00.000Z", after = "2026-10-23T09:00:01.000Z";
const source0 = randomUUID(), source1 = randomUUID(), feedbackDispatchId = randomUUID();
const reviewer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["write", "review"] };
const cognition: Principal = { actorId: "cognition", projectIds: [projectId], permissions: ["write"] };
const worker: Principal = { actorId: "worker", projectIds: [projectId], permissions: ["write"] };
const op = () => randomUUID();
const cmd = <T extends OrchestrationCommand>(value: Omit<T, "projectId" | "operationId">): T => ({ projectId, operationId: op(), ...value }) as T;
const failed = (code: string) => (error: unknown) => error instanceof OrchestrationError && error.code === code;

type Data = { loops: Map<string, OrchestrationLoop>; policies: Map<string, LoopPolicyRevision>; bindings: Map<string, RuntimeRoleBinding>; inbox: Map<string, OrchestrationInbox>; dispatches: Map<string, OrchestrationDispatch>; submissions: Map<string, OrchestrationSubmission>; decisions: Map<string, OrchestrationWorkerDecision>; parentRunStates: Map<string, "requested" | "dispatching" | "running" | "completed" | "failed" | "interrupted" | "unknown">; workflowOp: OrchestrationWorkflowOperationFact | null; observationFact: OrchestrationObservationFact | null; issueFact: OrchestrationIssueFact | null; extraDeliveryFact: OrchestrationDeliveryFact | null; extraStageFact: {projectId:string;id:string;goalId:string;state:string} | null; enrolledStageFact?: {projectId:string;id:string;goalId:string;state:string} | null; cognitiveActors: Set<string>; operations: Map<string, OrchestrationOperation>; events: OrchestrationEvent[]; source: Map<string, OrchestrationSourceFact>; taskVersion: number; extraTaskId: string | null; taskOwnerRoleId: string; taskState: "todo" | "in_progress"; taskStageId: string | null; scopeActive: boolean; runState: "requested" | "dispatching" | "running" | "completed" | "failed" | "interrupted" | "unknown"; runId: string; deliveryId: string; taskRevisionId: string; runInputHash: string };
function harness() {
  let currentTime = at;
  let delegation: {template: DelegationTemplate; hash: string} | null = null;
  let delegatedWorkerScope: {projectId:string;loopId:string;taskId:string;runId:string;roleId:string;kind:string}|null=null;
  const roleStates = new Map<string, {state:string;firstTaskId:string;accepted:boolean}>();
  let data: Data = { loops: new Map(), policies: new Map(), bindings: new Map(), inbox: new Map(), dispatches: new Map(), submissions: new Map(), decisions: new Map(), parentRunStates: new Map(), workflowOp: null, observationFact: null, issueFact: null, extraDeliveryFact: null, extraStageFact: null, cognitiveActors: new Set(), operations: new Map(), events: [], source: new Map([
    [source0, { projectId, id: source0, createdAtUtc: at, kind: "delivery.record", subjectId: taskId, subjectVersion: 1, sourceLoopId: null, originDispatchId: null, operationId: null, sourceActorId: null, observationId: null, deliveryId: null, observationResult: null }],
    [source1, { projectId, id: source1, createdAtUtc: after, kind: "worker.outcome", subjectId: taskId, subjectVersion: 5, sourceLoopId: loopId, originDispatchId: feedbackDispatchId, operationId: null, sourceActorId: null, observationId: null, deliveryId: null, observationResult: null }],
  ]), taskVersion: 1, extraTaskId: null, taskOwnerRoleId: workerRoleId, taskState: "in_progress", taskStageId: stageId, scopeActive: true, runState: "running", runId: randomUUID(), deliveryId: randomUUID(), taskRevisionId: randomUUID(), runInputHash: "f".repeat(64) };
  const view = (draft: Data): OrchestrationTransaction & OrchestrationReader => ({
    getOperation: async id => draft.operations.get(id) ?? null, insertOperation: async value => { draft.operations.set(value.id, value); },
    getLoop: async id => draft.loops.get(id) ?? null, insertLoop: async value => { draft.loops.set(value.id, value); }, updateLoop: async (value, expected) => { assert.equal(draft.loops.get(value.id)?.version, expected); draft.loops.set(value.id, value); },
    getPolicy: async id => draft.policies.get(id) ?? null, insertPolicy: async value => { draft.policies.set(value.id, value); },
    getBinding: async id => draft.bindings.get(id) ?? null, insertBinding: async value => { draft.bindings.set(value.id, value); },
    hasDivisionDecision: async (id, source, task) => draft.events.some(item => item.loopId === id && item.kind === "division.decided" && item.detail.sourceEventId === source && item.detail.firstTaskId === task),
    getDivisionDecisionFact: async id => { const e=draft.events.find(item=>item.kind==="division.decided"&&item.entityId===id);return e?{id:e.entityId,loopId:e.loopId,parentDispatchId:String(e.detail.parentDispatchId),sourceEventId:String(e.detail.sourceEventId),firstTaskId:String(e.detail.firstTaskId),firstTaskVersion:Number(e.detail.firstTaskVersion),choice:String(e.detail.choice)}:null; },
    findDivisionDecisionForParent: async id => { const e=draft.events.find(item=>item.kind==="division.decided"&&item.detail.parentDispatchId===id);return e?{id:e.entityId,loopId:e.loopId,parentDispatchId:id,sourceEventId:String(e.detail.sourceEventId),firstTaskId:String(e.detail.firstTaskId),firstTaskVersion:Number(e.detail.firstTaskVersion),choice:String(e.detail.choice)}:null; },
    countNewRoleAllocations: async (templateId, revision) => [...draft.bindings.values()].filter(item => item.choice === "new-role" && item.template.id === templateId && item.template.revision === revision).length,
    getDocumentRevisionFact: async () => ({contentHash: "a".repeat(64)}),
    getRoleState: async id => roleStates.get(id) ?? (id === workerRoleId ? {state: "active", firstTaskId: taskId, accepted: true} : null),
    getInbox: async id => draft.inbox.get(id) ?? null,
    findInbox: async (id, sourceEventId, recipientRoleId, purpose) => [...draft.inbox.values()].find(item => item.loopId === id && item.sourceEventId === sourceEventId && item.recipientRoleId === recipientRoleId && item.purpose === purpose) ?? null,
    insertInbox: async value => { draft.inbox.set(value.id, value); }, updateInbox: async (value, expected) => { assert.equal(draft.inbox.get(value.id)?.version, expected); draft.inbox.set(value.id, value); },
    getSubmission: async id => draft.submissions.get(id) ?? null,
    findSubmissionByDispatch: async id => [...draft.submissions.values()].find(item => item.dispatchId === id) ?? null,
    insertSubmission: async value => { draft.submissions.set(value.id, value); }, updateSubmission: async (value, expected) => { assert.equal(draft.submissions.get(value.id)?.version, expected); draft.submissions.set(value.id, value); },
    getDecision: async id => draft.decisions.get(id) ?? null, findDecisionByDispatch: async id => [...draft.decisions.values()].find(item => item.dispatchId === id) ?? null,
    hasChildDispatch: async id => [...draft.dispatches.values()].some(item => item.parentDispatchId === id),
    hasWaitingResume: async id => draft.events.some(item => item.kind === "waiting.resumed" && item.entityId === id),
    hasUnsettledDispatchForSource: async (loop, source, except) => [...draft.dispatches.values()].some(item => item.loopId === loop && item.sourceEventId === source && item.id !== except && ["pending", "claimed", "dispatching", "accepted", "unknown"].includes(item.state)),
    insertDecision: async value => { draft.decisions.set(value.id, value); },
    getDispatch: async id => draft.dispatches.get(id) ?? (id === feedbackDispatchId ? { projectId, id, version: 5, loopId, inboxId: randomUUID(), sourceEventId: source0, taskId, taskVersion: 1, parentDispatchId: randomUUID(), recipientRoleId: workerRoleId, purpose: "prior business", authorizationScopeId: scopeId, state: "completed", claimToken: randomUUID(), leaseUntilUtc: null, runtimeRunId: randomUUID(), outcome: "failed", deliveryId: null, evidenceRef: null, reason: "prior failure", requestedBy: cognition.actorId, createdAtUtc: at, updatedAtUtc: after } : null), insertDispatch: async value => { draft.dispatches.set(value.id, value); }, updateDispatch: async (value, expected) => { assert.equal(draft.dispatches.get(value.id)?.version, expected); draft.dispatches.set(value.id, value); },
    countCapacityUsed: async id => [...draft.dispatches.values()].filter(item => item.loopId === id &&
      (["claimed", "dispatching", "unknown"].includes(item.state) ||
        item.state === "accepted" && !["completed", "failed", "interrupted"].includes(item.runtimeRunId === draft.runId ? draft.runState : draft.parentRunStates.get(item.runtimeRunId ?? "") ?? "unknown"))).length,
    appendEvent: async value => { draft.events.push(value); if (value.kind === "loop.enrolled") draft.source.set(value.id, { projectId, id: value.id, createdAtUtc: value.createdAtUtc, kind: value.kind, subjectId: value.loopId, subjectVersion: 1, sourceLoopId: value.loopId, originDispatchId: null, operationId: null, sourceActorId: null, observationId: null, deliveryId: null, observationResult: null }); if (value.kind === "dispatch.gap") { const dispatch = draft.dispatches.get(value.entityId)!; draft.source.set(value.id, { projectId, id: value.id, createdAtUtc: value.createdAtUtc, kind: value.kind, subjectId: dispatch.taskId, subjectVersion: dispatch.version, sourceLoopId: value.loopId, originDispatchId: dispatch.id, operationId: null, sourceActorId: null, observationId: null, deliveryId: null, observationResult: null, gapRunId: dispatch.runtimeRunId, gapTaskVersion: dispatch.taskVersion }); } if (value.kind === "waiting.resumed") { const detail=value.detail; draft.source.set(value.id,{projectId,id:value.id,createdAtUtc:value.createdAtUtc,kind:value.kind,subjectId:detail.issueDocumentId as string,subjectVersion:1,sourceLoopId:value.loopId,originDispatchId:detail.dispatchId as string,operationId:value.operationId,sourceActorId:value.actorId,observationId:null,deliveryId:null,observationResult:null,issueRevisionId:detail.issueRevisionId as string,issueContentHash:detail.issueContentHash as string,waitingDecisionId:detail.decisionId as string,previousSourceEventId:detail.previousSourceEventId as string,originalSourceEventId:detail.originalSourceEventId as string,waitingRunId:detail.runId as string}); } }, getSourceFact: async id => draft.source.get(id) ?? null,
    getTaskFact: async id => id === taskId || id === draft.extraTaskId ? { projectId, id, version: draft.taskVersion, state: draft.taskState, ownerRoleId: draft.taskOwnerRoleId, goalId: draft.taskStageId ? goalId : null, stageId: draft.taskStageId } : null,
    getTaskScopeAtVersion: async (id, taskVersion) => id === taskId && taskVersion === 1 ? { projectId, taskId: id, taskVersion, goalId, stageId } : null,
    getGoalFact: async id => id === goalId ? { projectId, id, state: "active" } : null,
    getStageFact: async id => id === draft.extraStageFact?.id ? draft.extraStageFact : id === stageId ? draft.enrolledStageFact === undefined ? { projectId, id, goalId, state: "active" } : draft.enrolledStageFact : null,
    getAuthorizationFact: async id => id === scopeId ? { projectId, scopeId: id, actorId: draft.taskOwnerRoleId === cognitiveRoleId ? cognition.actorId : worker.actorId, roleId: draft.taskOwnerRoleId, active: draft.scopeActive } : null,
    getRunFact: async id => id === draft.runId ? { projectId, id, taskId, taskRevisionId: draft.taskRevisionId, inputHash: draft.runInputHash, state: draft.runState } : draft.parentRunStates.has(id) ? { projectId, id, taskId, taskRevisionId: draft.taskRevisionId, inputHash: draft.runInputHash, state: draft.parentRunStates.get(id)! } : null,
    getDeliveryFact: async id => id === draft.extraDeliveryFact?.id ? draft.extraDeliveryFact : id === draft.deliveryId ? { projectId, id, taskId, taskRevisionId: draft.taskRevisionId, runId: draft.runId, actorId: worker.actorId, artifactRef: "artifact", artifactRevision: "r1", contentHash: "a".repeat(64), technicalResult: "passed", technicalEvidence: "checks" } : null,
    getObservationFact: async id => draft.observationFact?.id === id ? draft.observationFact : null,
    getWorkflowOperationFact: async id => draft.workflowOp?.id === id ? draft.workflowOp : null,
    getIssueFact: async (documentId, revisionId) => draft.issueFact?.documentId === documentId && draft.issueFact.revisionId === revisionId ? draft.issueFact : null,
    wasActorRole: async actorId => draft.cognitiveActors.has(actorId),
    canActAsRole: async (actorId, roleId) => actorId === cognition.actorId && roleId === cognitiveRoleId || actorId === worker.actorId && roleId === workerRoleId,
    listLoops: async () => ({ items: [...draft.loops.values()], nextCursor: null }), listInbox: async () => ({ items: [...draft.inbox.values()], nextCursor: null }), listDispatches: async () => ({ items: [...draft.dispatches.values()], nextCursor: null }), listSubmissions: async () => ({ items: [...draft.submissions.values()], nextCursor: null }), listEvents: async () => ({ items: draft.events, nextCursor: null }), listSourceFacts: async loopId => ({ items: [...draft.source.values()].filter(item => item.id === draft.loops.get(loopId)?.bootstrapEventId || item.createdAtUtc > (draft.loops.get(loopId)?.sourceAfter.createdAtUtc ?? "")), nextCursor: null }),
  });
  const store: OrchestrationStore = { transaction: async (_project, action) => { const draft = structuredClone(data); const result = await action(view(draft)); data = draft; return result; }, read: async (_project, action) => action(view(data)) };
  const service = new OrchestrationService({ store, now: () => currentTime, nextId: randomUUID, hash: value => value,
    getWorkerScope:async()=>delegatedWorkerScope,
    getDelegationTemplate: async (_project, id) => delegation?.template.id === id ? delegation : null });
  const enroll = () => service.execute(reviewer, cmd({ type: "loop.enroll", loopId, goalId, stageId, cognitiveRoleId, allowedBusinessRoleIds: [workerRoleId], sourceAfter: { createdAtUtc: at, eventId: source0 }, maxRuns: 2, maxConcurrent: 1, reason: "bounded pilot" }));
  const accept = () => service.execute(cognition, cmd({ type: "inbox.accept", loopId, sourceEventId: source1, recipientRoleId: cognitiveRoleId, purpose: "next_action" }));
  const ack = (inboxId: string, expectedVersion = 1) => service.execute(cognition, cmd({ type: "inbox.ack", inboxId, expectedVersion, reason: "read source" }));
  const request = (inboxId: string, dispatchId = randomUUID()) => {
    const inbox = data.inbox.get(inboxId)!;
    const parentId = randomUUID(), parentDeliveryId = randomUUID();
    const parent: OrchestrationDispatch = { projectId, id: parentId, version: 5, loopId, inboxId: randomUUID(), sourceEventId: inbox.sourceEventId, taskId, taskVersion: 1, parentDispatchId: null, recipientRoleId: cognitiveRoleId, purpose: "cognition", authorizationScopeId: scopeId, state: "completed", claimToken: randomUUID(), leaseUntilUtc: after, runtimeRunId: randomUUID(), outcome: "delivered", deliveryId: parentDeliveryId, evidenceRef: null, reason: "cognitive result", requestedBy: cognition.actorId, createdAtUtc: at, updatedAtUtc: at };
    data.dispatches.set(parentId, parent);
    data.parentRunStates.set(parent.runtimeRunId!, "completed");
    const submission: OrchestrationSubmission = { projectId, id: randomUUID(), version: 3, dispatchId: parentId, runId: parent.runtimeRunId!, taskId, taskRevisionId: data.taskRevisionId, runInputHash: data.runInputHash, deliveryOperationId: randomUUID(), deliveryIntent: { artifactRef: "cognition", artifactRevision: "r1", contentHash: "b".repeat(64), technicalResult: "passed", technicalEvidence: "reviewed", reason: "decision" }, agentObservation: null, evidenceRefs: [], state: "sealed", submittedBy: cognition.actorId, sealedBy: reviewer.actorId, expectedTaskVersion: 1, sealToken: randomUUID(), deliveryId: parentDeliveryId, reason: "sealed", createdAtUtc: at, updatedAtUtc: at };
    data.submissions.set(submission.id, submission);
    return service.execute(cognition, cmd({ type: "dispatch.request", inboxId, expectedInboxVersion: 2, dispatchId, parentDispatchId: parentId, taskId, expectedTaskVersion: 1, recipientRoleId: workerRoleId, purpose: "perform Task", authorizationScopeId: scopeId, reason: "Task required" }));
  };
  return { service, enroll, accept, ack, request, get data() { return data; }, advanceTime(value: string) { currentTime = value; },
    change(fn: (value: Data) => void) { fn(data); }, setDelegation(value: {template: DelegationTemplate; hash: string} | null) { delegation = value; },
    setDelegatedWorkerScope(value: typeof delegatedWorkerScope) {delegatedWorkerScope=value;},
    setRoleState(id: string, value: {state:string;firstTaskId:string;accepted:boolean}) { roleStates.set(id,value); } };
}

test("enrollment starts after a verified event, duplicate source is one inbox, and no Task is dispatched on enrollment", async () => {
  const h = harness(); await h.enroll();
  assert.equal(h.data.dispatches.size, 0); assert.equal(h.data.inbox.size, 0);
  const seedId = h.data.loops.get(loopId)?.bootstrapEventId; assert.ok(seedId);
  const seed = await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId, sourceEventId: seedId, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" }));
  assert.equal(h.data.inbox.get(seed.entityId)?.sourceEventId, seedId);
  await assert.rejects(() => h.service.execute(cognition, cmd({ type: "inbox.accept", loopId, sourceEventId: source0, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" })), failed("SOURCE_UNAVAILABLE"));
  const first = await h.accept(), second = await h.accept();
  assert.equal(first.entityId, second.entityId); assert.equal(h.data.inbox.size, 2);
  assert.equal(h.data.events.filter(event => event.kind === "inbox.accepted").length, 2);
});

test("terminal missing-intent gap from cognition becomes one recovery inbox, while unknown and stale intent do not", async () => {
  const h = harness(); await h.enroll(); h.advanceTime(after);
  const gapDispatchId = randomUUID();
  h.change(value => {
    value.runState = "completed";
    value.dispatches.set(gapDispatchId, { projectId, id: gapDispatchId, version: 4, loopId,
      inboxId: randomUUID(), sourceEventId: source0, taskId, taskVersion: 1,
      parentDispatchId: null, recipientRoleId: cognitiveRoleId, purpose: "cognition",
      authorizationScopeId: scopeId, state: "accepted", claimToken: randomUUID(), leaseUntilUtc: null,
      runtimeRunId: value.runId, outcome: null, deliveryId: null, evidenceRef: null,
      reason: "native Run ended", requestedBy: cognition.actorId, createdAtUtc: at, updatedAtUtc: at });
  });
  // The old source projection had no dispatch.gap, so there could be no recovery inbox.
  assert.equal((await h.service.listSourceFacts({ ...reviewer, permissions: ["read", "write", "review"] }, projectId, loopId)).items.some(x => x.kind === "dispatch.gap"), false);
  await h.service.execute(reviewer, cmd({ type: "dispatch.gap", dispatchId: gapDispatchId,
    expectedVersion: 4, reason: "Worker intent gap: absent", evidenceRef: null }));
  const gap = h.data.events.find(e => e.kind === "dispatch.gap")!;
  assert.equal(gap.detail.runId, h.data.runId);
  assert.equal(gap.detail.dispatchVersion, 5);
  const first = await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: gap.id, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" }));
  const again = await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: gap.id, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" }));
  assert.equal(first.entityId, again.entityId);
  assert.equal(h.data.inbox.get(first.entityId)?.state, "pending");
  h.change(value => { value.runState = "unknown"; });
  await assert.rejects(() => h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: gap.id, recipientRoleId: cognitiveRoleId, purpose: "next_action" })), failed("SOURCE_UNAVAILABLE"));
  h.change(value => { value.runState = "completed"; value.decisions.set(randomUUID(), {
    projectId, id: randomUUID(), dispatchId: gapDispatchId, runId: value.runId, taskId,
    kind: "waiting", reason: "late forged decision", evidenceRefs: [], actorId: cognition.actorId, createdAtUtc: after }); });
  await assert.rejects(() => h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: gap.id, recipientRoleId: cognitiveRoleId, purpose: "next_action" })), failed("SOURCE_UNAVAILABLE"));
});

test("only an applied fixed issue from the original Task scope wakes cognition", async () => {
  const h = harness(); await h.enroll();
  const eventId = randomUUID(), documentId = randomUUID(), revisionId = randomUUID();
  const operationId = randomUUID(), writer = "independent-issue-writer", contentHash = "b".repeat(64);
  const issue: OrchestrationSourceFact = { projectId, id: eventId, createdAtUtc: after,
    kind: "document", subjectId: documentId, subjectVersion: 1, sourceLoopId: null,
    originDispatchId: null, operationId, sourceActorId: writer, observationId: null,
    deliveryId: null, observationResult: null, issueRevisionId: revisionId, issueContentHash: contentHash };
  h.change(value => {
    value.source.set(eventId, issue);
    value.workflowOp = { projectId, id: operationId, actorId: writer, commandType: "document.create",
      commandHash: "fixed", status: "applied", resultRefId: revisionId, resultVersion: 1 };
    value.issueFact = { projectId, documentId, revisionId, contentHash, author: writer, kind: "issue",
      originTaskId: taskId, originTaskRevisionId: value.taskRevisionId, originTaskVersion: 1,
      originRunId: null };
  });
  const first = await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: eventId, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" }));
  assert.equal((await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: eventId, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" }))).entityId, first.entityId);
  h.change(value => { value.cognitiveActors.add(writer); });
  await assert.rejects(() => h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: eventId, recipientRoleId: cognitiveRoleId, purpose: "next_action" })), failed("SOURCE_UNAVAILABLE"));
  h.change(value => { value.cognitiveActors.delete(writer); value.issueFact!.originTaskVersion = 2; });
  await assert.rejects(() => h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: eventId, recipientRoleId: cognitiveRoleId, purpose: "next_action" })), failed("SOURCE_UNAVAILABLE"));
  h.change(value => { value.issueFact = null; });
  await assert.rejects(() => h.service.execute(cognition, cmd({ type: "inbox.accept", loopId,
    sourceEventId: eventId, recipientRoleId: cognitiveRoleId, purpose: "next_action" })), failed("SOURCE_UNAVAILABLE"));
});

test("fixed Task and scope are checked at request and again before external dispatch", async () => {
  const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId);
  h.change(value => { value.taskVersion = 2; });
  await assert.rejects(() => h.request(item.entityId), failed("TASK_CHANGED"));
  assert.equal([...h.data.dispatches.values()].filter(item => item.recipientRoleId === workerRoleId).length, 0);
  h.change(value => { value.taskVersion = 1; });
  const requested = await h.request(item.entityId);
  h.change(value => { value.scopeActive = false; });
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: randomUUID(), leaseUntilUtc: after })), failed("SCOPE_NOT_AUTHORIZED"));
  assert.equal(h.data.dispatches.get(requested.entityId)?.state, "pending");
  h.change(value => { value.scopeActive = true; value.taskVersion = 2; });
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: randomUUID(), leaseUntilUtc: after })), failed("TASK_CHANGED"));
});

test("a Goal-scoped loop cannot dispatch a standalone Task without a proven active Stage link", async () => {
  const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId);
  h.change(value => { value.taskStageId = null; });
  await assert.rejects(() => h.request(item.entityId), failed("TASK_CHANGED"));
  assert.equal([...h.data.dispatches.values()].filter(item => item.recipientRoleId === workerRoleId).length, 0);
});

test("cognition may queue a same-source business request while its Run is active, but child claim waits for terminal parent", async () => {
  const h = harness(); await h.enroll(); h.change(value => { value.taskOwnerRoleId = cognitiveRoleId; });
  const cognitionInbox = await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId, sourceEventId: source1, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" }));
  await h.ack(cognitionInbox.entityId);
  const parent = await h.service.execute(cognition, cmd({ type: "dispatch.request", inboxId: cognitionInbox.entityId, expectedInboxVersion: 2, dispatchId: randomUUID(), parentDispatchId: null, taskId, expectedTaskVersion: 1, recipientRoleId: cognitiveRoleId, purpose: "cognition", authorizationScopeId: scopeId, reason: "assess source" }));
  const parentToken = randomUUID();
  await h.service.execute(cognition, cmd({ type: "dispatch.claim", dispatchId: parent.entityId, claimToken: parentToken, leaseUntilUtc: after }));
  await h.service.execute(cognition, cmd({ type: "dispatch.start", dispatchId: parent.entityId, claimToken: parentToken }));
  await h.service.execute(cognition, cmd({ type: "dispatch.resolve", dispatchId: parent.entityId, claimToken: parentToken, result: "accepted", runtimeRunId: h.data.runId, reason: "bound cognition Run" }));
  h.change(value => { value.taskOwnerRoleId = workerRoleId; });
  const actionInbox = await h.accept(); await h.ack(actionInbox.entityId);
  const child = await h.service.execute(cognition, cmd({ type: "dispatch.request", inboxId: actionInbox.entityId, expectedInboxVersion: 2, dispatchId: randomUUID(), parentDispatchId: parent.entityId, taskId, expectedTaskVersion: 1, recipientRoleId: workerRoleId, purpose: "perform Task", authorizationScopeId: scopeId, reason: "cognitive decision" }));
  assert.equal(h.data.dispatches.get(child.entityId)?.state, "pending");
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: child.entityId, claimToken: randomUUID(), leaseUntilUtc: after })), failed("PARENT_NOT_READY"));
});

test("formal business request starts once after waiting parent Run terminates without a Delivery", async () => {
  const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId);
  const child = await h.request(item.entityId);
  const dispatch = h.data.dispatches.get(child.entityId)!;
  const parent = h.data.dispatches.get(dispatch.parentDispatchId!)!;
  h.change(value => {
    value.dispatches.set(parent.id, { ...parent, state: "completed", outcome: "waiting", deliveryId: null });
    value.submissions.clear();
  });
  const token = randomUUID();
  await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: child.entityId, claimToken: token, leaseUntilUtc: after }));
  await h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: child.entityId, claimToken: token }));
  assert.equal(h.data.dispatches.get(child.entityId)?.state, "dispatching");
  assert.equal(h.data.events.filter(event => event.kind === "dispatch.started" && event.entityId === child.entityId).length, 1);
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: child.entityId, claimToken: token, leaseUntilUtc: after })), failed("DISPATCH_NOT_PENDING"));
});

test("accepted parent with signed request releases child after known terminal Run even before outcome", async () => {
  for (const state of ["completed", "failed", "interrupted"] as const) {
    const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId);
    const child = await h.request(item.entityId);
    const parent = h.data.dispatches.get(h.data.dispatches.get(child.entityId)!.parentDispatchId!)!;
    h.change(value => {
      value.dispatches.set(parent.id, { ...parent, state: "accepted", outcome: null, deliveryId: null });
      value.submissions.clear(); value.parentRunStates.set(parent.runtimeRunId!, state);
    });
    await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: child.entityId, claimToken: randomUUID(), leaseUntilUtc: after }));
    assert.equal(h.data.dispatches.get(child.entityId)?.state, "claimed");
  }
});

test("parent unknown/nonterminal/seal-unknown and broken causal edge cannot release child", async () => {
  for (const mode of ["running", "unknown", "submitted", "sealing", "seal-unknown", "source", "request"] as const) {
    const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId);
    const child = await h.request(item.entityId);
    const dispatch = h.data.dispatches.get(child.entityId)!;
    const parent = h.data.dispatches.get(dispatch.parentDispatchId!)!;
    h.change(value => {
      if (mode === "running" || mode === "unknown") value.parentRunStates.set(parent.runtimeRunId!, mode);
      if (["submitted", "sealing", "seal-unknown"].includes(mode)) {
        const submission = [...value.submissions.values()].find(s => s.dispatchId === parent.id)!;
        value.submissions.set(submission.id, { ...submission, state: mode === "seal-unknown" ? "unknown" : mode });
      }
      if (mode === "source") value.dispatches.set(parent.id, { ...parent, sourceEventId: randomUUID() });
      if (mode === "request") value.inbox.set(dispatch.inboxId, { ...value.inbox.get(dispatch.inboxId)!, dispatchId: randomUUID() });
    });
    await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: child.entityId, claimToken: randomUUID(), leaseUntilUtc: after })), failed("PARENT_NOT_READY"));
  }
});

test("a claimed child rechecks parent terminality before reclaim and external start", async () => {
  for (const operation of ["dispatch.reclaim", "dispatch.start"] as const) {
    const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId);
    const child = await h.request(item.entityId), token = randomUUID();
    await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: child.entityId, claimToken: token, leaseUntilUtc: after }));
    const parent = h.data.dispatches.get(h.data.dispatches.get(child.entityId)!.parentDispatchId!)!;
    h.change(value => { value.parentRunStates.set(parent.runtimeRunId!, "unknown"); });
    if (operation === "dispatch.reclaim") {
      h.advanceTime("2026-10-23T09:00:02.000Z");
      await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.reclaim", dispatchId: child.entityId,
        expectedVersion: 2, claimToken: token, leaseUntilUtc: "2026-10-23T09:00:03.000Z" })), failed("PARENT_NOT_READY"));
    } else {
      await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: child.entityId, claimToken: token })), failed("PARENT_NOT_READY"));
    }
    assert.equal(h.data.dispatches.get(child.entityId)?.state, "claimed");
  }
});

test("unknown dispatch is fenced and never automatically claimed or counted as free capacity", async () => {
  const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId); const requested = await h.request(item.entityId);
  const token = randomUUID();
  await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: token, leaseUntilUtc: after }));
  await h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: requested.entityId, claimToken: token }));
  await h.service.execute(worker, cmd({ type: "dispatch.resolve", dispatchId: requested.entityId, claimToken: token, result: "unknown", runtimeRunId: null, reason: "connection lost after start" }));
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: randomUUID(), leaseUntilUtc: after })), failed("DISPATCH_NOT_PENDING"));
  assert.equal(h.data.dispatches.get(requested.entityId)?.state, "unknown");
  assert.equal(h.data.events.filter(event => event.kind === "dispatch.unknown").length, 1);
  const source2 = randomUUID();
  h.change(value => { const prior = value.dispatches.get(requested.entityId)!; const origin = { ...prior, id: randomUUID(), version: 5, state: "completed" as const, outcome: "failed" as const }; value.dispatches.set(origin.id, origin); value.source.set(source2, { projectId, id: source2, createdAtUtc: "2026-10-23T09:00:02.000Z", kind: "worker.outcome", subjectId: taskId, subjectVersion: 5, sourceLoopId: loopId, originDispatchId: origin.id, operationId: null, sourceActorId: null, observationId: null, deliveryId: null, observationResult: null }); });
  const nextInbox = await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId, sourceEventId: source2, recipientRoleId: cognitiveRoleId, purpose: "next_action" }));
  await h.ack(nextInbox.entityId);
  const nextDispatch = await h.request(nextInbox.entityId);
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: nextDispatch.entityId, claimToken: randomUUID(), leaseUntilUtc: after })), failed("CAPACITY_FULL"));
  await h.service.execute(reviewer, cmd({ type: "dispatch.reconcile", dispatchId: requested.entityId, expectedVersion: 4, resolution: "rejected", runtimeRunId: null, evidenceRef: "readback:no-run", reason: "readback proves no Run exists" }));
  await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: nextDispatch.entityId, claimToken: randomUUID(), leaseUntilUtc: after }));
});

test("accepted Run requires real binding and delivered outcome requires terminal Run plus matching Delivery", async () => {
  const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId); const requested = await h.request(item.entityId), token = randomUUID();
  await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: token, leaseUntilUtc: after }));
  await h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: requested.entityId, claimToken: token }));
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.resolve", dispatchId: requested.entityId, claimToken: token, result: "accepted", runtimeRunId: randomUUID(), reason: "accepted" })), failed("RUN_MISMATCH"));
  await h.service.execute(worker, cmd({ type: "dispatch.resolve", dispatchId: requested.entityId, claimToken: token, result: "accepted", runtimeRunId: h.data.runId, reason: "accepted" }));
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "worker.outcome", dispatchId: requested.entityId, outcome: "delivered", deliveryId: h.data.deliveryId, decisionId: null, evidenceRef: null, reason: "delivered" })), failed("RUN_NOT_TERMINAL"));
  const submissionId = randomUUID(), deliveryOperationId = randomUUID();
  const deliveryIntent = { artifactRef: "artifact", artifactRevision: "r1", contentHash: "a".repeat(64), technicalResult: "passed" as const, technicalEvidence: "checks", reason: "delivered" };
  await h.service.execute(worker, cmd({ type: "worker.submit", submissionId, dispatchId: requested.entityId, runId: h.data.runId, taskRevisionId: h.data.taskRevisionId, runInputHash: h.data.runInputHash, deliveryOperationId, deliveryIntent, agentObservation: "tested", evidenceRefs: ["checks:fixture"] }));
  h.change(value => { value.runState = "completed"; });
  const sealToken = randomUUID();
  await h.service.execute(reviewer, cmd({ type: "worker.beginSeal", submissionId, expectedVersion: 1, expectedTaskVersion: 1, sealToken }));
  const workflowCommand = { type: "delivery.record", projectId, operationId: deliveryOperationId, taskId, runId: h.data.runId, expectedVersion: 1, ...deliveryIntent };
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  h.change(value => { value.workflowOp = { projectId, id: deliveryOperationId, actorId: worker.actorId, commandType: "delivery.record", commandHash: canonical({ actorId: worker.actorId, command: workflowCommand }), status: "applied", resultRefId: value.deliveryId, resultVersion: 1 }; });
  await h.service.execute(reviewer, cmd({ type: "worker.finishSeal", submissionId, sealToken, result: "sealed", deliveryId: h.data.deliveryId, reason: "confirmed PG Delivery" }));
  await h.service.execute(worker, cmd({ type: "worker.outcome", dispatchId: requested.entityId, outcome: "delivered", deliveryId: h.data.deliveryId, decisionId: null, evidenceRef: null, reason: "delivered" }));
  assert.equal(h.data.dispatches.get(requested.entityId)?.state, "completed");
});

test("preterminal worker stop decision settles only after Run terminal and closes loop without a Delivery", async () => {
  const h = harness(); await h.enroll(); const inbox = await h.accept(); await h.ack(inbox.entityId);
  const requested = await h.request(inbox.entityId), token = randomUUID(), decisionId = randomUUID();
  await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: token, leaseUntilUtc: after }));
  await h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: requested.entityId, claimToken: token }));
  await h.service.execute(worker, cmd({ type: "dispatch.resolve", dispatchId: requested.entityId, claimToken: token, result: "accepted", runtimeRunId: h.data.runId, reason: "bound" }));
  await h.service.execute(worker, cmd({ type: "worker.decision", decisionId, dispatchId: requested.entityId, runId: h.data.runId, kind: "stop", reason: "goal satisfied", evidenceRefs: ["doc:decision"] }));
  await assert.rejects(() => h.service.execute(reviewer, cmd({ type: "worker.outcome", dispatchId: requested.entityId, outcome: "no_action", deliveryId: null, decisionId, evidenceRef: "doc:decision", reason: "goal satisfied" })), failed("RUN_NOT_TERMINAL"));
  h.change(value => { value.runState = "completed"; });
  await h.service.execute(reviewer, cmd({ type: "worker.outcome", dispatchId: requested.entityId, outcome: "no_action", deliveryId: null, decisionId, evidenceRef: "doc:decision", reason: "goal satisfied" }));
  assert.equal(h.data.loops.get(loopId)?.state, "stopped");
  assert.equal(h.data.dispatches.get(requested.entityId)?.outcome, "no_action");
  assert.equal(h.data.events.filter(event => event.kind === "loop.stopped").length, 1);
});

test("same-clock child request is valid before a signed cognition decision, but no new child follows it", async () => {
  const setup = async () => {
    const h=harness(); await h.enroll(); const inbox=await h.accept(); await h.ack(inbox.entityId);
    const parentId=randomUUID();
    h.change(data => data.dispatches.set(parentId,{projectId,id:parentId,version:4,loopId,
      inboxId:randomUUID(),sourceEventId:source1,taskId,taskVersion:1,parentDispatchId:null,
      recipientRoleId:cognitiveRoleId,purpose:"cognition",authorizationScopeId:scopeId,
      state:"accepted",claimToken:randomUUID(),leaseUntilUtc:null,runtimeRunId:data.runId,
      outcome:null,deliveryId:null,evidenceRef:null,reason:"bound",requestedBy:cognition.actorId,
      createdAtUtc:at,updatedAtUtc:at}));
    const request=cmd({type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,
      dispatchId:randomUUID(),parentDispatchId:parentId,taskId,expectedTaskVersion:1,
      recipientRoleId:workerRoleId,purpose:"perform bounded work",authorizationScopeId:scopeId,reason:"explicit handoff"});
    const decision=cmd({type:"worker.decision",decisionId:randomUUID(),dispatchId:parentId,
      runId:h.data.runId,kind:"waiting",reason:"business child owns next action",evidenceRefs:[]});
    return {h,parentId,request,decision};
  };
  const before=await setup();
  const child=await before.h.service.execute(cognition,before.request);
  await before.h.service.execute(cognition,before.decision);
  assert.equal((await before.h.service.execute(cognition,before.request)).replayed,true,
    "the exact signed child request remains idempotently readable after the decision");
  assert.equal(before.h.data.dispatches.get(child.entityId)?.parentDispatchId,before.parentId);
  assert.equal(before.h.data.events.filter(event=>event.kind==="dispatch.requested").length,1);

  const afterDecision=await setup();
  await afterDecision.h.service.execute(cognition,afterDecision.decision);
  await assert.rejects(() => afterDecision.h.service.execute(cognition,afterDecision.request),failed("PARENT_DECIDED"));
  assert.equal(afterDecision.h.data.dispatches.has(afterDecision.request.dispatchId),false);
  assert.equal(afterDecision.h.data.events.filter(event=>event.kind==="dispatch.requested").length,0);
  assert.equal(afterDecision.h.data.inbox.get(afterDecision.request.inboxId)?.state,"acknowledged");
});

test("operation replay rechecks actor binding and retains one immutable audit decision", async () => {
  const h = harness(); const command = cmd<Extract<OrchestrationCommand, { type: "loop.enroll" }>>({ type: "loop.enroll", loopId, goalId, stageId, cognitiveRoleId, allowedBusinessRoleIds: [workerRoleId], sourceAfter: { createdAtUtc: at, eventId: source0 }, maxRuns: 2, maxConcurrent: 1, reason: "bounded pilot" });
  const first = await h.service.execute(reviewer, command), replay = await h.service.execute(reviewer, command);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(h.data.events.length, 1);
  await assert.rejects(() => h.service.execute({ ...reviewer, permissions: ["write"] }, command), failed("FORBIDDEN"));
  await assert.rejects(() => h.service.execute(reviewer, { ...command, reason: "different" }), failed("OPERATION_CONFLICT"));
});

test("pause and explicit no_action or stop do not consume run budget; stopped loop cannot resume", async () => {
  const h = harness(); await h.enroll(); const item = await h.accept(); await h.ack(item.entityId);
  await h.service.execute(reviewer, cmd({ type: "loop.state", loopId, expectedVersion: 1, state: "paused", reason: "review" }));
  await assert.rejects(() => h.request(item.entityId), failed("LOOP_PAUSED"));
  await h.service.execute(cognition, cmd({ type: "inbox.dispose", inboxId: item.entityId, expectedVersion: 2, disposition: "stop", reason: "no further work", evidenceRef: null }));
  assert.equal(h.data.loops.get(loopId)?.dispatchCount, 0); assert.equal(h.data.loops.get(loopId)?.state, "stopped");
  await assert.rejects(() => h.service.execute(reviewer, cmd({ type: "loop.state", loopId, expectedVersion: 3, state: "active", reason: "restart" })), failed("LOOP_STOPPED"));
});

test("expired pre-start claim renews with same token and CAS, never after external start", async () => {
  const h = harness(); await h.enroll(); const inbox = await h.accept(); await h.ack(inbox.entityId);
  const requested = await h.request(inbox.entityId); const token = randomUUID();
  await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: token, leaseUntilUtc: after }));
  h.advanceTime("2026-10-23T09:00:02.000Z");
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: requested.entityId, claimToken: token })), failed("CLAIM_EXPIRED"));
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.reclaim", dispatchId: requested.entityId, expectedVersion: 2, claimToken: randomUUID(), leaseUntilUtc: "2026-10-23T09:00:03.000Z" })), failed("RECLAIM_UNAVAILABLE"));
  const reclaimed = await h.service.execute(worker, cmd({ type: "dispatch.reclaim", dispatchId: requested.entityId, expectedVersion: 2, claimToken: token, leaseUntilUtc: "2026-10-23T09:00:03.000Z" }));
  assert.equal(reclaimed.version, 3);
  await h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: requested.entityId, claimToken: token }));
  h.advanceTime("2026-10-23T09:00:04.000Z");
  await assert.rejects(() => h.service.execute(worker, cmd({ type: "dispatch.reclaim", dispatchId: requested.entityId, expectedVersion: 4, claimToken: token, leaseUntilUtc: "2026-10-23T09:00:05.000Z" })), failed("RECLAIM_UNAVAILABLE"));
});

test("worker feedback is only from this loop's completed business dispatch", async () => {
  const h = harness(); await h.enroll();
  const id = randomUUID(), dispatchId = randomUUID();
  const base: OrchestrationDispatch = { projectId, id: dispatchId, version: 4, loopId, inboxId: randomUUID(), sourceEventId: source1,
    taskId, taskVersion: 1, parentDispatchId: randomUUID(), recipientRoleId: workerRoleId, purpose: "business", authorizationScopeId: scopeId,
    state: "completed", claimToken: randomUUID(), leaseUntilUtc: null, runtimeRunId: randomUUID(), outcome: "failed", deliveryId: null,
    evidenceRef: null, reason: "signed failure", requestedBy: cognition.actorId, createdAtUtc: at, updatedAtUtc: after };
  h.change(data => { data.dispatches.set(dispatchId, base); data.source.set(id, { projectId, id, createdAtUtc: after,
    kind: "worker.outcome", subjectId: taskId, subjectVersion: 4, sourceLoopId: loopId, originDispatchId: dispatchId, operationId: null, sourceActorId: null, observationId: null, deliveryId: null, observationResult: null }); });
  const first = await h.service.execute(cognition, cmd({ type: "inbox.accept", loopId, sourceEventId: id, recipientRoleId: cognitiveRoleId, purpose: "cognitive_review" }));
  assert.equal(h.data.inbox.get(first.entityId)?.sourceEventId, id);
  h.change(data => { data.source.set(id, { ...data.source.get(id)!, sourceLoopId: randomUUID() }); });
  await assert.rejects(() => h.service.execute(cognition, cmd({ type: "inbox.accept", loopId, sourceEventId: id, recipientRoleId: cognitiveRoleId, purpose: "next_action" })), failed("SOURCE_UNAVAILABLE"));
});

test("operation reads stay actor-scoped and a paused loop can finish an existing inbox", async () => {
  const h = harness(); await h.enroll(); const inbox = await h.accept();
  const operationId = [...h.data.operations.values()].find(op => op.result.entityId === inbox.entityId)!.id;
  await assert.rejects(() => h.service.getOperation({ ...reviewer, permissions: ["read", "write", "review"] }, projectId, operationId), failed("FORBIDDEN"));
  const reader = { ...cognition, permissions: ["read", "write"] as Principal["permissions"] };
  assert.equal((await h.service.getOperation(reader, projectId, operationId))?.id, operationId);
  await h.service.execute(reviewer, cmd({ type: "loop.state", loopId, expectedVersion: 1, state: "paused", reason: "hold" }));
  await h.ack(inbox.entityId);
  await h.service.execute(cognition, cmd({ type: "inbox.dispose", inboxId: inbox.entityId, expectedVersion: 2, disposition: "waiting", reason: "paused", evidenceRef: null }));
  assert.equal(h.data.inbox.get(inbox.entityId)?.state, "disposed");
});

test("first signed worker intent is refused after terminal or unknown Run", async () => {
  for (const state of ["completed", "failed", "interrupted", "unknown"] as const) {
    const h = harness(); await h.enroll(); const inbox = await h.accept(); await h.ack(inbox.entityId);
    const requested = await h.request(inbox.entityId), token = randomUUID();
    await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: token, leaseUntilUtc: after }));
    await h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: requested.entityId, claimToken: token }));
    await h.service.execute(worker, cmd({ type: "dispatch.resolve", dispatchId: requested.entityId, claimToken: token, result: "accepted", runtimeRunId: h.data.runId, reason: "bound" }));
    h.change(data => { data.runState = state; });
    await assert.rejects(() => h.service.execute(worker, cmd({ type: "worker.decision", decisionId: randomUUID(), dispatchId: requested.entityId,
      runId: h.data.runId, kind: "waiting", reason: "late decision", evidenceRefs: [] })), failed("RUN_NOT_ACTIVE"), state);
    await assert.rejects(() => h.service.execute(worker, cmd({ type: "worker.submit", submissionId: randomUUID(), dispatchId: requested.entityId,
      runId: h.data.runId, taskRevisionId: h.data.taskRevisionId, runInputHash: h.data.runInputHash,
      deliveryOperationId: randomUUID(), deliveryIntent: { artifactRef: "late", artifactRevision: "r1", contentHash: "a".repeat(64),
        technicalResult: "failed", technicalEvidence: "late", reason: "late submission" }, agentObservation: null, evidenceRefs: [] })), failed("RUN_NOT_ACTIVE"), state);
    assert.equal(h.data.submissions.size, 1, "only fixture parent remains");
    assert.equal(h.data.decisions.size, 0);
  }
});

test("a preterminal signed submission and decision replay by original operation after Run terminal", async () => {
  for (const kind of ["worker.submit", "worker.decision"] as const) {
    const h = harness(); await h.enroll(); const inbox = await h.accept(); await h.ack(inbox.entityId);
    const requested = await h.request(inbox.entityId), token = randomUUID();
    await h.service.execute(worker, cmd({ type: "dispatch.claim", dispatchId: requested.entityId, claimToken: token, leaseUntilUtc: after }));
    await h.service.execute(worker, cmd({ type: "dispatch.start", dispatchId: requested.entityId, claimToken: token }));
    await h.service.execute(worker, cmd({ type: "dispatch.resolve", dispatchId: requested.entityId, claimToken: token, result: "accepted", runtimeRunId: h.data.runId, reason: "bound" }));
    const intent = kind === "worker.submit"
      ? cmd({ type: "worker.submit", submissionId: randomUUID(), dispatchId: requested.entityId, runId: h.data.runId,
          taskRevisionId: h.data.taskRevisionId, runInputHash: h.data.runInputHash, deliveryOperationId: randomUUID(),
          deliveryIntent: { artifactRef: "fixed", artifactRevision: "r1", contentHash: "a".repeat(64),
            technicalResult: "passed", technicalEvidence: "checks", reason: "done" }, agentObservation: null, evidenceRefs: [] })
      : cmd({ type: "worker.decision", decisionId: randomUUID(), dispatchId: requested.entityId, runId: h.data.runId,
          kind: "no_action", reason: "nothing justified", evidenceRefs: [] });
    const first = await h.service.execute(worker, intent);
    h.change(data => { data.runState = "completed"; });
    const replay = await h.service.execute(worker, intent);
    assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(first.entityId, replay.entityId);
    assert.equal(h.data.events.filter(event => event.operationId === intent.operationId).length, 1);
  }
});

function addIndependentObservation(h: ReturnType<typeof harness>, options: { actorId?: string; stage?: string; goal?: string; createdAtUtc?: string; deliveryActorId?: string; eventId?: string } = {}) {
  const actorId=options.actorId ?? "candidate-consumer", eventId=options.eventId ?? randomUUID(), operationId=randomUUID(), observationId=randomUUID(), deliveryId=randomUUID();
  const fixedStageId=options.stage ?? stageId, fixedGoalId=options.goal ?? goalId;
  h.change(data => {
    if (fixedStageId !== stageId) data.extraStageFact={projectId,id:fixedStageId,goalId:fixedGoalId,state:"reviewed"};
    data.extraDeliveryFact={projectId,id:deliveryId,taskId,taskRevisionId:data.taskRevisionId,runId:data.runId,
      actorId:options.deliveryActorId ?? worker.actorId,artifactRef:"artifact",artifactRevision:"r1",contentHash:"a".repeat(64),technicalResult:"passed",technicalEvidence:"checks"};
    data.observationFact={projectId,id:observationId,taskId,deliveryId,actorId,result:"used",taskRevisionId:data.taskRevisionId,stageId:fixedStageId};
    data.workflowOp={projectId,id:operationId,actorId,commandType:"observation.record",commandHash:"fixed-observation",status:"applied",resultRefId:observationId,resultVersion:1};
    data.source.set(eventId,{projectId,id:eventId,createdAtUtc:options.createdAtUtc ?? "2026-10-23T09:00:02.000Z",kind:"observation.record",
      subjectId:taskId,subjectVersion:1,sourceLoopId:null,originDispatchId:null,operationId,sourceActorId:actorId,observationId,deliveryId,observationResult:"used"});
  });
  return eventId;
}

test("independent consumer Observation enters cognition once from fixed Delivery scope after a late poll", async () => {
  const h=harness(); await h.enroll(); h.advanceTime("2026-10-23T09:00:10.000Z");
  const eventId=addIndependentObservation(h);
  h.change(data => { data.taskVersion=9; data.taskStageId=null; }); // Later Task head cannot rewrite historical Delivery scope.
  const command=cmd({type:"inbox.accept",loopId,sourceEventId:eventId,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"});
  const first=await h.service.execute(cognition,command);
  const replay=await h.service.execute(cognition,command);
  const duplicate=await h.service.execute(cognition,cmd({type:"inbox.accept",loopId,sourceEventId:eventId,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"}));
  assert.equal(first.entityId,replay.entityId); assert.equal(first.entityId,duplicate.entityId);
  assert.equal(h.data.inbox.size,1); assert.equal(h.data.events.filter(event=>event.kind==="inbox.accepted").length,1);
});

test("consumer source rejects own cognition, producer self-report, and a foreign fixed Stage or Goal", async () => {
  const own=harness(); await own.enroll(); const ownId=addIndependentObservation(own,{actorId:"candidate-consumer"});
  own.change(data=>{data.cognitiveActors.add("candidate-consumer");});
  await assert.rejects(()=>own.service.execute(cognition,cmd({type:"inbox.accept",loopId,sourceEventId:ownId,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"})),failed("SOURCE_UNAVAILABLE"));
  const self=harness(); await self.enroll(); const selfId=addIndependentObservation(self,{actorId:worker.actorId,deliveryActorId:worker.actorId});
  await assert.rejects(()=>self.service.execute(cognition,cmd({type:"inbox.accept",loopId,sourceEventId:selfId,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"})),failed("SOURCE_UNAVAILABLE"));
  const foreign=harness(); await foreign.enroll(); const foreignId=addIndependentObservation(foreign,{stage:randomUUID(),goal:randomUUID()});
  await assert.rejects(()=>foreign.service.execute(cognition,cmd({type:"inbox.accept",loopId,sourceEventId:foreignId,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"})),failed("SOURCE_UNAVAILABLE"));
  const otherStage=harness(); await otherStage.enroll(); const otherId=addIndependentObservation(otherStage,{stage:randomUUID(),goal:goalId});
  await assert.rejects(()=>otherStage.service.execute(cognition,cmd({type:"inbox.accept",loopId,sourceEventId:otherId,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"})),failed("SOURCE_UNAVAILABLE"));
});

test("observation must match actual applied operation, actor, Delivery and enrolled event baseline", async () => {
  const cases=[
    (h:ReturnType<typeof harness>, id:string)=>h.change(d=>{d.source.set(id,{...d.source.get(id)!,sourceActorId:"forged"});}),
    (h:ReturnType<typeof harness>)=>h.change(d=>{d.workflowOp={...d.workflowOp!,status:"rejected"};}),
    (h:ReturnType<typeof harness>)=>h.change(d=>{d.observationFact={...d.observationFact!,deliveryId:randomUUID()};}),
    (h:ReturnType<typeof harness>, id:string)=>h.change(d=>{d.source.set(id,{...d.source.get(id)!,createdAtUtc:"2026-10-23T08:59:59.000Z"});}),
  ];
  for(const mutate of cases){
    const h=harness(); await h.enroll(); const id=addIndependentObservation(h); mutate(h,id);
    await assert.rejects(()=>h.service.execute(cognition,cmd({type:"inbox.accept",loopId,sourceEventId:id,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"})),failed("SOURCE_UNAVAILABLE"));
  }
});

test("a fabricated child is rejected even when another accepted Run is terminal", async () => {
  for (const runState of ["completed", "failed", "interrupted", "unknown"] as const) {
    const h=harness(); await h.enroll(); const inbox=await h.accept(); await h.ack(inbox.entityId);
    const first=await h.request(inbox.entityId), firstToken=randomUUID();
    await h.service.execute(worker,cmd({type:"dispatch.claim",dispatchId:first.entityId,claimToken:firstToken,leaseUntilUtc:after}));
    await h.service.execute(worker,cmd({type:"dispatch.start",dispatchId:first.entityId,claimToken:firstToken}));
    await h.service.execute(worker,cmd({type:"dispatch.resolve",dispatchId:first.entityId,claimToken:firstToken,result:"accepted",runtimeRunId:h.data.runId,reason:"bound"}));
    const secondTaskId=randomUUID(),secondDispatchId=randomUUID();
    h.change(data=>{
      data.runState=runState; data.extraTaskId=secondTaskId;
      const prior=data.dispatches.get(first.entityId)!;
      data.dispatches.set(secondDispatchId,{...prior,id:secondDispatchId,taskId:secondTaskId,version:1,state:"pending",
        claimToken:null,leaseUntilUtc:null,runtimeRunId:null,outcome:null,deliveryId:null});
    });
    const claim=()=>h.service.execute(worker,cmd({type:"dispatch.claim",dispatchId:secondDispatchId,claimToken:randomUUID(),leaseUntilUtc:after}));
    await assert.rejects(claim,failed("PARENT_NOT_READY")); // A fabricated child is not a formal request.
    assert.equal(h.data.dispatches.get(first.entityId)?.state,"accepted");
    assert.equal(h.data.dispatches.get(first.entityId)?.outcome,null);
    assert.equal(h.data.events.filter(event=>event.kind==="worker.outcome" || event.kind==="worker.decision").length,0);
  }
});

function waitingIssueFixture() {
  const h=harness();
  const eventId=randomUUID(),documentId=randomUUID(),revisionId=randomUUID(),operationId=randomUUID();
  const decisionId=randomUUID(),dispatchId=randomUUID(),writer="independent-issue-writer",contentHash="b".repeat(64);
  const make=async()=>{
    await h.enroll();
    h.advanceTime("2026-10-23T09:00:10.000Z");
    h.change(value=>{
      value.source.set(eventId,{projectId,id:eventId,createdAtUtc:after,kind:"document",subjectId:documentId,subjectVersion:1,
        sourceLoopId:null,originDispatchId:null,operationId,sourceActorId:writer,observationId:null,deliveryId:null,
        observationResult:null,issueRevisionId:revisionId,issueContentHash:contentHash});
      value.workflowOp={projectId,id:operationId,actorId:writer,commandType:"document.create",commandHash:"fixed",status:"applied",resultRefId:revisionId,resultVersion:1};
      value.issueFact={projectId,documentId,revisionId,contentHash,author:writer,kind:"issue",originTaskId:taskId,
        originTaskRevisionId:value.taskRevisionId,originTaskVersion:1,originRunId:null};
      const dispatch:OrchestrationDispatch={projectId,id:dispatchId,version:5,loopId,inboxId:randomUUID(),sourceEventId:eventId,
        taskId,taskVersion:1,parentDispatchId:null,recipientRoleId:cognitiveRoleId,purpose:"cognition",authorizationScopeId:scopeId,
        state:"completed",claimToken:null,leaseUntilUtc:null,runtimeRunId:value.runId,outcome:"waiting",deliveryId:null,
        evidenceRef:null,reason:"Waiting for evidence",requestedBy:cognition.actorId,createdAtUtc:after,updatedAtUtc:after};
      value.dispatches.set(dispatchId,dispatch);
      value.decisions.set(decisionId,{projectId,id:decisionId,dispatchId,runId:value.runId,taskId,kind:"waiting",
        reason:"Waiting for evidence",evidenceRefs:[],actorId:cognition.actorId,createdAtUtc:after});
      value.runState="completed";
      const loop=value.loops.get(loopId)!;value.loops.set(loopId,{...loop,dispatchCount:1});
    });
  };
  const command=()=>cmd({type:"loop.resumeWaiting",loopId,expectedLoopVersion:h.data.loops.get(loopId)!.version,
    decisionId,dispatchId,evidenceRef:"review:evidence",reason:"Resume fixed Issue review"});
  return {h,make,command,eventId,documentId,revisionId,decisionId,dispatchId};
}

test("review control resumes one terminal waiting cognition from fixed Issue without changing its history",async()=>{
  const f=waitingIssueFixture();await f.make();const before=structuredClone(f.h.data.decisions.get(f.decisionId));
  const initial=f.h.data.loops.get(loopId)!;const command=f.command();
  const first=await f.h.service.execute(reviewer,command);
  assert.deepEqual(first,{entityType:"loop",entityId:loopId,version:initial.version+1,replayed:false});
  assert.equal(f.h.data.loops.get(loopId)?.dispatchCount,initial.dispatchCount);
  assert.equal(f.h.data.loops.get(loopId)?.state,"active");
  assert.deepEqual(f.h.data.decisions.get(f.decisionId),before);
  const event=f.h.data.events.find(x=>x.kind==="waiting.resumed")!;
  assert.equal(event.detail.originalSourceEventId,f.eventId);
  assert.equal(event.detail.issueRevisionId,f.revisionId);
  assert.equal(f.h.data.source.get(event.id)?.issueContentHash,"b".repeat(64));
  const accepted=await f.h.service.execute(cognition,cmd({type:"inbox.accept",loopId,sourceEventId:event.id,
    recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"}));
  assert.equal(accepted.entityType,"inbox");
  assert.equal((await f.h.service.execute(reviewer,command)).replayed,true);
  assert.equal(f.h.data.events.filter(x=>x.kind==="waiting.resumed").length,1);
  await assert.rejects(()=>f.h.service.execute(reviewer,f.command()),failed("ALREADY_RESUMED"));
});

test("waiting resume rejects unapproved actors, stale or unsafe work, exhausted budget and non-Issue sources",async()=>{
  for(const mutation of ["worker","noReview","noWrite","stale","child","unknown","budget","paused","stopped","foreign","notIssue","wrongDecision","unsettled"] as const){
    const f=waitingIssueFixture();await f.make();let principal=reviewer;
    const command=f.command();
    f.h.change(value=>{
      if(mutation==="stale")value.loops.set(loopId,{...value.loops.get(loopId)!,version:2});
      if(mutation==="child")value.dispatches.set(randomUUID(),{...value.dispatches.get(f.dispatchId)!,id:randomUUID(),parentDispatchId:f.dispatchId});
      if(mutation==="unknown")value.runState="unknown";
      if(mutation==="budget")value.loops.set(loopId,{...value.loops.get(loopId)!,maxRuns:1});
      if(mutation==="paused")value.loops.set(loopId,{...value.loops.get(loopId)!,state:"paused"});
      if(mutation==="stopped")value.loops.set(loopId,{...value.loops.get(loopId)!,state:"stopped"});
      if(mutation==="foreign")value.dispatches.set(f.dispatchId,{...value.dispatches.get(f.dispatchId)!,loopId:randomUUID()});
      if(mutation==="notIssue")value.dispatches.set(f.dispatchId,{...value.dispatches.get(f.dispatchId)!,sourceEventId:source0});
      if(mutation==="wrongDecision")value.decisions.set(f.decisionId,{...value.decisions.get(f.decisionId)!,dispatchId:randomUUID()});
      if(mutation==="unsettled"){
        const id=randomUUID();value.dispatches.set(id,{...value.dispatches.get(f.dispatchId)!,id,state:"unknown"});
      }
    });
    if(mutation==="worker")principal={...reviewer,actorId:"worker-test"};
    if(mutation==="noReview")principal={...reviewer,permissions:["read","write"]};
    if(mutation==="noWrite")principal={...reviewer,permissions:["read","review"]};
    const code={worker:"FORBIDDEN",noReview:"FORBIDDEN",noWrite:"FORBIDDEN",stale:"VERSION_CONFLICT",
      child:"WAITING_UNAVAILABLE",unknown:"RUN_NOT_TERMINAL",budget:"BUDGET_EXHAUSTED",paused:"LOOP_PAUSED",
      stopped:"LOOP_STOPPED",foreign:"WAITING_UNAVAILABLE",notIssue:"SOURCE_UNAVAILABLE",
      wrongDecision:"WAITING_UNAVAILABLE",unsettled:"WAITING_UNAVAILABLE"}[mutation];
    await assert.rejects(()=>f.h.service.execute(principal,command),failed(code),mutation);
    assert.equal(f.h.data.events.filter(x=>x.kind==="waiting.resumed").length,0);
  }
});

test("waiting resume requires the enrolled Stage to remain active, including at resumed-source admission",async()=>{
  for(const state of ["reviewed","missing","foreignGoal","noStage"] as const){
    const f=waitingIssueFixture();await f.make();
    f.h.change(value=>{
      if(state==="reviewed")value.enrolledStageFact={projectId,id:stageId,goalId,state:"reviewed"};
      if(state==="missing")value.enrolledStageFact=null;
      if(state==="foreignGoal")value.enrolledStageFact={projectId,id:stageId,goalId:randomUUID(),state:"active"};
      if(state==="noStage")value.loops.set(loopId,{...value.loops.get(loopId)!,stageId:null});
    });
    await assert.rejects(()=>f.h.service.execute(reviewer,f.command()),failed("STAGE_NOT_ACTIVE"),state);
    assert.equal(f.h.data.events.some(x=>x.kind==="waiting.resumed"),false);
  }
  const f=waitingIssueFixture();await f.make();
  await f.h.service.execute(reviewer,f.command());
  const resumed=f.h.data.events.find(x=>x.kind==="waiting.resumed")!;
  f.h.change(value=>{value.enrolledStageFact={projectId,id:stageId,goalId,state:"reviewed"};});
  await assert.rejects(()=>f.h.service.execute(cognition,cmd({type:"inbox.accept",loopId,
    sourceEventId:resumed.id,recipientRoleId:cognitiveRoleId,purpose:"cognitive_review"})),failed("STAGE_NOT_ACTIVE"));
  assert.equal(f.h.data.source.get(resumed.id)?.kind,"waiting.resumed","historical source remains readable");
});

function divisionFixture() {
  const h = harness(), parentDispatchId = randomUUID(), parentRunId = randomUUID();
  const templateId = randomUUID(), templateHash = "b".repeat(64), documentId = randomUUID(), documentRevisionId = randomUUID();
  const template: DelegationTemplate = { id: templateId, revision: 1, projectId, goalId, loopId,
    existingRoleIds: [workerRoleId], cognitionRoleIds: [], newRoleAllocation: null, firstTaskId: taskId,
    actorId: "delegated-worker", authorizationScopeId: "scope:division", decisionActorIds: [cognition.actorId],
    allowedChoices: ["same-role-instance", "temporary-assignment"], cwd: "/tmp/evoloop-divison-test", model: "test-model",
    sandbox: "read-only", networkAccess: false, approvalPolicy: "on-request", expiresAtUtc: "2026-10-24T00:00:00.000Z" };
  const decision = () => cmd({ type: "division.decide", decisionId: randomUUID(), loopId,
    expectedLoopVersion: h.data.loops.get(loopId)!.version, sourceEventId: source1, parentDispatchId,
    documentId, documentRevisionId, documentContentHash: "a".repeat(64), firstTaskId: taskId,
    expectedFirstTaskVersion: 1, choice: "temporary-assignment", roleId: workerRoleId,
    templateId, templateRevision: 1, templateHash, reason: "bounded responsibility trial" });
  const setup = async () => {
    await h.enroll();
    h.change(value => {
      value.dispatches.set(parentDispatchId, { projectId, id: parentDispatchId, version: 5, loopId,
        inboxId: randomUUID(), sourceEventId: source1, taskId, taskVersion: 1, parentDispatchId: null,
        recipientRoleId: cognitiveRoleId, purpose: "cognition", authorizationScopeId: scopeId,
        state: "accepted", claimToken: null, leaseUntilUtc: null, runtimeRunId: parentRunId,
        outcome: "delivered", deliveryId: null, evidenceRef: null, reason: "review", requestedBy: cognition.actorId,
        createdAtUtc: at, updatedAtUtc: at });
      value.parentRunStates.set(parentRunId, "running");
    });
    h.setDelegation({template,hash:templateHash});
  };
  return { h, setup, decision, template, templateHash, parentDispatchId, parentRunId };
}

test("division decision pins material, bounded template and policy without refreshing Loop budget", async () => {
  const f = divisionFixture(); await f.setup();
  const initial = f.h.data.loops.get(loopId)!;
  const request = f.decision();
  const first = await f.h.service.execute(cognition, request);
  assert.equal(first.entityType, "binding");
  assert.equal(f.h.data.bindings.size, 1);
  assert.equal(f.h.data.loops.get(loopId)?.dispatchCount, initial.dispatchCount);
  assert.equal(f.h.data.loops.get(loopId)?.maxRuns, initial.maxRuns);
  const revised = f.h.data.policies.get(f.h.data.loops.get(loopId)!.currentPolicyRevisionId!)!;
  assert.equal(revised.bindingByRole[workerRoleId], first.entityId);
  const next = await f.h.accept(); await f.h.ack(next.entityId);
  const staticDispatch = await f.h.service.execute(cognition, cmd({type:"dispatch.request",inboxId:next.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:f.parentDispatchId,taskId,
    expectedTaskVersion:1,recipientRoleId:workerRoleId,purpose:"first trial run",authorizationScopeId:scopeId,
    reason:"original static authorization"}));
  assert.equal(f.h.data.dispatches.get(staticDispatch.entityId)?.bindingId,null,
    "the existing Role can still use its original static authorization");
  assert.equal((await f.h.service.execute(cognition, request)).replayed, true);
  await assert.rejects(() => f.h.service.execute(cognition, {...request,reason:"different intent"}), failed("OPERATION_CONFLICT"));
  assert.equal(f.h.data.bindings.size, 1);
});

test("current cognition worker may sign only the exact brokered parent under an explicit template", async () => {
  const f=divisionFixture();await f.setup();
  const runtimeWorker:Principal={actorId:`worker-${randomUUID()}`,projectIds:[projectId],permissions:["read","write","review"]};
  const scope={projectId,loopId,taskId,runId:f.parentRunId,roleId:cognitiveRoleId,kind:"cognition"};
  const request=f.decision();
  await assert.rejects(()=>f.h.service.execute(runtimeWorker,request),failed("FORBIDDEN"));
  f.h.setDelegatedWorkerScope(scope);
  await assert.rejects(()=>f.h.service.execute(runtimeWorker,{...request,operationId:op()}),failed("DELEGATION_DENIED"));
  f.h.setDelegation({template:{...f.template,decisionActorIds:[],cognitionRoleIds:[cognitiveRoleId]},hash:f.templateHash});
  for(const changed of [{...scope,roleId:workerRoleId},{...scope,runId:randomUUID()},
      {...scope,taskId:randomUUID()},{...scope,loopId:randomUUID()},{...scope,kind:"business"}]) {
    f.h.setDelegatedWorkerScope(changed);
    await assert.rejects(()=>f.h.service.execute(runtimeWorker,{...request,operationId:op()}),failed("FORBIDDEN"));
  }
  f.h.setDelegatedWorkerScope(scope);
  await assert.rejects(()=>f.h.service.execute(runtimeWorker,{...request,operationId:op(),parentDispatchId:randomUUID()}),failed("INVALID_CAUSALITY"));
  const chosen=await f.h.service.execute(runtimeWorker,{...request,operationId:op()});
  assert.equal(chosen.entityType,"binding");
  await assert.rejects(()=>f.h.service.execute(runtimeWorker,{...request,operationId:op(),
    expectedLoopVersion:f.h.data.loops.get(loopId)!.version}),failed("ALREADY_EXISTS"));
  await assert.rejects(()=>f.h.service.execute(runtimeWorker,cmd({type:"worker.decision",decisionId:randomUUID(),
    dispatchId:f.parentDispatchId,runId:randomUUID(),kind:"waiting",divisionDecisionId:chosen.entityId,
    reason:"Wrong brokered Run",evidenceRefs:[]})),failed("FORBIDDEN"));
  await assert.rejects(()=>f.h.service.execute(cognition,cmd({type:"worker.decision",decisionId:randomUUID(),
    dispatchId:f.parentDispatchId,runId:f.parentRunId,kind:"waiting",divisionDecisionId:randomUUID(),
    reason:"Wrong intent",evidenceRefs:[]})),failed("INVALID_CAUSALITY"));
  const waiting=await f.h.service.execute(cognition,cmd({type:"worker.decision",decisionId:randomUUID(),
    dispatchId:f.parentDispatchId,runId:f.parentRunId,kind:"waiting",divisionDecisionId:chosen.entityId,
    reason:"Use the fixed prior intent",evidenceRefs:[]}));
  assert.equal((await f.h.service.getDecision({...reviewer,permissions:["read","write","review"]},projectId,waiting.entityId))?.divisionDecisionId,chosen.entityId);
});

test("division intent closes when cognition has signed a final choice or its Run ended", async () => {
  const decided=divisionFixture();await decided.setup();
  await decided.h.service.execute(cognition,cmd({type:"worker.decision",decisionId:randomUUID(),
    dispatchId:decided.parentDispatchId,runId:decided.parentRunId,kind:"no_action",divisionDecisionId:null,
    reason:"No change needed",evidenceRefs:[]}));
  await assert.rejects(()=>decided.h.service.execute(cognition,decided.decision()),failed("PARENT_DECIDED"));
  const terminal=divisionFixture();await terminal.setup();
  terminal.h.change(data=>data.parentRunStates.set(terminal.parentRunId,"completed"));
  await assert.rejects(()=>terminal.h.service.execute(cognition,terminal.decision()),failed("PARENT_NOT_READY"));
});

test("method-only intent needs no delegated Role and a later stop leaves it unused", async () => {
  const f=divisionFixture();await f.setup();
  f.h.change(data=>{data.taskOwnerRoleId="method-owner";});
  const request={...f.decision(),choice:"method" as const,roleId:"method-owner",
    templateId:null,templateRevision:null,templateHash:null};
  const intent=await f.h.service.execute(cognition,request);
  assert.equal(intent.entityType,"decision");
  assert.equal(f.h.data.bindings.size,0);
  const stopped=await f.h.service.execute(cognition,cmd({type:"worker.decision",decisionId:randomUUID(),
    dispatchId:f.parentDispatchId,runId:f.parentRunId,kind:"stop",divisionDecisionId:null,
    reason:"Stop after inspection",evidenceRefs:[]}));
  assert.equal((await f.h.service.getDecision({...reviewer,permissions:["read","write","review"]},projectId,stopped.entityId))?.divisionDecisionId,null);
});

test("division rejects text-only authority, foreign scope, changed material, outsider and revoked template", async () => {
  const f = divisionFixture(); await f.setup();
  const request = f.decision();
  await assert.rejects(() => f.h.service.execute(worker, request), failed("DELEGATION_DENIED"));
  await assert.rejects(() => f.h.service.execute(cognition, {...request,operationId:op(),documentContentHash:"c".repeat(64)}), failed("MATERIAL_CHANGED"));
  await assert.rejects(() => f.h.service.execute(cognition, {...request,operationId:op(),firstTaskId:randomUUID()}), failed("TASK_CHANGED"));
  f.h.setDelegation({template:{...f.template,goalId:randomUUID()},hash:f.templateHash});
  await assert.rejects(() => f.h.service.execute(cognition, {...request,operationId:op()}), failed("DELEGATION_DENIED"));
  f.h.setDelegation(null);
  await assert.rejects(() => f.h.service.execute(cognition, {...request,operationId:op()}), failed("DELEGATION_DENIED"));
  f.h.setDelegation({template:{...f.template,model:"expanded-model"},hash:"c".repeat(64)});
  await assert.rejects(() => f.h.service.execute(cognition, {...request,operationId:op()}), failed("DELEGATION_DENIED"));
  f.h.advanceTime("2026-10-25T00:00:00.000Z");
  f.h.setDelegation({template:f.template,hash:f.templateHash});
  await assert.rejects(() => f.h.service.execute(cognition, {...request,operationId:op()}), failed("DELEGATION_DENIED"));
});

test("a newly accepted Role consumes one delegated allocation but cannot dispatch before continuation", async () => {
  const f = divisionFixture(); await f.setup();
  const newRoleId = randomUUID();
  f.h.setRoleState(newRoleId,{state:"trial",firstTaskId:taskId,accepted:true});
  f.h.setDelegation({template:{...f.template,existingRoleIds:[],newRoleAllocation:{maxTotal:1,requiredState:"trial"},
    allowedChoices:["new-role"]},hash:f.templateHash});
  const request = {...f.decision(),choice:"new-role" as const,roleId:newRoleId};
  const chosen = await f.h.service.execute(cognition,request);
  assert.equal(f.h.data.bindings.get(chosen.entityId)?.choice,"new-role");
  assert.equal(f.h.data.bindings.get(chosen.entityId)?.firstTaskVersion,1);
  const next = await f.h.accept(); await f.h.ack(next.entityId);
  await assert.rejects(() => f.h.service.execute(cognition,cmd({type:"dispatch.request",inboxId:next.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:f.parentDispatchId,taskId,
    expectedTaskVersion:1,recipientRoleId:newRoleId,purpose:"unwired trial",authorizationScopeId:scopeId,
    reason:"first Task"})),failed("DYNAMIC_EXECUTION_PENDING"));
  await f.h.service.execute(reviewer,cmd({type:"division.revoke",loopId,
    expectedLoopVersion:f.h.data.loops.get(loopId)!.version,bindingId:chosen.entityId,reason:"stop trial"}));
  assert.equal(f.h.data.bindings.size,1,"withdrawal does not return the new Role allocation");
  await assert.rejects(() => f.h.service.execute(cognition,cmd({type:"dispatch.request",inboxId:next.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:f.parentDispatchId,taskId,
    expectedTaskVersion:1,recipientRoleId:newRoleId,purpose:"revoked trial",authorizationScopeId:scopeId,
    reason:"first Task"})),failed("INVALID_CAUSALITY"));
});

test("revoke retains historical policy and cumulative binding but removes current dynamic permission", async () => {
  const f = divisionFixture(); await f.setup();
  const binding = await f.h.service.execute(cognition, f.decision());
  const formerId = f.h.data.loops.get(loopId)!.currentPolicyRevisionId!;
  await f.h.service.execute(reviewer, cmd({type:"division.revoke",loopId,
    expectedLoopVersion:f.h.data.loops.get(loopId)!.version,bindingId:binding.entityId,reason:"trial stopped"}));
  assert.equal(f.h.data.policies.get(formerId)?.bindingByRole[workerRoleId], binding.entityId);
  assert.equal(f.h.data.policies.get(f.h.data.loops.get(loopId)!.currentPolicyRevisionId!)?.bindingByRole[workerRoleId], undefined);
  assert.equal(f.h.data.bindings.size, 1);
  assert.equal(f.h.data.loops.get(loopId)?.dispatchCount, 0);
});
