import type { AppliedResult, Principal } from "@evoloop/contracts";
import { DomainError, type Transaction } from "@evoloop/contracts/ports";
import type { DecisionRequestCommand } from "@evoloop/contracts/decision-requests";

/**
 * 待我决定 requests. Create and withdraw need review (the Leader, a reviewer); only the identity a request names answers it, and
 * only while it is open at the version the answerer saw.
 */
export async function applyDecisionRequest(tx: Transaction, principal: Principal, command: DecisionRequestCommand, now: string):
  Promise<{ result: AppliedResult; effects: Array<{ kind: string; entityId: string; version: number }> }> {
  const store = tx.decisionRequests ?? (() => { throw new DomainError("CAPABILITY_UNAVAILABLE", "Decision request storage is unavailable"); })();
  const ok = (id: string, version: number) => ({ result: { status: "applied" as const, operationId: command.operationId, entityId: id, version },
    effects: [{ kind: command.type, entityId: id, version }] });
  if (command.type === "decision.request.create") {
    if (command.taskId && !await tx.getTask(command.taskId)) throw new DomainError("NOT_FOUND", "Task was not found");
    if (command.requestedFrom === principal.actorId) throw new DomainError("DECISION_SELF", "A request is for someone else to decide");
    await store.insertDecisionRequest({ projectId: command.projectId, id: command.requestId, requestedBy: principal.actorId, requestedFrom: command.requestedFrom,
      taskId: command.taskId ?? null, subject: command.subject, question: command.question, options: command.options, state: "open", answer: null, answerReason: null,
      answeredBy: null, answeredAt: null, withdrawnReason: null, version: 1, createdAt: now, updatedAt: now });
    return ok(command.requestId, 1);
  }
  const request = await store.getDecisionRequest(command.requestId);
  if (!request) throw new DomainError("NOT_FOUND", "Decision request was not found");
  if (request.version !== command.expectedVersion) throw new DomainError("VERSION_CONFLICT", "The request changed", request.version);
  if (request.state !== "open") throw new DomainError("DECISION_CLOSED", "This request is no longer open");
  if (command.type === "decision.request.answer") {
    if (principal.actorId !== request.requestedFrom) throw new DomainError("NOT_THE_DECIDER", "Only the identity the request names can answer it");
    if (request.options.length && !request.options.includes(command.answer)) throw new DomainError("ANSWER_NOT_AN_OPTION", "Choose one of the offered options");
    await store.updateDecisionRequest({ ...request, state: "answered", answer: command.answer, answerReason: command.reason, answeredBy: principal.actorId, answeredAt: now,
      version: request.version + 1, updatedAt: now }, request.version);
    return ok(request.id, request.version + 1);
  }
  if (principal.actorId !== request.requestedBy) throw new DomainError("NOT_THE_ASKER", "Only who asked can withdraw the request");
  await store.updateDecisionRequest({ ...request, state: "withdrawn", withdrawnReason: command.reason, version: request.version + 1, updatedAt: now }, request.version);
  return ok(request.id, request.version + 1);
}
