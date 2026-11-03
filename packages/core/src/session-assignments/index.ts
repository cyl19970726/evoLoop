import type { AppliedResult, Principal, Task } from "@evoloop/contracts";
import { DomainError, type Transaction } from "@evoloop/contracts/ports";
import type { SessionAssignmentCommand, SessionAssignmentTransaction, SessionProfileRecord, TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import type { SessionTarget } from "@evoloop/contracts/session-work";
import type { SessionIdentity } from "@evoloop/contracts/session-identity";
import { canonicalTaskInputJson, taskInputSignature } from "../task-input.js";

type AssignmentTx = Transaction & { sessionAssignments?: SessionAssignmentTransaction };
export interface SessionAssignmentContext {
  tx: AssignmentTx; command: SessionAssignmentCommand; principal: Principal; now: string;
}
const fail = (code: string, message: string, version?: number): never => { throw new DomainError(code, message, version); };
const requireRecord = <T>(value: T | null, name: string): T => value ?? fail("NOT_FOUND", `${name} not found`);
const ensureVersion = (actual: number, expected: number, name: string): void => {
  if (actual !== expected) fail("VERSION_CONFLICT", `${name} version changed`, actual);
};
async function targetRole(tx: Transaction, projectId: string, target: SessionTarget, allowInactive = false): Promise<string> {
  if (target.kind === "owned") {
    const session = requireRecord(await tx.getRuntimeSession(target.sessionId), "Session");
    if (session.projectId !== projectId) fail("PROJECT_SCOPE", "Session belongs to another project");
    if (!allowInactive && session.state !== "ready") fail("SESSION_UNAVAILABLE", "Owned Session must be ready");
    return session.roleId;
  }
  const link = requireRecord(await tx.getHostLink(target.linkId), "Host link");
  if (link.projectId !== projectId) fail("PROJECT_SCOPE", "Host link belongs to another project");
  if (link.host.kind !== "external") fail("TARGET_MISMATCH", "External target requires an external HostLink");
  if (!allowInactive && link.state === "revoked") fail("HOST_REVOKED", "Host link is revoked");
  return link.roleId;
}
function result(command: SessionAssignmentCommand, entityId: string, version: number): AppliedResult {
  return { status: "applied", operationId: command.operationId, entityId, version };
}
/** A dispatch freezes a new revision without changing the assigned business input. */
async function acknowledgedRevision(tx: Transaction, task: Task,
  assignment: TaskSessionAssignment, direct: boolean): Promise<string> {
  if (task.currentRevisionId === assignment.taskRevisionId) return assignment.taskRevisionId;
  const changed = () => fail("BASELINE_CHANGED", "Task revision changed; make a new assignment", task.version);
  if (!direct || assignment.target.kind !== "owned") return changed();
  const sessionId = assignment.target.sessionId;
  const original = await tx.getTaskRevision(task.id, assignment.taskRevisionId);
  const current = await tx.getTaskRevision(task.id, task.currentRevisionId);
  if (!original || !current || original.projectId !== task.projectId || current.projectId !== task.projectId ||
    original.taskId !== task.id || current.taskId !== task.id ||
    current.version !== original.version + 1 || current.version !== task.version ||
    current.reason !== "Runtime dispatch reserved") return changed();
  const runs = await tx.listRuntimeRuns(task.id);
  if (!runs.some(run => run.projectId === task.projectId && run.taskId === task.id &&
    run.taskRevisionId === current.id && run.sessionId === sessionId &&
    run.basisSetId === current.basisSetId)) return changed();
  const before = canonicalTaskInputJson(await taskInputSignature(tx, task, original.id));
  const after = canonicalTaskInputJson(await taskInputSignature(tx, task, current.id));
  if (before !== after) return changed();
  return current.id;
}
/** The WorkflowService owns operation-journal idempotence and transaction boundaries. */
export async function applySessionAssignment({ tx, command, principal, now }: SessionAssignmentContext): Promise<AppliedResult> {
  if (!principal.actorId || !principal.projectIds.includes(command.projectId) || !principal.permissions.includes("write"))
    fail("FORBIDDEN", "Actual project principal with write access required");
  const store = tx.sessionAssignments ?? fail("CAPABILITY_UNAVAILABLE", "Session assignment storage is unavailable");
  if (command.type === "session.identity.set") {
    await targetRole(tx, command.projectId, command.target, true);
    const previous = requireRecord(await store.getSessionIdentity(command.target), "Session identity");
    ensureVersion(previous.version, command.expectedVersion, "Session identity");
    const identity: SessionIdentity = { ...previous, version: previous.version + 1,
      color: command.color, mark: command.mark, actorId: principal.actorId,
      reason: command.reason, updatedAt: now };
    await store.saveSessionIdentity(identity, previous.version);
    return result(command, command.target.kind === "owned" ? command.target.sessionId : command.target.linkId, identity.version);
  }
  if (command.type === "session.profile.set") {
    if (!principal.permissions.includes("review")) fail("FORBIDDEN", "Session profile requires review authority");
    await targetRole(tx, command.projectId, command.target, true);
    const previous = await store.getSessionProfile(command.target);
    ensureVersion(previous?.version ?? 0, command.expectedVersion, "Session profile");
    const profile: SessionProfileRecord = { projectId: command.projectId, target: command.target,
      version: command.expectedVersion + 1, displayName: command.displayName, purpose: command.purpose,
      membership: command.membership, tenure: command.tenure, actorId: principal.actorId,
      reason: command.reason, updatedAt: now };
    await store.saveSessionProfile(profile, command.expectedVersion);
    return result(command, command.target.kind === "owned" ? command.target.sessionId : command.target.linkId, profile.version);
  }
  const task = requireRecord(await tx.getTask(command.taskId), "Task");
  if (task.projectId !== command.projectId) fail("PROJECT_SCOPE", "Task belongs to another project");
  const previous = await store.getTaskSessionAssignment(task.id);
  ensureVersion(previous?.version ?? 0, command.expectedVersion, "Task assignment");
  if (command.type !== "task.assignment.release") ensureVersion(task.version, command.expectedTaskVersion, "Task");
  if (command.type === "task.assignment.set") {
    if (!principal.permissions.includes("review")) fail("FORBIDDEN", "Assignment requires review authority");
    const roleId = await targetRole(tx, command.projectId, command.target);
    if (task.owner !== roleId) fail("ROLE_MISMATCH", "Task owner must match the target Session role");
    const role = requireRecord(await tx.getRole(roleId), "Role");
    if (["retirement-pending", "retired", "rejected", "deferred"].includes(role.state))
      fail("ROLE_UNAVAILABLE", "Target Role cannot receive an assignment");
    await store.assertTaskAssignmentMovable(task.id);
    const record: TaskSessionAssignment = { projectId: command.projectId, taskId: task.id,
      version: command.expectedVersion + 1, taskRevisionId: task.currentRevisionId, target: command.target,
      recipientActorId: command.recipientActorId, state: "assigned", ack: null,
      actorId: principal.actorId, reason: command.reason, updatedAt: now };
    await store.saveTaskSessionAssignment(record, command.expectedVersion);
    return result(command, task.id, record.version);
  }
  if (!previous || previous.state === "released") throw new DomainError("ASSIGNMENT_INACTIVE", "Task has no active assignment");
  if (command.type === "task.assignment.release") {
    if (!principal.permissions.includes("review")) fail("FORBIDDEN", "Release requires review authority");
    await store.assertTaskAssignmentMovable(task.id);
    const record: TaskSessionAssignment = { ...previous, version: previous.version + 1, state: "released",
      actorId: principal.actorId, reason: command.reason, updatedAt: now };
    await store.saveTaskSessionAssignment(record, previous.version);
    return result(command, task.id, record.version);
  }
  if (previous.state === "accepted") fail("ALREADY_ACCEPTED", "Assignment acceptance already recorded");
  if (command.type === "task.assignment.acknowledge") {
    if (!previous.recipientActorId || previous.recipientActorId !== principal.actorId)
      fail("RECIPIENT_MISMATCH", "Only the designated recipient can acknowledge directly");
    if (!principal.permissions.includes("read")) fail("FORBIDDEN", "Direct acknowledgement requires read access");
  } else if (!principal.permissions.includes("review")) {
    fail("FORBIDDEN", "Observed acceptance requires review authority");
  }
  const taskRevisionId = await acknowledgedRevision(tx, task, previous, command.type === "task.assignment.acknowledge");
  const record: TaskSessionAssignment = { ...previous, version: previous.version + 1, taskRevisionId, state: "accepted",
    ack: { method: command.type === "task.assignment.acknowledge" ? "direct" : "lead-observed",
      actorId: command.type === "task.assignment.acknowledge" ? principal.actorId : null,
      observerActorId: principal.actorId, evidence: command.evidence, sourceRef: command.sourceRef ?? null, at: now },
    actorId: principal.actorId, reason: command.evidence, updatedAt: now };
  await store.saveTaskSessionAssignment(record, previous.version);
  return result(command, task.id, record.version);
}
