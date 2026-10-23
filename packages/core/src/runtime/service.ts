import type { Principal, RuntimeRecordEvent, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import type { EvaluationPacketBinding, RuntimeBinding, RuntimeTurn } from "@evoloop/contracts/runtime";
import { DomainError } from "@evoloop/contracts/ports";
import type { Clock, IdFactory, Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import { event } from "./reserve.js";
import { validateDispatchBasis } from "./basis.js";

export interface RuntimeWorkflowDependencies { uow: UnitOfWork; clock: Clock; ids: IdFactory }
const internalActor = "runtime-coordinator";
const required = <T>(value: T | null, kind: string): T => {
  if (value === null) throw new DomainError("NOT_FOUND", `${kind} not found`);
  return value;
};
const safeDetail = (value: string): string => value.slice(0, 4000);
const canonicalUtc = (value: string): boolean => {
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString() === value;
};

/** Trusted coordinator entry. Never expose these result-recording methods as public HTTP commands. */
export class RuntimeWorkflowService {
  constructor(private readonly deps: RuntimeWorkflowDependencies) {}

  async verifyBinding(projectId: string, binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    return this.deps.uow.read(projectId, async reader => {
      const saved = required(await reader.getRuntimeSession(binding.sessionId), "runtime session");
      if (!["ready", "closing"].includes(saved.state) || binding.owner !== "evoloop-codex-app-server" ||
        binding.projectId !== projectId || binding.roleId !== saved.roleId ||
        binding.cwd !== saved.cwd || binding.authorizationScope !== saved.authorizationScope ||
        binding.nativeThreadId !== saved.nativeThreadId || binding.nativeSessionId !== saved.nativeSessionId) {
        throw new DomainError("FOREIGN_BINDING", "native binding does not match an owned active session");
      }
      return saved;
    });
  }

  async markSessionArchiveAttempt(projectId: string, sessionId: string, closeOperationId: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (current.state !== "closing" || current.closeOperationId !== closeOperationId || current.closeAttemptedAt)
        throw new DomainError("CLOSE_NOT_PENDING", "archive was already attempted or close intent changed");
      const now = this.deps.clock.now();
      const next = { ...current, version: current.version + 1, closeAttemptedAt: now, updatedAt: now };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.archiveAttempted", "Archive may have been sent; recovery only reads native state", null, projectId);
      return next;
    });
  }

  async confirmSessionClosed(projectId: string, binding: RuntimeBinding, closeOperationId: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(binding.sessionId), "runtime session");
      if (current.state !== "closing" || current.closeOperationId !== closeOperationId ||
        binding.owner !== "evoloop-codex-app-server" || binding.projectId !== projectId ||
        binding.roleId !== current.roleId || binding.cwd !== current.cwd || binding.authorizationScope !== current.authorizationScope ||
        binding.nativeThreadId !== current.nativeThreadId || binding.nativeSessionId !== current.nativeSessionId)
        throw new DomainError("FOREIGN_BINDING", "close proof does not match pending owned session");
      const now = this.deps.clock.now();
      const next = { ...current, state: "closed" as const, version: current.version + 1, closeVerifiedAt: now, updatedAt: now };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, current.id, "session.closed", "Exact owned native thread verified in archived listing", null, projectId);
      return next;
    });
  }

  private async emit(tx: Transaction, runId: string | null, sessionId: string | null,
    kind: RuntimeRecordEvent["kind"], detail: string, nativeTurnId: string | null,
    projectId: string, cursor: string | null = null, itemsDigest: string | null = null): Promise<void> {
    await tx.appendRuntimeEvent(event(projectId, this.deps.ids.next(), runId, sessionId,
      kind, safeDetail(detail), nativeTurnId, internalActor, this.deps.clock.now(), cursor, itemsDigest));
  }

  async beginSessionCreate(projectId: string, sessionId: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (current.state !== "reserved") throw new DomainError("SESSION_NOT_RESERVED", "session create was already attempted");
      const next = { ...current, state: "creating" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.creating", "External thread creation may now begin", null, projectId);
      return next;
    });
  }

  async bindSession(projectId: string, sessionId: string, binding: RuntimeBinding): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (!["creating", "unknown"].includes(current.state)) throw new DomainError("SESSION_NOT_CREATING", "session cannot bind from current state");
      if (binding.owner !== "evoloop-codex-app-server" || binding.projectId !== projectId || binding.sessionId !== sessionId ||
        binding.roleId !== current.roleId || binding.cwd !== current.cwd || binding.authorizationScope !== current.authorizationScope ||
        !binding.nativeThreadId || !binding.nativeSessionId) {
        throw new DomainError("FOREIGN_BINDING", "native binding does not match reserved project session");
      }
      const next = { ...current, state: "ready" as const, version: current.version + 1,
        nativeThreadId: binding.nativeThreadId, nativeSessionId: binding.nativeSessionId, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.bound", "Owned native thread bound", null, projectId);
      return next;
    });
  }

  async markSessionUnknown(projectId: string, sessionId: string, reason: string): Promise<RuntimeSessionRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (current.state === "unknown") return current;
      if (current.state !== "creating") throw new DomainError("SESSION_NOT_CREATING", "only a started create can become unknown");
      const next = { ...current, state: "unknown" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeSession(next, current.version);
      await this.emit(tx, null, sessionId, "session.unknown", reason, null, projectId);
      return next;
    });
  }

  async beginDispatch(projectId: string, runId: string): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (current.state !== "requested") throw new DomainError("RUN_NOT_REQUESTED", "turn start was already attempted");
      if (current.evaluationBinding && !current.evaluationPacket)
        throw new DomainError("EVALUATION_PACKET_MISSING", "a verified fixed-input packet is required before evaluation dispatch");
      const session = required(await tx.getRuntimeSession(current.sessionId), "runtime session");
      if (session.state !== "ready" || !session.nativeThreadId) throw new DomainError("SESSION_NOT_READY", "owned session is not ready");
      const task = required(await tx.getTask(current.taskId), "task");
      if (task.state !== "in_progress" || task.currentRevisionId !== current.taskRevisionId) {
        throw new DomainError("TASK_CHANGED", "task changed after run reservation");
      }
      if ((await tx.listImpacts(task.id)).some(item => item.state === "pending")) {
        throw new DomainError("PENDING_BASIS_REVIEW", "review pending basis impacts before dispatch");
      }
      const revision = required(await tx.getTaskRevision(task.id, current.taskRevisionId), "task revision");
      const basis = required(revision.basisSetId ? await tx.getBasisSet(task.id, revision.id, revision.basisSetId) : null, "sealed basis");
      await validateDispatchBasis(tx, task.id, basis);
      const next = { ...current, state: "dispatching" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      await this.emit(tx, runId, current.sessionId, "run.dispatching", "External turn/start may now begin", null, projectId);
      return next;
    });
  }

  /** Coordinator registers the already verified Blob-backed native input before any startTurn attempt. */
  async attachEvaluationPacket(projectId: string, runId: string, expectedVersion: number,
    packet: EvaluationPacketBinding): Promise<RuntimeRunRecord> {
    if (!/^[a-f0-9]{64}$/.test(packet.contentHash) || !/^[a-f0-9]{64}$/.test(packet.manifestHash) ||
      !packet.payloadRef || !packet.builderVersion || !packet.sources.length)
      throw new DomainError("INVALID_EVALUATION_PACKET", "packet requires Blob identity, hashes, builder and fixed sources");
    return this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (!run.evaluationBinding || run.state !== "requested" || run.version !== expectedVersion || run.evaluationPacket)
        throw new DomainError("EVALUATION_PACKET_CONFLICT", "packet can only be attached once to a requested evaluation Run", run.version);
      const revision = required(await tx.getEvaluation(run.evaluationBinding.evaluationId, run.evaluationBinding.revisionId), "evaluation revision");
      const condition = revision.definition.conditions.find(item => item.id === run.evaluationBinding?.conditionId);
      if (!condition) throw new DomainError("EVALUATION_CONDITION_MISSING", "Run condition is unavailable");
      const signature = revision.definition.case.sourceSignature;
      const mandatory = [
        ...signature.basis.map(item => ({ kind: "document" as const, id: item.documentId,
          revision: item.revisionId, contentHash: item.contentHash })),
        ...signature.external.map(item => ({ kind: item.kind, id: item.referenceId,
          revision: item.revision, contentHash: item.contentHash })),
      ];
      const expected = [revision.definition.protocol, ...revision.definition.case.materials, ...mandatory, ...(condition.wikiRefs ?? [])];
      const key = (item: typeof expected[number]) => `${item.kind}:${item.id}:${item.revision}:${item.contentHash}`;
      if ([...new Set(expected.map(key))].sort().join("|") !== [...new Set(packet.sources.map(key))].sort().join("|") ||
        packet.sources.length !== new Set(packet.sources.map(key)).size)
        throw new DomainError("EVALUATION_PACKET_SOURCES", "packet manifest differs from frozen sources");
      const next = { ...run, evaluationPacket: packet, version: run.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, run.version);
      return next;
    });
  }

  /** Records a preflight failure before any external turn/start attempt. */
  async rejectDispatch(projectId: string, runId: string, reason: string): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (current.state !== "requested") throw new DomainError("RUN_NOT_REQUESTED", "preflight rejection is only valid before external dispatch");
      const next: RuntimeRunRecord = { ...current, state: "failed", version: current.version + 1,
        resultSummary: safeDetail(reason), updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      await this.emit(tx, runId, current.sessionId, "run.preflightRejected", reason, null, projectId);
      await tx.appendOutbox({ projectId, id: this.deps.ids.next(), operationId: current.operationId,
        effectKey: `${projectId}:runtime.run.failed:${runId}`, kind: "runtime.run.failed",
        entityId: runId, version: next.version, createdAt: this.deps.clock.now() });
      return next;
    });
  }

  async bindTurn(projectId: string, runId: string, turn: RuntimeTurn,
    proof: { kind: "startReply" | "historyMarker"; operationId: string }): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (proof.operationId !== current.operationId || !turn.id) throw new DomainError("TURN_PROOF_MISMATCH", "turn must match durable dispatch operation");
      if (current.state === "unknown" && proof.kind !== "historyMarker") {
        throw new DomainError("HISTORY_PROOF_REQUIRED", "unknown start needs owned-history operation marker");
      }
      if (!["dispatching", "unknown"].includes(current.state)) throw new DomainError("RUN_NOT_DISPATCHING", "run cannot bind a new turn");
      if (current.nativeTurnId && current.nativeTurnId !== turn.id) throw new DomainError("FOREIGN_TURN", "run already has a different native turn");
      const next = { ...current, state: "running" as const, version: current.version + 1,
        nativeTurnId: turn.id, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      await this.emit(tx, runId, current.sessionId, "run.bound", `Turn bound from ${proof.kind}`, turn.id, projectId);
      return next;
    });
  }

  async markRunUnknown(projectId: string, runId: string, reason: string): Promise<RuntimeRunRecord> {
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (current.state === "unknown") return current;
      if (!["dispatching", "running"].includes(current.state)) throw new DomainError("RUN_NOT_IN_FLIGHT", "only in-flight turn can become unknown");
      const next = { ...current, state: "unknown" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      await this.emit(tx, runId, current.sessionId, "run.unknown", reason, current.nativeTurnId, projectId);
      return next;
    });
  }

  async recordTurn(projectId: string, runId: string, turnId: string,
    status: "running" | "completed" | "failed" | "interrupted", summary: string | null = null,
    checkpoint: { cursor?: string; itemsDigest?: string; completedAtUtc?: string } = {}): Promise<RuntimeRunRecord> {
    if (checkpoint.completedAtUtc && !canonicalUtc(checkpoint.completedAtUtc)) {
      throw new DomainError("INVALID_OBSERVATION", "native completion time must be canonical UTC");
    }
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (!current.nativeTurnId || current.nativeTurnId !== turnId) throw new DomainError("FOREIGN_TURN", "turn ID does not match bound run");
      if (!["running", "unknown"].includes(current.state)) {
        if (current.state === status) return current;
        throw new DomainError("RUN_TERMINAL", "terminal run cannot be rewritten");
      }
      if (status === "running" && current.state === "running" && !checkpoint.cursor && !checkpoint.itemsDigest) return current;
      const next: RuntimeRunRecord = { ...current, state: status, version: current.version + 1,
        resultSummary: summary ? safeDetail(summary) : current.resultSummary,
        updatedAt: this.deps.clock.now() };
      await tx.updateRuntimeRun(next, current.version);
      const detail = `${status}${checkpoint.completedAtUtc ? `; completedAtUtc=${checkpoint.completedAtUtc}` : ""}${summary ? `: ${summary}` : ""}`;
      await this.emit(tx, runId, current.sessionId, "run.status", detail, turnId, projectId,
        checkpoint.cursor ?? null, checkpoint.itemsDigest ?? null);
      if (status !== "running") {
        await tx.appendOutbox({ projectId, id: this.deps.ids.next(), operationId: current.operationId,
          effectKey: `${projectId}:runtime.run.${status}:${runId}`, kind: `runtime.run.${status}`,
          entityId: runId, version: next.version, createdAt: this.deps.clock.now() });
      }
      return next;
    });
  }

  /** Reviewer-triggered observation of the same owned native turn after an earlier terminal report. */
  async reconcileTerminalObservation(projectId: string, runId: string, turnId: string,
    status: "completed" | "failed" | "interrupted", summary: string | null,
    checkpoint: { itemsDigest: string; completedAtUtc: string }, expectedVersion: number,
    principal: Principal, reason: string): Promise<RuntimeRunRecord> {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("review") || !principal.actorId.trim()) {
      throw new DomainError("FORBIDDEN", "run reconciliation requires project review permission");
    }
    if (!canonicalUtc(checkpoint.completedAtUtc) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.itemsDigest) || !reason.trim()) {
      throw new DomainError("INVALID_OBSERVATION", "reconciliation needs a completed UTC native turn, item digest and reason");
    }
    return this.deps.uow.transaction(projectId, async tx => {
      const current = required(await tx.getRuntimeRun(runId), "runtime run");
      if (current.version !== expectedVersion) throw new DomainError("VERSION_CONFLICT", "run changed", current.version);
      if (!current.nativeTurnId || current.nativeTurnId !== turnId) throw new DomainError("FOREIGN_TURN", "turn ID does not match bound run");
      if (!["completed", "failed", "interrupted"].includes(current.state)) {
        throw new DomainError("RUN_NOT_TERMINAL", "only a terminal bound run can be reconciled");
      }
      const session = required(await tx.getRuntimeSession(current.sessionId), "runtime session");
      if (!session.nativeThreadId || !session.nativeSessionId || session.state !== "ready") {
        throw new DomainError("FOREIGN_BINDING", "run has no ready owned native session");
      }
      const now = this.deps.clock.now();
      const next: RuntimeRunRecord = { ...current, state: status, version: current.version + 1,
        resultSummary: summary === null ? current.resultSummary : safeDetail(summary), updatedAt: now };
      await tx.updateRuntimeRun(next, current.version);
      await tx.appendRuntimeEvent(event(projectId, this.deps.ids.next(), runId, current.sessionId, "run.reconciled",
        safeDetail(`Reviewer re-observed native terminal ${current.state} -> ${status}; completedAtUtc=${checkpoint.completedAtUtc}; reason=${reason}; summary=${summary ?? "unchanged"}`),
        turnId, principal.actorId, now, null, checkpoint.itemsDigest));
      await tx.appendOutbox({ projectId, id: this.deps.ids.next(), operationId: current.operationId,
        effectKey: `${projectId}:runtime.run.reconciled:${runId}:v${next.version}`, kind: "runtime.run.reconciled",
        entityId: runId, version: next.version, createdAt: now });
      return next;
    });
  }

  async recoverDispatching(projectId: string): Promise<{ sessions: string[]; runs: string[] }> {
    const sessions: string[] = [];
    const runs: string[] = [];
    // One project transaction is serialized with new dispatch reservations.
    await this.deps.uow.transaction(projectId, async tx => {
      for (const current of await tx.listRuntimeSessions()) {
        if (current.state !== "creating") continue;
        const next = { ...current, state: "unknown" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
        await tx.updateRuntimeSession(next, current.version);
        await this.emit(tx, null, current.id, "session.unknown", "Coordinator restarted during create; no automatic retry", null, projectId);
        sessions.push(current.id);
      }
      for (const current of await tx.listRuntimeRuns()) {
        if (current.state !== "dispatching") continue;
        const next = { ...current, state: "unknown" as const, version: current.version + 1, updatedAt: this.deps.clock.now() };
        await tx.updateRuntimeRun(next, current.version);
        await this.emit(tx, current.id, current.sessionId, "run.unknown", "Coordinator restarted during turn/start; no automatic retry", current.nativeTurnId, projectId);
        runs.push(current.id);
      }
    });
    return { sessions, runs };
  }

  async recordInterruptResult(projectId: string, runId: string, outcome: "acknowledged" | "unknown", detail: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (!run.interruptRequested || !run.nativeTurnId) throw new DomainError("NO_INTERRUPT", "no interrupt was requested");
      await this.emit(tx, runId, run.sessionId, "run.interruptResult", `${outcome}: ${detail}`, run.nativeTurnId, projectId);
    });
  }

  async recordApprovalDeclined(projectId: string, runId: string, turnId: string, detail: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (run.nativeTurnId !== turnId) throw new DomainError("FOREIGN_TURN", "approval belongs to another turn");
      await this.emit(tx, runId, run.sessionId, "runtime.approvalDeclined", detail, turnId, projectId);
    });
  }

  async recordSessionApprovalDeclined(projectId: string, sessionId: string,
    nativeThreadId: string, turnId: string | null, detail: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const session = required(await tx.getRuntimeSession(sessionId), "runtime session");
      if (!nativeThreadId || !["creating", "ready", "unknown"].includes(session.state) ||
        (session.nativeThreadId !== null && session.nativeThreadId !== nativeThreadId)) {
        throw new DomainError("FOREIGN_BINDING", "approval does not belong to an owned thread create or binding");
      }
      await this.emit(tx, null, sessionId, "runtime.approvalDeclined", `Thread ${nativeThreadId}: ${detail}`, turnId, projectId);
    });
  }

  async recordHandoffReceipt(projectId: string, runId: string,
    stage: "received" | "read" | "adopted" | "effect", evidence: string): Promise<void> {
    await this.deps.uow.transaction(projectId, async tx => {
      const run = required(await tx.getRuntimeRun(runId), "runtime run");
      if (run.state !== "completed") throw new DomainError("RUN_NOT_COMPLETED", "handoff follows a completed native run");
      const events = await tx.listRuntimeEvents(runId);
      const order = ["received", "read", "adopted", "effect"] as const;
      const position = order.indexOf(stage);
      if (position > 0 && !events.some(item => item.kind === `handoff.${order[position - 1]}`)) {
        throw new DomainError("HANDOFF_ORDER", "previous handoff evidence is missing");
      }
      if (events.some(item => item.kind === `handoff.${stage}`)) throw new DomainError("HANDOFF_ALREADY_RECORDED", "handoff stage already recorded");
      await this.emit(tx, runId, run.sessionId, `handoff.${stage}`, evidence, run.nativeTurnId, projectId);
    });
  }
}
