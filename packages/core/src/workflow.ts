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
  TaskJudgement,
  TaskProposal,
  TaskRevision,
} from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { Transaction } from "@evoloop/contracts/ports";

type WorkflowCommand = Extract<
  Command,
  {
    type:
      | "goal.create"
      | "goal.revise"
      | "stage.propose"
      | "stage.accept"
      | "stage.review"
      | "task.judge"
      | "task.revise"
      | "task.start"
      | "task.block"
      | "task.defer"
      | "task.resume"
      | "task.cancel"
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
  changes: Partial<Pick<Task, "title" | "goal" | "acceptance" | "owner">> = {},
): Promise<TaskRevision> {
  const previous = found(
    await tx.getTaskRevision(task.id, task.currentRevisionId),
    "task revision",
  );
  const id = nextId();
  const basisSetId = previous.basisSetId ? nextId() : null;
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
    const copy: BasisSet = {
      ...old,
      taskRevisionId: id,
      id: basisSetId,
      members: old.members.map((x) => ({ ...x })),
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
    case "task.judge": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      if (task.state !== "proposed")
        throw new DomainError("INVALID_STATE", "only proposals can be judged");
      const prior = (await tx.listTaskJudgements(task.id)).at(-1);
      if (prior?.taskRevisionId === task.currentRevisionId)
        throw new DomainError(
          "REVISION_REQUIRED",
          "revise the proposal before another judgement",
        );
      if (
        (c.decision === "needsEvidence" || c.decision === "defer") &&
        !c.relookCondition
      )
        throw new DomainError(
          "RELOOK_REQUIRED",
          "deferred judgement needs a relook condition",
        );
      const judgement: TaskJudgement = {
        projectId: c.projectId,
        id: nextId(),
        taskId: task.id,
        taskRevisionId: task.currentRevisionId,
        decision: c.decision,
        reason: c.reason,
        evidence: c.evidence,
        relookCondition: c.relookCondition ?? null,
        actorId,
        createdAt: now,
      };
      await tx.insertTaskJudgement(judgement);
      return result(c.operationId, task.id, judgement.id, task.version);
    }
    case "task.revise": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      if (task.state !== "proposed")
        throw new DomainError(
          "INVALID_STATE",
          "only proposed tasks can be revised",
        );
      const old = await tx.getTaskProposal(task.id, task.currentRevisionId);
      if (old?.stageId && (await tx.getStage(old.stageId))?.state !== "active")
        throw new DomainError("INVALID_STAGE", "Proposal stage is no longer active");
      if (new Set(c.documentIds).size !== c.documentIds.length)
        throw new DomainError(
          "DUPLICATE_DOCUMENT",
          "document links must be unique",
        );
      const oldLinks = await tx.listLinks(task.id);
      const oldDocIds = oldLinks.map((x) => x.documentId).sort();
      if (oldDocIds.some((x) => !c.documentIds.includes(x)))
        throw new DomainError(
          "LINK_REMOVAL_UNSUPPORTED",
          "existing document relation cannot be removed by task revision",
        );
      const consumer = c.consumer ?? old?.consumer ?? "";
      const useRequired = c.useRequired ?? old?.useRequired ?? false;
      const stopCondition = c.stopCondition ?? old?.stopCondition ?? "";
      const changed = [
        task.title !== c.title,
        task.goal !== c.goal,
        task.acceptance !== c.acceptance,
        task.owner !== c.owner,
        old?.evidence !== c.evidence,
        old?.consumer !== consumer,
        old?.useRequired !== useRequired,
        old?.stopCondition !== stopCondition,
        JSON.stringify(oldDocIds) !== JSON.stringify([...c.documentIds].sort()),
      ].some(Boolean);
      if (!changed)
        throw new DomainError(
          "UNCHANGED_PROPOSAL",
          "proposal needs material revision before reconsideration",
        );
      for (const id of c.documentIds)
        found(await tx.getDocument(id), "document");
      const revision = await newTaskRevision(
        tx,
        task,
        actorId,
        now,
        nextId,
        "proposed",
        c.reason,
        {
          title: c.title,
          goal: c.goal,
          acceptance: c.acceptance,
          owner: c.owner,
        },
      );
      const proposal: TaskProposal = {
        projectId: c.projectId,
        taskId: task.id,
        taskRevisionId: revision.id,
        stageId: old?.stageId ?? null,
        consumer,
        useRequired,
        evidence: c.evidence,
        stopCondition,
        createdAt: now,
      };
      await tx.insertTaskProposal(proposal);
      for (const id of c.documentIds.filter((x) => !oldDocIds.includes(x)))
        await tx.insertLink({
          projectId: c.projectId,
          id: nextId(),
          taskId: task.id,
          documentId: id,
          actorId,
          createdAt: now,
        });
      return result(c.operationId, task.id, revision.id, revision.version);
    }
    case "task.start":
    case "task.block":
    case "task.defer":
    case "task.resume":
    case "task.cancel": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      let next: Task["state"];
      if (c.type === "task.start") {
        if (task.state !== "ready")
          throw new DomainError("INVALID_STATE", "only ready task can start");
        next = "active";
      } else if (c.type === "task.block") {
        if (!["ready", "active", "review"].includes(task.state))
          throw new DomainError("INVALID_STATE", "task cannot be blocked");
        next = "blocked";
      } else if (c.type === "task.defer") {
        if (!["ready", "active", "review", "blocked"].includes(task.state))
          throw new DomainError("INVALID_STATE", "task cannot be deferred");
        next = "deferred";
      } else if (c.type === "task.cancel") {
        if (["done", "cancelled"].includes(task.state))
          throw new DomainError("INVALID_STATE", "task is closed");
        next = "cancelled";
      } else {
        if (!["blocked", "deferred"].includes(task.state))
          throw new DomainError("INVALID_STATE", "task is not paused");
        next = c.target;
      }
      if (
        next === "active" &&
        (await tx.listImpacts(task.id)).some((impact) => impact.state === "pending")
      )
        throw new DomainError(
          "PENDING_BASIS_REVIEW",
          "review adopted-source changes before resuming work",
        );
      const pending = (await tx.listImpacts(task.id)).filter(
        (impact) => impact.state === "pending",
      );
      const revision = await newTaskRevision(
        tx,
        task,
        actorId,
        now,
        nextId,
        next,
        c.reason,
      );
      const outcome = result(c.operationId, task.id, revision.id, revision.version);
      for (const impact of pending) {
        await tx.supersedeImpacts(task.id, impact.documentId);
        outcome.effects.push({
          kind: "impact.superseded",
          entityId: impact.id,
          version: 2,
        });
        if (next !== "cancelled") {
          const rebuilt = {
            ...impact,
            id: nextId(),
            taskRevisionId: revision.id,
            createdAt: now,
          };
          await tx.insertImpact(rebuilt);
          outcome.effects.push({
            kind: "impact",
            entityId: rebuilt.id,
            version: 1,
          });
        }
      }
      return outcome;
    }
    case "delivery.record": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      if (!["active", "review"].includes(task.state))
        throw new DomainError(
          "INVALID_STATE",
          "task must be active or in review to deliver",
        );
      const revision = await newTaskRevision(
        tx,
        task,
        actorId,
        now,
        nextId,
        "review",
        c.reason,
      );
      const delivery: Delivery = {
        projectId: c.projectId,
        id: nextId(),
        taskId: task.id,
        taskRevisionId: revision.id,
        artifactRef: c.artifactRef,
        artifactRevision: c.artifactRevision,
        contentHash: c.contentHash,
        technicalResult: c.technicalResult,
        technicalEvidence: c.technicalEvidence,
        reason: c.reason,
        actorId,
        createdAt: now,
      };
      await tx.insertDelivery(delivery);
      return result(c.operationId, task.id, delivery.id, revision.version);
    }
    case "observation.record": {
      const delivery = found(await tx.getDelivery(c.deliveryId), "delivery");
      if (delivery.taskId !== c.taskId)
        throw new DomainError(
          "WRONG_DELIVERY",
          "delivery belongs to another task",
        );
      const task = found(await tx.getTask(c.taskId), "task");
      if (task.state !== "review")
        throw new DomainError(
          "INVALID_STATE",
          "consumer observation requires review state",
        );
      if (c.observerKind === "agent" && c.observer !== actorId)
        throw new DomainError(
          "OBSERVER_MISMATCH",
          "agent use must be reported by that agent",
        );
      if (
        c.observerKind === "human" &&
        !principal.permissions.includes("review")
      )
        throw new DomainError(
          "ATTESTATION_REQUIRED",
          "external human use requires reviewer attestation",
        );
      const observation: ConsumerObservation = {
        projectId: c.projectId,
        id: nextId(),
        taskId: task.id,
        deliveryId: delivery.id,
        observer: c.observer,
        observerKind: c.observerKind,
        result: c.result,
        evidence: c.evidence,
        reason: c.reason,
        actorId,
        createdAt: now,
      };
      await tx.insertObservation(observation);
      return result(c.operationId, task.id, observation.id, task.version);
    }
    case "task.close": {
      const task = found(await tx.getTask(c.taskId), "task");
      version(task.version, c.expectedVersion);
      if (task.state !== "review")
        throw new DomainError("INVALID_STATE", "task must be in review");
      if (c.acceptanceResult !== "met")
        throw new DomainError(
          "ACCEPTANCE_UNMET",
          "task acceptance must be met before closure",
        );
      const deliveries = await tx.listDeliveries(task.id);
      const latest = deliveries.at(-1);
      if (!latest || latest.id !== c.deliveryId)
        throw new DomainError(
          "STALE_DELIVERY",
          "close requires latest delivery",
        );
      if (latest.technicalResult !== "passed")
        throw new DomainError(
          "TECHNICAL_CHECK_FAILED",
          "latest delivery has not passed technical checks",
        );
      const proposal = await tx.getTaskProposal(task.id);
      if (proposal?.useRequired) {
        const observations = (await tx.listObservations(task.id)).filter(
          (x) => x.deliveryId === latest.id && x.observer === proposal.consumer,
        );
        if (observations.at(-1)?.result !== "used")
          throw new DomainError(
            "USE_NOT_OBSERVED",
            "current delivery lacks current declared-consumer use evidence",
          );
      }
      const revision = await newTaskRevision(
        tx,
        task,
        actorId,
        now,
        nextId,
        "done",
        c.reason,
      );
      const closure: TaskClosure = {
        projectId: c.projectId,
        id: nextId(),
        taskId: task.id,
        taskRevisionId: revision.id,
        deliveryId: latest.id,
        acceptanceResult: "met",
        acceptanceEvidence: c.acceptanceEvidence,
        reason: c.reason,
        actorId,
        createdAt: now,
      };
      await tx.insertTaskClosure(closure);
      return result(c.operationId, task.id, revision.id, revision.version);
    }
  }
}
