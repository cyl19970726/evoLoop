import type { AppliedResult, BasisSet, Command, Principal, RuntimeRecordEvent, RuntimeRunRecord, RuntimeSessionRecord, TaskRevision } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { Transaction } from "@evoloop/contracts/ports";
import { validateDispatchBasis } from "./basis.js";

type ReserveCommand = Extract<Command, { type: "runtime.session.reserve" | "runtime.run.reserve" | "runtime.run.interrupt" | "runtime.run.abandonReadOnly" | "runtime.handoff.record" }>;
type Effect = { kind: string; entityId: string; version: number };
export interface ReserveContext {
  tx: Transaction;
  command: ReserveCommand;
  principal: Principal;
  now: string;
  nextId(): string;
  hash(value: string): string;
}
const required = <T>(value: T | null, name: string): T => {
  if (value === null) throw new DomainError("NOT_FOUND", `${name} not found`);
  return value;
};
const applied = (operationId: string, entityId: string, version: number, revisionId?: string): AppliedResult => ({
  status: "applied", operationId, entityId, version, ...(revisionId ? { revisionId } : {}),
});

export async function reserveRuntime({ tx, command, principal, now, nextId, hash }: ReserveContext): Promise<{ result: AppliedResult; effects: Effect[] }> {
  if (command.type === "runtime.handoff.record") {
    const run = required(await tx.getRuntimeRun(command.runId), "runtime run");
    if (run.state !== "completed") throw new DomainError("RUN_NOT_COMPLETED", "handoff follows a completed native run");
    const events = await tx.listRuntimeEvents(run.id);
    const stages = ["received","read","adopted","effect"] as const;
    const n = stages.indexOf(command.stage);
    if (events.some(e=>e.kind===`handoff.${command.stage}` && e.actorId===principal.actorId)) throw new DomainError("HANDOFF_ALREADY_RECORDED", "this actor already recorded this handoff stage");
    if (n>0 && !events.some(e=>e.kind===`handoff.${stages[n-1]}` && e.actorId===principal.actorId)) throw new DomainError("HANDOFF_ORDER", "this actor must record the previous handoff stage first");
    await tx.appendRuntimeEvent(event(command.projectId,nextId(),run.id,run.sessionId,`handoff.${command.stage}`,`Attributed ${command.stage} receipt: ${command.evidence}`,run.nativeTurnId,principal.actorId,now));
    return {result:applied(command.operationId,run.id,run.version),effects:[{kind:`runtime.handoff.${command.stage}`,entityId:run.id,version:run.version}]};
  }
  if (command.type === "runtime.run.abandonReadOnly") {
    const run = required(await tx.getRuntimeRun(command.runId), "runtime run");
    const session = required(await tx.getRuntimeSession(run.sessionId), "runtime session");
    if (run.version !== command.expectedVersion) throw new DomainError("VERSION_CONFLICT", "run changed", run.version);
    if (run.state !== "unknown" || run.nativeTurnId || session.sandbox !== "read-only") throw new DomainError("RUN_NOT_ABANDONABLE", "only an unbound unknown read-only run can be abandoned after review");
    const detail = `Reviewer abandoned uncertain read-only dispatch. This is not proof of external completion or non-execution. Old native session closed to further dispatch. Reason: ${command.reason} Evidence: ${command.evidence}`;
    await tx.updateRuntimeRun({ ...run, state: "failed", version: run.version + 1, resultSummary: detail, updatedAt: now }, run.version);
    await tx.updateRuntimeSession({ ...session, state: "closed", version: session.version + 1, updatedAt: now }, session.version);
    await tx.appendRuntimeEvent(event(command.projectId, nextId(), run.id, session.id, "run.reviewed", detail, null, principal.actorId, now));
    return { result: applied(command.operationId, run.id, run.version + 1), effects: [{ kind: "runtime.run.reviewed", entityId: run.id, version: run.version + 1 }] };
  }
  if (command.type === "runtime.run.interrupt") {
    const run = required(await tx.getRuntimeRun(command.runId), "runtime run");
    if (!run.nativeTurnId || !["running", "unknown"].includes(run.state)) {
      throw new DomainError("TURN_NOT_INTERRUPTIBLE", "only a known active turn can be interrupted");
    }
    if (run.interruptRequested) throw new DomainError("INTERRUPT_ALREADY_REQUESTED", "interrupt is already pending");
    await tx.updateRuntimeRun({ ...run, version: run.version + 1, interruptRequested: true, updatedAt: now }, run.version);
    await tx.appendRuntimeEvent(event(command.projectId, nextId(), run.id, run.sessionId, "run.interruptRequested", command.reason, run.nativeTurnId, principal.actorId, now));
    return { result: applied(command.operationId, run.id, run.version + 1), effects: [{ kind: "runtime.run.interruptRequested", entityId: run.id, version: run.version + 1 }] };
  }
  if (command.type === "runtime.session.reserve") {
    if (await tx.getRuntimeSession(command.sessionId)) throw new DomainError("ALREADY_EXISTS", "runtime session exists");
    if (command.cwd.split("/").some((segment, index) => index > 0 && (segment === "" || segment === "." || segment === ".."))) {
      throw new DomainError("INVALID_CWD", "runtime cwd must be a normalized absolute path");
    }
    const session: RuntimeSessionRecord = {
      projectId: command.projectId, id: command.sessionId, roleId: command.roleId,
      cwd: command.cwd, authorizationScope: command.authorizationScope,
      model: command.model ?? null, sandbox: command.sandbox,
      approvalPolicy: command.approvalPolicy, state: "reserved", version: 1,
      nativeThreadId: null, nativeSessionId: null, operationId: command.operationId,
      actorId: principal.actorId, createdAt: now, updatedAt: now,
    };
    await tx.insertRuntimeSession(session);
    await tx.appendRuntimeEvent(event(command.projectId, nextId(), null, session.id, "session.reserved", "Session reserved before external creation", null, principal.actorId, now));
    return { result: applied(command.operationId, session.id, 1), effects: [{ kind: "runtime.session.reserved", entityId: session.id, version: 1 }] };
  }

  const session = required(await tx.getRuntimeSession(command.sessionId), "runtime session");
  if (session.state !== "ready" || !session.nativeThreadId) throw new DomainError("SESSION_NOT_READY", "only a bound project-owned session can run");
  const task = required(await tx.getTask(command.taskId), "task");
  if (task.version !== command.expectedVersion) throw new DomainError("VERSION_CONFLICT", "task changed since dispatch was requested", task.version);
  if (task.state !== "ready" && task.state !== "active") {
    throw new DomainError("TASK_NOT_READY", "only accepted ready or active tasks may dispatch");
  }
  if ((await tx.listRuntimeRuns()).some(run => run.sessionId === session.id && ["requested", "dispatching", "running", "unknown"].includes(run.state))) {
    throw new DomainError("SESSION_BUSY", "an earlier run in this session is still active or unresolved");
  }
  if ((await tx.listRuntimeRuns(task.id)).some(run => ["requested", "dispatching", "running", "unknown"].includes(run.state))) {
    throw new DomainError("TASK_BUSY", "an earlier run for this task is still active or unresolved");
  }
  if (task.owner !== session.roleId) throw new DomainError("ROLE_MISMATCH", "task owner does not match session role");
  if ((await tx.listImpacts(task.id)).some(item => item.state === "pending")) {
    throw new DomainError("PENDING_BASIS_REVIEW", "review pending basis impacts before dispatch");
  }
  const previous = required(await tx.getTaskRevision(task.id, task.currentRevisionId), "task revision");
  const originalBasis = required(previous.basisSetId ? await tx.getBasisSet(task.id, previous.id, previous.basisSetId) : null, "sealed basis");
  await validateDispatchBasis(tx, task.id, originalBasis);
  if (await tx.getRuntimeRun(command.runId)) throw new DomainError("ALREADY_EXISTS", "runtime run exists");
  // This is the dispatch freeze: the new active revision and sealed basis become the run's immutable keys.
  const revisionId = nextId();
  const basisSetId = nextId();
  const revision: TaskRevision = {
    ...previous, id: revisionId, version: task.version + 1, state: "active",
    basisSetId, actorId: principal.actorId, reason: "Runtime dispatch reserved", createdAt: now,
  };
  const basis: BasisSet = {
    ...originalBasis, id: basisSetId, taskRevisionId: revisionId,
    members: originalBasis.members.map(item => ({ ...item })),
  };
  await tx.insertTaskRevision(revision);
  await tx.insertSealedBasisSet(basis);
  await tx.updateTask({ ...task, version: revision.version, currentRevisionId: revisionId, state: "active" }, task.version);
  const run: RuntimeRunRecord = {
    projectId: command.projectId, id: command.runId, taskId: task.id,
    taskRevisionId: revisionId, basisSetId, sessionId: session.id,
    operationId: command.operationId, input: command.input, inputHash: hash(command.input),
    state: "requested", version: 1, nativeTurnId: null, interruptRequested: false,
    resultSummary: null, actorId: principal.actorId, createdAt: now, updatedAt: now,
  };
  await tx.insertRuntimeRun(run);
  await tx.appendRuntimeEvent(event(command.projectId, nextId(), run.id, session.id, "run.requested", "Run reserved; no external turn started", null, principal.actorId, now));
  return { result: applied(command.operationId, run.id, 1, revision.id), effects: [
    { kind: "task", entityId: task.id, version: task.version + 1 },
    { kind: "runtime.run.requested", entityId: run.id, version: 1 },
  ] };
}

export function event(projectId: string, id: string, runId: string | null, sessionId: string | null,
  kind: RuntimeRecordEvent["kind"], detail: string, nativeTurnId: string | null,
  actorId: string, createdAt: string, cursor: string | null = null, itemsDigest: string | null = null): RuntimeRecordEvent {
  return { projectId, id, runId, sessionId, kind, detail, nativeTurnId, cursor, itemsDigest, actorId, createdAt };
}
