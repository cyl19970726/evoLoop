import type { AppliedResult, Principal } from "@evoloop/contracts";
import { DomainError, type Transaction } from "@evoloop/contracts/ports";
import type { ScheduleDispatchCommand } from "@evoloop/contracts/schedule-dispatch";
import { applySessionLine } from "../session-line/index.js";
import { applyWorkflow } from "../workflow.js";

const fail = (code: string, message: string): never => { throw new DomainError(code, message); };

/**
 * Scheduled direct dispatch commands (DEC-045 S1). The occurrence itself is made by the scheduling pump; these decide who may receive scheduled work,
 * how a schedule hands over, and what happens when the Leader takes a scheduled Task out of a line.
 */
export async function applyScheduleDispatch(tx: Transaction, principal: Principal, command: ScheduleDispatchCommand, now: string,
  nextId: () => string): Promise<{ result: AppliedResult; effects: Array<{ kind: string; entityId: string; version: number }> }> {
  if (!principal.permissions.includes("review")) fail("FORBIDDEN", "Scheduled dispatch decisions need project review permission");
  const port = tx.scheduleDispatch ?? fail("CAPABILITY_UNAVAILABLE", "Scheduled dispatch storage is unavailable");
  const done = (entityId: string, version: number) => ({ result: { status: "applied", operationId: command.operationId, entityId, version } as AppliedResult,
    effects: [{ kind: command.type, entityId, version }] });

  if (command.type === "schedule.dispatch.set") {
    const schedule = await tx.getSchedule(command.scheduleId) ?? fail("NOT_FOUND", "schedule was not found");
    const current = await port.getDispatchPolicy(command.scheduleId);
    if ((current?.version ?? 0) !== command.expectedVersion) throw new DomainError("VERSION_CONFLICT", "The dispatch policy changed", current?.version);
    if (command.mode === "direct") {
      if (schedule.revision.template.managedTarget) fail("INVALID_SCHEDULE_TARGET", "a managed cognition schedule is not dispatched directly");
      if (!(await port.getDirectList(schedule.revision.template.owner))?.sessionIds.length)
        fail("DIRECT_LIST_EMPTY", "the Role has no direct list: set one with schedule.directList.set first");
    }
    const saved = await port.saveDispatchPolicy({ projectId: command.projectId, scheduleId: command.scheduleId, version: (current?.version ?? 0) + 1, mode: command.mode,
      state: command.state, waitLimitMinutes: command.waitLimitMinutes, dailyRunBudget: command.dailyRunBudget, actorId: principal.actorId, reason: command.reason, updatedAt: now },
      command.expectedVersion, command.mode === "direct" && command.state === "active");
    return done(command.scheduleId, saved.version);
  }

  if (command.type === "schedule.directList.set") {
    const current = await port.getDirectList(command.roleId);
    if ((current?.version ?? 0) !== command.expectedVersion) throw new DomainError("VERSION_CONFLICT", "The direct list changed", current?.version);
    if (new Set(command.sessionIds).size !== command.sessionIds.length) fail("DUPLICATE_SESSION", "a Session is listed once");
    for (const sessionId of command.sessionIds) {
      const session = await tx.getRuntimeSession(sessionId) ?? fail("NOT_FOUND", `Session ${sessionId} was not found`);
      if (session.roleId !== command.roleId) fail("ROLE_MISMATCH", `Session ${sessionId} does not belong to this Role`);
    }
    await port.saveDirectList({ projectId: command.projectId, roleId: command.roleId, version: (current?.version ?? 0) + 1, sessionIds: command.sessionIds,
      actorId: principal.actorId, reason: command.reason, updatedAt: now }, command.expectedVersion);
    return done(command.roleId, (current?.version ?? 0) + 1);
  }

  // schedule.directEntry.withdraw
  const lines = tx.sessionLines ?? fail("CAPABILITY_UNAVAILABLE", "Session line storage is unavailable");
  const entry = await lines.getSessionLineEntry(command.entryId) ?? fail("NOT_FOUND", "Session line entry was not found");
  if (entry.source !== "schedule") fail("NOT_SCHEDULED", "only an entry a schedule sent to this line is withdrawn this way");
  const task = await tx.getTask(entry.taskId) ?? fail("NOT_FOUND", "Task was not found");
  // The line's own removal does the entry; the internal flag is what lets it touch a scheduled one.
  const removed = await applySessionLine(tx, principal, { type: "line.remove", projectId: command.projectId, operationId: command.operationId, entryId: command.entryId,
    expectedVersion: command.expectedVersion, reason: `${command.choice === "cancel" ? "Cancelled" : "Handed to the Leader"}: ${command.reason}`, viaDirectWithdraw: true } as never, now, nextId);
  const closed = ["done", "cancelled"].includes(task.state);
  if (closed) { /* The Task is already closed or cancelled: only the stale line entry is left to clear. */ }
  else if (command.choice === "cancel") {
    await applyWorkflow({ tx, command: { type: "task.cancel", projectId: command.projectId, operationId: nextId(), taskId: task.id, expectedVersion: task.version,
      reason: `Scheduled Task cancelled when taken out of the line: ${command.reason}` } as never, principal, now, nextId });
  } else await port.enqueueTodoNotice(task.id, now);
  await port.markWithdrawn(task.id, command.choice, now);
  return { result: { ...removed.result, operationId: command.operationId } as AppliedResult, effects: removed.effects };
}
