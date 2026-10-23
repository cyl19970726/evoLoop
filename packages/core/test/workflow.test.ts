import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  BasisDecision, BasisSet, Document, DocumentDecision, DocumentRevision, Impact, Operation,
  OutboxEvent, Principal, Project, Task, TaskDocumentLink, TaskRevision,
  Goal, GoalRevision, Stage, StageRevision, StageReview, TaskProposal, TaskJudgement, Delivery, ConsumerObservation, TaskClosure,
  DiscussionRecord, DiscussionEvent,
} from "@evoloop/contracts";
import type { Reader, Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import type { CognitiveClosureFact, WaitingHandoffFact, ChildHandoffFact } from "@evoloop/contracts/ports";
import { DomainError, WorkflowService } from "../src/index.ts";
import type { RoleRecord, RoleRevision, RoleTrialReview, RoleHandoff, RoleSessionBinding } from "@evoloop/contracts/roles";
import type { ScheduleDefinition, ScheduleRevision, Occurrence } from "@evoloop/contracts/scheduling";

const projectId = "00000000-0000-4000-8000-000000000001";
const documentId = "00000000-0000-4000-8000-000000000002";
const secondDocumentId = "00000000-0000-4000-8000-000000000003";
const taskA = "00000000-0000-4000-8000-000000000004";
const taskB = "00000000-0000-4000-8000-000000000005";
const principal: Principal = { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] };

type State = {
  project: Project | null;
  documents: Record<string, Document>;
  documentRevisions: Record<string, DocumentRevision>;
  documentDecisions: DocumentDecision[];
  tasks: Record<string, Task>;
  taskRevisions: Record<string, TaskRevision>;
  bases: Record<string, BasisSet>;
  links: TaskDocumentLink[];
  impacts: Record<string, Impact>;
  basisDecisions: BasisDecision[];
  operations: Record<string, Operation>;
  outbox: OutboxEvent[];
  goals: Record<string, Goal>;
  goalRevisions: GoalRevision[];
  stages: Record<string, Stage>;
  stageRevisions: StageRevision[];
  stageReviews: StageReview[];
  proposals: TaskProposal[];
  judgements: TaskJudgement[];
  deliveries: Delivery[];
  observations: ConsumerObservation[];
  closures: TaskClosure[];
  cognitiveClosureFact: CognitiveClosureFact | null;
  waitingHandoffFact: WaitingHandoffFact | null;
  childHandoffFact: ChildHandoffFact | null;
  discussions: Record<string, DiscussionRecord>;
  discussionEvents: DiscussionEvent[];
  roles: Record<string, RoleRecord>;
  roleRevisions: RoleRevision[];
  roleReviews: RoleTrialReview[];
  roleHandoffs: RoleHandoff[];
  roleBindings: RoleSessionBinding[];
  schedules: Record<string, ScheduleDefinition>;
  scheduleRevisions: ScheduleRevision[];
  occurrences: Occurrence[];
};

class MemoryUow implements UnitOfWork {
  state: State = {
    project: null, documents: {}, documentRevisions: {}, documentDecisions: [], tasks: {},
    taskRevisions: {}, bases: {}, links: [], impacts: {}, basisDecisions: [], operations: {}, outbox: [],
    goals: {}, goalRevisions: [], stages: {}, stageRevisions: [], stageReviews: [], proposals: [], judgements: [], deliveries: [], observations: [], closures: [], cognitiveClosureFact: null, waitingHandoffFact: null, childHandoffFact: null,
    discussions: {}, discussionEvents: [],
    roles: {}, roleRevisions: [], roleReviews: [], roleHandoffs: [], roleBindings: [], schedules: {}, scheduleRevisions: [], occurrences: [],
  };
  async transaction<T>(_projectId: string, action: (tx: Transaction) => Promise<T>): Promise<T> {
    let state = structuredClone(this.state);
    const reader = (): Reader => ({
      getRuntimeSession: async () => null,
      listRuntimeSessions: async () => [],
      getRuntimeRun: async () => null,
      listRuntimeRuns: async () => [],
      listRuntimeEvents: async () => [],
      listRuntimeSessionEvents: async () => [],
      getDiscussion: async id => state.discussions[id] ?? null,
      listDiscussions: async (limit, cursor) => {
        const values = Object.values(state.discussions).sort((a, b) => a.id.localeCompare(b.id));
        const start = cursor ? values.findIndex(item => item.id === cursor) + 1 : 0;
        return { items: values.slice(start, start + limit), nextCursor: values[start + limit]?.id ?? null };
      },
      listDiscussionEvents: async id => state.discussionEvents.filter(item => item.discussionId === id).sort((a, b) => a.version - b.version),
      getRole: async id => state.roles[id] ?? null,
      listRoles: async (limit = 50, cursor) => {
        const values = Object.values(state.roles).sort((a, b) => a.id.localeCompare(b.id));
        const start = cursor ? Math.max(0, values.findIndex(item => item.id === cursor) + 1) : 0;
        return { items: values.slice(start, start + limit), nextCursor: values[start + limit]?.id ?? null };
      },
      listRevisions: async id => state.roleRevisions.filter(item => item.roleId === id),
      listReviews: async id => state.roleReviews.filter(item => item.roleId === id),
      listHandoffs: async id => state.roleHandoffs.filter(item => item.roleId === id),
      listSessionBindings: async id => state.roleBindings.filter(item => item.roleId === id),
      getSchedule: async id => state.schedules[id] ?? null,
      listSchedules: async () => Object.values(state.schedules),
      listScheduleRevisions: async id => state.scheduleRevisions.filter(item => item.scheduleId === id),
      listOccurrences: async id => state.occurrences.filter(item => item.scheduleId === id),
      getDocumentPayloadRevision: async (documentId, revisionId) => {
        const item = state.documentRevisions[revisionId];
        return item?.documentId === documentId ? item : null;
      },
      listDocumentAssets: async (documentId, revisionId) => {
        const item = state.documentRevisions[revisionId];
        return item?.documentId === documentId ? item.assetsManifest : [];
      },
      getRegisteredBlob: async () => null,
      getGitSourceRef: async () => null,
      getGoal: async id => state.goals[id] ?? null,
      listGoals: async (limit, cursor) => {
        const values = Object.values(state.goals).sort((a, b) => a.id.localeCompare(b.id));
        const start = cursor ? Math.max(0, values.findIndex(item => item.id === cursor) + 1) : 0;
        return { items: values.slice(start, start + limit), nextCursor: values[start + limit]?.id ?? null };
      },
      listGoalRevisions: async goalId => state.goalRevisions.filter(item => item.id === goalId).sort((a, b) => a.version - b.version),
      getStage: async id => state.stages[id] ?? null,
      listStages: async goalId => Object.values(state.stages).filter(item => !goalId || item.goalId === goalId),
      listStageRevisions: async stageId => state.stageRevisions.filter(item => item.stageId === stageId).sort((a, b) => a.version - b.version),
      listStageReviews: async stageId => state.stageReviews.filter(item => item.stageId === stageId),
      getTaskProposal: async (taskId, revisionId) => state.proposals.filter(item => item.taskId === taskId && (!revisionId || item.taskRevisionId === revisionId)).at(-1) ?? null,
      listTaskJudgements: async taskId => state.judgements.filter(item => item.taskId === taskId),
      getDelivery: async id => state.deliveries.find(item => item.id === id) ?? null,
      listDeliveries: async taskId => state.deliveries.filter(item => item.taskId === taskId),
      listObservations: async taskId => state.observations.filter(item => item.taskId === taskId),
      listTaskClosures: async taskId => state.closures.filter(item => item.taskId === taskId),
      getCognitiveClosureFact: async id => state.cognitiveClosureFact?.decisionId === id ? state.cognitiveClosureFact : null,
      getWaitingHandoffFact: async id => state.waitingHandoffFact?.inboxId === id ? state.waitingHandoffFact : null,
      getChildHandoffFact: async id => state.childHandoffFact?.dispatchId === id ? state.childHandoffFact : null,
      getProject: async () => state.project,
      getDocument: async (id) => state.documents[id] ?? null,
      getDocumentRevision: async (document, revision) => {
        const found = state.documentRevisions[revision];
        return found?.documentId === document ? found : null;
      },
      hasDocumentAdoption: async (document, revision) => state.documentDecisions.some(
        decision => decision.documentId === document && decision.revisionId === revision),
      listDocuments: async (limit, cursor) => {
        const values = Object.values(state.documents).sort((a, b) => a.id.localeCompare(b.id));
        const start = cursor ? Math.max(0, values.findIndex((item) => item.id === cursor) + 1) : 0;
        const items = values.slice(start, start + limit);
        return { items, nextCursor: values[start + limit]?.id ?? null };
      },
      getTask: async (id) => state.tasks[id] ?? null,
      getTaskRevision: async (task, revision) => {
        const found = state.taskRevisions[revision];
        return found?.taskId === task ? found : null;
      },
      listTaskRevisions: async task => Object.values(state.taskRevisions)
        .filter(item => item.taskId === task).sort((a, b) => a.version - b.version),
      getBasisSet: async (task, revision, id) => {
        const found = state.bases[id];
        return found?.taskId === task && found.taskRevisionId === revision ? found : null;
      },
      listTasks: async (limit, cursor) => {
        const values = Object.values(state.tasks).sort((a, b) => a.id.localeCompare(b.id));
        const start = cursor ? Math.max(0, values.findIndex((item) => item.id === cursor) + 1) : 0;
        const items = values.slice(start, start + limit);
        return { items, nextCursor: values[start + limit]?.id ?? null };
      },
      listLinks: async (task) => state.links.filter((item) => item.taskId === task),
      getImpact: async (id) => state.impacts[id] ?? null,
      listImpacts: async (task) => Object.values(state.impacts).filter((item) => !task || item.taskId === task),
      listBasisDecisions: async (task) => state.basisDecisions.filter((item) => item.taskId === task),
      getOperation: async (id) => state.operations[id] ?? null,
      findTasksUsingDocument: async (document) => Object.values(state.tasks).filter((task) =>
        state.links.some((link) => link.taskId === task.id && link.documentId === document)),
    });
    const tx: Transaction = {
      ...reader(),
      insertDiscussion: async (item, event) => { state.discussions[item.id] = item; state.discussionEvents.push(event); },
      updateDiscussion: async (item, expected, event) => {
        assert.equal(state.discussions[item.id]?.version, expected);
        state.discussions[item.id] = item; state.discussionEvents.push(event);
      },
      createRole: async (item, revision) => { state.roles[item.id] = item; state.roleRevisions.push(revision); },
      advanceRole: async (item, expected, revision) => { assert.equal(state.roles[item.id]?.version, expected); state.roles[item.id] = item; state.roleRevisions.push(revision); },
      addDecision: async () => {},
      addReview: async item => { state.roleReviews.push(item); },
      getHandoff: async id => state.roleHandoffs.find(item => item.id === id) ?? null,
      addHandoff: async item => { state.roleHandoffs.push(item); },
      acknowledgeHandoff: async item => { const index = state.roleHandoffs.findIndex(value => value.id === item.id); assert.notEqual(index, -1); state.roleHandoffs[index] = item; },
      listUnacknowledgedHandoffs: async id => state.roleHandoffs.filter(item => item.roleId === id && item.state === "prepared"),
      listUnfinishedOwnedTasks: async id => Object.values(state.tasks).filter(item => item.owner === id && item.state !== "done" && item.state !== "cancelled"),
      listOpenRuntimeSessions: async () => [],
      addSessionBinding: async item => { state.roleBindings.push(item); },
      insertSchedule: async item => { state.schedules[item.id] = item; state.scheduleRevisions.push(item.revision); },
      updateSchedule: async (item, expected) => { assert.equal(state.schedules[item.id]?.version, expected); state.schedules[item.id] = item; state.scheduleRevisions.push(item.revision); },
      insertDocumentPayloadRevision: async item => { state.documentRevisions[item.id] = item; },
      registerDocumentBlob: async () => {},
      insertGoal: async (item, reason) => { state.goals[item.id] = item; state.goalRevisions.push({ ...item, reason }); },
      updateGoal: async (item, expected, reason) => {
        assert.equal(state.goals[item.id]?.version, expected);
        state.goals[item.id] = item;
        state.goalRevisions.push({ ...item, reason });
      },
      insertStage: async (item, revision) => { state.stages[item.id] = item; state.stageRevisions.push(revision); },
      updateStage: async (item, revision, expected) => {
        assert.equal(state.stages[item.id]?.version, expected);
        state.stages[item.id] = item;
        state.stageRevisions.push(revision);
      },
      insertStageReview: async item => { state.stageReviews.push(item); },
      insertTaskProposal: async item => { state.proposals.push(item); },
      insertTaskJudgement: async item => { state.judgements.push(item); },
      insertDelivery: async item => { state.deliveries.push(item); },
      insertObservation: async item => { state.observations.push(item); },
      insertTaskClosure: async item => { state.closures.push(item); },
      savepoint: async (work) => {
        const before = structuredClone(state);
        try { return await work(); } catch (error) { state = before; throw error; }
      },
      insertProject: async (item) => { state.project = item; },
      insertDocument: async (item) => { state.documents[item.id] = item; },
      insertDocumentRevision: async (item) => { state.documentRevisions[item.id] = item; },
      insertDocumentDecision: async (item) => { state.documentDecisions.push(item); },
      updateDocument: async (item, expected) => {
        assert.equal(state.documents[item.id]?.version, expected);
        state.documents[item.id] = item;
      },
      insertTask: async (item) => { state.tasks[item.id] = item; },
      insertTaskRevision: async (item) => { state.taskRevisions[item.id] = item; },
      insertSealedBasisSet: async (item) => { state.bases[item.id] = item; },
      updateTask: async (item, expected) => {
        assert.equal(state.tasks[item.id]?.version, expected);
        state.tasks[item.id] = item;
      },
      insertLink: async (item) => { state.links.push(item); },
      insertImpact: async (item) => { state.impacts[item.id] = item; },
      resolveImpact: async (id, decisionId) => {
        const item = state.impacts[id]; assert.ok(item);
        state.impacts[id] = { ...item, state: "resolved", decisionId };
      },
      supersedeImpacts: async (task, document) => {
        for (const item of Object.values(state.impacts)) {
          if (item.taskId === task && item.documentId === document && item.state === "pending") {
            state.impacts[item.id] = { ...item, state: "superseded" };
          }
        }
      },
      insertBasisDecision: async (item) => { state.basisDecisions.push(item); },
      insertOperation: async (item) => { state.operations[item.id] = item; },
      appendOutbox: async (item) => { state.outbox.push(item); },
    };
    const result = await action(tx);
    this.state = state;
    return result;
  }
  async read<T>(project: string, action: (reader: Reader) => Promise<T>): Promise<T> {
    return this.transaction(project, (tx) => action(tx));
  }
}

function fixture() {
  let sequence = 10;
  const uow = new MemoryUow();
  const service = new WorkflowService({
    uow,
    clock: { now: () => "2026-10-20T00:00:00.000Z" },
    ids: { next: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}` },
    hasher: { hash: (value) => createHash("sha256").update(value).digest("hex") },
  });
  const operation = () => `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
  return { uow, service, operation };
}

async function seedTwoTasks(f: ReturnType<typeof fixture>, documentIds = [documentId]) {
  const { service, operation } = f;
  await service.execute(principal, { type: "project.create", projectId, operationId: operation(), title: "Project" });
  for (const id of documentIds) {
    await service.execute(principal, { type: "document.create", projectId, operationId: operation(), documentId: id, title: "Requirement", body: "r1" });
    const document = await service.getDocument(principal, projectId, id);
    await service.execute(principal, { type: "document.adopt", projectId, operationId: operation(), documentId: id, expectedVersion: 1, revisionId: document.current.id, reason: "Accepted" });
  }
  for (const id of [taskA, taskB]) {
    await service.execute(principal, { type: "task.create", projectId, operationId: operation(), taskId: id,
      title: "Task", content: "Do work", acceptance: "r1 acceptance", owner: "owner", documentIds });
    const basis = await Promise.all(documentIds.map(async (docId) => ({
      documentId: docId, revisionId: (await service.getDocument(principal, projectId, docId)).adopted!.id,
    })));
    await service.execute(principal, { type: "task.start", projectId, operationId: operation(), taskId: id,
      expectedVersion: 1, basis, reason: "Start" });
  }
}

test("fixed basis read checks project authority and revision ownership before shared source validation", async () => {
  const f = fixture();
  await seedTwoTasks(f);
  const fixed = await f.service.getTask(principal, projectId, taskA);
  assert.ok(fixed.basis);
  await f.service.validateTaskRevisionBasis(principal, projectId, taskA, fixed.revision.id, fixed.basis.id);
  await assert.rejects(() => f.service.validateTaskRevisionBasis(principal, projectId, taskA,
    fixed.revision.id, "00000000-0000-4000-8000-000000009999"), error =>
      error instanceof DomainError && error.code === "BASIS_UNAVAILABLE");
  await assert.rejects(() => f.service.validateTaskRevisionBasis({ ...principal, permissions: [] }, projectId,
    taskA, fixed.revision.id, fixed.basis!.id), error =>
      error instanceof DomainError && error.code === "FORBIDDEN");
});

test("Task creation owns a primary Document and pins each changed body to an immutable revision", async () => {
  const f = fixture();
  await f.service.execute(principal, { type: "project.create", projectId, operationId: f.operation(), title: "Project" });
  const created = await f.service.execute(principal, { type: "task.create", projectId, operationId: f.operation(),
    taskId: taskA, title: "Implement", content: "First plan", acceptance: "Checks pass", owner: "owner", kind: "implementation" });
  assert.equal(created.status, "applied");
  const initial = await f.service.getTask(principal, projectId, taskA);
  assert.equal(initial.task.state, "todo");
  assert.equal(initial.task.content, "First plan");
  assert.equal(initial.task.kind, "implementation");
  const document = await f.service.getDocument(principal, projectId, initial.task.contentDocumentId);
  assert.equal(document.document.kind, "task");
  assert.equal(document.document.status, "draft");
  assert.equal(document.current.id, initial.revision.contentRevisionId);
  const blocked = await f.service.execute(principal, { type: "document.revise", projectId, operationId: f.operation(),
    documentId: document.document.id, expectedVersion: 1, body: "Bypass", reason: "Attempt" });
  assert.equal(blocked.status === "rejected" ? blocked.code : null, "TASK_CONTENT_OWNED");
  const changed = await f.service.execute(principal, { type: "task.update", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 1, title: "Implement", content: "Second plan", acceptance: "Checks pass",
    owner: "owner", reason: "Scope clarified" });
  assert.equal(changed.status, "applied");
  const next = await f.service.getTask(principal, projectId, taskA);
  assert.equal(next.task.content, "Second plan");
  assert.notEqual(next.revision.contentRevisionId, initial.revision.contentRevisionId);
  const updatedPrimary = await f.service.getDocument(principal, projectId, next.task.contentDocumentId);
  const primaryEvent = f.uow.state.outbox.find(event => event.operationId === changed.operationId &&
    event.kind === "document" && event.entityId === next.task.contentDocumentId);
  assert.equal(updatedPrimary.document.version, 2);
  assert.equal(primaryEvent?.version, updatedPrimary.document.version);
  assert.equal((await f.service.getTaskRevision(principal, projectId, taskA, initial.revision.id)).revision.content, "First plan");
  assert.equal((await f.service.getDocumentRevision(principal, projectId, document.document.id,
    initial.revision.contentRevisionId)).body, "First plan");
  const started = await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 2, reason: "Approved execution" });
  assert.equal(started.status, "applied");
  const active = await f.service.getTask(principal, projectId, taskA);
  assert.equal(active.task.state, "in_progress");
  assert.deepEqual(active.basis?.members, [{ documentId: active.task.contentDocumentId, revisionId: active.task.contentRevisionId }]);
  assert.equal((await f.service.getDocument(principal, projectId, active.task.contentDocumentId)).document.status, "published");
  const unauthorized: Principal = { ...principal, permissions: ["read", "write"] };
  await assert.rejects(f.service.execute(unauthorized, { type: "task.start", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 3, reason: "No review authority" }), error =>
    error instanceof DomainError && error.code === "FORBIDDEN");
  const premature = await f.service.execute(principal, { type: "task.update", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 3, title: "Implement", content: "Third plan", acceptance: "Checks pass",
    owner: "owner", reason: "New work" });
  assert.equal(premature.status === "rejected" ? premature.code : null, "REOPEN_REQUIRED");
});

test("reopen invalidates an earlier delivery before the same Task can close again", async () => {
  const f = fixture();
  await f.service.execute(principal, { type: "project.create", projectId, operationId: f.operation(), title: "Project" });
  await f.service.execute(principal, { type: "task.create", projectId, operationId: f.operation(),
    taskId: taskA, title: "Validate", content: "Check current behavior", acceptance: "Fixture passes", owner: "owner" });
  await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(), taskId: taskA,
    expectedVersion: 1, reason: "Start" });
  const delivery = await f.service.execute(principal, { type: "delivery.record", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 2, artifactRef: "repo/check", artifactRevision: "abc123",
    contentHash: "a".repeat(64), technicalResult: "passed", technicalEvidence: "Fixture passed", reason: "Ready for acceptance" });
  assert.equal(delivery.status, "applied");
  const firstClose = await f.service.execute(principal, { type: "task.close", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 3, deliveryId: delivery.status === "applied" ? delivery.revisionId! : "",
    acceptanceResult: "met", acceptanceEvidence: "Criterion checked", reason: "Accepted" });
  assert.equal(firstClose.status, "applied");
  const reopened = await f.service.execute(principal, { type: "task.reopen", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 4, reason: "New requirement" });
  assert.equal(reopened.status, "applied");
  const before = await f.service.getTask(principal, projectId, taskA);
  assert.equal(before.task.state, "todo");
  assert.ok(before.basis, "reopen keeps fixed sources for the next explicit start");
  await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(), taskId: taskA,
    expectedVersion: 5, reason: "Restart" });
  const oldDeliveryId = f.uow.state.deliveries[0]!.id;
  const stale = await f.service.execute(principal, { type: "task.close", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 6, deliveryId: oldDeliveryId,
    acceptanceResult: "met", acceptanceEvidence: "Old evidence", reason: "Attempt" });
  assert.equal(stale.status === "rejected" ? stale.code : null, "STALE_DELIVERY");
});

test("a settled cognition decision closes only its current Task revision; waiting needs a real handoff", async () => {
  const prepare = async () => {
    const f = fixture();
    await f.service.execute(principal, {type:"project.create",projectId,operationId:f.operation(),title:"Project"});
    await f.service.execute(principal, {type:"task.create",projectId,operationId:f.operation(),taskId:taskA,
      title:"Review event",content:"Read fixed source",acceptance:"Record grounded choice",owner:"cognition"});
    await f.service.execute(principal, {type:"task.start",projectId,operationId:f.operation(),taskId:taskA,
      expectedVersion:1,reason:"Start review"});
    const task=(await f.service.getTask(principal,projectId,taskA)).task;
    const decisionId=f.operation(),sourceInboxId=f.operation(),sourceEventId=f.operation(),loopId=f.operation();
    f.uow.state.cognitiveClosureFact={projectId,decisionId,actorId:"signed-cognition",kind:"no_action",
      taskId:taskA,taskRevisionId:task.currentRevisionId,runId:f.operation(),runState:"completed",dispatchId:f.operation(),
      loopId,sourceInboxId,sourceEventId,sourceTaskId:null,sourceTaskIsCognition:false,outcome:"no_action",purpose:"cognition",
      recipientRoleId:"cognition",cognitiveRoleId:"cognition",loopState:"active",decidedAtUtc:"2026-10-23T00:00:00.000Z"};
    const close=(extra:Record<string,unknown>={})=>f.service.execute(principal,{type:"task.close",projectId,
      operationId:f.operation(),taskId:taskA,expectedVersion:task.version,decisionId,acceptanceResult:"met",
      acceptanceEvidence:"Reviewed fixed source and signed no further action",reason:"Acceptance reviewed",...extra} as never);
    return {f,task,decisionId,sourceInboxId,sourceEventId,loopId,close};
  };
  const simple=await prepare();
  assert.equal((await simple.close({deliveryId:simple.f.operation()})).status,"rejected");
  assert.equal((await simple.close({waitingInboxId:simple.f.operation()})).status,"rejected");
  const closed=await simple.close();
  assert.equal(closed.status,"applied");
  assert.equal(simple.f.uow.state.closures[0]?.decisionId,simple.decisionId);
  assert.equal(simple.f.uow.state.closures[0]?.deliveryId,null);
  assert.equal((await simple.f.service.getTask(principal,projectId,taskA)).task.state,"done");

  const waiting=await prepare();
  const sourceTaskId=taskB,waitingInboxId=waiting.f.operation();
  waiting.f.uow.state.cognitiveClosureFact={...waiting.f.uow.state.cognitiveClosureFact!,kind:"waiting",outcome:"waiting",sourceTaskId};
  const without=await waiting.close();
  assert.equal(without.status==="rejected"?without.code:null,"WAITING_HANDOFF_REQUIRED");
  waiting.f.uow.state.tasks[sourceTaskId]={...waiting.task,id:sourceTaskId};
  waiting.f.uow.state.cognitiveClosureFact={...waiting.f.uow.state.cognitiveClosureFact!,sourceTaskIsCognition:true};
  assert.equal((await waiting.close({waitingInboxId})).status,"rejected");
  waiting.f.uow.state.cognitiveClosureFact={...waiting.f.uow.state.cognitiveClosureFact!,sourceTaskIsCognition:false};
  waiting.f.uow.state.waitingHandoffFact={projectId,inboxId:waitingInboxId,loopId:waiting.loopId,
    sourceEventId:waiting.sourceEventId,recipientRoleId:"cognition",disposition:"waiting",actorId:"signed-cognition"};
  const accepted=await waiting.close({waitingInboxId});
  assert.equal(accepted.status,"applied");
  assert.equal(waiting.f.uow.state.closures[0]?.sourceTaskId,sourceTaskId);
  assert.equal(waiting.f.uow.state.closures[0]?.waitingInboxId,waitingInboxId);

  const bootstrap=await prepare();
  const childDispatchId=bootstrap.f.operation();
  bootstrap.f.uow.state.cognitiveClosureFact={...bootstrap.f.uow.state.cognitiveClosureFact!,kind:"waiting",outcome:"waiting"};
  bootstrap.f.uow.state.childHandoffFact={projectId,dispatchId:childDispatchId,taskId:taskB,loopId:bootstrap.loopId,
    sourceEventId:bootstrap.sourceEventId,parentDispatchId:bootstrap.f.uow.state.cognitiveClosureFact!.dispatchId,
    recipientRoleId:"builder",cognitiveRoleId:"cognition",requestedBy:"signed-cognition",
    requestedAtUtc:"2026-10-22T23:59:59.000Z",sourceInboxId:bootstrap.f.operation()};
  assert.equal((await bootstrap.close()).status,"rejected");
  assert.equal((await bootstrap.close({waitingInboxId:bootstrap.f.operation(),handoffDispatchId:childDispatchId})).status,"rejected");
  assert.equal((await bootstrap.close({handoffDispatchId:bootstrap.f.operation()})).status,"rejected");
  bootstrap.f.uow.state.childHandoffFact={...bootstrap.f.uow.state.childHandoffFact,requestedAtUtc:"2026-10-23T00:00:01.000Z"};
  assert.equal((await bootstrap.close({handoffDispatchId:childDispatchId})).status,"rejected");
  bootstrap.f.uow.state.childHandoffFact={...bootstrap.f.uow.state.childHandoffFact,requestedAtUtc:"2026-10-22T23:59:59.000Z",requestedBy:"other-worker"};
  assert.equal((await bootstrap.close({handoffDispatchId:childDispatchId})).status,"rejected");
  bootstrap.f.uow.state.childHandoffFact={...bootstrap.f.uow.state.childHandoffFact,requestedBy:"signed-cognition",sourceEventId:bootstrap.f.operation()};
  assert.equal((await bootstrap.close({handoffDispatchId:childDispatchId})).status,"rejected");
  bootstrap.f.uow.state.childHandoffFact={...bootstrap.f.uow.state.childHandoffFact,sourceEventId:bootstrap.sourceEventId,parentDispatchId:bootstrap.f.operation()};
  assert.equal((await bootstrap.close({handoffDispatchId:childDispatchId})).status,"rejected");
  bootstrap.f.uow.state.childHandoffFact={...bootstrap.f.uow.state.childHandoffFact,parentDispatchId:bootstrap.f.uow.state.cognitiveClosureFact!.dispatchId,recipientRoleId:"cognition"};
  assert.equal((await bootstrap.close({handoffDispatchId:childDispatchId})).status,"rejected");
  bootstrap.f.uow.state.childHandoffFact={...bootstrap.f.uow.state.childHandoffFact,recipientRoleId:"builder"};
  assert.equal((await bootstrap.close({handoffDispatchId:childDispatchId})).status,"applied");
  assert.equal(bootstrap.f.uow.state.closures[0]?.sourceTaskId,null);
  assert.equal(bootstrap.f.uow.state.closures[0]?.handoffTaskId,taskB);
  assert.equal(bootstrap.f.uow.state.closures[0]?.handoffDispatchId,childDispatchId);

  const stopped=await prepare();
  stopped.f.uow.state.cognitiveClosureFact={...stopped.f.uow.state.cognitiveClosureFact!,kind:"stop",outcome:"no_action",loopState:"stopped"};
  assert.equal((await stopped.close()).status,"applied");
  const unstopped=await prepare();
  unstopped.f.uow.state.cognitiveClosureFact={...unstopped.f.uow.state.cognitiveClosureFact!,kind:"stop",outcome:"no_action",loopState:"active"};
  assert.equal((await unstopped.close()).status,"rejected");

  const stale=await prepare();
  stale.f.uow.state.cognitiveClosureFact={...stale.f.uow.state.cognitiveClosureFact!,taskRevisionId:stale.f.operation()};
  assert.equal((await stale.close()).status,"rejected");
  const failed=await prepare();
  failed.f.uow.state.cognitiveClosureFact={...failed.f.uow.state.cognitiveClosureFact!,kind:"failed",outcome:"failed"};
  assert.equal((await failed.close()).status,"rejected");
  const consumer=await prepare();
  consumer.f.uow.state.proposals.push({projectId,taskId:taskA,taskRevisionId:consumer.task.currentRevisionId,
    stageId:null,consumer:"human",useRequired:true,evidence:"Use",stopCondition:"Use",createdAt:"2026-10-23T00:00:00.000Z"});
  const noUse=await consumer.close();
  assert.equal(noUse.status==="rejected"?noUse.code:null,"USE_NOT_OBSERVED");
});

test("starting a migrated todo Task without basis input retains its fixed legacy sources", async () => {
  const f = fixture();
  await f.service.execute(principal, { type: "project.create", projectId, operationId: f.operation(), title: "Project" });
  await f.service.execute(principal, { type: "document.create", projectId, operationId: f.operation(),
    documentId, title: "Requirement", body: "fixed r1" });
  const source = await f.service.getDocument(principal, projectId, documentId);
  await f.service.execute(principal, { type: "document.publish", projectId, operationId: f.operation(),
    documentId, expectedVersion: 1, revisionId: source.current.id, reason: "Publish source" });
  await f.service.execute(principal, { type: "task.create", projectId, operationId: f.operation(),
    taskId: taskA, title: "Legacy task", content: "Fixed task text", acceptance: "Pass", owner: "owner", documentIds: [documentId] });
  const current = await f.service.getTask(principal, projectId, taskA);
  const legacyBasisId = "00000000-0000-4000-8000-000000000099";
  f.uow.state.taskRevisions[current.revision.id] = { ...current.revision, state: "ready", basisSetId: legacyBasisId };
  f.uow.state.bases[legacyBasisId] = { projectId, taskId: taskA, taskRevisionId: current.revision.id,
    id: legacyBasisId, members: [{ documentId, revisionId: source.current.id }], sealed: true };
  const started = await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 1, reason: "Explicit new start" });
  assert.equal(started.status, "applied");
  const active = await f.service.getTask(principal, projectId, taskA);
  assert.equal(active.basis?.members.length, 2);
  assert.deepEqual(active.basis?.members.find(item => item.documentId === documentId),
    { documentId, revisionId: source.current.id });
  assert.deepEqual(active.basis?.members.find(item => item.documentId === active.task.contentDocumentId),
    { documentId: active.task.contentDocumentId, revisionId: active.task.contentRevisionId });
});

test("reopen and body update keep the prior published primary while inheriting external sources", async () => {
  const f = fixture();
  await seedTwoTasks(f);
  const initial = await f.service.getTask(principal, projectId, taskA);
  const primaryId = initial.task.contentDocumentId;
  const published = await f.service.getDocument(principal, projectId, primaryId);
  assert.equal(published.document.status, "published");
  const reopened = await f.service.execute(principal, { type: "task.reopen", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 2, reason: "Replan" });
  assert.equal(reopened.status, "applied");
  const todo = await f.service.getTask(principal, projectId, taskA);
  assert.equal(todo.basis?.members.find(item => item.documentId === documentId)?.revisionId,
    initial.basis?.members.find(item => item.documentId === documentId)?.revisionId);
  const updated = await f.service.execute(principal, { type: "task.update", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 3, title: "Task", content: "Revised body", acceptance: "r1 acceptance",
    owner: "owner", reason: "Replan body" });
  assert.equal(updated.status, "applied");
  const candidate = await f.service.getDocument(principal, projectId, primaryId);
  assert.equal(candidate.document.status, "published", "a new candidate does not unpublish the earlier revision");
  assert.equal(candidate.adopted?.id, published.adopted?.id);
  assert.notEqual(candidate.current.id, candidate.adopted?.id);
  const restarted = await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 4, reason: "Review revised body" });
  assert.equal(restarted.status, "applied");
  const active = await f.service.getTask(principal, projectId, taskA);
  assert.equal(active.basis?.members.find(item => item.documentId === documentId)?.revisionId,
    initial.basis?.members.find(item => item.documentId === documentId)?.revisionId);
  assert.equal(active.basis?.members.find(item => item.documentId === primaryId)?.revisionId, active.task.contentRevisionId);
  assert.equal((await f.service.getDocument(principal, projectId, primaryId)).adopted?.id, active.task.contentRevisionId);
});

test("omitted basis rejects changed inherited sources; explicit empty basis deliberately removes them", async () => {
  const f = fixture();
  await seedTwoTasks(f);
  const before = await f.service.getDocument(principal, projectId, documentId);
  await f.service.execute(principal, { type: "document.revise", projectId, operationId: f.operation(),
    documentId, expectedVersion: before.document.version, body: "r2", reason: "Source changed" });
  const candidate = await f.service.getDocument(principal, projectId, documentId);
  await f.service.execute(principal, { type: "document.publish", projectId, operationId: f.operation(),
    documentId, expectedVersion: candidate.document.version, revisionId: candidate.current.id, reason: "Publish change" });
  await f.service.execute(principal, { type: "task.reopen", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 2, reason: "Replan after source change" });
  const inherited = await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 3, reason: "Try old source" });
  assert.equal(inherited.status === "rejected" ? inherited.code : null, "BASIS_CHANGED");
  assert.equal((await f.service.getTask(principal, projectId, taskA)).task.state, "todo");
  const explicit = await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(),
    taskId: taskA, expectedVersion: 3, basis: [], reason: "Explicitly omit changed source" });
  assert.equal(explicit.status, "applied");
  const active = await f.service.getTask(principal, projectId, taskA);
  assert.deepEqual(active.basis?.members, [{ documentId: active.task.contentDocumentId,
    revisionId: active.task.contentRevisionId }]);
});

test("explicit stage reassignment needs review and a complete active-stage proposal", async () => {
  const f = fixture();
  await f.service.execute(principal, { type: "project.create", projectId, operationId: f.operation(), title: "Project" });
  const goalId = "00000000-0000-4000-8000-000000000081";
  const stageId = "00000000-0000-4000-8000-000000000082";
  await f.service.execute(principal, { type: "goal.create", projectId, operationId: f.operation(), goalId,
    outcome: "Checked result", constraints: "Keep history", consumer: "owner", authority: "local",
    scope: "project", owner: "owner" });
  await f.service.execute(principal, { type: "stage.propose", projectId, operationId: f.operation(), stageId,
    goalId, deliverable: "Result", learningQuestion: "Useful?", reason: "Plan" });
  await f.service.execute(principal, { type: "stage.accept", projectId, operationId: f.operation(), stageId,
    expectedVersion: 1, reason: "Approve" });
  await f.service.execute(principal, { type: "task.create", projectId, operationId: f.operation(), taskId: taskA,
    title: "Task", content: "Body", acceptance: "Check", owner: "owner" });
  const command = { type: "task.update" as const, projectId, operationId: f.operation(), taskId: taskA,
    expectedVersion: 1, title: "Task", content: "Body", acceptance: "Check", owner: "owner",
    stageId, reason: "Bind stage" };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] };
  await assert.rejects(f.service.execute(writer, command), error =>
    error instanceof DomainError && error.code === "FORBIDDEN");
  const incomplete = await f.service.execute(principal, command);
  assert.equal(incomplete.status === "rejected" ? incomplete.code : null, "INCOMPLETE_PROPOSAL");
  assert.equal((await f.service.getTask(principal, projectId, taskA)).task.version, 1);
  const complete = await f.service.execute(principal, { ...command, operationId: f.operation(),
    consumer: "owner", evidence: "Observed need", stopCondition: "Checked result" });
  assert.equal(complete.status, "applied");
  assert.equal((await f.service.getTask(principal, projectId, taskA)).proposal?.stageId, stageId);
});

test("adoption creates pending impacts; decisions keep sealed old basis and rebuild other pending impacts", async () => {
  const f = fixture();
  await seedTwoTasks(f, [documentId, secondDocumentId]);
  const oldA = await f.service.getTask(principal, projectId, taskA);
  const oldRevisionId = oldA.revision.id;
  for (const id of [documentId, secondDocumentId]) {
    const before = await f.service.getDocument(principal, projectId, id);
    await f.service.execute(principal, { type: "document.revise", projectId, operationId: f.operation(), documentId: id,
      expectedVersion: before.document.version, body: "r2", reason: "Correction" });
    const candidate = await f.service.getDocument(principal, projectId, id);
    await f.service.execute(principal, { type: "document.adopt", projectId, operationId: f.operation(), documentId: id,
      expectedVersion: candidate.document.version, revisionId: candidate.current.id, reason: "Accepted correction" });
  }
  const initial = (await f.service.listImpacts(principal, projectId)).filter((item) => item.taskId === taskA && item.state === "pending");
  assert.equal(initial.length, 2);
  const first = initial.find((item) => item.documentId === documentId)!;
  const second = initial.find((item) => item.documentId === secondDocumentId)!;
  const adopt = await f.service.execute(principal, { type: "task.reviewBasis", projectId, operationId: f.operation(), taskId: taskA,
    expectedVersion: 2, impactId: first.id, decision: "adopt", reason: "Apply correction", acceptance: "r2 acceptance" });
  assert.equal(adopt.status, "applied");
  const updated = await f.service.getTask(principal, projectId, taskA);
  assert.equal(updated.task.version, 3);
  assert.equal(updated.task.acceptance, "r2 acceptance");
  assert.equal(updated.basis?.members.find((item) => item.documentId === documentId)?.revisionId, first.toRevisionId);
  assert.equal((await f.service.getTaskRevision(principal, projectId, taskA, oldRevisionId)).basis?.members.find((item) => item.documentId === documentId)?.revisionId, first.fromRevisionId);
  assert.equal((await f.service.listImpacts(principal, projectId)).find((item) => item.id === second.id)?.state, "superseded");
  assert.ok(f.uow.state.outbox.some((item) => item.kind === "impact.superseded" && item.entityId === second.id && item.version === 2));
  const rebuilt = (await f.service.listImpacts(principal, projectId)).find((item) => item.taskId === taskA && item.documentId === secondDocumentId && item.state === "pending")!;
  assert.equal(rebuilt.taskRevisionId, updated.revision.id);
  const stale = await f.service.execute(principal, { type: "task.reviewBasis", projectId, operationId: f.operation(), taskId: taskA,
    expectedVersion: 3, impactId: second.id, decision: "retain", reason: "Still applies" });
  assert.deepEqual({ status: stale.status, code: stale.status === "rejected" ? stale.code : null }, { status: "rejected", code: "STALE_IMPACT" });
  const retain = await f.service.execute(principal, { type: "task.reviewBasis", projectId, operationId: f.operation(), taskId: taskA,
    expectedVersion: 3, impactId: rebuilt.id, decision: "retain", reason: "Old scope still applies" });
  assert.equal(retain.status, "applied");
  assert.equal((await f.service.getTask(principal, projectId, taskA)).basis?.members.find((item) => item.documentId === secondDocumentId)?.revisionId, second.fromRevisionId);
});

test("basis review normalizes a legacy active revision without rewriting the old revision", async () => {
  const f = fixture();
  await seedTwoTasks(f);
  const before = await f.service.getTask(principal, projectId, taskA);
  f.uow.state.taskRevisions[before.revision.id] = { ...before.revision, state: "active" };
  const source = await f.service.getDocument(principal, projectId, documentId);
  await f.service.execute(principal, { type: "document.revise", projectId, operationId: f.operation(),
    documentId, expectedVersion: source.document.version, body: "r2", reason: "New source revision" });
  const candidate = await f.service.getDocument(principal, projectId, documentId);
  await f.service.execute(principal, { type: "document.publish", projectId, operationId: f.operation(),
    documentId, expectedVersion: candidate.document.version, revisionId: candidate.current.id, reason: "Publish source" });
  const impact = (await f.service.listImpacts(principal, projectId)).find(item => item.taskId === taskA && item.state === "pending");
  assert.ok(impact);
  const reviewed = await f.service.execute(principal, { type: "task.reviewBasis", projectId,
    operationId: f.operation(), taskId: taskA, expectedVersion: 2, impactId: impact.id,
    decision: "adopt", reason: "Reviewed changed source" });
  assert.equal(reviewed.status, "applied");
  const after = await f.service.getTask(principal, projectId, taskA);
  assert.equal(after.revision.state, "in_progress");
  assert.equal((await f.service.getTaskRevision(principal, projectId, taskA, before.revision.id)).revision.state, "active");
});

test("adopting a newer document revision emits supersession for the previous pending impact", async () => {
  const f = fixture();
  await seedTwoTasks(f);
  const adoptNext = async (body: string) => {
    const previous = await f.service.getDocument(principal, projectId, documentId);
    await f.service.execute(principal, { type: "document.revise", projectId, operationId: f.operation(), documentId,
      expectedVersion: previous.document.version, body, reason: "Correction" });
    const candidate = await f.service.getDocument(principal, projectId, documentId);
    return f.service.execute(principal, { type: "document.adopt", projectId, operationId: f.operation(), documentId,
      expectedVersion: candidate.document.version, revisionId: candidate.current.id, reason: "Accepted" });
  };
  const first = await adoptNext("r2");
  assert.equal(first.status, "applied");
  const old = (await f.service.listImpacts(principal, projectId)).filter((item) => item.state === "pending");
  assert.equal(old.length, 2);
  const second = await adoptNext("r3");
  assert.equal(second.status, "applied");
  for (const impact of old) {
    assert.equal((await f.service.listImpacts(principal, projectId)).find((item) => item.id === impact.id)?.state, "superseded");
    assert.equal(f.uow.state.outbox.filter((item) => item.kind === "impact.superseded" && item.entityId === impact.id && item.version === 2).length, 1);
  }
  assert.equal((await f.service.listImpacts(principal, projectId)).filter((item) => item.state === "pending").length, 2);
});

test("candidate revision, duplicate operation and UTF-8 byte cap are enforced without side effects", async () => {
  const f = fixture();
  await seedTwoTasks(f);
  const before = await f.service.getDocument(principal, projectId, documentId);
  const candidate = await f.service.execute(principal, { type: "document.revise", projectId, operationId: f.operation(),
    documentId, expectedVersion: before.document.version, body: "r2", reason: "New request" });
  assert.equal(candidate.status, "applied");
  const proposal = "00000000-0000-4000-8000-000000000006";
  await f.service.execute(principal, { type: "task.create", projectId, operationId: f.operation(), taskId: proposal,
    title: "New task", content: "Do work", acceptance: "Check", owner: "owner", documentIds: [documentId] });
  const outboxBefore = f.uow.state.outbox.length;
  const invalid = await f.service.execute(principal, { type: "task.start", projectId, operationId: f.operation(), taskId: proposal,
    expectedVersion: 1, basis: [{ documentId, revisionId: candidate.status === "applied" ? candidate.revisionId! : "" }], reason: "Try" });
  assert.equal(invalid.status === "rejected" ? invalid.code : "applied", "BASIS_UNAVAILABLE");
  const falseRetention = await f.service.execute(principal, { type: "task.start", projectId,
    operationId: f.operation(), taskId: proposal, expectedVersion: 1,
    basis: [{ documentId, revisionId: candidate.status === "applied" ? candidate.revisionId! : "" }],
    retentions: [{ documentId, revisionId: candidate.status === "applied" ? candidate.revisionId! : "",
      observedAdoptedRevisionId: before.adopted!.id, reason: "Try treating a draft as an old approved source" }],
    reason: "Draft must not be retained" });
  assert.equal(falseRetention.status === "rejected" ? falseRetention.code : "applied", "BASIS_UNAVAILABLE");
  assert.equal((await f.service.getTask(principal, projectId, proposal)).task.state, "todo");
  assert.equal(f.uow.state.outbox.length, outboxBefore);
  const overBytes = "好".repeat(23000);
  const oversize = await f.service.execute(principal, { type: "document.revise", projectId, operationId: f.operation(), documentId,
    expectedVersion: 3, body: overBytes, reason: "Oversize" });
  assert.equal(oversize.status, "rejected");
  assert.equal((await f.service.getDocument(principal, projectId, documentId)).document.version, 3);
  const opId = f.operation();
  const cmd = { type: "document.adopt" as const, projectId, operationId: opId, documentId, expectedVersion: 3,
    revisionId: candidate.status === "applied" ? candidate.revisionId! : "", reason: "Adopt" };
  const first = await f.service.execute(principal, cmd);
  assert.deepEqual(await f.service.execute(principal, { ...cmd }), first);
  assert.equal(f.uow.state.documentDecisions.length, 4);
  await assert.rejects(f.service.execute(principal, { ...cmd, reason: "Different" }),
    (error: unknown) => error instanceof DomainError && error.code === "OPERATION_REUSED");
  assert.ok(f.uow.state.outbox.every((item) => !JSON.stringify(item).includes("r2")));
});

test("read permission and operation ownership are checked on every query", async () => {
  const f = fixture();
  const operationId = f.operation();
  await f.service.execute(principal, { type: "project.create", projectId, operationId, title: "Project" });
  const other: Principal = { actorId: "other", projectIds: [projectId], permissions: ["read"] };
  await assert.rejects(f.service.getOperation(other, projectId, operationId),
    (error: unknown) => error instanceof DomainError && error.code === "FORBIDDEN");
  assert.equal(await f.service.getOperation(principal, projectId, f.operation()), null);
  await assert.rejects(f.service.getProject({ ...principal, projectIds: [] }, projectId),
    (error: unknown) => error instanceof DomainError && error.code === "FORBIDDEN");
});
