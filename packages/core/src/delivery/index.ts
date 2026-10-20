import type { Command, CommandResult, Principal, TaskDetail } from "@evoloop/contracts";
import type { DeliveryStore, IncomingRecord } from "@evoloop/contracts/delivery";
import { DomainError } from "@evoloop/contracts/ports";

export class CollaborationRuleError extends DomainError {
  constructor(code: string, message: string) { super(code, message); this.name = "CollaborationRuleError"; }
}
const forbid = (message: string): never => { throw new CollaborationRuleError("FORBIDDEN", message); };
function reviewer(principal: Principal, projectId: string): void {
  if (!principal.actorId || !principal.projectIds.includes(projectId) || !principal.permissions.includes("read") || !principal.permissions.includes("write") || !principal.permissions.includes("review")) forbid("project review authority required");
}
export interface IncomingWorkflow {
  getTask(principal: Principal, projectId: string, taskId: string): Promise<TaskDetail>;
  getOperation(principal: Principal, projectId: string, operationId: string): Promise<{ result: CommandResult } | null>;
  execute(principal: Principal, command: Command): Promise<CommandResult>;
}
export interface IncomingReviewResult { state: IncomingRecord["state"]; operationId: string; reason: string }

/** Incoming content is a reviewed candidate; only the ordinary Task command may change task authority. */
export async function reviewIncomingChange(deps: { store: DeliveryStore; workflow: IncomingWorkflow; consumerId: string; nowUtc(): string; verifyRemote(candidate: IncomingRecord): Promise<boolean> }, principal: Principal,
  projectId: string, incomingId: string, decision: "apply" | "reject", reason: string): Promise<IncomingReviewResult> {
  reviewer(principal, projectId);
  if (!reason.trim()) throw new CollaborationRuleError("INVALID_INPUT", "review reason required");
  const candidate = await deps.store.getIncoming(projectId,incomingId,deps.consumerId);
  if (!candidate) throw new CollaborationRuleError("NOT_FOUND", "incoming candidate not found");
  if (!["pending","review-only","unknown"].includes(candidate.state)) return { state:candidate.state, operationId:candidate.operationId, reason:"already decided" };
  const finish = async (state: IncomingRecord["state"], detail: string): Promise<IncomingReviewResult> => {
    const saved = await deps.store.decideIncoming({ projectId,id:incomingId,operationId:candidate.operationId,state,actorId:principal.actorId,reason:detail,createdAtUtc:deps.nowUtc() },deps.consumerId);
    if (!saved) throw new CollaborationRuleError("VERSION_CONFLICT", "incoming decision changed; reread before acting");
    return { state,operationId:candidate.operationId,reason:detail };
  };
  if (decision === "reject") return finish("rejected", reason);
  if (candidate.reviewOnly || !candidate.actor?.verified || !candidate.actor.projectActorId || !candidate.actor.sourceEventId) return finish("conflict", "actor or baseline is not verified; review-only candidate");
  const prior = await deps.workflow.getOperation(principal,projectId,candidate.operationId);
  if (prior) return finish(prior.result.status === "applied" ? "applied" : "conflict", `original Task operation ${prior.result.status}; ${reason}`);
  if (candidate.state === "unknown") return { state:"unknown",operationId:candidate.operationId,reason:"original Task operation still unconfirmed; do not issue a second command" };
  const binding = await deps.store.getBinding(projectId,candidate.entityId,deps.consumerId);
  if (!binding || binding.remoteRecordId !== candidate.remoteRecordId || binding.localVersion !== candidate.observedLocalVersion) return finish("conflict", "remote binding or local baseline changed");
  if (!await deps.verifyRemote(candidate)) return finish("conflict", "remote record no longer matches the observed candidate; reread required");
  const detail = await deps.workflow.getTask(principal,projectId,candidate.entityId);
  const task = detail.task;
  if (task.state !== "todo" || task.version !== candidate.observedLocalVersion) return finish("conflict", "started or changed Task requires normal Task workflow review");
  if (candidate.patch.status !== undefined) return finish("conflict", "remote status cannot directly change Task state");
  const title = candidate.patch.title;
  if (!title || title === task.title) return finish("conflict", "no supported title change to apply");
  const command = {
    type:"task.update" as const, projectId,operationId:candidate.operationId,taskId:task.id,expectedVersion:task.version,
    title,content:task.content,acceptance:task.acceptance,owner:task.owner,kind:task.kind,
    documentIds:detail.links.filter(link=>link.documentId!==task.contentDocumentId).map(link=>link.documentId),
    evidence:`Remote candidate ${candidate.sourceEventId}; verified external actor ${candidate.actor.projectActorId}; ${reason}`,
    consumer:detail.proposal?.consumer ?? task.owner,useRequired:detail.proposal?.useRequired ?? false,
    stopCondition:detail.proposal?.stopCondition ?? "Review remote proposal",reason,
  };
  try {
    const result = await deps.workflow.execute(principal,command);
    return finish(result.status === "applied" ? "applied" : "conflict", `Task command ${result.status}; ${reason}`);
  } catch {
    const recovered = await deps.workflow.getOperation(principal,projectId,candidate.operationId).catch(() => null);
    if (recovered) return finish(recovered.result.status === "applied" ? "applied" : "conflict", `Task operation readback ${recovered.result.status}; ${reason}`);
    return finish("unknown", "Task operation result unconfirmed; query original operation ID before further action");
  }
}
