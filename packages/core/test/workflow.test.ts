import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  BasisDecision, BasisSet, Document, DocumentDecision, DocumentRevision, Impact, Operation,
  OutboxEvent, Principal, Project, Task, TaskDocumentLink, TaskRevision,
  Goal, GoalRevision, Stage, StageRevision, StageReview, TaskProposal, TaskJudgement, Delivery, ConsumerObservation, TaskClosure,
} from "@evoloop/contracts";
import type { Reader, Transaction, UnitOfWork } from "@evoloop/contracts/ports";
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
    goals: {}, goalRevisions: [], stages: {}, stageRevisions: [], stageReviews: [], proposals: [], judgements: [], deliveries: [], observations: [], closures: [],
    roles: {}, roleRevisions: [], roleReviews: [], roleHandoffs: [], roleBindings: [], schedules: {}, scheduleRevisions: [], occurrences: [],
  };
  async transaction<T>(_projectId: string, action: (tx: Transaction) => Promise<T>): Promise<T> {
    let state = structuredClone(this.state);
    const reader = (): Reader => ({
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
      getProject: async () => state.project,
      getDocument: async (id) => state.documents[id] ?? null,
      getDocumentRevision: async (document, revision) => {
        const found = state.documentRevisions[revision];
        return found?.documentId === document ? found : null;
      },
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
    await service.execute(principal, { type: "task.propose", projectId, operationId: operation(), taskId: id,
      title: "Task", goal: "Do work", acceptance: "r1 acceptance", owner: "owner", documentIds });
    const basis = await Promise.all(documentIds.map(async (docId) => ({
      documentId: docId, revisionId: (await service.getDocument(principal, projectId, docId)).adopted!.id,
    })));
    await service.execute(principal, { type: "task.accept", projectId, operationId: operation(), taskId: id,
      expectedVersion: 1, basis, reason: "Ready" });
  }
}

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
  await f.service.execute(principal, { type: "task.propose", projectId, operationId: f.operation(), taskId: proposal,
    title: "New task", goal: "Do work", acceptance: "Check", owner: "owner", documentIds: [documentId] });
  const outboxBefore = f.uow.state.outbox.length;
  const invalid = await f.service.execute(principal, { type: "task.accept", projectId, operationId: f.operation(), taskId: proposal,
    expectedVersion: 1, basis: [{ documentId, revisionId: candidate.status === "applied" ? candidate.revisionId! : "" }], reason: "Try" });
  assert.equal(invalid.status === "rejected" ? invalid.code : "applied", "UNADOPTED_BASIS");
  assert.equal((await f.service.getTask(principal, projectId, proposal)).task.state, "proposed");
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
  assert.equal(f.uow.state.documentDecisions.length, 2);
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
