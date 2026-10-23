import type { Principal } from "@evoloop/contracts";
import { orchestrationCommandSchema } from "@evoloop/contracts/orchestration";
import type { OrchestrationCommand, OrchestrationDispatch, OrchestrationEvent, OrchestrationInbox, OrchestrationLoop, OrchestrationResult, OrchestrationSourceFact, OrchestrationStore, OrchestrationSubmission, OrchestrationTransaction, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";

export class OrchestrationError extends Error {
  constructor(public readonly code: string, message: string, public readonly currentVersion?: number) { super(message); this.name = "OrchestrationError"; }
}
export interface OrchestrationDependencies { store: OrchestrationStore; now(): string; nextId(): string; hash(value: string): string }
const fail = (code: string, message: string, currentVersion?: number): never => { throw new OrchestrationError(code, message, currentVersion); };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const cursorAfter = (a: { createdAtUtc: string; eventId: string }, b: { createdAtUtc: string; eventId: string | null }): boolean => Date.parse(a.createdAtUtc) > Date.parse(b.createdAtUtc) || (Date.parse(a.createdAtUtc) === Date.parse(b.createdAtUtc) && a.eventId > (b.eventId ?? ""));
const activeCapacity = new Set(["claimed", "dispatching", "accepted", "unknown"]);
const scheduleIdFor = (hash: (value: string) => string, value: string): string => {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** Only persists orchestration decisions. WorkflowService remains the sole Task/Run/Delivery writer. */
export class OrchestrationService {
  constructor(private readonly deps: OrchestrationDependencies) {}

  async execute(principal: Principal, input: OrchestrationCommand): Promise<OrchestrationResult> {
    const parsed = orchestrationCommandSchema.safeParse(input);
    if (!parsed.success) return fail("INVALID_COMMAND", parsed.error.message);
    const command = parsed.data;
    if (!principal.actorId || !principal.projectIds.includes(command.projectId) || !principal.permissions.includes("write")) return fail("FORBIDDEN", "project write permission required");
    if ((command.type === "loop.enroll" || command.type === "loop.state" || command.type === "loop.resumeWaiting" || command.type === "dispatch.reconcile" || command.type === "dispatch.gap" || command.type === "worker.beginSeal" || command.type === "worker.finishSeal" || command.type === "worker.reconcileSeal") && !principal.permissions.includes("review")) return fail("FORBIDDEN", "loop policy requires review permission");
    if (command.type === "loop.resumeWaiting" && principal.actorId.startsWith("worker-")) return fail("FORBIDDEN", "runtime worker cannot resume waiting cognition");
    const now = this.deps.now();
    if (!Number.isFinite(Date.parse(now)) || !now.endsWith("Z")) return fail("INVALID_TIME", "clock must return UTC time");
    return this.deps.store.transaction(command.projectId, async tx => {
      // Authorize before journal replay: a revoked actor cannot replay a former operation.
      await this.authorize(tx, principal, command);
      const hash = this.deps.hash(canonical(command));
      const prior = await tx.getOperation(command.operationId);
      if (prior) {
        if (prior.projectId !== command.projectId || prior.actorId !== principal.actorId || prior.commandHash !== hash) return fail("OPERATION_CONFLICT", "operation ID belongs to a different intent");
        return { ...prior.result, replayed: true };
      }
      const result = await this.apply(tx, principal, command, now);
      await tx.insertOperation({ projectId: command.projectId, id: command.operationId, actorId: principal.actorId, commandHash: hash, result, createdAtUtc: now });
      return result;
    });
  }

  async getOperation(principal: Principal, projectId: string, id: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, async reader => { const operation = await reader.getOperation(id); if (operation && operation.actorId !== principal.actorId) return fail("FORBIDDEN", "operation belongs to another actor"); return operation; }); }
  async getInbox(principal: Principal, projectId: string, id: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.getInbox(id)); }
  async getDispatch(principal: Principal, projectId: string, id: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.getDispatch(id)); }
  async getLoop(principal: Principal, projectId: string, id: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.getLoop(id)); }
  async listLoops(principal: Principal, projectId: string, limit = 50, cursor?: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.listLoops(this.limit(limit), cursor)); }
  async listInbox(principal: Principal, projectId: string, loopId: string, limit = 50, cursor?: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.listInbox(loopId, this.limit(limit), cursor)); }
  async listDispatches(principal: Principal, projectId: string, loopId: string, limit = 50, cursor?: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.listDispatches(loopId, this.limit(limit), cursor)); }
  async getSubmission(principal: Principal, projectId: string, id: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.getSubmission(id)); }
  async getDecision(principal: Principal, projectId: string, id: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.getDecision(id)); }
  async getSubmissionForDispatch(principal: Principal, projectId: string, dispatchId: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.findSubmissionByDispatch(dispatchId)); }
  async getDecisionForDispatch(principal: Principal, projectId: string, dispatchId: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.findDecisionByDispatch(dispatchId)); }
  async listSubmissions(principal: Principal, projectId: string, loopId: string, limit = 50, cursor?: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.listSubmissions(loopId, this.limit(limit), cursor)); }
  async listEvents(principal: Principal, projectId: string, loopId: string, limit = 50, cursor?: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.listEvents(loopId, this.limit(limit), cursor)); }
  async listSourceFacts(principal: Principal, projectId: string, loopId: string, limit = 50, cursor?: string) { this.readable(principal, projectId); return this.deps.store.read(projectId, reader => reader.listSourceFacts(loopId, this.limit(limit), cursor)); }
  private readable(principal: Principal, projectId: string) { if (!principal.actorId || !principal.projectIds.includes(projectId) || !principal.permissions.includes("read")) return fail("FORBIDDEN", "project read permission required"); }
  private limit(n: number) { if (!Number.isInteger(n) || n < 1 || n > 100) return fail("INVALID_PAGE", "page limit must be 1–100"); return n; }

  private async authorize(tx: OrchestrationTransaction, principal: Principal, command: OrchestrationCommand): Promise<void> {
    if (command.type === "loop.enroll" || command.type === "loop.state" || command.type === "loop.resumeWaiting" || command.type === "dispatch.reconcile" || command.type === "dispatch.gap" || command.type === "worker.beginSeal" || command.type === "worker.finishSeal" || command.type === "worker.reconcileSeal" || (command.type === "worker.outcome" && principal.permissions.includes("review")) || (command.type === "dispatch.resolve" && command.result === "unknown" && principal.permissions.includes("review"))) return;
    let loop: OrchestrationLoop | null = null;
    let dispatch: OrchestrationDispatch | null = null;
    if (command.type === "inbox.accept") loop = await tx.getLoop(command.loopId);
    else if (command.type === "inbox.ack" || command.type === "inbox.dispose" || command.type === "dispatch.request") {
      const inbox = await tx.getInbox(command.inboxId);
      if (!inbox) return fail("NOT_FOUND", "inbox item not found");
      loop = await tx.getLoop(inbox.loopId);
    } else {
      dispatch = await tx.getDispatch(command.dispatchId);
      if (!dispatch) return fail("NOT_FOUND", "dispatch not found");
      loop = await tx.getLoop(dispatch.loopId);
    }
    if (!loop || loop.projectId !== command.projectId) return fail("NOT_FOUND", "loop not found in project");
    const roleId = dispatch ? dispatch.recipientRoleId : loop.cognitiveRoleId;
    if (!(await tx.canActAsRole(principal.actorId, roleId))) return fail("FORBIDDEN", "actor is not bound to the required role");
  }

  private async apply(tx: OrchestrationTransaction, principal: Principal, command: OrchestrationCommand, now: string): Promise<OrchestrationResult> {
    const event = async (loopId: string, entityType: OrchestrationEvent["entityType"], entityId: string, kind: string, detail: Record<string, unknown> = {}, eventId = this.deps.nextId()) => tx.appendEvent({ projectId: command.projectId, id: eventId, loopId, entityType, entityId, operationId: command.operationId, kind, actorId: principal.actorId, detail, createdAtUtc: now });
    const result = (entityType: OrchestrationResult["entityType"], entityId: string, version: number): OrchestrationResult => ({ entityType, entityId, version, replayed: false });
    if (command.type === "loop.enroll") {
      if (command.maxConcurrent > command.maxRuns) return fail("INVALID_POLICY", "maxConcurrent cannot exceed maxRuns");
      if (new Set(command.allowedBusinessRoleIds).size !== command.allowedBusinessRoleIds.length) return fail("INVALID_POLICY", "business roles must be unique");
      if (command.allowedBusinessRoleIds.includes(command.cognitiveRoleId)) return fail("INVALID_POLICY", "cognitive role must differ from worker roles");
      const goal = await tx.getGoalFact(command.goalId);
      if (!goal || goal.projectId !== command.projectId) return fail("GOAL_NOT_FOUND", "goal not found in project");
      if (command.stageId) {
        const stage = await tx.getStageFact(command.stageId);
        if (!stage || stage.projectId !== command.projectId || stage.goalId !== goal.id || stage.state !== "active") return fail("STAGE_NOT_ACTIVE", "stage must be active under this goal");
      }
      if (Date.parse(command.sourceAfter.createdAtUtc) > Date.parse(now)) return fail("INVALID_CURSOR", "source cursor cannot be in the future");
      if (command.sourceAfter.eventId) {
        const source = await tx.getSourceFact(command.sourceAfter.eventId);
        if (!source || source.projectId !== command.projectId || Date.parse(source.createdAtUtc) !== Date.parse(command.sourceAfter.createdAtUtc)) return fail("INVALID_CURSOR", "source cursor must match a verified project event");
      }
      if (await tx.getLoop(command.loopId)) return fail("ALREADY_EXISTS", "loop ID already enrolled");
      const bootstrapEventId = this.deps.nextId();
      const loop: OrchestrationLoop = { projectId: command.projectId, id: command.loopId, version: 1, goalId: goal.id, stageId: command.stageId, bootstrapEventId, cognitiveRoleId: command.cognitiveRoleId, allowedBusinessRoleIds: command.allowedBusinessRoleIds, sourceAfter: command.sourceAfter, maxRuns: command.maxRuns, maxConcurrent: command.maxConcurrent, dispatchCount: 0, state: "active", enrolledBy: principal.actorId, createdAtUtc: now, updatedAtUtc: now };
      await tx.insertLoop(loop); await event(loop.id, "loop", loop.id, "loop.enrolled", { goalId: loop.goalId, stageId: loop.stageId, sourceAfter: loop.sourceAfter }, bootstrapEventId);
      return result("loop", loop.id, 1);
    }
    if (command.type === "loop.state") {
      const loop = await this.loop(tx, command.loopId, command.projectId);
      this.version(loop.version, command.expectedVersion);
      if (loop.state === "stopped") return fail("LOOP_STOPPED", "stopped loop cannot resume");
      if (loop.state === command.state) return fail("NO_CHANGE", "loop is already in that state");
      const next = { ...loop, state: command.state, version: loop.version + 1, updatedAtUtc: now };
      await tx.updateLoop(next, loop.version); await event(loop.id, "loop", loop.id, "loop.state", { state: next.state, reason: command.reason });
      return result("loop", loop.id, next.version);
    }
    if (command.type === "loop.resumeWaiting") {
      const loop = await this.loop(tx, command.loopId, command.projectId);
      this.version(loop.version, command.expectedLoopVersion);
      this.active(loop);
      if (!loop.stageId) return fail("STAGE_NOT_ACTIVE", "waiting resume requires an active enrolled Stage");
      const stage = await tx.getStageFact(loop.stageId);
      if (!stage || stage.projectId !== command.projectId || stage.goalId !== loop.goalId || stage.state !== "active")
        return fail("STAGE_NOT_ACTIVE", "waiting resume requires the same active enrolled Stage");
      if (loop.dispatchCount >= loop.maxRuns) return fail("BUDGET_EXHAUSTED", "loop has no remaining Run budget");
      const decision = await tx.getDecision(command.decisionId);
      const dispatch = await tx.getDispatch(command.dispatchId);
      if (!decision || !dispatch || decision.projectId !== command.projectId || dispatch.projectId !== command.projectId ||
        decision.dispatchId !== dispatch.id || dispatch.loopId !== loop.id || dispatch.parentDispatchId !== null ||
        dispatch.recipientRoleId !== loop.cognitiveRoleId || decision.kind !== "waiting" ||
        dispatch.state !== "completed" || dispatch.outcome !== "waiting" ||
        dispatch.runtimeRunId !== decision.runId || dispatch.taskId !== decision.taskId ||
        await tx.findSubmissionByDispatch(dispatch.id))
        return fail("WAITING_UNAVAILABLE", "decision must belong to completed waiting cognition in this loop");
      const run = await tx.getRunFact(decision.runId);
      if (!run || run.projectId !== command.projectId || run.taskId !== dispatch.taskId ||
        !["completed", "failed", "interrupted"].includes(run.state))
        return fail("RUN_NOT_TERMINAL", "waiting cognition Run must have a known terminal state");
      if (await tx.hasChildDispatch(dispatch.id) || await tx.hasUnsettledDispatchForSource(loop.id, dispatch.sourceEventId, dispatch.id))
        return fail("WAITING_UNAVAILABLE", "waiting cognition already has a child or unsettled dispatch");
      if (await tx.hasWaitingResume(decision.id)) return fail("ALREADY_RESUMED", "waiting decision has already been resumed");
      const previous = await tx.getSourceFact(dispatch.sourceEventId);
      const rootId = previous?.kind === "document" ? previous.id : previous?.kind === "waiting.resumed" ? previous.originalSourceEventId : null;
      const root = rootId ? await tx.getSourceFact(rootId) : null;
      if (!previous || !root || !rootId || root.kind !== "document" || root.projectId !== command.projectId ||
        previous.projectId !== command.projectId ||
        (previous.kind === "waiting.resumed" && (previous.sourceLoopId !== loop.id || previous.subjectId !== root.subjectId ||
          previous.issueRevisionId !== root.issueRevisionId || previous.issueContentHash !== root.issueContentHash)))
        return fail("SOURCE_UNAVAILABLE", "waiting source must trace to a fixed Issue in this project");
      await this.fixedIssue(tx, loop, root, command.projectId);
      const next = { ...loop, version: loop.version + 1, updatedAtUtc: now };
      await tx.updateLoop(next, loop.version);
      await event(loop.id, "decision", decision.id, "waiting.resumed", {
        previousSourceEventId: previous.id, originalSourceEventId: root.id,
        issueDocumentId: root.subjectId, issueRevisionId: root.issueRevisionId, issueContentHash: root.issueContentHash,
        decisionId: decision.id, dispatchId: dispatch.id, runId: run.id,
        resumedAtLoopVersion: next.version, evidenceRef: command.evidenceRef, reason: command.reason,
      });
      return result("loop", loop.id, next.version);
    }
    if (command.type === "inbox.accept") {
      const loop = await this.loop(tx, command.loopId, command.projectId);
      this.active(loop);
      if (command.recipientRoleId !== loop.cognitiveRoleId) return fail("RECIPIENT_MISMATCH", "source event must enter the enrolled cognitive role");
      const source = await tx.getSourceFact(command.sourceEventId);
      const bootstrap = source?.id === loop.bootstrapEventId && source.kind === "loop.enrolled" && source.sourceLoopId === loop.id && source.subjectId === loop.id && source.subjectVersion === 1;
      const feedback = source?.kind === "worker.outcome" && source.sourceLoopId === loop.id && !!source.originDispatchId;
      const recoveryGap = source?.kind === "dispatch.gap" && source.sourceLoopId === loop.id && !!source.originDispatchId;
      const externalObservation = source?.kind === "observation.record" && source.sourceLoopId === null && source.originDispatchId === null;
      const scopedIssue = source?.kind === "document" && source.sourceLoopId === null && source.originDispatchId === null && !!source.issueRevisionId;
      const resumedWaiting = source?.kind === "waiting.resumed" && source.sourceLoopId === loop.id && !!source.originalSourceEventId;
      const scheduled = source?.kind === "schedule.task.todo" && source.sourceLoopId === loop.id && source.scheduleTargetLoopId === loop.id && source.originDispatchId === null;
      if (!source || source.projectId !== command.projectId || (!bootstrap && !feedback && !recoveryGap && !externalObservation && !scopedIssue && !resumedWaiting && !scheduled) || (!bootstrap && !cursorAfter({ createdAtUtc: source.createdAtUtc, eventId: source.id }, loop.sourceAfter))) return fail("SOURCE_UNAVAILABLE", "source event must be an enrolled or verified source in this loop");
      if (resumedWaiting) {
        if (!loop.stageId) return fail("STAGE_NOT_ACTIVE", "resumed waiting source requires an active enrolled Stage");
        const stage = await tx.getStageFact(loop.stageId);
        if (!stage || stage.projectId !== command.projectId || stage.goalId !== loop.goalId || stage.state !== "active")
          return fail("STAGE_NOT_ACTIVE", "resumed waiting source requires the same active enrolled Stage");
        const root = await tx.getSourceFact(source.originalSourceEventId!);
        if (!root || root.kind !== "document" || root.projectId !== command.projectId || root.subjectId !== source.subjectId ||
          root.issueRevisionId !== source.issueRevisionId || root.issueContentHash !== source.issueContentHash ||
          !source.waitingDecisionId || !source.originDispatchId || !source.waitingRunId || !source.previousSourceEventId)
          return fail("SOURCE_UNAVAILABLE", "resumed waiting source has no fixed Issue chain");
        await this.fixedIssue(tx, loop, root, command.projectId);
      }
      if (scheduled) {
        if (!source.scheduleId || !source.scheduleRevisionId || !source.plannedAtUtc ||
          !source.scheduleTargetStageId || !source.scheduleTaskRevisionId || !source.operationId || !source.sourceActorId || source.subjectVersion !== 1 ||
          source.scheduleTargetStageId !== loop.stageId ||
          source.operationId !== scheduleIdFor(this.deps.hash, `schedule-operation:${command.projectId}:${source.scheduleId}:${source.plannedAtUtc}`) ||
          source.subjectId !== scheduleIdFor(this.deps.hash, `schedule-task:${command.projectId}:${source.scheduleId}:${source.plannedAtUtc}`) ||
          source.id !== scheduleIdFor(this.deps.hash, `schedule-outbox:${command.projectId}:${source.scheduleId}:${source.plannedAtUtc}`) ||
          source.scheduleTaskRevisionId !== scheduleIdFor(this.deps.hash, `schedule-task-revision:${command.projectId}:${source.scheduleId}:${source.plannedAtUtc}`))
          return fail("SOURCE_UNAVAILABLE", "Schedule source must match its stable UTC occurrence and creation Task");
        const operation = await tx.getWorkflowOperationFact(source.operationId);
        const fixed = await tx.getTaskScopeAtVersion(source.subjectId, 1);
        const stage = await tx.getStageFact(source.scheduleTargetStageId);
        if (!operation || operation.projectId !== command.projectId || operation.commandType !== "schedule.occurrence" ||
          operation.status !== "applied" || operation.actorId !== source.sourceActorId ||
          operation.commandHash !== this.deps.hash(`${command.projectId}:${source.scheduleId}:${source.plannedAtUtc}`) ||
          operation.resultRefId !== source.subjectId || operation.resultVersion !== 1 ||
          !fixed || fixed.projectId !== command.projectId || fixed.taskVersion !== 1 ||
          fixed.stageId !== source.scheduleTargetStageId || fixed.goalId !== loop.goalId ||
          !stage || stage.projectId !== command.projectId || stage.goalId !== loop.goalId || stage.state !== "active")
          return fail("SOURCE_UNAVAILABLE", "Schedule source has no matching applied operation or fixed active Stage");
      }
      if (scopedIssue) {
        await this.fixedIssue(tx, loop, source, command.projectId);
      }
      if (recoveryGap) {
        const origin = await tx.getDispatch(source.originDispatchId!);
        if (!origin || origin.projectId !== command.projectId || origin.loopId !== loop.id ||
          origin.state !== "accepted" || origin.outcome !== null || !origin.runtimeRunId ||
          origin.runtimeRunId !== source.gapRunId || origin.taskId !== source.subjectId ||
          origin.taskVersion !== source.gapTaskVersion ||
          origin.version < source.subjectVersion)
          return fail("SOURCE_UNAVAILABLE", "recovery requires the original accepted dispatch and fixed gap Run");
        const run = await tx.getRunFact(origin.runtimeRunId);
        if (!run || run.projectId !== command.projectId || run.taskId !== origin.taskId ||
          !["completed", "failed", "interrupted"].includes(run.state) ||
          await tx.findSubmissionByDispatch(origin.id) || await tx.findDecisionByDispatch(origin.id))
          return fail("SOURCE_UNAVAILABLE", "recovery requires a confirmed terminal Run with no signed worker intent");
        const fixed = await tx.getTaskScopeAtVersion(origin.taskId, origin.taskVersion);
        if (!fixed || fixed.projectId !== command.projectId || fixed.taskVersion !== origin.taskVersion ||
          !fixed.stageId || fixed.goalId !== loop.goalId || (loop.stageId !== null && fixed.stageId !== loop.stageId))
          return fail("SOURCE_UNAVAILABLE", "the original Task revision is outside this loop's fixed Goal and Stage");
      }
      if (feedback) {
        const origin = await tx.getDispatch(source.originDispatchId!);
        if (!origin || origin.projectId !== command.projectId || origin.loopId !== loop.id || origin.recipientRoleId === loop.cognitiveRoleId || origin.state !== "completed" || !["delivered", "failed", "waiting", "no_action"].includes(origin.outcome ?? "") || origin.taskId !== source.subjectId || origin.version !== source.subjectVersion) return fail("SOURCE_UNAVAILABLE", "feedback must be a completed business outcome in this loop");
      }
      if (externalObservation) {
        if (!source.operationId || !source.sourceActorId || !source.observationId || !source.deliveryId || !source.observationResult)
          return fail("SOURCE_UNAVAILABLE", "consumer observation source lacks fixed operation and observation identity");
        // These reads share one transaction client; keep them serial for pg's single-query connection contract.
        const operation = await tx.getWorkflowOperationFact(source.operationId);
        const observation = await tx.getObservationFact(source.observationId);
        const delivery = await tx.getDeliveryFact(source.deliveryId);
        if (!operation || operation.projectId !== command.projectId || operation.id !== source.operationId ||
          operation.commandType !== "observation.record" || operation.status !== "applied" ||
          operation.actorId !== source.sourceActorId || operation.resultRefId !== source.observationId ||
          operation.resultVersion !== source.subjectVersion ||
          !observation || observation.projectId !== command.projectId || observation.id !== source.observationId ||
          observation.taskId !== source.subjectId || observation.deliveryId !== source.deliveryId ||
          observation.actorId !== source.sourceActorId || observation.result !== source.observationResult ||
          !delivery || delivery.projectId !== command.projectId || delivery.id !== observation.deliveryId ||
          delivery.taskId !== observation.taskId || delivery.taskRevisionId !== observation.taskRevisionId ||
          delivery.actorId === observation.actorId || !observation.stageId)
          return fail("SOURCE_UNAVAILABLE", "consumer observation must match its applied operation, fixed Delivery, and independent actor");
        const stage = await tx.getStageFact(observation.stageId);
        if (!stage || stage.projectId !== command.projectId || stage.goalId !== loop.goalId ||
          (loop.stageId !== null && stage.id !== loop.stageId) ||
          await tx.wasActorRole(observation.actorId, loop.id, loop.cognitiveRoleId))
          return fail("SOURCE_UNAVAILABLE", "consumer observation is outside this loop's fixed scope or authored by its cognition worker");
      }
      const existing = await tx.findInbox(loop.id, source.id, command.recipientRoleId, command.purpose);
      if (existing) return result("inbox", existing.id, existing.version);
      const inbox: OrchestrationInbox = { projectId: command.projectId, id: this.deps.nextId(), version: 1, loopId: loop.id, sourceEventId: source.id, recipientRoleId: command.recipientRoleId, purpose: command.purpose, state: "pending", acknowledgedBy: null, disposition: null, reason: null, evidenceRef: null, dispatchId: null, createdAtUtc: now, updatedAtUtc: now };
      await tx.insertInbox(inbox); await event(loop.id, "inbox", inbox.id, "inbox.accepted", { sourceEventId: source.id, kind: source.kind, purpose: inbox.purpose });
      return result("inbox", inbox.id, 1);
    }
    if (command.type === "inbox.ack" || command.type === "inbox.dispose") {
      const inbox = await this.inbox(tx, command.inboxId, command.projectId);
      const loop = await this.loop(tx, inbox.loopId, command.projectId);
      this.version(inbox.version, command.expectedVersion);
      if (inbox.state === "disposed") return fail("INBOX_DISPOSED", "inbox item already disposed");
      if (command.type === "inbox.ack") {
        if (inbox.state !== "pending") return fail("INVALID_STATE", "inbox item already acknowledged");
        const next: OrchestrationInbox = { ...inbox, version: inbox.version + 1, state: "acknowledged", acknowledgedBy: principal.actorId, reason: command.reason, updatedAtUtc: now };
        await tx.updateInbox(next, inbox.version); await event(loop.id, "inbox", inbox.id, "inbox.acknowledged", { reason: command.reason });
        return result("inbox", inbox.id, next.version);
      }
      // Stop is a legitimate disposition while paused; it closes the loop in the same transaction.
      // Existing inbox items may be accounted for while a loop is paused or stopped.
      if (inbox.state !== "acknowledged") return fail("ACK_REQUIRED", "inbox item must be acknowledged before disposition");
      const next: OrchestrationInbox = { ...inbox, version: inbox.version + 1, state: "disposed", disposition: command.disposition, reason: command.reason, evidenceRef: command.evidenceRef, updatedAtUtc: now };
      await tx.updateInbox(next, inbox.version);
      if (command.disposition === "stop") {
        if (loop.state === "stopped") return fail("LOOP_STOPPED", "loop already stopped");
        await tx.updateLoop({ ...loop, state: "stopped", version: loop.version + 1, updatedAtUtc: now }, loop.version);
        await event(loop.id, "loop", loop.id, "loop.stopped", { reason: command.reason });
      }
      await event(loop.id, "inbox", inbox.id, "inbox.disposed", { disposition: command.disposition, reason: command.reason, evidenceRef: command.evidenceRef });
      return result("inbox", inbox.id, next.version);
    }
    if (command.type === "dispatch.request") {
      const inbox = await this.inbox(tx, command.inboxId, command.projectId);
      const loop = await this.loop(tx, inbox.loopId, command.projectId);
      this.active(loop); this.version(inbox.version, command.expectedInboxVersion);
      if (inbox.state !== "acknowledged") return fail("ACK_REQUIRED", "acknowledged inbox item required");
      if (loop.dispatchCount >= loop.maxRuns) return fail("RUN_LIMIT", "loop run budget exhausted");
      const cognitionRequest = command.recipientRoleId === loop.cognitiveRoleId;
      if (cognitionRequest) {
        if (command.purpose !== "cognition" || inbox.purpose !== "cognitive_review" || command.parentDispatchId !== null) return fail("INVALID_CAUSALITY", "cognition requires cognitive_review inbox without a parent dispatch");
      } else {
        if (!loop.allowedBusinessRoleIds.includes(command.recipientRoleId) || inbox.purpose !== "next_action" || !command.parentDispatchId) return fail("INVALID_CAUSALITY", "business dispatch requires next_action inbox and cognition parent");
        const parent = await tx.getDispatch(command.parentDispatchId);
        if (!parent || parent.projectId !== command.projectId || parent.loopId !== loop.id || parent.sourceEventId !== inbox.sourceEventId || parent.recipientRoleId !== loop.cognitiveRoleId || !parent.runtimeRunId || !["accepted", "completed"].includes(parent.state)) return fail("PARENT_NOT_READY", "accepted cognition dispatch for the same source is required");
        // A signed decision fixes the parent's choice. The project transaction lock orders
        // child requests and worker decisions even when their UTC timestamps are identical.
        if (await tx.findDecisionByDispatch(parent.id)) return fail("PARENT_DECIDED", "cognition decision is already signed; no later child dispatch can be attributed to it");
      }
      const auth = await tx.getAuthorizationFact(command.authorizationScopeId);
      if (!auth || auth.projectId !== command.projectId || !auth.active || auth.roleId !== command.recipientRoleId) return fail("SCOPE_NOT_AUTHORIZED", "active scoped worker authorization required");
      const task = await tx.getTaskFact(command.taskId);
      if (!task || task.projectId !== command.projectId || task.version !== command.expectedTaskVersion || (task.state !== "todo" && task.state !== "in_progress") || task.ownerRoleId !== command.recipientRoleId || task.goalId !== loop.goalId || !task.stageId || (loop.stageId !== null && task.stageId !== loop.stageId)) return fail("TASK_CHANGED", "Task current version, state, owner, and loop scope must match");
      const stage = await tx.getStageFact(task.stageId);
      if (!stage || stage.projectId !== command.projectId || stage.goalId !== loop.goalId || stage.state !== "active") return fail("STAGE_NOT_ACTIVE", "Task stage must be active under the loop goal");
      if (await tx.getDispatch(command.dispatchId)) return fail("ALREADY_EXISTS", "dispatch ID already used");
      const dispatch: OrchestrationDispatch = { projectId: command.projectId, id: command.dispatchId, version: 1, loopId: loop.id, inboxId: inbox.id, sourceEventId: inbox.sourceEventId, taskId: task.id, taskVersion: task.version, parentDispatchId: command.parentDispatchId, recipientRoleId: command.recipientRoleId, purpose: command.purpose, authorizationScopeId: auth.scopeId, state: "pending", claimToken: null, leaseUntilUtc: null, runtimeRunId: null, outcome: null, deliveryId: null, evidenceRef: null, reason: command.reason, requestedBy: principal.actorId, createdAtUtc: now, updatedAtUtc: now };
      await tx.insertDispatch(dispatch);
      await tx.updateInbox({ ...inbox, version: inbox.version + 1, state: "disposed", disposition: "dispatch", dispatchId: dispatch.id, reason: command.reason, updatedAtUtc: now }, inbox.version);
      await tx.updateLoop({ ...loop, version: loop.version + 1, dispatchCount: loop.dispatchCount + 1, updatedAtUtc: now }, loop.version);
      await event(loop.id, "dispatch", dispatch.id, "dispatch.requested", { taskId: task.id, taskVersion: task.version, sourceEventId: inbox.sourceEventId, recipientRoleId: dispatch.recipientRoleId });
      return result("dispatch", dispatch.id, 1);
    }
    if (command.type === "worker.beginSeal" || command.type === "worker.finishSeal" || command.type === "worker.reconcileSeal") return this.applySeal(tx, principal, command, now, event, result);
    const dispatch = await this.dispatch(tx, command.dispatchId, command.projectId);
    const loop = await this.loop(tx, dispatch.loopId, command.projectId);
    if (command.type === "worker.decision") {
      if (dispatch.state !== "accepted" || dispatch.runtimeRunId !== command.runId) return fail("RUN_MISMATCH", "decision requires this accepted dispatch and bound Run");
      const run = await tx.getRunFact(command.runId);
      if (!run || run.projectId !== command.projectId || run.taskId !== dispatch.taskId) return fail("RUN_MISMATCH", "decision Run must belong to this fixed project Task");
      if (!["requested", "dispatching", "running"].includes(run.state)) return fail("RUN_NOT_ACTIVE", "first worker decision must be recorded before the Run becomes terminal or unknown");
      if (await tx.findDecisionByDispatch(dispatch.id) || await tx.getDecision(command.decisionId) || await tx.findSubmissionByDispatch(dispatch.id)) return fail("ALREADY_EXISTS", "dispatch already has a worker intent or decision ID is used");
      const decision: OrchestrationWorkerDecision = { projectId: command.projectId, id: command.decisionId, dispatchId: dispatch.id, runId: command.runId, taskId: dispatch.taskId, kind: command.kind, reason: command.reason, evidenceRefs: command.evidenceRefs, actorId: principal.actorId, createdAtUtc: now };
      await tx.insertDecision(decision); await event(loop.id, "decision", decision.id, "worker.decision", { dispatchId: dispatch.id, runId: command.runId, kind: decision.kind, evidenceRefs: decision.evidenceRefs });
      return result("decision", decision.id, 1);
    }
    if (command.type === "worker.submit") {
      if (dispatch.state !== "accepted" || dispatch.runtimeRunId !== command.runId) return fail("RUN_MISMATCH", "submission requires this accepted dispatch and bound Run");
      if (await tx.findSubmissionByDispatch(dispatch.id) || await tx.findDecisionByDispatch(dispatch.id) || await tx.getSubmission(command.submissionId)) return fail("ALREADY_EXISTS", "dispatch already has a submission or ID is used");
      const run = await tx.getRunFact(command.runId);
      if (!run || run.projectId !== command.projectId || run.taskId !== dispatch.taskId || run.taskRevisionId !== command.taskRevisionId || run.inputHash !== command.runInputHash) return fail("RUN_MISMATCH", "submission fixed input must match bound Run");
      if (!["requested", "dispatching", "running"].includes(run.state)) return fail("RUN_NOT_ACTIVE", "first worker submission must be recorded before the Run becomes terminal or unknown");
      const submission: OrchestrationSubmission = { projectId: command.projectId, id: command.submissionId, version: 1, dispatchId: dispatch.id, runId: run.id, taskId: dispatch.taskId, taskRevisionId: run.taskRevisionId, runInputHash: run.inputHash, deliveryOperationId: command.deliveryOperationId, deliveryIntent: command.deliveryIntent, agentObservation: command.agentObservation, evidenceRefs: command.evidenceRefs, state: "submitted", submittedBy: principal.actorId, sealedBy: null, expectedTaskVersion: null, sealToken: null, deliveryId: null, reason: null, createdAtUtc: now, updatedAtUtc: now };
      await tx.insertSubmission(submission); await event(loop.id, "submission", submission.id, "worker.submitted", { runId: run.id, taskRevisionId: run.taskRevisionId, deliveryOperationId: submission.deliveryOperationId, evidenceRefs: submission.evidenceRefs });
      return result("submission", submission.id, 1);
    }
    if (command.type === "dispatch.claim") {
      this.active(loop);
      if (dispatch.state !== "pending") return fail("DISPATCH_NOT_PENDING", "only pending dispatch can be claimed");
      if (Date.parse(command.leaseUntilUtc) <= Date.parse(now) || Date.parse(command.leaseUntilUtc) > Date.parse(now) + 300_000) return fail("INVALID_LEASE", "lease must expire within five minutes");
      await this.parentRequestReady(tx, dispatch, loop);
      if (await tx.countCapacityUsed(loop.id) >= loop.maxConcurrent) return fail("CAPACITY_FULL", "loop concurrency limit reached, including unknown dispatches");
      await this.freshTaskAndScope(tx, dispatch, loop, principal.actorId);
      const next: OrchestrationDispatch = { ...dispatch, version: dispatch.version + 1, state: "claimed", claimToken: command.claimToken, leaseUntilUtc: command.leaseUntilUtc, updatedAtUtc: now };
      await tx.updateDispatch(next, dispatch.version); await event(loop.id, "dispatch", dispatch.id, "dispatch.claimed", { leaseUntilUtc: next.leaseUntilUtc });
      return result("dispatch", dispatch.id, next.version);
    }
    if (command.type === "dispatch.reclaim") {
      this.active(loop); this.version(dispatch.version, command.expectedVersion);
      if (dispatch.state !== "claimed" || dispatch.claimToken !== command.claimToken || !dispatch.leaseUntilUtc || Date.parse(dispatch.leaseUntilUtc) > Date.parse(now)) return fail("RECLAIM_UNAVAILABLE", "only the same expired pre-start claim can renew its lease");
      if (Date.parse(command.leaseUntilUtc) <= Date.parse(now) || Date.parse(command.leaseUntilUtc) > Date.parse(now) + 300_000) return fail("INVALID_LEASE", "lease must expire within five minutes");
      await this.freshTaskAndScope(tx, dispatch, loop, principal.actorId); await this.parentRequestReady(tx, dispatch, loop);
      const next = { ...dispatch, version: dispatch.version + 1, leaseUntilUtc: command.leaseUntilUtc, updatedAtUtc: now };
      await tx.updateDispatch(next, dispatch.version); await event(loop.id, "dispatch", dispatch.id, "dispatch.reclaimed", { leaseUntilUtc: next.leaseUntilUtc });
      return result("dispatch", dispatch.id, next.version);
    }
    if (command.type === "dispatch.start") {
      this.active(loop); this.claim(dispatch, command.claimToken, now);
      if (dispatch.state !== "claimed") return fail("INVALID_STATE", "dispatch must be claimed before external start");
      await this.freshTaskAndScope(tx, dispatch, loop, principal.actorId);
      await this.parentRequestReady(tx, dispatch, loop);
      const next: OrchestrationDispatch = { ...dispatch, version: dispatch.version + 1, state: "dispatching", updatedAtUtc: now };
      await tx.updateDispatch(next, dispatch.version); await event(loop.id, "dispatch", dispatch.id, "dispatch.started", { taskId: dispatch.taskId, taskVersion: dispatch.taskVersion });
      return result("dispatch", dispatch.id, next.version);
    }
    if (command.type === "dispatch.resolve") {
      this.claim(dispatch, command.claimToken, now, false);
      if (dispatch.state !== "dispatching" && !(dispatch.state === "claimed" && command.result === "unknown")) return fail("INVALID_STATE", "only a claimed or externally started dispatch can resolve");
      if (command.result === "accepted") {
        if (!command.runtimeRunId) return fail("RUN_REQUIRED", "accepted dispatch requires a bound runtime Run");
        const run = await tx.getRunFact(command.runtimeRunId);
        if (!run || run.projectId !== command.projectId || run.taskId !== dispatch.taskId) return fail("RUN_MISMATCH", "runtime Run must belong to the fixed project Task");
      } else if (command.runtimeRunId) return fail("RUN_MISMATCH", "only accepted dispatch may bind a runtime Run");
      const state = command.result === "accepted" ? "accepted" : command.result === "unknown" ? "unknown" : "rejected";
      const next: OrchestrationDispatch = { ...dispatch, version: dispatch.version + 1, state, runtimeRunId: command.runtimeRunId, reason: command.reason, updatedAtUtc: now };
      await tx.updateDispatch(next, dispatch.version); await event(loop.id, "dispatch", dispatch.id, `dispatch.${state}`, { runtimeRunId: next.runtimeRunId, reason: command.reason });
      return result("dispatch", dispatch.id, next.version);
    }
    if (command.type === "dispatch.reconcile") {
      this.version(dispatch.version, command.expectedVersion);
      if (dispatch.state !== "unknown") return fail("INVALID_STATE", "only an unknown dispatch can be reconciled");
      if (command.resolution === "accepted") {
        if (!command.runtimeRunId) return fail("RUN_REQUIRED", "accepted reconciliation requires a bound runtime Run");
        const run = await tx.getRunFact(command.runtimeRunId);
        if (!run || run.projectId !== command.projectId || run.taskId !== dispatch.taskId) return fail("RUN_MISMATCH", "runtime Run must belong to the fixed project Task");
      } else if (command.runtimeRunId) return fail("RUN_MISMATCH", "rejected reconciliation cannot bind a runtime Run");
      const next: OrchestrationDispatch = { ...dispatch, version: dispatch.version + 1, state: command.resolution, runtimeRunId: command.runtimeRunId, evidenceRef: command.evidenceRef, reason: command.reason, updatedAtUtc: now };
      await tx.updateDispatch(next, dispatch.version); await event(loop.id, "dispatch", dispatch.id, "dispatch.reconciled", { resolution: next.state, runtimeRunId: next.runtimeRunId, evidenceRef: next.evidenceRef, reason: command.reason });
      return result("dispatch", dispatch.id, next.version);
    }
    if (command.type === "dispatch.gap") {
      this.version(dispatch.version, command.expectedVersion);
      if (dispatch.state !== "accepted" || !dispatch.runtimeRunId) return fail("INVALID_STATE", "only a terminal accepted Run can carry a worker intent gap");
      const run = await tx.getRunFact(dispatch.runtimeRunId);
      if (!run || run.projectId !== command.projectId || run.taskId !== dispatch.taskId || !["completed", "failed", "interrupted"].includes(run.state)) return fail("RUN_NOT_TERMINAL", "worker intent gap requires terminal bound Run");
      if (dispatch.reason.startsWith("Worker intent gap:")) return fail("GAP_RECORDED", "worker intent gap is already recorded for this dispatch");
      const next = { ...dispatch, version: dispatch.version + 1, reason: command.reason, evidenceRef: command.evidenceRef, updatedAtUtc: now };
      await tx.updateDispatch(next, dispatch.version); await event(loop.id, "dispatch", dispatch.id, "dispatch.gap", { reason: command.reason, evidenceRef: command.evidenceRef, runId: run.id, taskId: dispatch.taskId, taskVersion: dispatch.taskVersion, dispatchVersion: next.version });
      return result("dispatch", dispatch.id, next.version);
    }
    if (dispatch.state !== "accepted") return fail("INVALID_STATE", "worker outcome requires an accepted dispatch");
    const terminalRun = dispatch.runtimeRunId ? await tx.getRunFact(dispatch.runtimeRunId) : null;
    if (!terminalRun || terminalRun.projectId !== command.projectId || terminalRun.taskId !== dispatch.taskId || !["completed", "failed", "interrupted"].includes(terminalRun.state)) return fail("RUN_NOT_TERMINAL", "worker outcome requires the bound terminal Run");
    if (command.outcome === "delivered") {
      if (!command.deliveryId) return fail("DELIVERY_REQUIRED", "delivered outcome requires a recorded Delivery");
      const delivery = await tx.getDeliveryFact(command.deliveryId);
      const submission = await tx.findSubmissionByDispatch(dispatch.id);
      if (!submission || submission.state !== "sealed" || submission.deliveryId !== command.deliveryId) return fail("SUBMISSION_UNSEALED", "delivered outcome requires the fixed sealed worker submission");
      if (!delivery || delivery.projectId !== command.projectId || delivery.taskId !== dispatch.taskId || delivery.runId !== dispatch.runtimeRunId) return fail("DELIVERY_MISMATCH", "Delivery must be recorded for this Task and Run");
    } else {
      if (command.deliveryId || !command.decisionId) return fail("DECISION_REQUIRED", "non-delivered outcome requires a fixed worker decision and no Delivery");
      const decision = await tx.getDecision(command.decisionId);
      if (!decision || decision.projectId !== command.projectId || decision.dispatchId !== dispatch.id || decision.runId !== dispatch.runtimeRunId || decision.taskId !== dispatch.taskId || !(await tx.canActAsRole(decision.actorId, dispatch.recipientRoleId)) || (decision.kind === "stop" ? command.outcome !== "no_action" : decision.kind !== command.outcome) || decision.reason !== command.reason || (command.evidenceRef !== null && !decision.evidenceRefs.includes(command.evidenceRef))) return fail("DECISION_MISMATCH", "terminal outcome must match the worker's durable preterminal decision");
    }
    if (command.outcome === "delivered" && command.decisionId) return fail("DECISION_MISMATCH", "delivered outcome must be supported by sealed submission, not decision intent");
    const next: OrchestrationDispatch = { ...dispatch, version: dispatch.version + 1, state: "completed", outcome: command.outcome, deliveryId: command.deliveryId, evidenceRef: command.evidenceRef, reason: command.reason, updatedAtUtc: now };
    await tx.updateDispatch(next, dispatch.version);
    if (command.decisionId) { const decision = await tx.getDecision(command.decisionId); if (decision?.kind === "stop" && loop.state !== "stopped") { await tx.updateLoop({ ...loop, state: "stopped", version: loop.version + 1, updatedAtUtc: now }, loop.version); await event(loop.id, "loop", loop.id, "loop.stopped", { decisionId: decision.id, reason: decision.reason }); } }
    await event(loop.id, "dispatch", dispatch.id, "worker.outcome", { outcome: next.outcome, deliveryId: next.deliveryId, decisionId: command.decisionId, evidenceRef: next.evidenceRef, reason: command.reason });
    return result("dispatch", dispatch.id, next.version);
  }

  private async applySeal(
    tx: OrchestrationTransaction, principal: Principal,
    command: Extract<OrchestrationCommand, { type: "worker.beginSeal" | "worker.finishSeal" | "worker.reconcileSeal" }>, now: string,
    event: (loopId: string, entityType: OrchestrationEvent["entityType"], entityId: string, kind: string, detail?: Record<string, unknown>, eventId?: string) => Promise<void>,
    result: (entityType: OrchestrationResult["entityType"], entityId: string, version: number) => OrchestrationResult,
  ): Promise<OrchestrationResult> {
    const submission = await tx.getSubmission(command.submissionId);
    if (!submission || submission.projectId !== command.projectId) return fail("NOT_FOUND", "worker submission not found");
    const dispatch = await this.dispatch(tx, submission.dispatchId, command.projectId);
    const loop = await this.loop(tx, dispatch.loopId, command.projectId);
    if (command.type === "worker.beginSeal") {
      this.version(submission.version, command.expectedVersion);
      if (submission.state !== "submitted" || dispatch.state !== "accepted") return fail("INVALID_STATE", "only submitted intent from an accepted dispatch can begin seal");
      const run = await tx.getRunFact(submission.runId);
      const task = await tx.getTaskFact(submission.taskId);
      if (!run || run.projectId !== command.projectId || run.taskId !== submission.taskId || !["completed", "failed", "interrupted"].includes(run.state)) return fail("RUN_NOT_TERMINAL", "source Run must be confirmed terminal before delivery seal");
      if (!task || task.projectId !== command.projectId || task.version !== command.expectedTaskVersion || task.state !== "in_progress") return fail("TASK_CHANGED", "Task current version and state must be observed for delivery seal");
      const next: OrchestrationSubmission = { ...submission, version: submission.version + 1, state: "sealing", sealedBy: principal.actorId, expectedTaskVersion: task.version, sealToken: command.sealToken, updatedAtUtc: now };
      await tx.updateSubmission(next, submission.version); await event(loop.id, "submission", submission.id, "worker.sealing", { deliveryOperationId: submission.deliveryOperationId, expectedTaskVersion: task.version, sealerActorId: principal.actorId });
      return result("submission", submission.id, next.version);
    }
    this.version(submission.version, command.type === "worker.finishSeal" ? submission.version : command.expectedVersion);
    if (command.type === "worker.finishSeal") {
      if (submission.state !== "sealing" || submission.sealToken !== command.sealToken || submission.sealedBy !== principal.actorId) return fail("INVALID_SEAL", "only the current sealer can finish this intent");
      if (command.result === "unknown") {
        if (command.deliveryId) return fail("DELIVERY_MISMATCH", "unknown seal cannot claim a Delivery");
        const next: OrchestrationSubmission = { ...submission, version: submission.version + 1, state: "unknown", reason: command.reason, updatedAtUtc: now };
        await tx.updateSubmission(next, submission.version); await event(loop.id, "submission", submission.id, "worker.sealUnknown", { deliveryOperationId: submission.deliveryOperationId, reason: command.reason });
        return result("submission", submission.id, next.version);
      }
      return this.confirmSeal(tx, submission, loop.id, command.result, command.deliveryId, command.reason, now, event, result);
    }
    if (submission.state !== "unknown") return fail("INVALID_STATE", "only unknown seal can be reconciled");
    return this.confirmSeal(tx, submission, loop.id, command.resolution, command.deliveryId, command.reason, now, event, result, command.evidenceRef);
  }

  private async confirmSeal(
    tx: OrchestrationTransaction, submission: OrchestrationSubmission, loopId: string,
    state: "sealed" | "rejected", deliveryId: string | null, reason: string, now: string,
    event: (loopId: string, entityType: OrchestrationEvent["entityType"], entityId: string, kind: string, detail?: Record<string, unknown>, eventId?: string) => Promise<void>,
    result: (entityType: OrchestrationResult["entityType"], entityId: string, version: number) => OrchestrationResult,
    evidenceRef?: string,
  ): Promise<OrchestrationResult> {
    if (!submission.expectedTaskVersion) return fail("INVALID_SEAL", "seal intent lacks a fixed Task version");
    const workflowCommand = { type: "delivery.record", projectId: submission.projectId, operationId: submission.deliveryOperationId, taskId: submission.taskId, runId: submission.runId, expectedVersion: submission.expectedTaskVersion, ...submission.deliveryIntent };
    const expectedHash = this.deps.hash(canonical({ actorId: submission.submittedBy, command: workflowCommand }));
    const op = await tx.getWorkflowOperationFact(submission.deliveryOperationId);
    if (!op || op.projectId !== submission.projectId || op.actorId !== submission.submittedBy || op.commandType !== "delivery.record" || op.commandHash !== expectedHash) return fail("WORKFLOW_OPERATION_MISMATCH", "matching authoritative delivery operation is required");
    if (state === "sealed") {
      if (op.status !== "applied" || !deliveryId || op.resultRefId !== deliveryId) return fail("DELIVERY_MISMATCH", "applied operation must identify the sealed Delivery");
      const delivery = await tx.getDeliveryFact(deliveryId);
      const intent = submission.deliveryIntent;
      if (!delivery || delivery.projectId !== submission.projectId || delivery.taskId !== submission.taskId || delivery.runId !== submission.runId || delivery.actorId !== submission.submittedBy || delivery.artifactRef !== intent.artifactRef || delivery.artifactRevision !== intent.artifactRevision || delivery.contentHash !== intent.contentHash || delivery.technicalResult !== intent.technicalResult || delivery.technicalEvidence !== intent.technicalEvidence) return fail("DELIVERY_MISMATCH", "actual Delivery does not match submitted intent");
    } else if (op.status !== "rejected" || deliveryId) return fail("WORKFLOW_OPERATION_MISMATCH", "rejected seal requires a rejected operation and no Delivery");
    const next: OrchestrationSubmission = { ...submission, version: submission.version + 1, state, deliveryId, reason, updatedAtUtc: now };
    await tx.updateSubmission(next, submission.version);
    await event(loopId, "submission", submission.id, "worker.sealResult", { state, deliveryOperationId: submission.deliveryOperationId, deliveryId, submittedBy: submission.submittedBy, sealedBy: submission.sealedBy, evidenceRef: evidenceRef ?? null, reason });
    return result("submission", submission.id, next.version);
  }

  private async parentRequestReady(tx: OrchestrationTransaction, dispatch: OrchestrationDispatch, loop: OrchestrationLoop) {
    if (dispatch.recipientRoleId === loop.cognitiveRoleId) return;
    const parent = dispatch.parentDispatchId ? await tx.getDispatch(dispatch.parentDispatchId) : null;
    const inbox = await tx.getInbox(dispatch.inboxId);
    if (!parent || parent.projectId !== dispatch.projectId || parent.loopId !== loop.id ||
      parent.sourceEventId !== dispatch.sourceEventId || parent.recipientRoleId !== loop.cognitiveRoleId ||
      parent.purpose !== "cognition" || !parent.runtimeRunId || !["accepted", "completed"].includes(parent.state) ||
      !loop.allowedBusinessRoleIds.includes(dispatch.recipientRoleId) ||
      !inbox || inbox.projectId !== dispatch.projectId || inbox.loopId !== loop.id ||
      inbox.sourceEventId !== dispatch.sourceEventId || inbox.recipientRoleId !== loop.cognitiveRoleId ||
      inbox.purpose !== "next_action" || inbox.state !== "disposed" || inbox.disposition !== "dispatch" ||
      inbox.dispatchId !== dispatch.id) return fail("PARENT_NOT_READY", "formal same-source cognition request required");
    const run = await tx.getRunFact(parent.runtimeRunId);
    if (!run || run.projectId !== dispatch.projectId || run.taskId !== parent.taskId ||
      !["completed", "failed", "interrupted"].includes(run.state))
      return fail("PARENT_NOT_READY", "bound cognition Run must have a known terminal state");
    const submission = await tx.findSubmissionByDispatch(parent.id);
    if (submission && ["submitted", "sealing", "unknown"].includes(submission.state))
      return fail("PARENT_NOT_READY", "cognition seal must have a known result before business dispatch");
  }

  private async freshTaskAndScope(tx: OrchestrationTransaction, dispatch: OrchestrationDispatch, loop: OrchestrationLoop, actorId: string) {
    const task = await tx.getTaskFact(dispatch.taskId);
    const auth = await tx.getAuthorizationFact(dispatch.authorizationScopeId);
    if (!task || task.projectId !== dispatch.projectId || task.version !== dispatch.taskVersion || (task.state !== "todo" && task.state !== "in_progress") || task.ownerRoleId !== dispatch.recipientRoleId || task.goalId !== loop.goalId || !task.stageId || (loop.stageId !== null && task.stageId !== loop.stageId)) return fail("TASK_CHANGED", "Task changed before dispatch; explicit new request required");
    if (!auth || auth.projectId !== dispatch.projectId || !auth.active || auth.roleId !== dispatch.recipientRoleId || auth.actorId !== actorId) return fail("SCOPE_NOT_AUTHORIZED", "worker scope changed before dispatch");
    const stage = await tx.getStageFact(task.stageId);
    if (!stage || stage.projectId !== dispatch.projectId || stage.goalId !== loop.goalId || stage.state !== "active") return fail("STAGE_NOT_ACTIVE", "Task stage changed before dispatch");
  }
  private claim(dispatch: OrchestrationDispatch, token: string, now: string, requireFreshLease = true) {
    if (dispatch.claimToken !== token) return fail("CLAIM_MISMATCH", "dispatch claim token changed");
    if (requireFreshLease && (!dispatch.leaseUntilUtc || Date.parse(dispatch.leaseUntilUtc) <= Date.parse(now))) return fail("CLAIM_EXPIRED", "dispatch claim expired before start");
  }
  private async fixedIssue(tx: OrchestrationTransaction, loop: OrchestrationLoop, source: OrchestrationSourceFact, projectId: string) {
    if (!source.operationId || !source.sourceActorId || !source.issueRevisionId || !source.issueContentHash ||
      source.subjectVersion !== 1 || source.sourceLoopId !== null || source.originDispatchId !== null)
      return fail("SOURCE_UNAVAILABLE", "Issue source lacks original creation operation or fixed revision");
    const operation = await tx.getWorkflowOperationFact(source.operationId);
    const issue = await tx.getIssueFact(source.subjectId, source.issueRevisionId);
    if (!operation || operation.projectId !== projectId || operation.commandType !== "document.create" ||
      operation.status !== "applied" || operation.actorId !== source.sourceActorId ||
      operation.resultRefId !== source.issueRevisionId || operation.resultVersion !== 1 ||
      !issue || issue.projectId !== projectId || issue.documentId !== source.subjectId ||
      issue.revisionId !== source.issueRevisionId || issue.contentHash !== source.issueContentHash ||
      issue.author !== source.sourceActorId || !issue.originTaskId || !issue.originTaskRevisionId ||
      await tx.wasActorRole(issue.author, loop.id, loop.cognitiveRoleId))
      return fail("SOURCE_UNAVAILABLE", "Issue must be an applied, fixed, independently authored creation in this project");
    if (issue.originRunId) {
      const run = await tx.getRunFact(issue.originRunId);
      if (!run || run.projectId !== projectId || run.taskId !== issue.originTaskId ||
        run.taskRevisionId !== issue.originTaskRevisionId || run.state === "unknown")
        return fail("SOURCE_UNAVAILABLE", "Issue Run must match its fixed Task input and have a known state");
    }
    const fixed = await tx.getTaskScopeAtVersion(issue.originTaskId, issue.originTaskVersion);
    if (!fixed || fixed.projectId !== projectId || fixed.taskVersion !== issue.originTaskVersion ||
      !fixed.stageId || fixed.goalId !== loop.goalId || (loop.stageId !== null && fixed.stageId !== loop.stageId))
      return fail("SOURCE_UNAVAILABLE", "Issue origin Task revision is outside this loop's fixed Goal and Stage");
  }
  private active(loop: OrchestrationLoop) { if (loop.state !== "active") return fail(loop.state === "stopped" ? "LOOP_STOPPED" : "LOOP_PAUSED", "loop is not active"); }
  private version(actual: number, expected: number) { if (actual !== expected) return fail("VERSION_CONFLICT", "version changed", actual); }
  private async loop(tx: OrchestrationTransaction, id: string, projectId: string) { const value = await tx.getLoop(id); if (!value || value.projectId !== projectId) return fail("NOT_FOUND", "loop not found"); return value; }
  private async inbox(tx: OrchestrationTransaction, id: string, projectId: string) { const value = await tx.getInbox(id); if (!value || value.projectId !== projectId) return fail("NOT_FOUND", "inbox item not found"); return value; }
  private async dispatch(tx: OrchestrationTransaction, id: string, projectId: string) { const value = await tx.getDispatch(id); if (!value || value.projectId !== projectId) return fail("NOT_FOUND", "dispatch not found"); return value; }
}
