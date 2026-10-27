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
  materialTaskRevision: async (task, revision) => task === taskId && revision === revisionId,
  run: async id => id === runId ? { projectId, taskId, sessionId } : null,
  delivery: async id => id === deliveryId ? { projectId, taskId, runId } : null,
  inbox: async id => id === inboxId ? { projectId, loopId, state: "acknowledged" } : null,
  document: async id => id === documentId ? { projectId, taskId: null, loopId: null } : null,
  fixedDocument: async (task, doc, revision) => task === taskId && doc === documentId && revision === revisionId,
  materialDocument: async (task, doc, revision) => task === taskId && doc === documentId && revision === revisionId,
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
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/runtime/runs/${runId}/input?cursor=0&limit=31` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/runtime/runs/${u()}/input` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/runtime/runs/${runId}/input?cursor=0&revision=${u()}` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/tasks/${taskId}/revisions/${revisionId}/materials` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/tasks/${otherTaskId}/revisions/${revisionId}/materials` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}/body?cursor=3&limit=5` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}/revisions/${u()}/body` }, facts), false);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}/assets/${u()}` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}/body?cursor=1&revision=${u()}` }, facts), false);
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

test("a cognition worker may update its Task but cannot reselect fixed inputs", async () => {
  const cognition: WorkerIdentity = { ...worker, scope: { ...worker.scope, kind: "cognition", roleId: "planner" } };
  const update = command("task.update", { taskId, owner: "builder" });
  assert.equal(await authorizeWorkerCommand(cognition, update, facts), true);
  assert.equal(await authorizeWorkerCommand(cognition, { ...update, basis: [] }, facts), false);
  assert.equal(await authorizeWorkerCommand(cognition, { ...update, retentions: [] }, facts), false);
});

test("dynamic handoff reads stay on the worker's own binding and fixed material",async()=>{
  const bindingId=u(),foreignBinding=u();
  const bounded:WorkerGuardFacts={...facts,
    divisionBinding:async id=>id===bindingId,
    divisionMaterial:async(doc,revision)=>doc===documentId&&revision===revisionId,
    fixedDocument:async()=>false,document:async()=>null};
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:`/api/projects/${projectId}/orchestration/bindings/${bindingId}`},bounded),true);
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:`/api/projects/${projectId}/orchestration/bindings/${foreignBinding}`},bounded),false);
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:`/api/projects/${projectId}/documents/${documentId}/revisions/${revisionId}/original`},bounded),true);
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:`/api/projects/${projectId}/documents/${documentId}/revisions/${u()}/original`},bounded),false);
  const thinker:WorkerIdentity={principal:worker.principal,scope:{...worker.scope,kind:"cognition",roleId:"planner",allowedRoleIds:["planner"]}};
  assert.equal(await authorizeWorkerRequest(thinker,{method:"GET",path:`/api/projects/${projectId}/orchestration/loops/${loopId}/delegation-choices`},bounded),true);
  assert.equal(await authorizeWorkerRequest(worker,{method:"GET",path:`/api/projects/${projectId}/orchestration/loops/${loopId}/delegation-choices`},bounded),false);
  const parent={projectId,id:parentDispatchId,loopId,taskId,sourceEventId:revisionId,runtimeRunId:runId};
  const cognitionFacts={...bounded,dispatchForRun:async()=>parent,
    run:async()=>({projectId,taskId,sessionId,state:"running" as const})};
  const intention=command("division.decide",{loopId,parentDispatchId,sourceEventId:revisionId,
    firstTaskId:taskId,documentId,documentRevisionId:revisionId});
  assert.equal(await authorizeWorkerRequest(thinker,{method:"POST",path:"/api/orchestration/commands",body:intention},cognitionFacts),false,
    "a future binding must not bootstrap access to its own evidence");
  assert.equal(await authorizeWorkerRequest(thinker,{method:"POST",path:"/api/orchestration/commands",body:intention},
    {...cognitionFacts,fixedDocument:async()=>true}),true);
});

test("cognitive worker owner, loop and dispatch boundaries", async () => {
  const thinker: WorkerIdentity = { principal: { ...worker.principal }, scope: { ...worker.scope, kind: "cognition", roleId: "planner", allowedRoleIds: ["planner", "builder"] } };
  assert.equal(await authorizeWorkerCommand(thinker, command("task.create", { taskId: u(), owner: "builder", stageId }), facts), true);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `/api/projects/${projectId}/goals/${goalId}` }, facts), true);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `/api/projects/${projectId}/stages/${stageId}/reviews` }, facts), true);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `/api/projects/${projectId}/orchestration/loops/${loopId}/sources` }, facts), true);
  assert.equal(await authorizeWorkerRequest(worker, { method: "GET", path: `/api/projects/${projectId}/orchestration/loops/${loopId}/sources` }, facts), false);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `/api/projects/${projectId}/orchestration/loops/${u()}/sources` }, facts), false);
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

test("planning candidates require cognition, exact Task revision and one query parameter", async () => {
  const thinker: WorkerIdentity = { principal: { ...worker.principal },
    scope: { ...worker.scope, kind: "cognition", roleId: "planner", allowedRoleIds: ["planner", "builder"] } };
  const path = `/api/projects/${projectId}/orchestration/tasks/${taskId}/planning-sources?taskRevisionId=${revisionId}`;
  assert.equal(await authorizeWorkerRequest(thinker, {method: "GET", path}, facts), true);
  assert.equal(await authorizeWorkerRequest(thinker, {method: "GET", path},
    {...facts, loop: async () => ({projectId, state: "active", goalId, stageId: null,
      cognitiveRoleId: "planner", allowedBusinessRoleIds: ["builder"]})}), true);
  assert.equal(await authorizeWorkerRequest(worker, {method: "GET", path}, facts), false);
  assert.equal(await authorizeWorkerRequest(thinker, {method: "GET", path: path.replace(taskId, u())}, facts), false);
  assert.equal(await authorizeWorkerRequest(thinker, {method: "GET", path: path.replace(revisionId, u())},
    {...facts, taskRevision: async (_task, revision) => revision === revisionId}), false);
  assert.equal(await authorizeWorkerRequest(thinker, {method: "GET", path: `${path}&taskRevisionId=${revisionId}`}, facts), false);
  assert.equal(await authorizeWorkerRequest(thinker, {method: "GET", path: `${path}&all=true`}, facts), false);
  assert.equal(await authorizeWorkerRequest(thinker, {method: "GET", path: path.replace(`?taskRevisionId=${revisionId}`, "")}, facts), false);
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

test("recovery cognition reads only the gap's terminal Run and fixed Task and basis revisions", async () => {
  const thinker = {...worker, scope: {...worker.scope, kind: "cognition" as const, roleId: "planner"}};
  const originalRunId = u(), originalTaskId = u(), originalRevisionId = u(), originalDocumentId = u(), originalDocumentRevisionId = u();
  const gapFacts: WorkerGuardFacts = {...facts,
    task: async () => null, document: async () => null,
    recoveryGap: async () => ({projectId, loopId, dispatchId: u(), eventId: u(),
      runId: originalRunId, taskId: originalTaskId, taskRevisionId: originalRevisionId}),
    recoveryDocument: async (doc, revision) => doc === originalDocumentId && revision === originalDocumentRevisionId};
  const get = (path: string, f = gapFacts) => authorizeWorkerRequest(thinker,
    {method: "GET", path: `/api/projects/${projectId}/${path}`}, f);
  assert.equal(await get(`runtime/runs/${originalRunId}`), true);
  assert.equal(await get(`runtime/runs/${originalRunId}/result`), true);
  assert.equal(await get(`tasks/${originalTaskId}/revisions/${originalRevisionId}`), true);
  assert.equal(await get(`references/tasks/${originalTaskId}/revisions/${originalRevisionId}`), true);
  assert.equal(await get(`documents/${originalDocumentId}/revisions/${originalDocumentRevisionId}/original`), true);
  for (const path of [`runtime/runs/${u()}`, `tasks/${originalTaskId}`, `tasks/${originalTaskId}/revisions`,
    `tasks/${originalTaskId}/revisions/${u()}`, `documents/${originalDocumentId}`,
    `documents/${originalDocumentId}/revisions`, `documents/${originalDocumentId}/revisions/${u()}/original`])
    assert.equal(await get(path), false, path);
  assert.equal(await get(`runtime/runs/${originalRunId}`, {...gapFacts, recoveryGap: async () => null}), false);
  assert.equal(await get(`runtime/runs/${originalRunId}`, {...gapFacts, recoveryGap: async () =>
    ({projectId, loopId: u(), dispatchId: u(), eventId: u(), runId: originalRunId,
      taskId: originalTaskId, taskRevisionId: originalRevisionId})}), false);
  assert.equal(await authorizeWorkerRequest(worker,
    {method:"GET",path:`/api/projects/${projectId}/runtime/runs/${originalRunId}`},gapFacts),false);
});
test("worker issue provenance is bound to its own Run; cognition reads and adopts only the frozen source revision", async () => {
  const issueId = u(), issueRevisionId = u(), laterRevisionId = u();
  const thinker: WorkerIdentity = { ...worker, scope: { ...worker.scope, kind: "cognition", roleId: "planner" } };
  const sourceFacts: WorkerGuardFacts = { ...facts,
    document: async () => null,
    sourceIssueDocumentRevision: async (doc, revision) => doc === issueId && revision === issueRevisionId,
    sourceIssueLinkedDocument: async doc => doc === issueId,
  };
  assert.equal(await authorizeWorkerCommand(worker, command("document.create", {
    documentId: issueId, kind: "issue", origin: { taskId, runId }, title: "Problem", body: "Evidence",
  }), sourceFacts), true);
  for (const origin of [undefined, { taskId: otherTaskId, runId }, { taskId, runId: u() }, { taskId, runId: null }]) {
    assert.equal(await authorizeWorkerCommand(worker, command("document.create", {
      documentId: issueId, kind: "issue", origin,
    }), sourceFacts), false);
  }
  const fixed = `/api/projects/${projectId}/documents/${issueId}/revisions/${issueRevisionId}`;
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: fixed }, sourceFacts), true);
  assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path: `${fixed}/original` }, sourceFacts), true);
  for (const path of [`/api/projects/${projectId}/documents/${issueId}`,
    `/api/projects/${projectId}/documents/${issueId}/revisions`,
    `/api/projects/${projectId}/documents/${issueId}/revisions/${laterRevisionId}/original`,
    `/api/projects/${u()}/documents/${issueId}/revisions/${issueRevisionId}/original`])
    assert.equal(await authorizeWorkerRequest(thinker, { method: "GET", path }, sourceFacts), false);
  assert.equal(await authorizeWorkerCommand(thinker, command("document.adopt", { documentId: issueId, revisionId: issueRevisionId }), sourceFacts), true);
  assert.equal(await authorizeWorkerCommand(thinker, command("document.publish", { documentId: issueId, revisionId: issueRevisionId }), sourceFacts), true);
  assert.equal(await authorizeWorkerCommand(thinker, command("document.adopt", { documentId: issueId, revisionId: laterRevisionId }), sourceFacts), false);
  assert.equal(await authorizeWorkerCommand(worker, command("document.adopt", { documentId: issueId, revisionId: issueRevisionId }), sourceFacts), false);
  const create = command("task.create", { taskId: u(), owner: "builder", stageId, documentIds: [issueId] });
  const update = command("task.update", { taskId, owner: "builder", documentIds: [issueId] });
  assert.equal(await authorizeWorkerCommand(thinker, create, sourceFacts), true);
  assert.equal(await authorizeWorkerCommand(thinker, update, sourceFacts), true);
  assert.equal(await authorizeWorkerCommand(worker, create, sourceFacts), false);
  for (const rejected of [u(), documentId]) {
    assert.equal(await authorizeWorkerCommand(thinker, { ...create, documentIds: [rejected] }, sourceFacts), false);
    assert.equal(await authorizeWorkerCommand(thinker, { ...update, documentIds: [rejected] }, sourceFacts), false);
  }
  assert.equal(await authorizeWorkerCommand(thinker, create,
    { ...sourceFacts, sourceIssueLinkedDocument: async () => false }), false);
});
