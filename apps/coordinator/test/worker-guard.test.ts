import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { authorizeWorkerCommand, authorizeWorkerRequest, type WorkerGuardFacts } from "../src/workers/guard.ts";
import type { WorkerIdentity } from "../src/workers/types.ts";

const u = randomUUID;
const projectId = u(), loopId = u(), goalId = u(), stageId = u(), taskId = u(), runId = u(), sessionId = u(),
  otherTaskId = u(), deliveryId = u(), inboxId = u(), documentId = u(), revisionId = u(), gitId = u(), wikiId = u(), parentDispatchId = u();
const worker: WorkerIdentity = { principal: { actorId: `worker-${u()}`, projectIds: [projectId], permissions: ["read", "write"] },
  scope: { projectId, loopId, taskId, runId, sessionId, roleId: "builder", kind: "business", allowedRoleIds: ["builder"] } };
const facts: WorkerGuardFacts = {
  loop: async id => id === loopId ? { projectId, state: "active", goalId, stageId, cognitiveRoleId: "planner", allowedBusinessRoleIds: ["builder"] } : null,
  task: async id => id === taskId ? { projectId, loopId, ownerRoleId: "builder" } :
    id === otherTaskId ? { projectId, loopId, ownerRoleId: "other" } : null,
  taskRevision: async () => true,
  run: async id => id === runId ? { projectId, taskId, sessionId } : null,
  delivery: async id => id === deliveryId ? { projectId, taskId, runId } : null,
  inbox: async id => id === inboxId ? { projectId, loopId, state: "acknowledged" } : null,
  document: async id => id === documentId ? { projectId, taskId: null, loopId: null } : null,
  fixedDocument: async (task, doc, revision) => task === taskId && doc === documentId && revision === revisionId,
  fixedReference: async (task, kind, ref, revision) => task === taskId &&
    (kind === "git" && ref === gitId || kind === "wiki" && ref === wikiId && (!revision || revision === revisionId)),
  operation: async () => null,
  dispatchForRun: async () => ({projectId, id: parentDispatchId, loopId, taskId, sourceEventId: u(), runtimeRunId: runId}),
};
const command = (type: string, fields: Record<string, unknown> = {}) => ({ type, projectId, operationId: u(), ...fields });

test("business worker can attribute its own terminal Run delivery and agent observation only", async () => {
  assert.equal(await authorizeWorkerCommand(worker, command("delivery.record", { taskId, runId }), facts), true);
  assert.equal(await authorizeWorkerCommand(worker, command("observation.record", { taskId, deliveryId, observerKind: "agent", observer: worker.principal.actorId }), facts), true);
  for (const body of [command("delivery.record", { taskId: otherTaskId, runId }), command("delivery.record", { taskId, runId: u() }),
    command("delivery.record", { taskId }), command("observation.record", { taskId, deliveryId, observerKind: "human", observer: worker.principal.actorId }),
    command("runtime.session.reserve", { taskId }), command("role.create"), command("schedule.create"), command("project.create")])
    assert.equal(await authorizeWorkerCommand(worker, body, facts), false);
  assert.equal(await authorizeWorkerCommand(worker, { ...command("delivery.record", { taskId, runId }), projectId: u() }, facts), false);
  assert.equal(await authorizeWorkerCommand(worker, command("observation.record", { taskId, deliveryId, observerKind: "agent", observer: worker.principal.actorId }),
    { ...facts, delivery: async () => ({ projectId, taskId, runId: u() }) }), false);
});

test("worker route guard denies foreign reads and every unlisted write", async () => {
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/tasks/${taskId}` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/tasks/${otherTaskId}` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${u()}/tasks/${taskId}` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "POST", path: `/api/projects/${projectId}/runtime/recover` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/knowledge/pages` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}/original` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}/revisions/${u()}/original` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}/revisions` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/references/git/${gitId}` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/knowledge/pages/${wikiId}?revision=${revisionId}` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/knowledge/pages/${wikiId}?revision=${revisionId}&revision=${u()}` }, facts), false);
});

test("cognitive worker owner, loop and dispatch boundaries", async () => {
  const thinker: WorkerIdentity = { principal: { ...worker.principal }, scope: { ...worker.scope, kind: "cognition", roleId: "planner", allowedRoleIds: ["planner", "builder"] } };
  assert.equal(await authorizeWorkerCommand(thinker, command("task.create", { taskId: u(), owner: "builder", stageId }), facts), true);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `/api/projects/${projectId}/goals/${goalId}` }, facts), true);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `/api/projects/${projectId}/stages/${stageId}/reviews` }, facts), true);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `/api/projects/${projectId}/goals/${u()}` }, facts), false);
  assert.equal(await authorizeWorkerCommand(thinker, command("task.create", { taskId: u(), owner: "outside" }), facts), false);
  assert.equal(await authorizeWorkerCommand(thinker, command("dispatch.request", { taskId, inboxId, parentDispatchId, recipientRoleId: "builder" }), facts), true);
  assert.equal(await authorizeWorkerCommand(thinker, command("dispatch.request", { taskId, inboxId: u(), recipientRoleId: "builder" }), facts), false);
  assert.equal(await authorizeWorkerCommand(thinker, command("dispatch.request", { taskId: otherTaskId, inboxId, recipientRoleId: "outside" }), facts), false);
  assert.equal(await authorizeWorkerCommand(thinker, command("task.update", { taskId: otherTaskId, owner: "builder" }), facts), true);
  assert.equal(await authorizeWorkerCommand(worker, command("task.update", { taskId: otherTaskId, owner: "builder" }), facts), false);
  assert.equal(await authorizeWorkerCommand(thinker, command("inbox.ack", { inboxId }),
    { ...facts, inbox: async () => ({ projectId, loopId, state: "pending" }) }), true);
  assert.equal(await authorizeWorkerCommand(thinker, command("inbox.dispose", { inboxId }), facts), true);
  const paused: WorkerGuardFacts = { ...facts, loop: async () => ({ projectId, state: "paused", goalId: u(), stageId: null,
    cognitiveRoleId: "planner", allowedBusinessRoleIds: ["builder"] }) };
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/tasks/${taskId}` }, paused), true);
  assert.equal(await authorizeWorkerCommand(worker, command("delivery.record", { taskId, runId }), paused), true);
  assert.equal(await authorizeWorkerCommand(thinker, command("dispatch.request", { taskId, inboxId, recipientRoleId: "builder" }), paused), false);
});
test("a worker can verify the exact report revision it authored and cognition can read its Loop child", async () => {
  const report = u(), reportRevision = u(), child = u();
  const own = {...facts, document: async (id: string) => id === report ? {projectId,taskId,loopId} : null,
    fixedDocument: async () => false,
    ownedDocumentRevision: async (doc: string, revision: string) => doc === report && revision === reportRevision,
    dispatch: async (id: string) => id === child ? {projectId,loopId} : null};
  const path = `/api/projects/${projectId}/documents/${report}/revisions/`;
  assert.equal(await authorizeWorkerRequest(worker, {method: "GET", path: `${path}${reportRevision}/original`}, own), true);
  assert.equal(await authorizeWorkerRequest(worker, {method: "GET", path: `${path}${u()}/original`}, own), false);
  assert.equal(await authorizeWorkerRequest(worker, {method: "GET", path: `/api/projects/${projectId}/documents/${report}`}, own), false);
  assert.equal(await authorizeWorkerRequest(worker, {method: "GET", path: `${path.slice(0,-1)}`}, own), false);
  const thinker = {...worker,scope:{...worker.scope,kind:"cognition" as const,roleId:"planner"}};
  assert.equal(await authorizeWorkerRequest(thinker, {method:"GET",path:`/api/projects/${projectId}/orchestration/dispatches/${child}`},own),true);
  assert.equal(await authorizeWorkerRequest(worker, {method:"GET",path:`/api/projects/${projectId}/orchestration/dispatches/${child}`},own),false);
});
