import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { OrchestrationDispatch, OrchestrationInbox, OrchestrationLoop, OrchestrationSourceFact } from "@evoloop/contracts/orchestration";
import { ManagedLoopRunner, loopIntentId, type ManagedLoopDependencies } from "../src/orchestration/runner.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const goalId = "00000000-0000-4000-8000-000000000002";
const stageId = "00000000-0000-4000-8000-000000000003";
const loopId = "00000000-0000-4000-8000-000000000004";
const sourceId = "00000000-0000-4000-8000-000000000005";
const cognition = "cognition";
const scopeId = "cognitive-scope";
const principal: Principal = { actorId: "controller", projectIds: [projectId], permissions: ["read", "write", "review"] };
const now = "2026-10-23T00:00:00.000Z";
const noObservation = { operationId: null, sourceActorId: null, observationId: null,
  deliveryId: null, observationResult: null } as const;

function fixture() {
  let currentTime = now;
  const orchestrationOperations = new Map<string, {projectId:string;id:string;actorId:string;commandHash:string;result:{entityType:"dispatch";entityId:string;version:number;replayed:false};createdAtUtc:string}>();
  let lostClaimResponse: "dispatch.claim" | "dispatch.reclaim" | null = null;
  let loseReadbackOnce = false;
  const loop: OrchestrationLoop = { projectId, id: loopId, version: 1, goalId, stageId,
    bootstrapEventId: sourceId, cognitiveRoleId: cognition, allowedBusinessRoleIds: ["builder"],
    sourceAfter: { createdAtUtc: now, eventId: null }, maxRuns: 3, maxConcurrent: 1, dispatchCount: 0,
    state: "active", enrolledBy: "owner", createdAtUtc: now, updatedAtUtc: now };
  const source: OrchestrationSourceFact = { projectId, id: sourceId, createdAtUtc: now,
    kind: "loop.enrolled", subjectId: loopId, subjectVersion: 1, sourceLoopId: loopId, originDispatchId: null,
    ...noObservation };
  const inbox: OrchestrationInbox[] = [];
  const dispatches: OrchestrationDispatch[] = [];
  const tasks = new Map<string, { version: number; state: "todo" | "in_progress";
    links?: { documentId: string }[]; basis?: object }>();
  const documents = new Map<string, { status: "draft" | "published" | "archived"; adoptedRevisionId: string | null;
    currentRevisionId?: string }>();
  const documentHashes = new Map<string, string>();
  const taskStarts: Record<string, any>[] = [];
  const taskCreates: Record<string, any>[] = [];
  const documentReads: string[] = [];
  const operations = new Map<string, { result: { status: "applied"; entityId: string; version: number } }>();
  const sessions = new Map<string, { state: "reserved" | "ready"; id: string }>();
  const runs = new Map<string, { id: string; state: "requested" | "completed" | "unknown"; taskId: string }>();
  const commands: string[] = [];
  const facts = [source];
  const rejectedSources = new Set<string>();
  let credentialIssues = 0;
  let lastScope: { allowedRoleIds: string[] } | null = null;
  let lastInput: string | null = null;
  let sealStatus: Awaited<ReturnType<ManagedLoopDependencies["sealSubmission"]>> = { status: "absent" };
  const orchestration = {
    getOperation: async (_: Principal, _projectId: string, id: string) => { if (loseReadbackOnce) { loseReadbackOnce=false; throw new Error("RECEIPT_READ_LOST"); } return orchestrationOperations.get(id) ?? null; },
    getDispatch: async (_: Principal, _projectId: string, id: string) => dispatches.find(item => item.id === id) ?? null,
    getInbox: async (_: Principal, _projectId: string, id: string) => inbox.find(item => item.id === id) ?? null,
    getSubmissionForDispatch: async () => null,
    getDecisionForDispatch: async () => null,
    listLoops: async () => ({ items: [loop], nextCursor: null }),
    getLoop: async () => loop,
    listSourceFacts: async () => ({ items: facts, nextCursor: null }),
    listInbox: async () => ({ items: inbox, nextCursor: null }),
    listDispatches: async () => ({ items: dispatches, nextCursor: null }),
    execute: async (principal: Principal, command: Record<string, any>) => {
      commands.push(command.type);
      if (command.type === "inbox.accept") {
        if (rejectedSources.has(command.sourceEventId)) throw new Error("SELF_COGNITION_SOURCE");
        if (!inbox.some(item => item.sourceEventId === command.sourceEventId && item.purpose === command.purpose))
          inbox.push({ projectId, id: loopIntentId(loopId, command.sourceEventId, "inbox"), loopId,
            sourceEventId: command.sourceEventId, recipientRoleId: cognition, purpose: command.purpose,
            version: 1, state: "pending", acknowledgedBy: null, disposition: null, reason: null,
            evidenceRef: null, dispatchId: null, createdAtUtc: now, updatedAtUtc: now });
      }
      if (command.type === "inbox.ack") Object.assign(inbox.find(item => item.id === command.inboxId)!, { state: "acknowledged", version: 2 });
      if (command.type === "inbox.dispose") Object.assign(inbox.find(item => item.id === command.inboxId)!, { state: "disposed", disposition: command.disposition, version: 3 });
      if (command.type === "dispatch.request") {
        const item = inbox.find(item => item.id === command.inboxId)!;
        Object.assign(item, { state: "disposed", disposition: "dispatch", dispatchId: command.dispatchId });
        dispatches.push({ projectId, id: command.dispatchId, version: 1, loopId, inboxId: item.id,
          sourceEventId: item.sourceEventId, taskId: command.taskId, taskVersion: command.expectedTaskVersion,
          parentDispatchId: null, recipientRoleId: cognition, purpose: "cognition", authorizationScopeId: scopeId,
          state: "pending", claimToken: null, leaseUntilUtc: null, runtimeRunId: null, outcome: null,
          deliveryId: null, evidenceRef: null, reason: command.reason, requestedBy: principal.actorId,
          createdAtUtc: now, updatedAtUtc: now });
        loop.dispatchCount++;
      }
      const dispatch = dispatches.find(item => item.id === command.dispatchId);
      if (command.type === "dispatch.claim") Object.assign(dispatch!, { state: "claimed", claimToken: command.claimToken, leaseUntilUtc: command.leaseUntilUtc, version: dispatch!.version + 1 });
      if (command.type === "dispatch.reclaim") Object.assign(dispatch!, { leaseUntilUtc: command.leaseUntilUtc, version: dispatch!.version + 1 });
      if (command.type === "dispatch.start") Object.assign(dispatch!, { state: "dispatching" });
      if (command.type === "dispatch.resolve") Object.assign(dispatch!, { state: command.result, runtimeRunId: command.runtimeRunId });
      if (command.type === "dispatch.gap") {
        Object.assign(dispatch!, { reason: command.reason, version: dispatch!.version + 1 });
        facts.push({ projectId, id: loopIntentId(dispatch!.id, "gap-source"), createdAtUtc: currentTime,
          kind: "dispatch.gap", subjectId: dispatch!.taskId, subjectVersion: dispatch!.version,
          sourceLoopId: loopId, originDispatchId: dispatch!.id, gapRunId: dispatch!.runtimeRunId,
          gapTaskVersion: dispatch!.taskVersion,
          ...noObservation });
      }
      if (command.type === "worker.outcome") Object.assign(dispatch!, { state: "completed", outcome: command.outcome, deliveryId: command.deliveryId });
      if (command.type === "dispatch.claim" || command.type === "dispatch.reclaim") {
        const canonical = JSON.stringify(command, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
        orchestrationOperations.set(command.operationId, {projectId,id:command.operationId,actorId:principal.actorId,commandHash:createHash("sha256").update(canonical).digest("hex"),result:{entityType:"dispatch",entityId:command.dispatchId,version:dispatch!.version,replayed:false},createdAtUtc:currentTime});
        if (lostClaimResponse === command.type) { lostClaimResponse = null; loseReadbackOnce=true; throw new Error("CLAIM_RESPONSE_LOST"); }
      }
      return { entityType: "inbox", entityId: command.inboxId ?? command.dispatchId ?? loopId, version: 1, replayed: false };
    },
  };
  const workflow = {
    getTask: async (_: Principal, _projectId: string, id: string) => {
      const task = tasks.get(id); if (!task) throw new Error("missing task");
      return { task: { id, version: task.version, state: task.state }, links: task.links ?? [], basis: task.basis ?? null };
    },
    getDocument: async (_: Principal, _projectId: string, id: string) => {
      documentReads.push(id);
      const document = documents.get(id); if (!document) throw new Error(`missing document ${id}`);
      return { document: { id, ...document }, adopted: document.adoptedRevisionId
        ? { id: document.adoptedRevisionId, contentHash: documentHashes.get(id) } : null };
    },
    getOperation: async (_: Principal, _projectId: string, id: string) => operations.get(id) ?? null,
    getRuntimeSession: async (_: Principal, _projectId: string, id: string) => {
      const session = sessions.get(id); if (!session) throw new Error("missing session"); return session;
    },
    getRuntimeRun: async (_: Principal, _projectId: string, id: string) => {
      const run = runs.get(id); if (!run) throw new Error("missing run"); return { projectId, ...run };
    },
    execute: async (_: Principal, command: Record<string, any>) => {
      commands.push(command.type);
      const previous = operations.get(command.operationId);
      if (previous) return previous.result;
      if (command.type === "task.create") { taskCreates.push(command); tasks.set(command.taskId, { version: 1, state: "todo" }); }
      if (command.type === "task.start") {
        taskStarts.push(command);
        Object.assign(tasks.get(command.taskId)!, { version: 2, state: "in_progress" });
      }
      if (command.type === "runtime.session.reserve") sessions.set(command.sessionId, { id: command.sessionId, state: "reserved" });
      if (command.type === "runtime.run.reserve") {
        lastInput = command.input;
        tasks.get(command.taskId)!.version++;
        runs.set(command.runId, { id: command.runId, taskId: command.taskId, state: "requested" });
      }
      const result = { status: "applied" as const, entityId: command.taskId ?? command.sessionId ?? command.runId, version: 1 };
      operations.set(command.operationId, { result });
      return result;
    },
  };
  const credentials = new Map<string, { principal: Principal; wrapperPath: string }>();
  const deps: ManagedLoopDependencies = {
    projects: [projectId], reader: () => principal,
    orchestration: orchestration as unknown as ManagedLoopDependencies["orchestration"],
    workflow: workflow as unknown as ManagedLoopDependencies["workflow"],
    runtime: { pump: async () => {} },
    controller: async () => ({ principal, authorizationScopeId: scopeId, cwd: "/tmp/evoloop-test",
      sandbox: "workspace-write", approvalPolicy: "on-request" }),
    credential: {
      issue: async scope => { credentialIssues++; lastScope = scope; const issued = { principal, wrapperPath: `/private/${scope.runId}/worker-cli.mjs` }; credentials.set(scope.runId, issued); return issued; },
      lookup: async runId => credentials.get(runId) ?? null,
    },
    sealSubmission: async () => sealStatus,
    now: () => currentTime, canWrite: () => true,
  };
  return { loop, facts, inbox, dispatches, tasks, documents, documentHashes, taskStarts, taskCreates, documentReads, sessions, runs, commands, deps,
    rejectSource: (id: string) => rejectedSources.add(id),
    advanceTime: (value:string) => { currentTime=value; },
    loseClaimResponse: (kind:"dispatch.claim"|"dispatch.reclaim") => { lostClaimResponse=kind; },
    orchestrationOperations,
    setSeal: (value: typeof sealStatus) => { sealStatus = value; }, credentialIssues: () => credentialIssues,
    lastScope: () => lastScope, lastInput: () => lastInput };
}

test("bootstrap seeds exactly one cognition Task and dispatch across repeated polls", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump(); await runner.pump();
  assert.equal(f.inbox.length, 1);
  assert.equal(f.inbox[0]!.purpose, "cognitive_review");
  assert.equal(f.tasks.size, 1);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.dispatches[0]!.purpose, "cognition");
  assert.equal(f.commands.filter(type => type === "task.create").length, 1);
});

test("pause blocks new claims while an accepted terminal Run can settle", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  f.loop.state = "paused";
  await runner.pump();
  assert.equal(f.dispatches[0]!.state, "pending");
  f.dispatches[0]!.state = "accepted";
  f.dispatches[0]!.runtimeRunId = loopIntentId(f.dispatches[0]!.id, "run");
  f.runs.set(f.dispatches[0]!.runtimeRunId!, { id: f.dispatches[0]!.runtimeRunId!, taskId: f.dispatches[0]!.taskId, state: "completed" });
  f.setSeal({ status: "decision", decisionId: loopIntentId("decision"), outcome: "no_action", reason: "No action justified" });
  await runner.pump();
  assert.equal(f.dispatches[0]!.state, "completed");
  assert.equal(f.dispatches[0]!.outcome, "no_action");
});

test("signed waiting cognition settles without a gap and releases its requested child once", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const parent = f.dispatches[0]!;
  parent.state = "accepted"; parent.outcome = null; parent.deliveryId = null;
  parent.runtimeRunId = loopIntentId(parent.id, "run");
  f.runs.set(parent.runtimeRunId, { id: parent.runtimeRunId, taskId: parent.taskId, state: "requested" });
  f.setSeal({ status: "decision", decisionId: loopIntentId("waiting-decision"), outcome: "waiting", reason: "Signed waiting decision" });
  const childTaskId = loopIntentId("child-task"), childId = loopIntentId("child-dispatch");
  const childInboxId = loopIntentId("child-inbox");
  f.tasks.set(childTaskId, { version: 1, state: "todo" });
  f.inbox.push({ projectId, id: childInboxId, loopId, sourceEventId: parent.sourceEventId,
    recipientRoleId: cognition, purpose: "next_action", version: 3, state: "disposed",
    acknowledgedBy: principal.actorId, disposition: "dispatch", reason: null, evidenceRef: null,
    dispatchId: childId, createdAtUtc: now, updatedAtUtc: now });
  f.dispatches.push({ projectId, id: childId, version: 1, loopId,
    inboxId: childInboxId, sourceEventId: parent.sourceEventId, taskId: childTaskId, taskVersion: 1,
    parentDispatchId: parent.id, recipientRoleId: "builder", purpose: "next_action", authorizationScopeId: scopeId,
    state: "pending", claimToken: null, leaseUntilUtc: null, runtimeRunId: null, outcome: null, deliveryId: null,
    evidenceRef: null, reason: "signed dispatch request", requestedBy: principal.actorId, createdAtUtc: now, updatedAtUtc: now });
  await runner.pump();
  assert.equal(f.commands.filter(type => type === "dispatch.claim").length, 0);
  f.runs.get(parent.runtimeRunId)!.state = "completed";
  await runner.pump();
  assert.equal(parent.state, "completed");
  assert.equal(parent.outcome, "waiting");
  assert.equal(parent.deliveryId, null);
  assert.equal(f.commands.filter(type => type === "worker.outcome").length, 1);
  assert.equal(f.commands.filter(type => type === "dispatch.gap").length, 0);
  assert.equal(f.dispatches[1]!.state, "dispatching");
  await runner.pump();
  assert.equal(f.commands.filter(type => type === "dispatch.claim").length, 1);
  assert.equal(f.taskStarts.filter(item => item.taskId === childTaskId).length, 1);
});

test("terminal cognition with a signed child but no final declaration records a closure gap", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const parent = f.dispatches[0]!;
  parent.state = "accepted"; parent.runtimeRunId = loopIntentId(parent.id, "run");
  f.runs.set(parent.runtimeRunId, { id: parent.runtimeRunId, taskId: parent.taskId, state: "completed" });
  const childTaskId = loopIntentId("child-without-parent-declaration-task");
  const childId = loopIntentId("child-without-parent-declaration-dispatch");
  const childInboxId = loopIntentId("child-without-parent-declaration-inbox");
  f.tasks.set(childTaskId, { version: 1, state: "todo" });
  f.inbox.push({ projectId, id: childInboxId, loopId, sourceEventId: parent.sourceEventId,
    recipientRoleId: cognition, purpose: "next_action", version: 3, state: "disposed",
    acknowledgedBy: principal.actorId, disposition: "dispatch", reason: null, evidenceRef: null,
    dispatchId: childId, createdAtUtc: now, updatedAtUtc: now });
  f.dispatches.push({ projectId, id: childId, version: 1, loopId, inboxId: childInboxId,
    sourceEventId: parent.sourceEventId, taskId: childTaskId, taskVersion: 1, parentDispatchId: parent.id,
    recipientRoleId: "builder", purpose: "next_action", authorizationScopeId: scopeId,
    state: "pending", claimToken: null, leaseUntilUtc: null, runtimeRunId: null, outcome: null,
    deliveryId: null, evidenceRef: null, reason: "signed dispatch request", requestedBy: principal.actorId,
    createdAtUtc: now, updatedAtUtc: now });
  await runner.pump();
  assert.equal(parent.state, "accepted");
  assert.equal(parent.outcome, null);
  assert.equal(parent.deliveryId, null);
  assert.match(parent.reason, /final declaration absent/);
  assert.match(parent.reason, new RegExp(childId));
  assert.equal(f.commands.filter(type => type === "dispatch.gap").length, 1);
  assert.equal(f.commands.filter(type => type === "worker.outcome").length, 0);
  assert.equal(f.dispatches.find(item => item.id === childId)!.state, "dispatching");
  await runner.pump();
  assert.equal(f.commands.filter(type => type === "dispatch.gap").length, 1);
  assert.equal(f.commands.filter(type => type === "dispatch.claim").length, 1);
  assert.equal(f.taskStarts.filter(item => item.taskId === childTaskId).length, 1);
  assert.equal(f.dispatches.filter(item => item.purpose === "next_action").length, 1);
});

test("unknown Run waits; terminal missing intent creates one recovery cognition after gap and restart", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const dispatch = f.dispatches[0]!;
  dispatch.state = "accepted"; dispatch.runtimeRunId = loopIntentId(dispatch.id, "run");
  f.runs.set(dispatch.runtimeRunId, { id: dispatch.runtimeRunId, taskId: dispatch.taskId, state: "unknown" });
  await runner.pump();
  assert.equal(dispatch.state, "accepted");
  f.runs.get(dispatch.runtimeRunId)!.state = "completed";
  await runner.pump();
  assert.equal(dispatch.state, "accepted");
  assert.equal(f.inbox.length, 1);
  assert.equal(dispatch.reason, "Worker intent gap: absent");
  assert.equal(f.inbox.some(item => item.sourceEventId === loopIntentId(dispatch.id, "gap-source")), false);
  f.loop.state = "paused";
  await runner.pump();
  assert.equal(f.commands.filter(type => type === "dispatch.gap").length, 1);
  assert.equal(f.inbox.filter(item => item.sourceEventId === loopIntentId(dispatch.id, "gap-source")).length, 0);
  f.loop.state = "active";
  await runner.pump();
  assert.equal(f.inbox.filter(item => item.sourceEventId === loopIntentId(dispatch.id, "gap-source")).length, 1);
  assert.equal(f.tasks.size, 2);
  assert.equal(f.dispatches.length, 2);
  await new ManagedLoopRunner(f.deps).pump();
  assert.equal(f.inbox.filter(item => item.sourceEventId === loopIntentId(dispatch.id, "gap-source")).length, 1);
  assert.equal(f.commands.filter(type => type === "task.create").length, 2);
});

test("post-start crash reuses original Task start and worker credential", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const dispatch = f.dispatches[0]!;
  dispatch.state = "dispatching";
  await runner.pump();
  assert.equal(f.tasks.get(dispatch.taskId)!.state, "in_progress");
  const session = [...f.sessions.values()][0]!;
  session.state = "ready";
  await runner.pump();
  assert.equal(f.credentialIssues(), 1);
  assert.equal(f.runs.size, 1);
  assert.equal(dispatch.state, "accepted");
  assert.deepEqual(f.lastScope()!.allowedRoleIds, ["cognition", "builder"]);
  assert.match(f.lastInput()!, /builder=cognitive-scope/);
  assert.match(f.lastInput()!, /parentDispatchId=/);
  await runner.pump();
  assert.equal(f.commands.filter(type => type === "task.start").length, 1);
  assert.equal(f.credentialIssues(), 1);
});

test("first Task start pins every linked published Document revision", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const task = f.tasks.get(f.dispatches[0]!.taskId)!;
  const first = loopIntentId("source-first");
  const second = loopIntentId("source-second");
  const firstRevision = loopIntentId("revision-first");
  const secondRevision = loopIntentId("revision-second");
  task.links = [{ documentId: second }, { documentId: first }];
  f.documents.set(first, { status: "published", adoptedRevisionId: firstRevision });
  f.documents.set(second, { status: "published", adoptedRevisionId: secondRevision });
  await runner.pump();
  assert.deepEqual(f.taskStarts[0]!.basis, [
    { documentId: first, revisionId: firstRevision },
    { documentId: second, revisionId: secondRevision },
  ].sort((a, b) => a.documentId.localeCompare(b.documentId)));
  assert.equal(task.state, "in_progress");
});

test("unpublished or archived linked Document blocks automatic Task start", async () => {
  for (const status of ["draft", "archived"] as const) {
    const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
    await runner.pump();
    const task = f.tasks.get(f.dispatches[0]!.taskId)!;
    const documentId = loopIntentId("linked", status);
    task.links = [{ documentId }];
    f.documents.set(documentId, { status, adoptedRevisionId: status === "archived" ? loopIntentId("adopted") : null });
    await runner.pump();
    assert.equal(task.state, "todo");
    assert.equal(f.taskStarts.length, 0);
    assert.match(runner.status().faults[0]!.code, /LINKED_BASIS_UNPUBLISHED/);
  }
});

test("existing Task basis is inherited without reading current linked adoption", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const task = f.tasks.get(f.dispatches[0]!.taskId)!;
  const documentId = loopIntentId("retained-source");
  task.links = [{ documentId }];
  task.basis = { members: [{ documentId, revisionId: loopIntentId("prior-revision") }], retentions: [] };
  f.documents.set(documentId, { status: "published", adoptedRevisionId: loopIntentId("new-adoption") });
  await runner.pump();
  assert.equal(task.state, "in_progress");
  assert.equal(Object.hasOwn(f.taskStarts[0]!, "basis"), false);
  assert.deepEqual(f.documentReads, []);
});

async function fixedIssueChild(sourceKind: "document" | "waiting.resumed" = "document") {
  const f = fixture(), runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const parent = f.dispatches[0]!;
  parent.state = "accepted";
  parent.runtimeRunId = loopIntentId(parent.id, "run");
  f.runs.set(parent.runtimeRunId, { id: parent.runtimeRunId, taskId: parent.taskId, state: "completed" });
  f.setSeal({ status: "decision", decisionId: loopIntentId("source-parent-decision"),
    outcome: "waiting", reason: "fixed source follow-up" });
  const childTaskId = loopIntentId("issue-child-task"), childInboxId = loopIntentId("issue-child-inbox");
  const childId = loopIntentId("issue-child-dispatch");
  f.tasks.set(childTaskId, { version: 1, state: "todo" });
  f.inbox.push({ projectId, id: childInboxId, loopId, sourceEventId: sourceId, recipientRoleId: cognition,
    purpose: "next_action", version: 3, state: "disposed", acknowledgedBy: principal.actorId,
    disposition: "dispatch", reason: null, evidenceRef: null, dispatchId: childId, createdAtUtc: now, updatedAtUtc: now });
  const child: OrchestrationDispatch = { projectId, id: childId, version: 1, loopId, inboxId: childInboxId,
    sourceEventId: sourceId, taskId: childTaskId, taskVersion: 1, parentDispatchId: parent.id,
    recipientRoleId: "builder", purpose: "next_action", authorizationScopeId: scopeId, state: "pending",
    claimToken: null, leaseUntilUtc: null, runtimeRunId: null, outcome: null, deliveryId: null,
    evidenceRef: null, reason: "fixed issue child", requestedBy: principal.actorId, createdAtUtc: now, updatedAtUtc: now };
  f.dispatches.push(child);
  const sourceIssueId = loopIntentId("fixed-source-issue"), fixedRevisionId = loopIntentId("fixed-source-revision");
  const contentHash = "b".repeat(64);
  f.facts[0] = { projectId, id: sourceId, createdAtUtc: now, kind: sourceKind, subjectId: sourceIssueId,
    subjectVersion: 1, sourceLoopId: null, originDispatchId: null, operationId: loopIntentId("source-operation"),
    sourceActorId: "business-reporter", issueRevisionId: fixedRevisionId, issueContentHash: contentHash,
    observationId: null, deliveryId: null, observationResult: null };
  const task = f.tasks.get(child.taskId)!;
  task.links = [{ documentId: sourceIssueId }];
  f.documents.set(sourceIssueId, { status: "published", adoptedRevisionId: fixedRevisionId,
    currentRevisionId: fixedRevisionId });
  f.documentHashes.set(sourceIssueId, contentHash);
  return { f, runner, child, task, sourceIssueId, fixedRevisionId, contentHash };
}

test("Issue child start pins the original source revision and waits for exact publication", async () => {
  const { f, runner, child, task, sourceIssueId, fixedRevisionId } = await fixedIssueChild();
  f.documents.set(sourceIssueId, { status: "draft", adoptedRevisionId: null, currentRevisionId: fixedRevisionId });
  await runner.pump(); await runner.pump();
  assert.equal(task.state, "todo");
  assert.equal(f.taskStarts.length, 0);
  assert.match(runner.status().faults[0]!.code, /LINKED_BASIS_UNPUBLISHED/);
  f.documents.set(sourceIssueId, { status: "published", adoptedRevisionId: fixedRevisionId, currentRevisionId: fixedRevisionId });
  await runner.pump();
  assert.deepEqual(f.taskStarts[0]!.basis, [{ documentId: sourceIssueId, revisionId: fixedRevisionId }]);
  assert.equal(f.taskStarts[0]!.taskId, child.taskId);
});

test("Issue child refuses missing link, later head or adoption, and mismatched existing basis", async () => {
  for (const change of ["missing", "head", "adopted", "hash", "basis"] as const) {
    const { f, runner, task, sourceIssueId, fixedRevisionId } = await fixedIssueChild();
    if (change === "missing") task.links = [];
    if (change === "head") f.documents.get(sourceIssueId)!.currentRevisionId = loopIntentId("later-head");
    if (change === "adopted") f.documents.get(sourceIssueId)!.adoptedRevisionId = loopIntentId("later-adoption");
    if (change === "hash") f.documentHashes.set(sourceIssueId, "c".repeat(64));
    if (change === "basis") task.basis = { members: [{ documentId: sourceIssueId,
      revisionId: loopIntentId("later-basis") }], retentions: [] };
    await runner.pump(); await runner.pump();
    assert.equal(task.state, "todo", change);
    assert.equal(f.taskStarts.length, 0, change);
    assert.match(runner.status().faults[0]!.code, /SOURCE_ISSUE_/, change);
  }
});

test("Issue child inherits an existing basis only when it retains the original revision", async () => {
  const { f, runner, task, sourceIssueId, fixedRevisionId } = await fixedIssueChild();
  task.basis = { members: [{ documentId: sourceIssueId, revisionId: fixedRevisionId }], retentions: [] };
  f.documents.get(sourceIssueId)!.adoptedRevisionId = loopIntentId("later-adoption");
  await runner.pump(); await runner.pump();
  assert.equal(task.state, "in_progress");
  assert.equal(Object.hasOwn(f.taskStarts[0]!, "basis"), false);
});

test("resumed Issue child uses the same original and rejects a newer adoption", async () => {
  const original = await fixedIssueChild("waiting.resumed");
  await original.runner.pump(); await original.runner.pump();
  assert.deepEqual(original.f.taskStarts[0]!.basis,
    [{ documentId: original.sourceIssueId, revisionId: original.fixedRevisionId }]);
  const changed = await fixedIssueChild("waiting.resumed");
  changed.f.documents.get(changed.sourceIssueId)!.adoptedRevisionId = loopIntentId("new-adoption");
  await changed.runner.pump(); await changed.runner.pump();
  assert.equal(changed.task.state, "todo");
  assert.match(changed.runner.status().faults[0]!.code, /SOURCE_ISSUE_CHANGED/);
});

test("more than 19 linked Documents blocks automatic Task start", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const task = f.tasks.get(f.dispatches[0]!.taskId)!;
  task.links = Array.from({ length: 20 }, (_, index) => ({ documentId: loopIntentId("source", String(index)) }));
  await runner.pump();
  assert.equal(task.state, "todo");
  assert.equal(f.taskStarts.length, 0);
  assert.deepEqual(f.documentReads, []);
  assert.match(runner.status().faults[0]!.code, /LINKED_BASIS_LIMIT/);
});

test("source scan ignores housekeeping and cognition Task changes", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  f.facts.push({ projectId, id: loopIntentId("housekeeping"), createdAtUtc: now,
    kind: "task", subjectId: loopIntentId("cognition-task"), subjectVersion: 2,
    sourceLoopId: loopId, originDispatchId: null, ...noObservation });
  await runner.pump(); await runner.pump();
  assert.equal(f.inbox.length, 1);
});

test("a sealed business result returns to cognition once, while raw delivery does not", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  const businessTaskId = loopIntentId("business-task");
  const resultEventId = loopIntentId("business-delivery-event");
  f.dispatches.push({ projectId, id: loopIntentId("business-dispatch"), version: 4, loopId,
    inboxId: loopIntentId("business-inbox"), sourceEventId: sourceId, taskId: businessTaskId, taskVersion: 2,
    parentDispatchId: loopIntentId("prior-cognition"), recipientRoleId: "builder", purpose: "next_action",
    authorizationScopeId: "builder-scope", state: "completed", claimToken: null, leaseUntilUtc: null,
    runtimeRunId: loopIntentId("business-run"), outcome: "delivered", deliveryId: loopIntentId("delivery"),
    evidenceRef: null, reason: "delivered", requestedBy: "worker", createdAtUtc: now, updatedAtUtc: now });
  f.facts.push({ projectId, id: resultEventId, createdAtUtc: now, kind: "worker.outcome",
    subjectId: businessTaskId, subjectVersion: 4, sourceLoopId: loopId,
    originDispatchId: f.dispatches[0]!.id, ...noObservation });
  f.facts.push({ projectId, id: loopIntentId("unrelated-delivery"), createdAtUtc: now,
    kind: "delivery.record", subjectId: loopIntentId("unrelated-task"), subjectVersion: 3,
    sourceLoopId: null, originDispatchId: null, ...noObservation });
  await runner.pump(); await runner.pump();
  assert.deepEqual(f.inbox.map(item => item.sourceEventId).sort(), [sourceId, resultEventId].sort());
  assert.equal(f.inbox.filter(item => item.sourceEventId === resultEventId).length, 1);
});

test("business failure wakes cognition once and cognitive outcome cannot self-wake", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  const failed = loopIntentId("business-failed");
  const outcomeEvent = loopIntentId("failure-outcome-event");
  f.dispatches.push({ projectId, id: failed, version: 4, loopId,
    inboxId: loopIntentId("business-inbox"), sourceEventId: sourceId, taskId: loopIntentId("business-task"), taskVersion: 2,
    parentDispatchId: loopIntentId("prior-cognition"), recipientRoleId: "builder", purpose: "next_action",
    authorizationScopeId: "builder-scope", state: "completed", claimToken: null, leaseUntilUtc: null,
    runtimeRunId: loopIntentId("business-run"), outcome: "failed", deliveryId: null,
    evidenceRef: null, reason: "worker failed", requestedBy: "worker", createdAtUtc: now, updatedAtUtc: now });
  f.facts.push({ projectId, id: outcomeEvent, createdAtUtc: now, kind: "worker.outcome", subjectId: f.dispatches[0]!.taskId, subjectVersion: 4,
    sourceLoopId: loopId, originDispatchId: failed, ...noObservation });
  f.facts.push({ projectId, id: loopIntentId("cognitive-outcome"), createdAtUtc: now,
    kind: "worker.outcome", subjectId: loopIntentId("cognitive-dispatch"), subjectVersion: 4,
    sourceLoopId: loopId, originDispatchId: loopIntentId("cognitive-dispatch"), ...noObservation });
  await runner.pump(); await runner.pump();
  assert.deepEqual(f.inbox.map(item => item.sourceEventId).sort(), [sourceId, outcomeEvent].sort());
});

test("verified external observation wakes cognition; raw Delivery and self cognition do not", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  const externalId = loopIntentId("external-observation");
  const selfId = loopIntentId("self-observation");
  const observation = (id: string, actorId: string) => ({ projectId, id, createdAtUtc: now,
    kind: "observation.record", subjectId: loopIntentId("observed-task"), subjectVersion: 3,
    sourceLoopId: null, originDispatchId: null, operationId: loopIntentId(id, "operation"),
    sourceActorId: actorId, observationId: loopIntentId(id, "observation"),
    deliveryId: loopIntentId(id, "delivery"), observationResult: "used" as const });
  f.facts.push(observation(externalId, "external-observer"));
  f.facts.push({ projectId, id: loopIntentId("raw-delivery"), createdAtUtc: now,
    kind: "delivery.record", subjectId: loopIntentId("observed-task"), subjectVersion: 3,
    sourceLoopId: null, originDispatchId: null, ...noObservation });
  f.facts.push(observation(selfId, "self-cognitive-worker"));
  f.rejectSource(selfId); // Core rejects an Observation by the loop's own cognition actor.
  await runner.pump(); await runner.pump();
  assert.deepEqual(f.inbox.map(item => item.sourceEventId).sort(), [sourceId, externalId].sort());
  assert.equal(f.inbox.filter(item => item.sourceEventId === externalId).length, 1);
});

test("a verified issue creation seeds one cognition Task with its exact original; report does not wake", async () => {
  const f = fixture();
  const issueId = loopIntentId("issue-document"), issueEventId = loopIntentId("issue-source");
  const issueRevisionId = loopIntentId("issue-initial-revision");
  const issueHash = "a".repeat(64);
  f.facts.push({ projectId, id: issueEventId, createdAtUtc: "2026-10-23T00:01:00.000Z",
    kind: "document", subjectId: issueId, subjectVersion: 1, sourceLoopId: null, originDispatchId: null,
    operationId: loopIntentId("issue-create-operation"), sourceActorId: "independent-reporter",
    issueRevisionId, issueContentHash: issueHash, observationId: null, deliveryId: null, observationResult: null });
  f.facts.push({ projectId, id: loopIntentId("report-source"), createdAtUtc: "2026-10-23T00:01:01.000Z",
    kind: "document", subjectId: loopIntentId("report-document"), subjectVersion: 1,
    sourceLoopId: null, originDispatchId: null, operationId: loopIntentId("report-operation"),
    sourceActorId: "independent-reporter", issueRevisionId: null, issueContentHash: null,
    observationId: null, deliveryId: null, observationResult: null });
  const runner = new ManagedLoopRunner(f.deps);
  await runner.pump(); await runner.pump();
  assert.equal(f.inbox.filter(item => item.sourceEventId === issueEventId).length, 1);
  assert.equal(f.inbox.some(item => item.sourceEventId === loopIntentId("report-source")), false);
  const issueTask = f.taskCreates.find(command => String(command.content).includes(issueEventId));
  assert.ok(issueTask);
  assert.match(issueTask.content, new RegExp(`${issueId}/revisions/${issueRevisionId}/original`));
  assert.match(issueTask.content, new RegExp(issueHash));
  assert.equal(f.taskCreates.length, 2);
  await new ManagedLoopRunner(f.deps).pump();
  assert.equal(f.inbox.filter(item => item.sourceEventId === issueEventId).length, 1);
  assert.equal(f.taskCreates.length, 2);
});

test("trusted waiting resume opens a new cognition Run with the unchanged fixed Issue", async () => {
  const f = fixture(), runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const previous = f.dispatches[0]!;
  previous.state = "completed";
  previous.runtimeRunId = loopIntentId(previous.id, "run");
  previous.outcome = null;
  const resumeId = loopIntentId("resume-source"), issueId = loopIntentId("resume-issue");
  const revisionId = loopIntentId("resume-original-revision"), decisionId = loopIntentId("waiting-decision");
  const resumed = { projectId, id: resumeId, createdAtUtc: "2026-10-23T00:01:00.000Z",
    kind: "waiting.resumed", subjectId: issueId, subjectVersion: 1, sourceLoopId: loopId,
    originDispatchId: previous.id, operationId: loopIntentId("resume-operation"), sourceActorId: "review-owner",
    issueRevisionId: revisionId, issueContentHash: "d".repeat(64), observationId: null,
    deliveryId: null, observationResult: null, waitingDecisionId: decisionId,
    waitingRunId: previous.runtimeRunId, previousSourceEventId: sourceId,
    originalSourceEventId: sourceId } as OrchestrationSourceFact;
  f.facts.push(resumed);
  await runner.pump();
  assert.equal(f.taskCreates.some(item => String(item.content).includes(resumeId)), false);
  previous.outcome = "waiting";
  await runner.pump();
  const cognitionTask = f.taskCreates.find(item => String(item.content).includes(resumeId));
  assert.ok(cognitionTask);
  assert.match(cognitionTask.content, new RegExp(`${issueId}/revisions/${revisionId}/original`));
  assert.match(cognitionTask.content, new RegExp(decisionId));
  await runner.pump();
  const session = [...f.sessions.values()][0];
  assert.ok(session);
  session.state = "ready";
  await runner.pump();
  assert.match(f.lastInput()!, new RegExp(decisionId));
  assert.match(f.lastInput()!, new RegExp(`${issueId} revision ${revisionId}`));
});

test("targeted scheduled todo enters cognition once with its existing Task identity", async () => {
  const f = fixture();
  const taskId = loopIntentId("scheduled-business-task"), eventId = loopIntentId("scheduled-source");
  const scheduleId = loopIntentId("schedule"), revisionId = loopIntentId("schedule-revision");
  f.tasks.set(taskId, { version: 1, state: "todo" });
  f.facts.push({ projectId, id: eventId, createdAtUtc: "2026-10-23T00:01:00.000Z",
    kind: "schedule.task.todo", subjectId: taskId, subjectVersion: 1,
    sourceLoopId: loopId, originDispatchId: null, operationId: loopIntentId("schedule-operation"),
    sourceActorId: "schedule:builder", observationId: null, deliveryId: null, observationResult: null,
    scheduleId, scheduleRevisionId: revisionId, plannedAtUtc: "2026-10-23T00:01:00.000Z",
    scheduleTargetLoopId: loopId, scheduleTargetStageId: stageId,
    scheduleTaskRevisionId: loopIntentId("scheduled-task-revision") });
  const runner = new ManagedLoopRunner(f.deps);
  await runner.pump(); await new ManagedLoopRunner(f.deps).pump();
  assert.equal(f.inbox.filter(item => item.sourceEventId === eventId).length, 1);
  const cognitionTask = f.taskCreates.find(command => String(command.content).includes(scheduleId));
  assert.ok(cognitionTask);
  assert.match(cognitionTask.content, new RegExp(taskId));
  assert.match(cognitionTask.content, /reuse it for the next_action child dispatch/);
  assert.equal(f.taskCreates.some(command => command.taskId === taskId), false);
});

test("missing Stage and exhausted budget become durable waiting inbox dispositions", async () => {
  const noStage = fixture(); noStage.loop.stageId = null;
  await new ManagedLoopRunner(noStage.deps).pump();
  assert.equal(noStage.inbox[0]!.disposition, "waiting");
  assert.equal(noStage.tasks.size, 0);

  const noBudget = fixture(); noBudget.loop.maxRuns = 1; noBudget.loop.dispatchCount = 1;
  await new ManagedLoopRunner(noBudget.deps).pump();
  assert.equal(noBudget.inbox[0]!.disposition, "waiting");
  assert.equal(noBudget.tasks.size, 0);
});

test("expired pre-start claim is reclaimed with the original token before starting", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const dispatch = f.dispatches[0]!;
  dispatch.state = "claimed";
  dispatch.claimToken = loopIntentId(dispatch.id, "claim-token");
  dispatch.leaseUntilUtc = "2026-10-22T00:00:00.000Z";
  await runner.pump();
  assert.equal(f.commands.filter(type => type === "dispatch.reclaim").length, 1);
  assert.equal(dispatch.state, "dispatching");
  assert.equal(dispatch.claimToken, loopIntentId(dispatch.id, "claim-token"));
});

test("pause holds a dispatching intent with no Run; resume may reserve the original Run", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const dispatch = f.dispatches[0]!;
  dispatch.state = "dispatching";
  dispatch.claimToken = loopIntentId(dispatch.id, "claim-token");
  f.loop.state = "paused";
  await runner.pump();
  assert.equal(f.sessions.size, 0);
  assert.equal(dispatch.state, "dispatching");
  f.loop.state = "active";
  await runner.pump();
  assert.equal(f.sessions.size, 1);
  [...f.sessions.values()][0]!.state = "ready";
  await runner.pump();
  assert.equal(dispatch.state, "accepted");
  assert.equal(f.runs.size, 1);
});

test("stopped dispatching intent without a Run becomes a durable unknown gap", async () => {
  const f = fixture(); const runner = new ManagedLoopRunner(f.deps);
  await runner.pump();
  const dispatch = f.dispatches[0]!;
  dispatch.state = "dispatching";
  dispatch.claimToken = loopIntentId(dispatch.id, "claim-token");
  f.loop.state = "stopped";
  await runner.pump();
  assert.equal(dispatch.state, "unknown");
  assert.equal(f.sessions.size, 0);
  assert.equal(f.runs.size, 0);
});

test("paused dynamic dispatch reconciles only its historical exact Run without a static profile", async () => {
  const f=fixture();await new ManagedLoopRunner(f.deps).pump();
  const dispatch=f.dispatches[0]!;
  Object.assign(dispatch,{bindingId:loopIntentId("binding"),recipientRoleId:"dynamic-role",state:"dispatching",
    claimToken:loopIntentId(dispatch.id,"claim-token")});
  const runId=loopIntentId(dispatch.id,"run");
  f.runs.set(runId,{id:runId,taskId:dispatch.taskId,state:"requested"});
  f.loop.state="paused";
  const historicalCalls:boolean[]=[];
  const deps:ManagedLoopDependencies={...f.deps,controller:async(_project,role)=>
      role===cognition?{principal,authorizationScopeId:scopeId,cwd:"/tmp/evoloop-test",
        sandbox:"workspace-write",approvalPolicy:"on-request"}:null,
    dynamicController:async(_dispatch,historical)=>{historicalCalls.push(historical===true);
      return historical?{principal,authorizationScopeId:scopeId,cwd:"/tmp/evoloop-test",
        sandbox:"workspace-write",approvalPolicy:"on-request"}:null;}};
  await new ManagedLoopRunner(deps).pump();
  assert.equal(dispatch.state,"accepted");
  assert.deepEqual(historicalCalls,[true]);
  assert.equal(f.sessions.size,0);
  assert.equal(f.runs.size,1);
});

test("claim commit plus lost response and readback recovers next tick without another native Run", async () => {
  const f=fixture(), runner=new ManagedLoopRunner(f.deps);
  await runner.pump();
  f.loseClaimResponse("dispatch.claim");
  await runner.pump();
  const dispatch=f.dispatches[0]!;
  assert.equal(dispatch.state,"claimed");
  assert.equal(f.commands.filter(value=>value==="dispatch.claim").length,1);
  f.advanceTime("2026-10-23T00:00:01.000Z");
  await runner.pump();
  assert.equal(f.commands.filter(value=>value==="dispatch.claim").length,1);
  assert.equal(dispatch.state,"dispatching");
  assert.equal(f.sessions.size,1);
  [...f.sessions.values()][0]!.state="ready";
  await runner.pump();
  assert.equal(f.runs.size,1);
  assert.equal(f.credentialIssues(),1);
});

test("reclaim commit plus lost response resumes after clock advances with the original token", async () => {
  const f=fixture(), runner=new ManagedLoopRunner(f.deps);
  await runner.pump();
  const dispatch=f.dispatches[0]!;
  dispatch.state="claimed"; dispatch.version=2; dispatch.claimToken=loopIntentId(dispatch.id,"claim-token");
  dispatch.leaseUntilUtc="2026-10-22T00:00:00.000Z";
  f.loseClaimResponse("dispatch.reclaim");
  await runner.pump();
  assert.equal(dispatch.state,"claimed");
  assert.equal(f.commands.filter(value=>value==="dispatch.reclaim").length,1);
  const renewedLease=dispatch.leaseUntilUtc;
  f.advanceTime("2026-10-23T00:00:02.000Z");
  await runner.pump();
  assert.equal(f.commands.filter(value=>value==="dispatch.reclaim").length,1);
  assert.equal(dispatch.leaseUntilUtc,renewedLease);
  assert.equal(dispatch.claimToken,loopIntentId(dispatch.id,"claim-token"));
  assert.equal(dispatch.state,"dispatching");
  assert.equal(f.sessions.size,1);
  [...f.sessions.values()][0]!.state="ready";
  await runner.pump();
  assert.equal(f.runs.size,1);
});
