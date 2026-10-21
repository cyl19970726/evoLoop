import assert from "node:assert/strict";
import test from "node:test";
import { commandSchema, type BasisSet, type Principal, type Task, type TaskRevision } from "@evoloop/contracts";
import type { EvaluationAttempt, EvaluationAssessment, EvaluationConclusion, EvaluationDefinition, EvaluationRevision } from "@evoloop/contracts/evaluation";
import type { Transaction } from "@evoloop/contracts/ports";
import { applyEvaluation, taskSignature } from "../src/evaluation/index.ts";
import { reserveRuntime } from "../src/runtime/reserve.ts";
import { RuntimeWorkflowService } from "../src/runtime/service.ts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const hash = "a".repeat(64);
const projectId = id(1), taskId = id(2), primaryId = id(3), sourceRevisionId = id(4), basisId = id(5);
const principal: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const task: Task = { projectId, id: taskId, version: 2, currentRevisionId: sourceRevisionId, title: "Check source",
  content: "Read the fixed evidence", contentDocumentId: primaryId, contentRevisionId: id(6),
  acceptance: "Record the result", owner: "evaluator", kind: "validation", state: "in_progress" };
const sourceRevision: TaskRevision = { ...task, taskId, id: sourceRevisionId, basisSetId: basisId,
  actorId: "owner", reason: "started", createdAt: "2026-10-21T00:00:00Z" };
const basis: BasisSet = { projectId, taskId, taskRevisionId: sourceRevisionId, id: basisId,
  members: [{ documentId: primaryId, revisionId: id(6) }], sealed: true };

function fixture() {
  const state = { task: { ...task }, revisions: [sourceRevision], bases: [basis], definitions: [] as EvaluationRevision[],
    attempts: [] as EvaluationAttempt[], assessments: [] as EvaluationAssessment[], conclusions: [] as EvaluationConclusion[], runs: [] as any[],
    events: [] as any[], sessions: [{ projectId, id: id(10), roleId: "evaluator", cwd: "/tmp/eval", authorizationScope: "project",
      model: "model-a", sandbox: "read-only", approvalPolicy: "on-request", state: "ready", version: 2,
      nativeThreadId: "native", nativeSessionId: "session", operationId: id(11), actorId: "reviewer",
      createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" }] };
  const tx = {
    getTask: async (key: string) => key === taskId ? state.task : null,
    getTaskRevision: async (_task: string, key: string) => state.revisions.find(item => item.id === key) ?? null,
    getBasisSet: async (_task: string, rev: string) => state.bases.find(item => item.taskRevisionId === rev) ?? null,
    getDocumentRevision: async (documentId: string, revisionId: string) => documentId === primaryId && revisionId === id(6)
      ? { contentHash: hash } : null,
    getDocument: async (key: string) => key === primaryId ? { id: primaryId, adoptedRevisionId: id(6) } : null,
    getGitSourceRef: async () => null,
    listTaskExternalSnapshot: async () => [],
    insertTaskExternalSnapshot: async () => {},
    getEvaluation: async (key: string, rev?: string) => state.definitions.filter(item => item.evaluationId === key && (!rev || item.id === rev)).at(-1) ?? null,
    listEvaluationAttempts: async (key: string, rev: string) => state.attempts.filter(item => item.evaluationId === key && item.revisionId === rev),
    listEvaluationAssessments: async (key: string, rev: string) => state.assessments.filter(item => item.evaluationId === key && item.revisionId === rev),
    listEvaluationConclusions: async (key: string, rev: string) => state.conclusions.filter(item => item.evaluationId === key && item.revisionId === rev),
    insertEvaluationRevision: async (value: EvaluationRevision) => { state.definitions.push(value); },
    insertEvaluationAttempt: async (value: EvaluationAttempt) => { state.attempts.push(value); },
    insertEvaluationAssessment: async (value: EvaluationAssessment) => { state.assessments.push(value); },
    insertEvaluationConclusion: async (value: EvaluationConclusion) => { state.conclusions.push(value); },
    getDelivery: async () => null,
    listObservations: async () => [],
    getRuntimeSession: async (key: string) => state.sessions.find(item => item.id === key) ?? null,
    listRuntimeRuns: async (key?: string) => state.runs.filter(item => !key || item.taskId === key),
    getRuntimeRun: async (key: string) => state.runs.find(item => item.id === key) ?? null,
    insertRuntimeRun: async (run: any) => { state.runs.push(run); },
    updateRuntimeRun: async (run: any) => { state.runs[state.runs.findIndex(item => item.id === run.id)] = run; },
    appendRuntimeEvent: async (event: any) => { state.events.push(event); },
    listImpacts: async () => [],
    listBasisDecisions: async () => [],
    insertTaskRevision: async (revision: TaskRevision) => { state.revisions.push(revision); },
    insertSealedBasisSet: async (next: BasisSet) => { state.bases.push(next); },
    updateTask: async (next: Task) => { state.task = next; },
  } as unknown as Transaction;
  return { state, tx };
}

async function definition(tx: Transaction): Promise<EvaluationDefinition> {
  return { ownerTaskId: taskId, question: "Does the fixed Wiki help?",
    protocol: { kind: "document", id: primaryId, revision: id(6), contentHash: hash },
    case: { id: id(20), taskId, sourceTaskRevisionId: sourceRevisionId, sourceSignature: await taskSignature(tx, task),
      commonInput: "Answer using fixed materials", materials: [{ kind: "document", id: primaryId, revision: id(6), contentHash: hash }],
      criteria: "Check the fixed result" },
    conditions: [
      { id: id(21), kind: "direct", wikiRefs: null, model: "model-a", environment: { cwd: "/tmp/eval", authorizationScope: "project", sandbox: "read-only", approvalPolicy: "on-request" } },
      { id: id(22), kind: "wiki", wikiRefs: [{ kind: "wiki", id: id(23), revision: id(24), contentHash: hash }],
        model: "model-a", environment: { cwd: "/tmp/eval", authorizationScope: "project", sandbox: "read-only", approvalPolicy: "on-request" } },
    ], limits: "Tool access isolation is unverified" };
}

test("freezes a neutral case and auto-registers a real Run attempt with derived Task revision", async () => {
  const { state, tx } = fixture();
  const frozen = await definition(tx);
  await applyEvaluation({ tx, command: { type: "evaluation.create", projectId, operationId: id(30),
    evaluationId: id(31), revisionId: id(32), definition: frozen }, principal, now: "2026-10-21T00:00:00Z" });
  let seq = 40;
  const result = await reserveRuntime({ tx, command: { type: "runtime.run.reserve", projectId, operationId: id(33),
    runId: id(34), taskId, sessionId: id(10), expectedVersion: 2, input: frozen.case.commonInput,
    evaluation: { evaluationId: id(31), revisionId: id(32), caseId: id(20), conditionId: id(21) } },
    principal, now: "2026-10-21T00:01:00Z", nextId: () => id(seq++), hash: () => hash });
  assert.equal(result.result.status, "applied");
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0]!.sourceTaskRevisionId, sourceRevisionId);
  assert.notEqual(state.attempts[0]!.actualTaskRevisionId, sourceRevisionId);
  assert.equal(state.runs[0]!.evaluationBinding.attemptId, state.attempts[0]!.id);
  assert.equal(state.runs[0]!.evaluationPacket, null);
  assert.equal(state.attempts[0]!.ordinal, 1);
  const workflow = new RuntimeWorkflowService({ uow: { transaction: async (_project, action) => action(tx),
    read: async (_project, action) => action(tx) }, clock: { now: () => "2026-10-21T00:02:00Z" }, ids: { next: () => id(seq++) } });
  await assert.rejects(workflow.beginDispatch(projectId, id(34)), /fixed-input packet is required/);
  await workflow.attachEvaluationPacket(projectId, id(34), 1, { payloadRef: id(60), contentHash: hash,
    manifestHash: hash, builderVersion: "v1", sources: [{ kind: "document", id: primaryId,
      revision: id(6), contentHash: hash }] });
  await workflow.beginDispatch(projectId, id(34));
  assert.equal(state.runs[0]!.state, "dispatching");
  state.runs[0]!.state = "completed";
  await assert.rejects(reserveRuntime({ tx, command: { type: "runtime.run.reserve", projectId,
    operationId: id(61), runId: id(62), taskId, sessionId: id(10), expectedVersion: 3,
    input: frozen.case.commonInput, evaluation: { evaluationId: id(31), revisionId: id(32),
      caseId: id(20), conditionId: id(22) } }, principal, now: "2026-10-21T00:02:10Z",
    nextId: () => id(seq++), hash: () => hash }), /fresh unused owned session/);
  assert.equal(state.attempts.length, 1);
  const assessment = await applyEvaluation({ tx, command: { type: "evaluation.assessment.record",
    projectId, operationId: id(50), evaluationId: id(31), revisionId: id(32), assessmentId: id(51),
    attemptId: state.attempts[0]!.id, deliveryId: null, observationId: null, supersedesId: null,
    values: { sourceFidelity: "unknown", knowledgeAdoption: "not_applicable", deliveryQuality: "unknown", humanEffect: "unknown" },
    costs: [{ phase: "run", unit: "USD", amount: null, source: "provider receipt unavailable", evidence: null }],
    evidence: [], assessorKind: "agent", reason: "The Run has no observed output yet" }, principal, now: "2026-10-21T00:02:00Z" });
  assert.equal(assessment.result.status, "applied");
  await assert.rejects(applyEvaluation({ tx, command: { type: "evaluation.conclusion.record",
    projectId, operationId: id(52), evaluationId: id(31), revisionId: id(32), conclusionId: id(53),
    assessmentIds: [id(51)], supersedesId: null, finding: "No comparison yet", limits: "Only direct attempt exists",
    comparability: "comparable", comparabilityReason: "Claimed comparable", nextChoice: "wait", affectedRefs: [], nextActionRef: null },
    principal, now: "2026-10-21T00:03:00Z" }), /cost coverage and technical isolation/);
  await applyEvaluation({ tx, command: { type: "evaluation.conclusion.record",
    projectId, operationId: id(54), evaluationId: id(31), revisionId: id(32), conclusionId: id(55),
    assessmentIds: [id(51)], supersedesId: null, finding: "No comparison yet", limits: "Only direct attempt exists; cost unknown",
    comparability: "with_limits", comparabilityReason: "Missing Wiki group", nextChoice: "wait", affectedRefs: [], nextActionRef: null },
    principal, now: "2026-10-21T00:03:00Z" });
  assert.equal(state.conclusions.length, 1);
  assert.equal(state.task.state, "in_progress");
  await applyEvaluation({ tx, command: { type: "evaluation.assessment.record", projectId,
    operationId: id(63), evaluationId: id(31), revisionId: id(32), assessmentId: id(64),
    attemptId: state.attempts[0]!.id, deliveryId: null, observationId: null, supersedesId: id(51),
    values: { sourceFidelity: "unknown", knowledgeAdoption: "not_applicable", deliveryQuality: "failed", humanEffect: "unknown" },
    costs: [{ phase: "run", unit: "USD", amount: null, source: "provider receipt unavailable", evidence: null }],
    evidence: [], assessorKind: "human", reason: "Corrected after checking the missing output" },
    principal, now: "2026-10-21T00:04:00Z" });
  const correction = { type: "evaluation.conclusion.record" as const, projectId, operationId: id(65),
    evaluationId: id(31), revisionId: id(32), conclusionId: id(66), assessmentIds: [id(51)],
    supersedesId: id(55), finding: "The attempted run failed", limits: "Wiki group and cost absent",
    comparability: "with_limits" as const, comparabilityReason: "Missing Wiki group",
    nextChoice: "wait" as const, affectedRefs: [], nextActionRef: null };
  await assert.rejects(applyEvaluation({ tx, command: correction, principal,
    now: "2026-10-21T00:05:00Z" }), /latest corrected assessment/);
  await applyEvaluation({ tx, command: { ...correction, assessmentIds: [id(64)] }, principal,
    now: "2026-10-21T00:05:00Z" });
  assert.equal(state.conclusions.length, 2);
  const next = { ...correction, operationId: id(67), conclusionId: id(68), supersedesId: id(66),
    assessmentIds: [id(64)], nextActionRef: { kind: "task" as const, taskId, taskRevisionId: sourceRevisionId } };
  assert.equal(commandSchema.safeParse(next).success, true);
  await applyEvaluation({ tx, command: next, principal, now: "2026-10-21T00:06:00Z" });
  assert.deepEqual(state.conclusions.at(-1)?.nextActionRef, next.nextActionRef);
  assert.equal(commandSchema.safeParse({ ...next, nextActionRef: { ...next.nextActionRef, contentHash: hash } }).success, false);
});

test("conclusion rejects a foreign next Task and a revision from the wrong Task", async () => {
  const { state, tx } = fixture();
  const frozen = await definition(tx);
  state.definitions.push({ projectId, evaluationId: id(150), id: id(151), version: 1,
    definition: frozen, actorId: principal.actorId, reason: "fixed", createdAt: "2026-10-21T00:00:00Z" });
  state.attempts.push({ projectId, id: id(152), evaluationId: id(150), revisionId: id(151), caseId: id(20),
    conditionId: id(21), ordinal: 1, runId: id(153), sourceTaskRevisionId: sourceRevisionId,
    actualTaskRevisionId: sourceRevisionId, sessionId: id(10), actorId: principal.actorId, createdAt: "2026-10-21T00:01:00Z" });
  state.assessments.push({ projectId, id: id(154), evaluationId: id(150), revisionId: id(151),
    attemptId: id(152), deliveryId: null, observationId: null, supersedesId: null,
    values: { sourceFidelity: "unknown", knowledgeAdoption: "not_applicable", deliveryQuality: "unknown", humanEffect: "unknown" },
    costs: [], evidence: [], assessorKind: "human", actorId: principal.actorId,
    reason: "No output", createdAt: "2026-10-21T00:02:00Z" });
  const command = { type: "evaluation.conclusion.record" as const, projectId, operationId: id(155),
    evaluationId: id(150), revisionId: id(151), conclusionId: id(156), assessmentIds: [id(154)],
    supersedesId: null, finding: "No result", limits: "No Wiki attempt", comparability: "with_limits" as const,
    comparabilityReason: "One condition only", nextChoice: "wait" as const, affectedRefs: [],
    nextActionRef: { kind: "task" as const, taskId: id(157), taskRevisionId: id(158) } };
  const originalGetTask = tx.getTask.bind(tx), originalGetRevision = tx.getTaskRevision.bind(tx);
  tx.getTask = async key => key === id(157) ? { ...task, projectId: id(159), id: key } : originalGetTask(key);
  tx.getTaskRevision = async (taskKey, revisionKey) => taskKey === id(157) && revisionKey === id(158)
    ? { ...sourceRevision, projectId: id(159), taskId: taskKey, id: revisionKey } : originalGetRevision(taskKey, revisionKey);
  await assert.rejects(applyEvaluation({ tx, command, principal, now: "2026-10-21T00:03:00Z" }), /this project's Task/);
  tx.getTask = async key => key === id(157) ? { ...task, id: key } : originalGetTask(key);
  tx.getTaskRevision = async (taskKey, revisionKey) => taskKey === id(157) && revisionKey === id(158)
    ? { ...sourceRevision, taskId, id: revisionKey } : originalGetRevision(taskKey, revisionKey);
  await assert.rejects(applyEvaluation({ tx, command, principal, now: "2026-10-21T00:03:00Z" }), /this project's Task/);
  assert.equal(state.conclusions.length, 0);
});

test("two recorded conditions and known run costs still do not establish full comparability", async () => {
  const { state, tx } = fixture();
  const frozen = await definition(tx);
  state.definitions.push({ projectId, evaluationId: id(170), id: id(171), version: 1,
    definition: frozen, actorId: principal.actorId, reason: "fixed", createdAt: "2026-10-21T00:00:00Z" });
  for (const [index, conditionId] of [id(21), id(22)].entries()) {
    state.attempts.push({ projectId, id: id(172 + index), evaluationId: id(170), revisionId: id(171),
      caseId: id(20), conditionId, ordinal: 1, runId: id(174 + index), sourceTaskRevisionId: sourceRevisionId,
      actualTaskRevisionId: sourceRevisionId, sessionId: id(10), actorId: principal.actorId,
      createdAt: "2026-10-21T00:01:00Z" });
    state.assessments.push({ projectId, id: id(176 + index), evaluationId: id(170), revisionId: id(171),
      attemptId: id(172 + index), deliveryId: null, observationId: null, supersedesId: null,
      values: { sourceFidelity: "unknown", knowledgeAdoption: index ? "not_observed" : "not_applicable",
        deliveryQuality: "failed", humanEffect: "unknown" },
      costs: [{ phase: "run", unit: "USD", amount: 0.5, source: "provider receipt", evidence: null }],
      evidence: [], assessorKind: "human", actorId: principal.actorId,
      reason: "Preflight failed", createdAt: "2026-10-21T00:02:00Z" });
  }
  await assert.rejects(applyEvaluation({ tx, command: { type: "evaluation.conclusion.record", projectId,
    operationId: id(178), evaluationId: id(170), revisionId: id(171), conclusionId: id(179),
    assessmentIds: [id(176), id(177)], supersedesId: null, finding: "No outcome",
    limits: "Preflight failures; costs only cover run phase", comparability: "comparable",
    comparabilityReason: "Two conditions were recorded", nextChoice: "wait", affectedRefs: [], nextActionRef: null },
    principal, now: "2026-10-21T00:03:00Z" }), /cost coverage and technical isolation/);
  assert.equal(state.conclusions.length, 0);
});

test("direct comparison rejects a Task whose mandatory basis already includes Wiki", async () => {
  const { tx } = fixture();
  tx.listTaskExternalSnapshot = async () => [{ slotId: id(70), kind: "wiki", referenceId: id(71),
    revision: id(72), contentHash: hash }] as any;
  const frozen = await definition(tx);
  await assert.rejects(applyEvaluation({ tx, command: { type: "evaluation.create", projectId, operationId: id(30),
    evaluationId: id(31), revisionId: id(32), definition: frozen }, principal, now: "2026-10-21T00:00:00Z" }),
  /cannot omit Wiki/);
});

test("Wiki attempt requires the declared model and a packet containing its fixed Wiki revision", async () => {
  const { state, tx } = fixture();
  const frozen = await definition(tx);
  await applyEvaluation({ tx, command: { type: "evaluation.create", projectId, operationId: id(80),
    evaluationId: id(81), revisionId: id(82), definition: frozen }, principal, now: "2026-10-21T00:00:00Z" });
  state.sessions[0]!.model = "different-model";
  let seq = 90;
  const command = { type: "runtime.run.reserve" as const, projectId, operationId: id(83), runId: id(84),
    taskId, sessionId: id(10), expectedVersion: 2, input: frozen.case.commonInput,
    evaluation: { evaluationId: id(81), revisionId: id(82), caseId: id(20), conditionId: id(22) } };
  await assert.rejects(reserveRuntime({ tx, command, principal, now: "2026-10-21T00:01:00Z",
    nextId: () => id(seq++), hash: () => hash }), /model or declared environment/);
  assert.equal(state.attempts.length, 0);
  state.sessions[0]!.model = "model-a";
  await reserveRuntime({ tx, command, principal, now: "2026-10-21T00:01:00Z",
    nextId: () => id(seq++), hash: () => hash });
  const workflow = new RuntimeWorkflowService({ uow: { transaction: async (_project, action) => action(tx),
    read: async (_project, action) => action(tx) }, clock: { now: () => "2026-10-21T00:02:00Z" }, ids: { next: () => id(seq++) } });
  await assert.rejects(workflow.attachEvaluationPacket(projectId, id(84), 1, { payloadRef: id(85),
    contentHash: hash, manifestHash: hash, builderVersion: "v1",
    sources: [{ kind: "document", id: primaryId, revision: id(6), contentHash: hash }] }), /manifest differs/);
  const attached = await workflow.attachEvaluationPacket(projectId, id(84), 1, { payloadRef: id(85),
    contentHash: hash, manifestHash: hash, builderVersion: "v1", sources: [
      { kind: "document", id: primaryId, revision: id(6), contentHash: hash },
      { kind: "wiki", id: id(23), revision: id(24), contentHash: hash },
    ] });
  assert.equal(attached.evaluationPacket?.sources.length, 2);
});

test("derived revision rejects a changed external head before creating Run or Attempt", async () => {
  const { state, tx } = fixture();
  const oldSource = { id: id(101), projectId, taskId, taskRevisionId: sourceRevisionId, slotId: id(102), version: 1,
    decision: "adopt", kind: "git", referenceId: id(103), revision: "a".repeat(40), contentHash: hash,
    reason: "fixed", actionImpact: "none", actorId: "owner", createdAt: "2026-10-21T00:00:00Z",
    observedCurrentRevision: "a".repeat(40), observedCurrentHash: hash, observedCurrentValidity: "valid" } as const;
  tx.listTaskExternalSnapshot = async (_task, revisionId) => revisionId === sourceRevisionId ? [oldSource] as any :
    [{ ...oldSource, id: id(104), taskRevisionId: revisionId, version: 2 }] as any;
  const frozen = await definition(tx);
  await applyEvaluation({ tx, command: { type: "evaluation.create", projectId, operationId: id(105),
    evaluationId: id(106), revisionId: id(107), definition: frozen }, principal, now: "2026-10-21T00:00:00Z" });
  let seq = 110;
  await assert.rejects(reserveRuntime({ tx, command: { type: "runtime.run.reserve", projectId,
    operationId: id(108), runId: id(109), taskId, sessionId: id(10), expectedVersion: 2,
    input: frozen.case.commonInput, evaluation: { evaluationId: id(106), revisionId: id(107),
      caseId: id(20), conditionId: id(21) } }, principal, now: "2026-10-21T00:01:00Z",
    nextId: () => id(seq++), hash: () => hash }), /Current external heads differ/);
  assert.equal(state.runs.length, 0);
  assert.equal(state.attempts.length, 0);
});
