import assert from "node:assert/strict";
import test from "node:test";
import type { BasisSet, Principal, Task, TaskRevision } from "@evoloop/contracts";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import type { Transaction } from "@evoloop/contracts/ports";
import type { SessionAssignmentCommand, SessionProfileRecord, TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import { applySessionAssignment } from "../src/session-assignments/index.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), taskId = id(2), roleId = id(3), firstLink = id(4), secondLink = id(5), sessionId = id(10);
const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
const recipient: Principal = { actorId: "recipient", projectIds: [projectId], permissions: ["read", "write"] };
function fixture() {
  const task: Task = { projectId, id: taskId, version: 1, currentRevisionId: id(6), title: "Shared Role Task",
    content: "fixed", contentDocumentId: id(7), contentRevisionId: id(8), kind: null, acceptance: "result", owner: roleId, state: "todo" };
  let profile: SessionProfileRecord | null = null;
  let assignment: TaskSessionAssignment | null = null;
  const history: TaskSessionAssignment[] = [];
  const revisions = new Map<string, TaskRevision>();
  const bases = new Map<string, BasisSet>();
  const runs: RuntimeRunRecord[] = [];
  const firstRevision: TaskRevision = { ...task, taskId, id: task.currentRevisionId, basisSetId: id(11),
    actorId: "lead", reason: "Task started", createdAt: "2026-10-26T00:00:00Z" };
  revisions.set(firstRevision.id, firstRevision);
  bases.set(firstRevision.id, { projectId, taskId, taskRevisionId: firstRevision.id,
    id: firstRevision.basisSetId!, members: [], sealed: true });
  let busy = false;
  const tx = { getTask: async () => task, getRole: async () => ({ projectId, id: roleId, state: "active" }),
    getRuntimeSession: async () => ({ projectId, id: sessionId, roleId, state: "ready" }),
    getTaskRevision: async (_taskId: string, revisionId: string) => revisions.get(revisionId) ?? null,
    getBasisSet: async (_taskId: string, revisionId: string) => bases.get(revisionId) ?? null,
    listTaskExternalSnapshot: async () => [], getTaskProposal: async () => null,
    listRuntimeRuns: async () => runs,
    getHostLink: async (linkId: string) => ({ projectId, id: linkId, roleId, state: "verified", host: { kind: "external" } }),
    sessionAssignments: {
      getSessionProfile: async () => profile, saveSessionProfile: async (record: SessionProfileRecord) => { profile = record; },
      getTaskSessionAssignment: async () => assignment,
      saveTaskSessionAssignment: async (record: TaskSessionAssignment) => { assignment = record; history.push(record); },
      assertTaskAssignmentMovable: async () => { if (busy) throw new Error("busy"); },
    } } as unknown as Transaction;
  const apply = (command: SessionAssignmentCommand, principal = lead) => applySessionAssignment({ tx, command, principal, now: "2026-10-26T00:00:00Z" });
  const set = (linkId: string, expectedVersion: number, recipientActorId: string | null = "recipient"): SessionAssignmentCommand =>
    ({ type: "task.assignment.set", projectId, operationId: id(30 + expectedVersion), taskId,
      expectedTaskVersion: task.version, expectedVersion, target: { kind: "external", linkId }, recipientActorId, reason: "Lead assignment" });
  const dispatch = (changes: Partial<TaskRevision> = {}, runSessionId = sessionId) => {
    const revision: TaskRevision = { ...firstRevision, id: id(12), version: 2,
      basisSetId: id(13), reason: "Runtime dispatch reserved", ...changes };
    revisions.set(revision.id, revision);
    bases.set(revision.id, { projectId, taskId, taskRevisionId: revision.id,
      id: revision.basisSetId!, members: [], sealed: true });
    task.version = revision.version;
    task.currentRevisionId = revision.id;
    runs.push({ projectId, id: id(14), taskId, taskRevisionId: revision.id, basisSetId: revision.basisSetId!,
      sessionId: runSessionId, operationId: id(15), input: "fixed", inputHash: "hash", state: "completed",
      version: 1, nativeTurnId: "turn", interruptRequested: false, resultSummary: null,
      actorId: "lead", createdAt: "2026-10-26T00:01:00Z", updatedAt: "2026-10-26T00:02:00Z" });
  };
  const setOwned = (): SessionAssignmentCommand => ({ type: "task.assignment.set", projectId,
    operationId: id(31), taskId, expectedTaskVersion: task.version, expectedVersion: 0,
    target: { kind: "owned", sessionId }, recipientActorId: "recipient", reason: "Lead assignment" });
  return { task, apply, set, setOwned, dispatch, runs, revisions, history,
    get assignment() { return assignment; }, set busy(value: boolean) { busy = value; } };
}

test("two HostLinks sharing a Role remain distinct and prior assignment stays in history", async () => {
  const f = fixture();
  await f.apply(f.set(firstLink, 0));
  await f.apply(f.set(secondLink, 1));
  assert.equal(f.assignment?.target.kind, "external");
  assert.equal(f.assignment?.target.kind === "external" && f.assignment.target.linkId, secondLink);
  assert.equal(f.history[0]?.target.kind === "external" && f.history[0].target.linkId, firstLink);
  assert.equal(f.task.version, 1);
});

test("direct acceptance requires exact recipient and current fixed Task revision", async () => {
  const f = fixture();
  await f.apply(f.set(firstLink, 0));
  const cmd: SessionAssignmentCommand = { type: "task.assignment.acknowledge", projectId, operationId: id(40), taskId,
    expectedVersion: 1, expectedTaskVersion: 1, evidence: "I read the assignment" };
  await assert.rejects(f.apply(cmd, lead), { code: "RECIPIENT_MISMATCH" });
  f.task.currentRevisionId = id(9);
  await assert.rejects(f.apply(cmd, recipient), { code: "BASELINE_CHANGED" });
  f.task.currentRevisionId = id(6);
  await f.apply(cmd, recipient);
  assert.deepEqual(f.assignment?.ack?.method, "direct");
  assert.equal(f.assignment?.ack?.actorId, "recipient");
});

test("recipient acknowledges the same owned Session after a content-identical dispatch freeze", async () => {
  const f = fixture();
  await f.apply(f.setOwned());
  f.dispatch();
  const cmd: SessionAssignmentCommand = { type: "task.assignment.acknowledge", projectId,
    operationId: id(40), taskId, expectedVersion: 1, expectedTaskVersion: 2,
    evidence: "I read the fixed assignment" };
  await f.apply(cmd, recipient);
  assert.equal(f.assignment?.taskRevisionId, id(12));
  assert.equal(f.history[0]?.taskRevisionId, id(6));
  assert.equal(f.assignment?.ack?.actorId, "recipient");
  await assert.rejects(f.apply({ ...cmd, operationId: id(41) }, recipient), { code: "VERSION_CONFLICT" });
});

test("dispatch bridge rejects business changes, wrong Session, wrong actor and absent Run", async () => {
  const cases = [
    { name: "content", changes: { content: "new requirement" } },
    { name: "acceptance", changes: { acceptance: "new criterion" } },
    { name: "owner", changes: { owner: id(99) } },
    { name: "wrong session", changes: {}, runSessionId: id(98) },
    { name: "no Run", changes: {}, removeRun: true },
    { name: "ordinary revision", changes: { reason: "Task updated" } },
    { name: "skipped version", changes: { version: 3 } },
  ];
  for (const item of cases) {
    const f = fixture();
    await f.apply(f.setOwned());
    f.dispatch(item.changes, item.runSessionId);
    if (item.removeRun) f.runs.length = 0;
    const cmd: SessionAssignmentCommand = { type: "task.assignment.acknowledge", projectId,
      operationId: id(40), taskId, expectedVersion: 1, expectedTaskVersion: f.task.version,
      evidence: "I read the fixed assignment" };
    await assert.rejects(f.apply(cmd, recipient), { code: "BASELINE_CHANGED" }, item.name);
    assert.equal(f.assignment?.state, "assigned", item.name);
  }
  const f = fixture();
  await f.apply(f.setOwned());
  f.dispatch();
  await assert.rejects(f.apply({ type: "task.assignment.acknowledge", projectId,
    operationId: id(40), taskId, expectedVersion: 1, expectedTaskVersion: 2,
    evidence: "I read the fixed assignment" }, lead), { code: "RECIPIENT_MISMATCH" });
  const stale = fixture();
  await stale.apply(stale.setOwned());
  stale.dispatch();
  stale.revisions.set(id(16), { ...stale.revisions.get(id(12))!, id: id(16), version: 3 });
  stale.task.currentRevisionId = id(16);
  stale.task.version = 3;
  await assert.rejects(stale.apply({ type: "task.assignment.acknowledge", projectId,
    operationId: id(41), taskId, expectedVersion: 1, expectedTaskVersion: 3,
    evidence: "I read the fixed assignment" }, recipient), { code: "BASELINE_CHANGED" },
  "an older Run cannot justify a newer Task head");
});

test("Lead observation is labeled and cannot claim recipient identity", async () => {
  const f = fixture();
  await f.apply(f.set(firstLink, 0, null));
  await f.apply({ type: "task.assignment.observeAcceptance", projectId, operationId: id(42), taskId,
    expectedVersion: 1, expectedTaskVersion: 1, evidence: "Manual chat reply", sourceRef: "chat:123" });
  assert.equal(f.assignment?.ack?.method, "lead-observed");
  assert.equal(f.assignment?.ack?.actorId, null);
  assert.equal(f.assignment?.ack?.sourceRef, "chat:123");
});

test("active ownership blocks both reassignment and release", async () => {
  const f = fixture();
  await f.apply(f.set(firstLink, 0));
  f.busy = true;
  await assert.rejects(f.apply(f.set(secondLink, 1)), /busy/);
  await assert.rejects(f.apply({ type: "task.assignment.release", projectId, operationId: id(44),
    taskId, expectedVersion: 1, reason: "Move" }), /busy/);
  assert.equal(f.assignment?.version, 1);
});
