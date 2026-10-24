import type { WorkerIdentity } from "./types.js";

type Fact = { projectId: string };
export interface WorkerGuardFacts {
  loop(loopId: string): Promise<(Fact & { state: "active" | "paused" | "stopped"; goalId: string; stageId: string | null;
    cognitiveRoleId: string; allowedBusinessRoleIds: string[] }) | null>;
  task(taskId: string): Promise<(Fact & { ownerRoleId: string; loopId: string }) | null>;
  taskRevision(taskId: string, revisionId: string): Promise<boolean>;
  recoveryGap?(): Promise<(Fact & {loopId: string; dispatchId: string; eventId: string; runId: string;
    taskId: string; taskRevisionId: string}) | null>;
  recoveryDocument?(documentId: string, revisionId: string): Promise<boolean>;
  run(runId: string): Promise<(Fact & { taskId: string; sessionId: string; state?: string }) | null>;
  delivery(deliveryId: string): Promise<(Fact & { taskId: string; runId: string | null }) | null>;
  inbox(inboxId: string): Promise<(Fact & { loopId: string; state: "pending" | "acknowledged" | "disposed" }) | null>;
  document(documentId: string): Promise<(Fact & { taskId: string | null; loopId: string | null }) | null>;
  fixedDocument(taskId: string, documentId: string, revisionId: string): Promise<boolean>;
  ownedDocumentRevision?(documentId: string, revisionId: string): Promise<boolean>;
  sourceIssueDocumentRevision?(documentId: string, revisionId: string): Promise<boolean>;
  sourceIssueLinkedDocument?(documentId: string): Promise<boolean>;
  fixedReference(taskId: string, kind: "git" | "wiki", referenceId: string, revisionId?: string): Promise<boolean>;
  fixedRunTrace?(targetRunId: string): Promise<boolean>;
  operation(operationId: string): Promise<(Fact & { actorId: string }) | null>;
  dispatchForRun?(runId: string): Promise<(Fact & {id: string; loopId: string; taskId: string; sourceEventId: string; runtimeRunId: string | null}) | null>;
  dispatch?(dispatchId: string): Promise<(Fact & {loopId: string}) | null>;
  divisionBinding?(bindingId: string): Promise<boolean>;
  divisionMaterial?(documentId: string, revisionId: string): Promise<boolean>;
  submission?(submissionId: string): Promise<(Fact & {runId: string; taskId: string}) | null>;
  decision?(decisionId: string): Promise<(Fact & {loopId: string; runId: string; taskId: string; actorId: string}) | null>;
}

/** Evaluate only rights that existed before a division binding was written. */
export async function canReadDivisionEvidence(identity: WorkerIdentity, facts: WorkerGuardFacts,
  documentId: string, revisionId: string): Promise<boolean> {
  return identity.scope.kind === "cognition" &&
    (await facts.fixedDocument(identity.scope.taskId, documentId, revisionId) ||
      await facts.sourceIssueDocumentRevision?.(documentId, revisionId) === true ||
      await facts.recoveryDocument?.(documentId, revisionId) === true);
}
export interface WorkerRequest { method: string; path: string; body?: unknown }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const obj = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const same = (value: Fact | null, projectId: string) => value?.projectId === projectId;

/** Fail-closed worker-specific authorization. Run after authentication and before ordinary core route authorization. */
export async function authorizeWorkerRequest(identity: WorkerIdentity, request: WorkerRequest, facts: WorkerGuardFacts): Promise<boolean> {
  const scope = identity.scope, [path, rawQuery] = request.path.split("?"), method = request.method.toUpperCase();
  if (!path || request.path.split("?").length > 2) return false;
  if (!identity.principal.projectIds.includes(scope.projectId) || !identity.principal.actorId.startsWith("worker-")) return false;
  const loop = await facts.loop(scope.loopId);
  if (!loop || !same(loop, scope.projectId) ||
      (scope.kind === "business" ? !loop.allowedBusinessRoleIds.includes(scope.roleId) : loop.cognitiveRoleId !== scope.roleId)) return false;
  if (method === "GET" || method === "HEAD") {
    if (path === "/api/session" || path === `/api/projects/${scope.projectId}`) return true;
    const prefix = `/api/projects/${scope.projectId}/`;
    if (!path.startsWith(prefix)) return false;
    const rest = path.slice(prefix.length), parts = rest.split("/");
    if (parts[0] === "references" && parts[1] === "tasks" && id(parts[2]) &&
        parts[3] === "revisions" && id(parts[4]) && parts.length === 5) {
      const gap = scope.kind === "cognition" ? await facts.recoveryGap?.() : null;
      if (gap && same(gap, scope.projectId) && gap.loopId === scope.loopId &&
          gap.taskId === parts[2] && gap.taskRevisionId === parts[4]) return true;
      const bound = await facts.task(parts[2]);
      return !!bound && same(bound, scope.projectId) && bound.loopId === scope.loopId &&
        (scope.kind === "cognition" || parts[2] === scope.taskId) && facts.taskRevision(parts[2], parts[4]);
    }
    if (scope.kind === "cognition" && parts[0] === "goals" && parts[1] === loop.goalId &&
        (parts.length === 2 || parts.length === 3 && parts[2] === "revisions")) return true;
    if (scope.kind === "cognition" && loop.stageId && parts[0] === "stages" && parts[1] === loop.stageId &&
        (parts.length === 2 || parts.length === 3 && ["revisions", "reviews"].includes(parts[2]!))) return true;
    if (scope.kind === "cognition" && parts[0] === "orchestration" && parts[1] === "loops" && parts[2] === scope.loopId &&
        (parts.length === 3 || parts.length === 4 && ["inbox", "dispatches", "events", "sources", "tasks", "submissions", "delegation-choices"].includes(parts[3]!))) return true;
    if (scope.kind === "cognition" && parts[0] === "orchestration" && parts[1] === "inbox" && id(parts[2]) && parts.length === 3) {
      const inbox = await facts.inbox(parts[2]);
      return same(inbox, scope.projectId) && inbox?.loopId === scope.loopId;
    }
    if (parts[0] === "orchestration" && parts[1] === "tasks" && id(parts[2]) &&
        parts[3] === "planning-sources" && parts.length === 4) {
      if (scope.kind !== "cognition") return false;
      const query = new URLSearchParams(rawQuery ?? "");
      if ([...query.keys()].some(key => key !== "taskRevisionId") ||
          query.getAll("taskRevisionId").length !== 1 || !id(query.get("taskRevisionId"))) return false;
      const bound = await facts.task(parts[2]);
      return same(bound, scope.projectId) && bound?.loopId === scope.loopId &&
        await facts.taskRevision(parts[2], query.get("taskRevisionId")!);
    }
    if (parts[0] === "references" && parts[1] === "git" && id(parts[2]) && parts.length === 3)
      return facts.fixedReference(scope.taskId, "git", parts[2]);
    if (parts[0] === "knowledge" && parts[1] === "pages" && id(parts[2]) && parts.length === 3) {
      const params = new URLSearchParams(rawQuery ?? "");
      if ([...params.keys()].some(key => key !== "revision") || params.getAll("revision").length > 1) return false;
      const revision = params.get("revision") ?? undefined;
      return !revision || id(revision) ? facts.fixedReference(scope.taskId, "wiki", parts[2], revision) : false;
    }
    if (parts[0] === "tasks" && id(parts[1]) && (parts.length === 2 || parts.length === 3 && parts[2] === "revisions" ||
        parts.length === 4 && parts[2] === "revisions" && id(parts[3]))) {
      if (parts.length === 4 && scope.kind === "cognition") {
        const gap = await facts.recoveryGap?.();
        if (gap && same(gap, scope.projectId) && gap.loopId === scope.loopId &&
            gap.taskId === parts[1] && gap.taskRevisionId === parts[3]) return true;
      }
      const task = await facts.task(parts[1]);
      return same(task, scope.projectId) && task?.loopId === scope.loopId &&
        (scope.kind === "cognition" || parts[1] === scope.taskId && task.ownerRoleId === scope.roleId) &&
        (parts.length !== 4 || await facts.taskRevision(parts[1], parts[3]!));
    }
    if (parts[0] === "runtime" && parts[1] === "runs" && parts[2] === scope.runId &&
        (parts.length === 3 || parts.length === 4 && ["events", "result"].includes(parts[3] ?? ""))) {
      const run = await facts.run(scope.runId);
      return same(run, scope.projectId) && run?.taskId === scope.taskId && run.sessionId === scope.sessionId;
    }
    if (scope.kind === "cognition" && parts[0] === "runtime" && parts[1] === "runs" && id(parts[2]) &&
        (parts.length === 3 || parts.length === 4 && ["events", "result"].includes(parts[3] ?? ""))) {
      const gap = await facts.recoveryGap?.();
      if (gap && same(gap, scope.projectId) && gap.loopId === scope.loopId && gap.runId === parts[2]) return true;
      // The CLI reads fixed Run metadata to verify TaskRev/inputHash before offering its trace pointer.
      // This exact Run detail has the same frozen-snapshot gate as trace; events/result remain denied.
      return parts.length === 3 && !rawQuery && !!facts.fixedRunTrace && await facts.fixedRunTrace(parts[2]);
    }
    if (parts[0] === "runtime" && parts[1] === "runs" && id(parts[2]) &&
        (parts.length === 3 || parts.length === 4 && parts[3] === "trace")) {
      const params = new URLSearchParams(rawQuery ?? "");
      if ([...params.keys()].some(key => key !== "cursor") || params.getAll("cursor").length > 1) return false;
      if (parts.length === 3 && rawQuery) return false;
      return !!facts.fixedRunTrace && await facts.fixedRunTrace(parts[2]);
    }
    if (parts[0] === "documents" && id(parts[1]) &&
        (parts.length === 2 || parts[2] === "revisions" && parts.length <= 5)) {
      if (scope.kind === "cognition" && parts.length >= 4 && id(parts[3]) &&
          (parts.length === 4 || parts.length === 5 && parts[4] === "original") &&
          await facts.recoveryDocument?.(parts[1], parts[3])) return true;
      // The source issue belongs to the original business Task, not to the
      // cognition Task. Grant only its frozen revision/original endpoint.
      if (parts.length >= 4 && id(parts[3]) &&
          (parts.length === 4 || parts.length === 5 && parts[4] === "original") &&
          await facts.sourceIssueDocumentRevision?.(parts[1], parts[3]) === true) return true;
      if (parts.length >= 4 && id(parts[3]) &&
          (parts.length === 4 || parts.length === 5 && parts[4] === "original") &&
          await facts.divisionMaterial?.(parts[1], parts[3]) === true) return true;
      const document = await facts.document(parts[1]);
      if (!same(document, scope.projectId)) return false;
      if (parts.length >= 4 && id(parts[3])) return parts.length === 4 || parts[4] === "original" ?
        (await facts.fixedDocument(scope.taskId, parts[1], parts[3]) ||
          await facts.ownedDocumentRevision?.(parts[1], parts[3]) === true) : false;
      // Every worker document read must bind a revision. A detail/list route can reveal a later
      // current body even when an older authored, linked, or delivered revision is authorized.
      return false;
    }
    if ((parts[0] === "operations" && parts.length === 2 && id(parts[1])) ||
        (parts[0] === "orchestration" && parts[1] === "operations" && parts.length === 3 && id(parts[2]))) {
      const operation = await facts.operation(parts.at(-1)!);
      // An absent operation is safe to query and must yield the formal unknown-result response.
      return !operation || same(operation, scope.projectId) && operation.actorId === identity.principal.actorId;
    }
    if (parts[0] === "orchestration" && parts[1] === "dispatches" && id(parts[2]) && parts.length === 3) {
      const dispatch = await facts.dispatchForRun?.(scope.runId);
      if (dispatch?.id === parts[2] && dispatch.loopId === scope.loopId) return true;
      const related = scope.kind === "cognition" ? await facts.dispatch?.(parts[2]) : null;
      return !!related && same(related, scope.projectId) && related.loopId === scope.loopId;
    }
    if (parts[0] === "orchestration" && parts[1] === "bindings" && id(parts[2]) && parts.length === 3)
      return await facts.divisionBinding?.(parts[2]) === true;
    if (parts[0] === "orchestration" && parts[1] === "submissions" && id(parts[2]) && parts.length === 3) {
      const submission = await facts.submission?.(parts[2]);
      return !!submission && same(submission, scope.projectId) && submission.runId === scope.runId && submission.taskId === scope.taskId;
    }
    if (parts[0] === "orchestration" && parts[1] === "decisions" && id(parts[2]) && parts.length === 3) {
      const decision = await facts.decision?.(parts[2]);
      return !!decision && same(decision, scope.projectId) && decision.loopId === scope.loopId &&
        (scope.kind === "cognition" || decision.runId === scope.runId && decision.taskId === scope.taskId &&
          decision.actorId === identity.principal.actorId);
    }
    return false;
  }
  if (method !== "POST") return false;
  if (path === "/api/commands") return authorizeWorkerCommand(identity, request.body, facts);
  // An orchestration route must parse the shared command first and pass that body through the same guard.
  if (path === "/api/orchestration/commands") return authorizeWorkerCommand(identity, request.body, facts);
  return false;
}

export async function authorizeWorkerCommand(identity: WorkerIdentity, value: unknown, facts: WorkerGuardFacts): Promise<boolean> {
  const command = obj(value), scope = identity.scope;
  const loop = await facts.loop(scope.loopId);
  if (!loop || !same(loop, scope.projectId) ||
      (scope.kind === "business" ? !loop.allowedBusinessRoleIds.includes(scope.roleId) : loop.cognitiveRoleId !== scope.roleId) ||
      !identity.principal.projectIds.includes(scope.projectId) || !identity.principal.actorId.startsWith("worker-")) return false;
  if (!command || command.projectId !== scope.projectId || !id(command.operationId) || typeof command.type !== "string") return false;
  const task = async (taskId: unknown) => {
    if (!id(taskId)) return false;
    const fact = await facts.task(taskId);
    return same(fact, scope.projectId) && fact?.loopId === scope.loopId &&
      (scope.kind === "cognition" || taskId === scope.taskId && fact.ownerRoleId === scope.roleId);
  };
  const linkedDocuments = async () => {
    if (command.documentIds === undefined) return true;
    if (!Array.isArray(command.documentIds)) return false;
    for (const documentId of command.documentIds) {
      if (!id(documentId)) return false;
      const document = await facts.document(documentId);
      if (!same(document, scope.projectId) || document?.loopId !== scope.loopId) {
        if (scope.kind !== "cognition" || await facts.sourceIssueLinkedDocument?.(documentId) !== true) return false;
      }
    }
    return true;
  };
  if (command.type === "document.create") {
    const origin = obj(command.origin), run = await facts.run(scope.runId);
    return ["issue", "report"].includes(String(command.kind)) && id(command.documentId) &&
      !!origin && origin.taskId === scope.taskId && origin.runId === scope.runId &&
      same(run, scope.projectId) && run?.taskId === scope.taskId && run.sessionId === scope.sessionId;
  }
  if (command.type === "document.adopt" || command.type === "document.publish")
    return scope.kind === "cognition" && id(command.documentId) && id(command.revisionId) &&
      await facts.sourceIssueDocumentRevision?.(command.documentId, command.revisionId) === true;
  if (command.type === "division.decide") {
    if (scope.kind !== "cognition" || loop.state !== "active" || command.loopId !== scope.loopId ||
        !id(command.firstTaskId) || !await task(command.firstTaskId) ||
        !id(command.documentId) || !id(command.documentRevisionId) ||
        !await canReadDivisionEvidence(identity,facts,command.documentId,command.documentRevisionId)) return false;
    const parent = await facts.dispatchForRun?.(scope.runId), run = await facts.run(scope.runId);
    return !!parent && same(parent,scope.projectId) && parent.id === command.parentDispatchId &&
      parent.loopId === scope.loopId && parent.taskId === scope.taskId && parent.runtimeRunId === scope.runId &&
      parent.sourceEventId === command.sourceEventId && same(run,scope.projectId) &&
      run?.taskId === scope.taskId && run.sessionId === scope.sessionId &&
      ["requested","dispatching","running"].includes(run.state ?? "");
  }
  if (command.type === "worker.submit" || command.type === "worker.decision" || command.type === "division.ackHandoff") {
    if (command.type === "division.ackHandoff" && scope.kind !== "business") return false;
    if (command.type === "worker.decision" && command.divisionDecisionId != null &&
        (scope.kind !== "cognition" || command.kind !== "waiting" || !id(command.divisionDecisionId))) return false;
    const dispatch = await facts.dispatchForRun?.(scope.runId);
    return !!dispatch && dispatch.id === command.dispatchId && dispatch.loopId === scope.loopId &&
      dispatch.taskId === scope.taskId && command.runId === scope.runId && dispatch.runtimeRunId === scope.runId;
  }
  if (command.type === "observation.record") {
    if (!await task(command.taskId) || !id(command.deliveryId) || command.observerKind !== "agent" || command.observer !== identity.principal.actorId) return false;
    const delivery = await facts.delivery(command.deliveryId);
    return same(delivery, scope.projectId) && delivery?.taskId === command.taskId &&
      (scope.kind === "cognition" || delivery?.runId === scope.runId);
  }
  if (scope.kind === "business") {
    if (command.type !== "delivery.record" || command.taskId !== scope.taskId || command.runId !== scope.runId || !await task(command.taskId)) return false;
    const run = await facts.run(scope.runId);
    return same(run, scope.projectId) && run?.taskId === scope.taskId && run.sessionId === scope.sessionId;
  }
  if (command.type === "task.create") {
    if (loop.state !== "active" || !id(command.taskId) || command.stageId !== loop.stageId || loop.stageId === null ||
        !scope.allowedRoleIds.includes(String(command.owner))) return false;
    return linkedDocuments();
  }
  if (command.type === "task.update" || command.type === "task.reviewBasis") return await task(command.taskId) &&
    (command.type !== "task.update" || await linkedDocuments() && (command.stageId === undefined || command.stageId === loop.stageId) && scope.allowedRoleIds.includes(String(command.owner)));
  if (command.type === "task.close") return command.taskId !== scope.taskId && await task(command.taskId);
  if (command.type === "inbox.accept") {
    const dispatch = await facts.dispatchForRun?.(scope.runId);
    return loop.state === "active" && command.loopId === scope.loopId && command.purpose === "next_action" &&
      command.recipientRoleId === scope.roleId && !!dispatch && command.sourceEventId === dispatch.sourceEventId;
  }
  if (command.type === "dispatch.request") {
    if (loop.state !== "active" || !id(command.inboxId) || !await task(command.taskId) ||
        !scope.allowedRoleIds.includes(String(command.recipientRoleId))) return false;
    const parent = await facts.dispatchForRun?.(scope.runId);
    if (!parent || command.parentDispatchId !== parent.id) return false;
    const inbox = await facts.inbox(command.inboxId);
    return same(inbox, scope.projectId) && inbox?.loopId === scope.loopId && inbox.state === "acknowledged";
  }
  if (command.type === "inbox.ack" || command.type === "inbox.dispose") {
    if (!id(command.inboxId)) return false;
    const inbox = await facts.inbox(command.inboxId);
    return same(inbox, scope.projectId) && inbox?.loopId === scope.loopId &&
      (command.type === "inbox.ack" ? inbox.state === "pending" : inbox.state === "acknowledged");
  }
  return false;
}
