import type {
  AppliedResult,
  BasisSet,
  Command,
  ConsumerObservation,
  Delivery,
  Goal,
  Principal,
  Stage,
  StageReview,
  Task,
  TaskClosure,
  TaskProposal,
  TaskRevision,
} from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { ArtifactReferenceError, parseArtifactReference } from "@evoloop/contracts/artifact-reference";
import type { Transaction } from "@evoloop/contracts/ports";
import { currentRetentions } from "./runtime/basis.js";
import { canonicalTaskInputJson, taskInputSignature } from "./task-input.js";

type WorkflowCommand = Extract<
  Command,
  {
    type:
      | "goal.create"
      | "goal.revise"
      | "stage.propose"
      | "stage.accept"
      | "stage.review"
      | "stage.review.correct"
      | "task.cancel"
      | "task.reopen"
      | "delivery.record"
      | "observation.record"
      | "task.close";
  }
>;
export type WorkflowEffect = {
  kind: string;
  entityId: string;
  version: number;
};
export type WorkflowOutcome = {
  result: AppliedResult;
  effects: WorkflowEffect[];
};
export interface WorkflowContext {
  tx: Transaction;
  command: WorkflowCommand;
  principal: Principal;
  now: string;
  nextId(): string;
}
const found = <T>(value: T | null, kind: string): T => {
  if (value === null) throw new DomainError("NOT_FOUND", `${kind} not found`);
  return value;
};
const version = (actual: number, expected: number): void => {
  if (actual !== expected)
    throw new DomainError(
      "VERSION_CONFLICT",
      "observed version changed",
      actual,
    );
};
async function requireCurrentPassedRun(tx: Transaction, delivery: Delivery): Promise<void> {
  if (!delivery.runId) return;
  const run = await tx.getRuntimeRun(delivery.runId);
  if (!run || run.projectId !== delivery.projectId || run.taskId !== delivery.taskId ||
      run.state !== "completed" || !delivery.sourceRunVersion || run.version !== delivery.sourceRunVersion)
    throw new DomainError("DELIVERY_RUN_CHANGED", "current source Run no longer supports this passed Delivery");
}
const result = (
  operationId: string,
  entityId: string,
  revisionId?: string,
  objectVersion?: number,
): WorkflowOutcome => ({
  result: {
    status: "applied",
    operationId,
    entityId,
    ...(revisionId ? { revisionId } : {}),
    ...(objectVersion ? { version: objectVersion } : {}),
  },
  effects: [{ kind: "workflow", entityId, version: objectVersion ?? 1 }],
});

async function newTaskRevision(
  tx: Transaction,
  task: Task,
  actorId: string,
  now: string,
  nextId: () => string,
  state: Task["state"],
  reason: string,
  changes: Partial<Pick<Task, "title" | "content" | "acceptance" | "owner" | "kind">> = {},
  retainBasis = true,
): Promise<TaskRevision> {
  const previous = found(
    await tx.getTaskRevision(task.id, task.currentRevisionId),
    "task revision",
  );
  const id = nextId();
  const basisSetId = retainBasis && previous.basisSetId ? nextId() : null;
  const revision: TaskRevision = {
    ...previous,
    ...changes,
    id,
    version: task.version + 1,
    state,
    basisSetId,
    actorId,
    reason,
    createdAt: now,
  };
  await tx.insertTaskRevision(revision);
  if (previous.basisSetId && basisSetId) {
    const old = found(
      await tx.getBasisSet(task.id, previous.id, previous.basisSetId),
      "basis set",
    );
    const retentions = await currentRetentions(tx, old);
    const copy: BasisSet = {
      projectId: old.projectId, taskId: old.taskId, taskRevisionId: id, id: basisSetId,
      sealed: true, members: old.members.map((x) => ({ ...x })),
      ...(retentions ? { retentions } : {}),
    };
    await tx.insertSealedBasisSet(copy);
  }
  await tx.updateTask(
    {
      ...task,
      ...changes,
      version: revision.version,
      currentRevisionId: id,
      state,
    },
    task.version,
  );
  return revision;
}

export async function applyWorkflow({
  tx,
  command: c,
  principal,
  now,
  nextId,
}: WorkflowContext): Promise<WorkflowOutcome> {
  const actorId = principal.actorId;
  switch (c.type) {
    case "goal.create": {
      if (await tx.getGoal(c.goalId))
        throw new DomainError("ALREADY_EXISTS", "goal exists");
      const goal: Goal = {
        projectId: c.projectId,
        id: c.goalId,
        version: 1,
        outcome: c.outcome,
        constraints: c.constraints,
        consumer: c.consumer,
        authority: c.authority,
        scope: c.scope,
        owner: c.owner,
        createdAt: now,
        actorId,
      };
      await tx.insertGoal(goal, "Initial goal");
      return result(c.operationId, goal.id, undefined, 1);
    }
    case "goal.revise": {
      const old = found(await tx.getGoal(c.goalId), "goal");
      version(old.version, c.expectedVersion);
      const goal: Goal = {
        ...old,
        version: old.version + 1,
        outcome: c.outcome,
        constraints: c.constraints,
        consumer: c.consumer,
        authority: c.authority,
        scope: c.scope,
        owner: c.owner,
        actorId,
        createdAt: now,
      };
      await tx.updateGoal(goal, old.version, c.reason);
      return result(c.operationId, goal.id, undefined, goal.version);
    }
    case "stage.propose": {
      found(await tx.getGoal(c.goalId), "goal");
      if (await tx.getStage(c.stageId))
        throw new DomainError("ALREADY_EXISTS", "stage exists");
      const stage: Stage = {
        projectId: c.projectId,
        id: c.stageId,
        goalId: c.goalId,
        version: 1,
        deliverable: c.deliverable,
        learningQuestion: c.learningQuestion,
        state: "proposed",
        createdAt: now,
        actorId,
      };
      const revision = {
        projectId: c.projectId,
        stageId: stage.id,
        id: nextId(),
        version: 1,
        state: stage.state,
        deliverable: stage.deliverable,
        learningQuestion: stage.learningQuestion,
        actorId,
        reason: c.reason,
        createdAt: now,
      };
      await tx.insertStage(stage, revision);
      return result(c.operationId, stage.id, revision.id, 1);
    }
    case "stage.accept": {
      const stage = found(await tx.getStage(c.stageId), "stage");
      version(stage.version, c.expectedVersion);
      if (stage.state !== "proposed")
        throw new DomainError("INVALID_STATE", "stage is not proposed");
      const next = {
        ...stage,
        version: stage.version + 1,
        state: "active" as const,
        actorId,
        createdAt: now,
      };
      const revision = {
        projectId: c.projectId,
        stageId: stage.id,
        id: nextId(),
        version: next.version,
        state: next.state,
        deliverable: next.deliverable,
        learningQuestion: next.learningQuestion,
        actorId,
        reason: c.reason,
        createdAt: now,
      };
      await tx.updateStage(next, revision, stage.version);
      return result(c.operationId, stage.id, revision.id, next.version);
    }
    case "stage.review": {
      const stage = found(await tx.getStage(c.stageId), "stage");
      version(stage.version, c.expectedVersion);
      if (stage.state !== "active")
        throw new DomainError("INVALID_STATE", "stage is not active");
      const review: StageReview = {
        projectId: c.projectId,
        id: nextId(),
        stageId: stage.id,
        stageVersion: stage.version,
        supersedesReviewId: null,
        adopted: c.adopted,
        rejected: c.rejected,
        gap: c.gap,
        nextChoice: c.nextChoice,
        evidence: c.evidence,
        reason: c.reason,
        actorId,
        createdAt: now,
      };
      await tx.insertStageReview(review);
      const next = {
        ...stage,
        version: stage.version + 1,
        state: "reviewed" as const,
        actorId,
        createdAt: now,
      };
      const revision = {
        projectId: c.projectId,
        stageId: stage.id,
        id: nextId(),
        version: next.version,
        state: next.state,
        deliverable: next.deliverable,
        learningQuestion: next.learningQuestion,
        actorId,
        reason: c.reason,
        createdAt: now,
      };
      await tx.updateStage(next, revision, stage.version);
      return result(c.operationId, stage.id, review.id, next.version);
    }
    case "stage.review.correct": {
      const stage = found(await tx.getStage(c.stageId), "stage");
      version(stage.version, c.expectedVersion);
      if (stage.state !== "reviewed")
        throw new DomainError("INVALID_STATE", "only a reviewed stage can be corrected");
      const reviews = await tx.listStageReviews(stage.id);
      const latest = reviews.reduce<StageReview | null>((best, item) =>
        best === null || item.stageVersion > best.stageVersion ? item : best, null);
      if (!latest || latest.stageVersion !== stage.version - 1 || latest.id !== c.supersedesReviewId)
        throw new DomainError("REVIEW_TARGET_CHANGED", "correction must supersede the latest review of this stage");
      const review: StageReview = {
        projectId: c.projectId,
        id: nextId(),
        stageId: stage.id,
        stageVersion: stage.version,
        supersedesReviewId: latest.id,
        adopted: c.adopted,
        rejected: c.rejected,
        gap: c.gap,
        nextChoice: c.nextChoice,
        evidence: c.evidence,
        reason: c.reason,
        actorId,
        createdAt: now,
      };
      await tx.insertStageReview(review);
      const next: Stage = { ...stage, version: stage.version + 1, actorId, createdAt: now };
      const revision = {
        projectId: c.projectId,
        stageId: stage.id,
        id: nextId(),
        version: next.version,
        state: "reviewed" as const,
        deliverable: next.deliverable,
        learningQuestion: next.learningQuestion,
        actorId,
        reason: c.reason,
        createdAt: now,
      };
      await tx.updateStage(next, revision, stage.version);
      return result(c.operationId, stage.id, review.id, next.version);
    }
    case "task.cancel":
    case "task.reopen": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      if (c.type === "task.cancel" && (task.state === "done" || task.state === "cancelled"))
        throw new DomainError("INVALID_STATE", "task is already closed");
      if (c.type === "task.reopen" && task.state === "todo")
        throw new DomainError("INVALID_STATE", "task is already todo");
      if ((await tx.listRuntimeRuns(task.id)).some(run => ["requested", "dispatching", "running", "unknown"].includes(run.state)))
        throw new DomainError("TASK_BUSY", "resolve the current or uncertain run before changing lifecycle");
      const next = c.type === "task.cancel" ? "cancelled" : "todo";
      const revision = await newTaskRevision(tx, task, actorId, now, nextId, next, c.reason);
      for (const impact of (await tx.listImpacts(task.id)).filter(item => item.state === "pending"))
        await tx.supersedeImpacts(task.id, impact.documentId);
      return result(c.operationId, task.id, revision.id, revision.version);
    }
    case "delivery.record": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      if (task.state !== "in_progress") throw new DomainError("INVALID_STATE", "task must be in progress to deliver");
      if ((await tx.listRuntimeRuns(task.id)).some(run => ["requested", "dispatching", "running", "unknown"].includes(run.state)))
        throw new DomainError("TASK_BUSY", "resolve the current or uncertain run before recording delivery");
      const proposal = await tx.getTaskProposal(task.id);
      let submittedByActorId: string | null = actorId;
      let sourceRunVersion: number | null = null;
      if (c.runId) {
        const run = found(await tx.getRuntimeRun(c.runId), "source Run");
        if (run.projectId !== c.projectId || run.taskId !== task.id)
          throw new DomainError("DELIVERY_RUN_MISMATCH", "Source Run does not belong to this project's Task");
        if (!["completed", "failed", "interrupted"].includes(run.state))
          throw new DomainError("DELIVERY_RUN_UNSETTLED", "Source Run must have a confirmed terminal state");
        if (c.technicalResult === "passed" && run.state !== "completed")
          throw new DomainError("DELIVERY_RUN_FAILED", "a failed or interrupted source Run cannot support a passed Delivery");
        const executedInput = await taskInputSignature(tx, task, run.taskRevisionId);
        const currentInput = await taskInputSignature(tx, task);
        if (canonicalTaskInputJson(executedInput) !== canonicalTaskInputJson(currentInput))
          throw new DomainError("DELIVERY_INPUT_CHANGED", "Task business input changed since the source Run");
        submittedByActorId = await tx.getSignedRunSubmitter?.(run.id, task.id, run.taskRevisionId,
          actorId, c.operationId, c.expectedVersion, {artifactRef:c.artifactRef,artifactRevision:c.artifactRevision,
            contentHash:c.contentHash,technicalResult:c.technicalResult,
            technicalEvidence:c.technicalEvidence,reason:c.reason}) ?? null;
        if (proposal?.acceptanceMode && !submittedByActorId)
          throw new DomainError("DELIVERY_ORIGIN_UNVERIFIED", "new acceptance requires the signed Run submitter");
        sourceRunVersion = run.version;
      }
      // Keep signed bytes for exact sealing, including older file references.
      // Internal project routes remain verifiable even if signed before this validator.
      const signedIntent = !!c.runId && !!submittedByActorId;
      const internalRef = /^document:/i.test(c.artifactRef) || /#\/p\//i.test(c.artifactRef);
      let artifact: ReturnType<typeof parseArtifactReference> | null = null;
      if (!signedIntent || internalRef) {
        try { artifact = parseArtifactReference(c.artifactRef,c.artifactRevision,c.projectId,false); }
        catch (error) {
          if (error instanceof ArtifactReferenceError) throw new DomainError(error.code,error.message);
          throw error;
        }
        if (artifact.kind === 'document') {
          const original = await tx.getDocumentRevision(artifact.documentId,artifact.revisionId);
          if (!original || original.projectId !== c.projectId)
            throw new DomainError('ARTIFACT_DOCUMENT_NOT_FOUND','Read the exact Document revision in this project before Delivery');
          if (original.contentHash.toLowerCase() !== c.contentHash.toLowerCase())
            throw new DomainError('ARTIFACT_HASH_MISMATCH','contentHash must equal the saved Document revision SHA-256');
        }
      }
      const revision = await newTaskRevision(tx, task, actorId, now, nextId, "in_progress", c.reason);
      const delivery: Delivery = { projectId: c.projectId, id: nextId(), taskId: task.id,
        taskRevisionId: revision.id, runId: c.runId ?? null, sourceRunVersion,
        submittedByActorId,
        artifactRef: signedIntent ? c.artifactRef : artifact?.artifactRef ?? c.artifactRef,
        artifactRevision: c.artifactRevision,
        contentHash: c.contentHash, technicalResult: c.technicalResult,
        technicalEvidence: c.technicalEvidence, reason: c.reason, actorId, createdAt: now };
      await tx.insertDelivery(delivery);
      return result(c.operationId, task.id, delivery.id, revision.version);
    }
    case "observation.record": {
      const delivery = found(await tx.getDelivery(c.deliveryId), "delivery");
      if (delivery.taskId !== c.taskId) throw new DomainError("WRONG_DELIVERY", "delivery belongs to another task");
      const task = found(await tx.getTask(c.taskId), "task");
      if (task.state !== "in_progress") throw new DomainError("INVALID_STATE", "consumer observation requires in-progress task");
      const proposal = await tx.getTaskProposal(task.id);
      if (proposal?.acceptanceMode && c.result === "used" && delivery.technicalResult === "passed")
        await requireCurrentPassedRun(tx, delivery);
      if (proposal?.acceptanceMode && proposal.consumer && c.observer !== proposal.consumer)
        throw new DomainError("CONSUMER_MISMATCH", "observation must come from the declared consumer actor");
      if (proposal?.acceptanceMode === "independent_agent") {
        if (principal.identityKind === "human" || c.observerKind !== "agent" || c.observer !== actorId)
          throw new DomainError("INDEPENDENT_OBSERVER_REQUIRED", "independent acceptance requires the actual agent actor");
        if (c.result === "used" && (!delivery.submittedByActorId || delivery.submittedByActorId === actorId))
          throw new DomainError("SELF_ACCEPTANCE", "the submission actor cannot accept their own delivery");
      }
      if (proposal?.acceptanceMode === "human_required" &&
        (principal.identityKind !== "human" || c.observerKind !== "human" || c.observer !== actorId || c.observer !== proposal.consumer))
        throw new DomainError("TRUSTED_HUMAN_REQUIRED", "human-required acceptance needs the declared human's credential");
      if (c.observerKind === "agent" && c.observer !== actorId)
        throw new DomainError("OBSERVER_MISMATCH", "agent use must be reported by that agent");
      if (c.observerKind === "human" && !proposal?.acceptanceMode && !principal.permissions.includes("review"))
        throw new DomainError("ATTESTATION_REQUIRED", "external human use requires reviewer attestation");
      const observation: ConsumerObservation = { projectId: c.projectId, id: nextId(), taskId: task.id,
        deliveryId: delivery.id, observer: c.observer, observerKind: c.observerKind, result: c.result,
        evidence: c.evidence, reason: c.reason, actorId, createdAt: now };
      await tx.insertObservation(observation);
      return result(c.operationId, task.id, observation.id, task.version);
    }
    case "task.close": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      if (task.state !== "in_progress") throw new DomainError("INVALID_STATE", "task must be in progress");
      if ((await tx.listRuntimeRuns(task.id)).some(run => ["requested", "dispatching", "running", "unknown"].includes(run.state)))
        throw new DomainError("TASK_BUSY", "resolve the current or uncertain run before closing");
      if (c.acceptanceResult !== "met") throw new DomainError("ACCEPTANCE_UNMET", "task acceptance must be met before closure");
      if (!!c.deliveryId === !!c.decisionId) throw new DomainError("CLOSURE_EVIDENCE_REQUIRED", "choose exactly one Delivery or settled cognition Decision");
      const proposal = await tx.getTaskProposal(task.id);
      let closureEvidence: Pick<TaskClosure,"deliveryId"|"decisionId"|"sourceInboxId"|"sourceEventId"|"sourceTaskId"|"waitingInboxId"|"handoffDispatchId"|"handoffTaskId">;
      if (c.deliveryId) {
        if (c.waitingInboxId || c.handoffDispatchId) throw new DomainError("CLOSURE_EVIDENCE_REQUIRED", "Delivery closure cannot cite a cognition handoff");
        const deliveries = await tx.listDeliveries(task.id);
        const latest = deliveries.at(-1);
        if (!latest || latest.id !== c.deliveryId || latest.taskRevisionId !== task.currentRevisionId)
          throw new DomainError("STALE_DELIVERY", "close requires latest delivery for the current Task revision");
        if (latest.technicalResult !== "passed") throw new DomainError("TECHNICAL_CHECK_FAILED", "latest delivery has not passed technical checks");
        if (proposal?.acceptanceMode) await requireCurrentPassedRun(tx, latest);
        const queueAcceptance = await tx.getClaimedQueueAcceptanceForTask?.(task.id) ?? null;
        if (queueAcceptance && latest.runId !== queueAcceptance.runId)
          throw new DomainError("QUEUE_RUN_MISMATCH", "close requires the current claimed Queue attempt's Delivery");
        if (proposal?.useRequired || proposal?.acceptanceMode) {
          const observations = (await tx.listObservations(task.id)).filter(x => x.deliveryId === latest.id &&
            (!proposal.consumer || x.observer === proposal.consumer) &&
            (!queueAcceptance || x.observer === queueAcceptance.consumerId));
          const observed = observations.at(-1);
          if (observed?.result !== "used") throw new DomainError("USE_NOT_OBSERVED", "current delivery lacks declared-consumer use evidence");
          if (proposal?.acceptanceMode === "independent_agent" &&
            (!latest.submittedByActorId || observed.observerKind !== "agent" || observed.actorId !== observed.observer ||
              observed.actorId === latest.submittedByActorId))
            throw new DomainError("SELF_ACCEPTANCE", "current Delivery lacks independent agent use");
          if (proposal?.acceptanceMode === "human_required" &&
            (observed.observerKind !== "human" || observed.actorId !== proposal.consumer || observed.observer !== proposal.consumer))
            throw new DomainError("TRUSTED_HUMAN_REQUIRED", "current Delivery lacks the declared human's use");
        }
        closureEvidence = {deliveryId:latest.id,decisionId:null,sourceInboxId:null,sourceEventId:null,sourceTaskId:null,waitingInboxId:null,handoffDispatchId:null,handoffTaskId:null};
      } else {
        if (proposal?.useRequired || proposal?.acceptanceMode) throw new DomainError("USE_NOT_OBSERVED", "a cognition decision cannot replace required consumer use");
        const fact = await tx.getCognitiveClosureFact?.(c.decisionId!);
        if (!fact || fact.projectId !== c.projectId || fact.taskId !== task.id || fact.taskRevisionId !== task.currentRevisionId ||
          fact.purpose !== "cognition" || fact.recipientRoleId !== fact.cognitiveRoleId ||
          !["completed","failed","interrupted"].includes(fact.runState) ||
          !(fact.kind === "no_action" && fact.outcome === "no_action" ||
            fact.kind === "stop" && fact.outcome === "no_action" && fact.loopState === "stopped" ||
            fact.kind === "waiting" && fact.outcome === "waiting"))
          throw new DomainError("DECISION_UNSETTLED", "close requires a settled, signed cognition Decision for this fixed Task revision");
        let waitingInboxId: string | null = null;
        let handoffDispatchId: string | null = null;
        let handoffTaskId: string | null = null;
        if (fact.kind === "waiting") {
          if (!!c.waitingInboxId === !!c.handoffDispatchId)
            throw new DomainError("WAITING_HANDOFF_REQUIRED", "waiting requires exactly one signed source Inbox disposition or child business dispatch");
          if (c.waitingInboxId) {
            if (!fact.sourceTaskId || fact.sourceTaskId === task.id || fact.sourceTaskIsCognition || !await tx.getTask(fact.sourceTaskId))
              throw new DomainError("WAITING_HANDOFF_REQUIRED", "waiting needs a discoverable source business Task; cognition Tasks are not business handoffs");
            const waiting = await tx.getWaitingHandoffFact?.(c.waitingInboxId);
            if (!waiting || waiting.projectId !== c.projectId || waiting.loopId !== fact.loopId ||
              waiting.sourceEventId !== fact.sourceEventId || waiting.recipientRoleId !== fact.cognitiveRoleId ||
              waiting.disposition !== "waiting" || waiting.actorId !== fact.actorId)
              throw new DomainError("WAITING_HANDOFF_REQUIRED", "waiting needs a signed same-source Inbox disposition by the cognition worker");
            waitingInboxId = waiting.inboxId;
          } else {
            const child = await tx.getChildHandoffFact?.(c.handoffDispatchId!);
            if (!child || child.projectId !== c.projectId || child.parentDispatchId !== fact.dispatchId ||
              child.loopId !== fact.loopId || child.sourceEventId !== fact.sourceEventId ||
              child.recipientRoleId === fact.cognitiveRoleId ||
              child.cognitiveRoleId !== fact.cognitiveRoleId || child.taskId === task.id ||
              (child.division ? child.division.waitingDecisionId !== fact.decisionId :
                child.requestedBy !== fact.actorId || !Number.isFinite(Date.parse(child.requestedAtUtc)) ||
                Date.parse(child.requestedAtUtc) > Date.parse(fact.decidedAtUtc)))
              throw new DomainError("WAITING_HANDOFF_REQUIRED", "waiting needs an exact signed business handoff for this cognition decision");
            handoffDispatchId = child.dispatchId;
            handoffTaskId = child.taskId;
          }
        } else if (c.waitingInboxId || c.handoffDispatchId) throw new DomainError("WAITING_HANDOFF_UNEXPECTED", "only waiting decisions may cite a handoff");
        closureEvidence = {deliveryId:null,decisionId:fact.decisionId,sourceInboxId:fact.sourceInboxId,
          sourceEventId:fact.sourceEventId,sourceTaskId:fact.sourceTaskId,waitingInboxId,handoffDispatchId,handoffTaskId};
      }
      const revision = await newTaskRevision(tx, task, actorId, now, nextId, "done", c.reason);
      const closure: TaskClosure = { projectId: c.projectId, id: nextId(), taskId: task.id,
        taskRevisionId: revision.id, ...closureEvidence, acceptanceResult: "met",
        acceptanceEvidence: c.acceptanceEvidence, reason: c.reason, actorId, createdAt: now };
      await tx.insertTaskClosure(closure);
      return result(c.operationId, task.id, revision.id, revision.version);
    }
  }
}
