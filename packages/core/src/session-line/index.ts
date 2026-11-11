import type { AppliedResult, Principal } from "@evoloop/contracts";
import { DomainError, type Transaction } from "@evoloop/contracts/ports";
import type { SessionLineCommand, SessionLineEntry } from "@evoloop/contracts/session-line";

type Effect = { kind: string; entityId: string; version: number };
const TERMINAL_RUN = new Set(["completed", "failed", "interrupted"]);

function fail(code: string, message: string): never { throw new DomainError(code, message); }
const ok = (command: SessionLineCommand, entityId: string, version: number): AppliedResult =>
  ({ status: "applied", operationId: command.operationId, entityId, version });

/**
 * Session line commands (DEC-045 Q1, design 5.1). A line holds the Tasks that wait for one resident Session, in the order the Leader
 * arranged them. Appending, moving and removing are Leader decisions; begin/advance/started/suspend/withdrawReturned record the
 * pump's steps. Starting the Task, assigning it and reserving the Run are ordinary commands guarded by QUEUED_IN_SESSION_LINE.
 */
export async function applySessionLine(tx: Transaction, principal: Principal, command: SessionLineCommand, now: string,
  nextId: () => string): Promise<{ result: AppliedResult; effects: Effect[] }> {
  const lines = tx.sessionLines ?? fail("CAPABILITY_UNAVAILABLE", "Session line storage is unavailable");
  const actorId = principal.actorId;
  const event = (sessionId: string, entry: SessionLineEntry | null, kind: string, detail: Record<string, unknown>) =>
    lines.appendSessionLineEvent({ projectId: command.projectId, sessionId, entryId: entry?.id ?? null, taskId: entry?.taskId ?? null,
      kind, detail, actorId, at: now });
  const effect = (entry: SessionLineEntry): Effect => ({ kind: command.type, entityId: entry.id, version: entry.version });
  const requireEntry = async (entryId: string, expectedVersion: number): Promise<SessionLineEntry> => {
    const entry = await lines.getSessionLineEntry(entryId) ?? fail("NOT_FOUND", "Session line entry was not found");
    if (entry.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "Session line entry changed", entry.version);
    return entry;
  };
  // The line's own version follows every change to its entries.
  const touch = async (sessionId: string) => {
    const line = await lines.getSessionLine(sessionId);
    if (line) await lines.touchSessionLine(sessionId, line.version, now);
  };
  const save = async (entry: SessionLineEntry, patch: Partial<SessionLineEntry>): Promise<SessionLineEntry> => {
    const next = { ...entry, ...patch, version: entry.version + 1, updatedAt: now };
    await lines.updateSessionLineEntry(next, entry.version);
    await touch(entry.sessionId);
    return next;
  };

  if (command.type === "line.append") {
    const session = await tx.getRuntimeSession(command.sessionId) ?? fail("NOT_FOUND", "runtime session was not found");
    if (session.state !== "ready") fail("SESSION_NOT_READY", "only a ready Session has a line");
    const task = await tx.getTask(command.taskId) ?? fail("NOT_FOUND", "Task was not found");
    if (task.version !== command.expectedTaskVersion) throw new DomainError("VERSION_CONFLICT", "Task changed", task.version);
    if (task.state === "done" || task.state === "cancelled") fail("TASK_NOT_OPEN", "a finished Task cannot wait in a line; reopen it first");
    if (task.owner !== session.roleId) fail("ROLE_MISMATCH", "Task owner must match the Session's Role");
    if ((await tx.listRuntimeRuns(task.id)).some(run => !TERMINAL_RUN.has(run.state))) fail("TASK_BUSY", "resolve the Task's current Run before queueing it");
    if (command.source === "schedule" && !command.scheduleId) fail("SCHEDULE_REQUIRED", "a scheduled entry names its schedule");
    if (await lines.getLiveSessionLineEntryForTask(task.id)) fail("TASK_ALREADY_QUEUED", "This Task is already waiting in a Session line");
    if (await lines.getSessionLine(session.id)) await touch(session.id);
    else
      await lines.insertSessionLine({ projectId: command.projectId, sessionId: session.id, controllerActorId: actorId, version: 1, createdAt: now, updatedAt: now });
    const entry = await lines.insertSessionLineEntry({ projectId: command.projectId, id: nextId(), sessionId: session.id, taskId: task.id,
      state: "queued", step: null, attempt: 0, stepTry: 0, assignOperationId: null, startOperationId: null, reassignOperationId: null,
      reserveOperationId: null, messageId: null, suspendReason: null, withdrawnReason: null, source: command.source, sourceActorId: actorId,
      scheduleId: command.scheduleId ?? null, releaseRule: "run_end", runId: null, runEndedAt: null, version: 1, appendedAt: now, updatedAt: now });
    await event(session.id, entry, "entry.appended", { source: command.source, scheduleId: command.scheduleId ?? null, position: entry.position, reason: command.reason });
    return { result: ok(command, entry.id, entry.version), effects: [effect(entry)] };
  }

  const entry = await requireEntry(command.entryId, command.expectedVersion);
  await lines.getSessionLine(entry.sessionId) ?? fail("NOT_FOUND", "Session line was not found");
  const task = await tx.getTask(entry.taskId) ?? fail("NOT_FOUND", "Task was not found");

  if (command.type === "line.move") {
    if (entry.state !== "queued" && entry.state !== "suspended") fail("ENTRY_STARTING", "only a waiting entry can move");
    const moved = await lines.swapSessionLineEntry(entry.id, command.direction, now);
    if (!moved) fail("LINE_END", command.direction === "forward" ? "the entry is already first" : "the entry is already last");
    await touch(entry.sessionId);
    const after = await lines.getSessionLineEntry(entry.id) ?? entry;
    await event(entry.sessionId, after, "entry.moved", { direction: command.direction, position: after.position });
    return { result: ok(command, entry.id, after.version), effects: [effect(after)] };
  }
  if (command.type === "line.remove") {
    if (entry.state === "started" || entry.state === "withdrawn") fail("ENTRY_NOT_REMOVABLE", "the entry has already started or ended");
    // At the start step the entry can still leave, as long as no Run was reserved for it: otherwise it would hold the line for good.
    if (entry.state === "starting" && entry.step === "start" &&
      (await tx.listRuntimeRuns(entry.taskId)).some(run => run.createdAt >= entry.appendedAt))
      fail("ENTRY_NOT_REMOVABLE", "a Run was already reserved for this entry");
    // An assignment the line made for the confirmation request is released with it, so the Task can be arranged another way.
    const assignment = await tx.sessionAssignments?.getTaskSessionAssignment(entry.taskId);
    if (entry.state === "starting" && assignment && assignment.state !== "released" && assignment.target.kind === "owned" &&
      assignment.target.sessionId === entry.sessionId)
      await tx.sessionAssignments!.saveTaskSessionAssignment({ ...assignment, version: assignment.version + 1, state: "released",
        actorId, reason: `Removed from the Session line: ${command.reason}`, updatedAt: now }, assignment.version);
    const next = await save(entry, { state: "withdrawn", step: null, withdrawnReason: `removed: ${command.reason}` });
    await event(entry.sessionId, next, "entry.removed", { reason: command.reason });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  if (command.type === "line.resume") {
    if (entry.state !== "suspended") fail("ENTRY_NOT_SUSPENDED", "only a suspended entry can be resumed");
    const next = await save(entry, { state: "queued", step: null, suspendReason: null });
    await event(entry.sessionId, next, "entry.resumed", { reason: command.reason });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  if (command.type === "line.begin") {
    if (entry.state !== "queued") fail("ENTRY_NOT_QUEUED", "only a queued entry can begin");
    const waiting = await lines.listSessionLineEntries(entry.sessionId);
    const head = waiting.find(item => item.state === "queued");
    if (waiting.some(item => item.state === "starting")) fail("LINE_BUSY", "another entry of this line is starting");
    if (head?.id !== entry.id) fail("NOT_AT_HEAD", "only the first waiting entry begins");
    if (await lines.sessionHasLiveRun(entry.sessionId)) fail("SESSION_BUSY", "the Session is still busy");
    const next = await save(entry, { state: "starting", step: "assign", attempt: entry.attempt + 1,
      assignOperationId: command.assignOperationId, startOperationId: command.startOperationId, reassignOperationId: command.reassignOperationId,
      reserveOperationId: command.reserveOperationId, messageId: command.messageId });
    await event(entry.sessionId, next, "entry.starting", { attempt: next.attempt });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  if (command.type === "line.retry") {
    if (entry.state !== "starting") fail("ENTRY_NOT_STARTING", "only a starting entry retries a step");
    const next = await save(entry, { stepTry: entry.stepTry + 1, assignOperationId: command.assignOperationId, startOperationId: command.startOperationId,
      reassignOperationId: command.reassignOperationId, reserveOperationId: command.reserveOperationId });
    await event(entry.sessionId, next, "entry.retried", { step: entry.step, stepTry: next.stepTry });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  if (command.type === "line.runEnded") {
    if (entry.state !== "started" || entry.runEndedAt) fail("STEP_MISMATCH", "the entry's Run end is not pending");
    const ended = await tx.getRuntimeRun(entry.runId!);
    if (!ended || !TERMINAL_RUN.has(ended.state) || ended.state !== command.runState) fail("RUN_NOT_ENDED", "the entry's Run has not ended with that result");
    const next = await save(entry, { runEndedAt: now });
    await event(entry.sessionId, next, "entry.runEnded", { runId: ended.id, runState: ended.state });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  if (command.type === "line.advance") {
    if (entry.state !== "starting") fail("ENTRY_NOT_STARTING", "the entry is not starting");
    if (command.to === "confirm") {
      if (entry.step !== "assign") fail("STEP_MISMATCH", "the entry is not at the assignment step");
      const next = await save(entry, { step: "confirm" });
      await event(entry.sessionId, next, "entry.confirmationRequested", { messageId: entry.messageId });
      return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
    }
    if (entry.step !== "confirm") fail("STEP_MISMATCH", "the entry is not waiting for confirmation");
    const assignment = await tx.sessionAssignments?.getTaskSessionAssignment(entry.taskId);
    const confirmation = assignment ? await tx.sessionAssignments?.getAssignmentConfirmation(entry.taskId, assignment.version) : null;
    if (!assignment || assignment.state !== "accepted" || confirmation?.verdict !== "confirm" || confirmation.expectedRevisionId !== task.currentRevisionId)
      fail("NOT_CONFIRMED", "the Session has not confirmed this exact Task revision");
    const next = await save(entry, { step: "start" });
    await event(entry.sessionId, next, "entry.confirmed", { plan: confirmation.plan });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  if (command.type === "line.started") {
    if (entry.state !== "starting" || entry.step !== "start") fail("STEP_MISMATCH", "the entry is not at the start step");
    const run = await tx.getRuntimeRun(command.runId);
    if (!run || run.taskId !== entry.taskId || run.sessionId !== entry.sessionId) fail("RUN_MISMATCH", "the Run does not belong to this entry");
    const next = await save(entry, { state: "started", step: null, runId: run.id });
    await event(entry.sessionId, next, "entry.started", { runId: run.id });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  if (command.type === "line.suspend") {
    if (entry.state !== "starting") fail("ENTRY_NOT_STARTING", "only a starting entry is suspended");
    const next = await save(entry, { state: "suspended", step: null, suspendReason: `${command.code}: ${command.reason}` });
    await event(entry.sessionId, next, "entry.suspended", { code: command.code, reason: command.reason, level: "immediate" });
    return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
  }
  // line.withdrawReturned: the Session returned the Task at its execution confirmation.
  if (entry.state !== "starting" || entry.step !== "confirm") fail("STEP_MISMATCH", "the entry is not waiting for confirmation");
  const assignment = await tx.sessionAssignments?.getTaskSessionAssignment(entry.taskId);
  const confirmation = assignment ? await tx.sessionAssignments?.getAssignmentConfirmation(entry.taskId, assignment.version) : null;
  if (!confirmation || confirmation.verdict !== "return") fail("NOT_RETURNED", "the Session has not returned this Task");
  const next = await save(entry, { state: "withdrawn", step: null, withdrawnReason: `returned: ${command.reason}` });
  await event(entry.sessionId, next, "entry.returned", { missing: confirmation.missing, level: "summary", reason: command.reason });
  return { result: ok(command, entry.id, next.version), effects: [effect(next)] };
}
