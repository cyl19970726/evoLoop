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
      if (c.runId) {
        const run = found(await tx.getRuntimeRun(c.runId), "source Run");
        if (run.projectId !== c.projectId || run.taskId !== task.id)
          throw new DomainError("DELIVERY_RUN_MISMATCH", "Source Run does not belong to this project's Task");
        if (!["completed", "failed", "interrupted"].includes(run.state))
          throw new DomainError("DELIVERY_RUN_UNSETTLED", "Source Run must have a confirmed terminal state");
        const executedInput = await taskInputSignature(tx, task, run.taskRevisionId);
        const currentInput = await taskInputSignature(tx, task);
        if (canonicalTaskInputJson(executedInput) !== canonicalTaskInputJson(currentInput))
          throw new DomainError("DELIVERY_INPUT_CHANGED", "Task business input changed since the source Run");
      }
      const revision = await newTaskRevision(tx, task, actorId, now, nextId, "in_progress", c.reason);
      const delivery: Delivery = { projectId: c.projectId, id: nextId(), taskId: task.id,
        taskRevisionId: revision.id, runId: c.runId ?? null,
        artifactRef: c.artifactRef, artifactRevision: c.artifactRevision,
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
      if (c.observerKind === "agent" && c.observer !== actorId)
        throw new DomainError("OBSERVER_MISMATCH", "agent use must be reported by that agent");
      if (c.observerKind === "human" && !principal.permissions.includes("review"))
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
      let closureEvidence: Pick<TaskClosure,"deliveryId"|"decisionId"|"sourceInboxId"|"sourceEventId"|"sourceTaskId"|"waitingInboxId">;
      if (c.deliveryId) {
        if (c.waitingInboxId) throw new DomainError("CLOSURE_EVIDENCE_REQUIRED", "Delivery closure cannot cite a waiting Inbox");
        const deliveries = await tx.listDeliveries(task.id);
        const latest = deliveries.at(-1);
        if (!latest || latest.id !== c.deliveryId || latest.taskRevisionId !== task.currentRevisionId)
          throw new DomainError("STALE_DELIVERY", "close requires latest delivery for the current Task revision");
        if (latest.technicalResult !== "passed") throw new DomainError("TECHNICAL_CHECK_FAILED", "latest delivery has not passed technical checks");
        if (proposal?.useRequired) {
          const observations = (await tx.listObservations(task.id)).filter(x => x.deliveryId === latest.id && x.observer === proposal.consumer);
          if (observations.at(-1)?.result !== "used") throw new DomainError("USE_NOT_OBSERVED", "current delivery lacks declared-consumer use evidence");
        }
        closureEvidence = {deliveryId:latest.id,decisionId:null,sourceInboxId:null,sourceEventId:null,sourceTaskId:null,waitingInboxId:null};
      } else {
        if (proposal?.useRequired) throw new DomainError("USE_NOT_OBSERVED", "a cognition decision cannot replace required consumer use");
        const fact = await tx.getCognitiveClosureFact?.(c.decisionId!);
        if (!fact || fact.projectId !== c.projectId || fact.taskId !== task.id || fact.taskRevisionId !== task.currentRevisionId ||
          fact.purpose !== "cognition" || fact.recipientRoleId !== fact.cognitiveRoleId ||
          !["completed","failed","interrupted"].includes(fact.runState) ||
          !(fact.kind === "no_action" && fact.outcome === "no_action" ||
            fact.kind === "stop" && fact.outcome === "no_action" && fact.loopState === "stopped" ||
            fact.kind === "waiting" && fact.outcome === "waiting"))
          throw new DomainError("DECISION_UNSETTLED", "close requires a settled, signed cognition Decision for this fixed Task revision");
        let waitingInboxId: string | null = null;
        if (fact.kind === "waiting") {
          if (!c.waitingInboxId || !fact.sourceTaskId || fact.sourceTaskId === task.id || fact.sourceTaskIsCognition || !await tx.getTask(fact.sourceTaskId))
            throw new DomainError("WAITING_HANDOFF_REQUIRED", "waiting needs a discoverable source business Task and same-source waiting Inbox; cognition Tasks are not business handoffs");
          const waiting = await tx.getWaitingHandoffFact?.(c.waitingInboxId);
          if (!waiting || waiting.projectId !== c.projectId || waiting.loopId !== fact.loopId ||
            waiting.sourceEventId !== fact.sourceEventId || waiting.recipientRoleId !== fact.cognitiveRoleId ||
            waiting.disposition !== "waiting" || waiting.actorId !== fact.actorId)
            throw new DomainError("WAITING_HANDOFF_REQUIRED", "waiting needs a signed same-source Inbox disposition by the cognition worker");
          waitingInboxId = waiting.inboxId;
        } else if (c.waitingInboxId) throw new DomainError("WAITING_HANDOFF_UNEXPECTED", "only waiting decisions may cite a waiting Inbox");
        closureEvidence = {deliveryId:null,decisionId:fact.decisionId,sourceInboxId:fact.sourceInboxId,
          sourceEventId:fact.sourceEventId,sourceTaskId:fact.sourceTaskId,waitingInboxId};
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
