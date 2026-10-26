import assert from "node:assert/strict";
import test from "node:test";
import type { Principal, Task } from "@evoloop/contracts";
import type { Transaction } from "@evoloop/contracts/ports";
import type { SessionAssignmentCommand, SessionProfileRecord, TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import { applySessionAssignment } from "../src/session-assignments/index.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), taskId = id(2), roleId = id(3), firstLink = id(4), secondLink = id(5);
const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
const recipient: Principal = { actorId: "recipient", projectIds: [projectId], permissions: ["read", "write"] };
function fixture() {
  const task: Task = { projectId, id: taskId, version: 1, currentRevisionId: id(6), title: "Shared Role Task",
    content: "fixed", contentDocumentId: id(7), contentRevisionId: id(8), kind: null, acceptance: "result", owner: roleId, state: "todo" };
  let profile: SessionProfileRecord | null = null;
  let assignment: TaskSessionAssignment | null = null;
  const history: TaskSessionAssignment[] = [];
  let busy = false;
  const tx = { getTask: async () => task, getRole: async () => ({ projectId, id: roleId, state: "active" }),
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
  return { task, apply, set, history, get assignment() { return assignment; }, set busy(value: boolean) { busy = value; } };
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
