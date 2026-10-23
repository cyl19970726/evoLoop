import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import type { OrchestrationDispatch, OrchestrationSubmission, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import type { WorkflowService } from "@evoloop/core";
import type { OrchestrationService } from "@evoloop/core/orchestration";
import type { WorkerCredentialBroker } from "../workers/credentials.js";
import { loopIntentId } from "./runner.js";

export type SettlementResult = {
  status: "sealed" | "decision" | "pending" | "unknown" | "rejected" | "absent";
  deliveryId?: string; decisionId?: string; outcome?: "no_action" | "waiting" | "failed";
  reason?: string; evidenceRef?: string;
};
export interface WorkerSealerDependencies {
  workflow: Pick<WorkflowService, "getTask" | "getOperation" | "execute">;
  orchestration: Pick<OrchestrationService, "getSubmissionForDispatch" | "getDecisionForDispatch" | "execute">;
  credential: Pick<WorkerCredentialBroker, "lookup">;
  controller(projectId: string, roleId: string, dispatch?: OrchestrationDispatch): Principal | null | Promise<Principal | null>;
  now(): string;
}
const terminal = (run: RuntimeRunRecord) => ["completed", "failed", "interrupted"].includes(run.state);
const validTime = (value: string) => Number.isFinite(Date.parse(value));
function signedBy(issued: Awaited<ReturnType<WorkerCredentialBroker["lookup"]>>, dispatch: OrchestrationDispatch,
  run: RuntimeRunRecord, actorId: string, signedAt: string): issued is NonNullable<typeof issued> {
  if (!issued) return false;
  const { metadataWithoutSecret: meta, principal } = issued;
  const scope = meta.scope;
  return meta.revokedAt === null && validTime(meta.issuedAt) && validTime(meta.expiresAt) && validTime(signedAt) &&
    Date.parse(meta.issuedAt) <= Date.parse(signedAt) && Date.parse(signedAt) < Date.parse(meta.expiresAt) &&
    meta.actorId === actorId && principal.actorId === actorId && principal.projectIds.includes(dispatch.projectId) &&
    scope.projectId === dispatch.projectId && scope.loopId === dispatch.loopId && scope.taskId === dispatch.taskId &&
    scope.runId === run.id && scope.sessionId === run.sessionId && scope.roleId === dispatch.recipientRoleId &&
    scope.allowedRoleIds.includes(dispatch.recipientRoleId) &&
    (scope.kind === "business" || scope.kind === "cognition");
}
function commandFor(submission: OrchestrationSubmission) {
  if (!submission.expectedTaskVersion) throw new Error("Submission has no fixed Task version");
  return { type: "delivery.record" as const, projectId: submission.projectId,
    operationId: submission.deliveryOperationId, taskId: submission.taskId, runId: submission.runId,
    expectedVersion: submission.expectedTaskVersion, ...submission.deliveryIntent };
}
/** Only a signed preterminal intent can be settled; this never derives work from native final text. */
export function createWorkerSealer(deps: WorkerSealerDependencies) {
  return async (dispatch: OrchestrationDispatch, run: RuntimeRunRecord): Promise<SettlementResult> => {
    if (dispatch.projectId !== run.projectId || dispatch.taskId !== run.taskId || dispatch.runtimeRunId !== run.id ||
      dispatch.state !== "accepted" || !terminal(run)) return { status: "pending", reason: "BOUND_TERMINAL_RUN_REQUIRED" };
    const controller = await deps.controller(dispatch.projectId, dispatch.recipientRoleId, dispatch);
    if (!controller || !controller.projectIds.includes(dispatch.projectId) ||
      !["read", "write", "review"].every(p => controller.permissions.includes(p as "read" | "write" | "review")))
      return { status: "pending", reason: "SEAL_CONTROLLER_UNAVAILABLE" };
    const [submission, decision] = await Promise.all([
      deps.orchestration.getSubmissionForDispatch(controller, dispatch.projectId, dispatch.id),
      deps.orchestration.getDecisionForDispatch(controller, dispatch.projectId, dispatch.id),
    ]);
    if (submission && decision) return { status: "rejected", reason: "CONFLICTING_WORKER_INTENTS" };
    if (!submission && !decision) return { status: "absent", reason: "SIGNED_WORKER_INTENT_ABSENT" };
    const issued = await deps.credential.lookup(run.id, { allowExpired: true });
    const intent: OrchestrationSubmission | OrchestrationWorkerDecision = submission ?? decision!;
    const actorId = submission?.submittedBy ?? decision!.actorId;
    if (!signedBy(issued, dispatch, run, actorId, intent.createdAtUtc))
      return { status: "pending", reason: "SIGNED_WORKER_AUTHORITY_UNAVAILABLE" };
    if (decision) return { status: "decision", decisionId: decision.id,
      outcome: decision.kind === "stop" ? "no_action" : decision.kind,
      reason: decision.reason, ...(decision.evidenceRefs[0] ? { evidenceRef: decision.evidenceRefs[0] } : {}) };
    let current = submission!;
    if (current.projectId !== dispatch.projectId || current.dispatchId !== dispatch.id || current.runId !== run.id ||
      current.taskId !== run.taskId || current.taskRevisionId !== run.taskRevisionId || current.runInputHash !== run.inputHash)
      return { status: "rejected", reason: "SUBMISSION_BINDING_MISMATCH" };
    if (current.state === "sealed") return current.deliveryId
      ? { status: "sealed", deliveryId: current.deliveryId, reason: "ALREADY_SEALED" }
      : { status: "rejected", reason: "SEALED_WITHOUT_DELIVERY" };
    if (current.state === "rejected") return { status: "rejected", reason: current.reason ?? "WORKFLOW_REJECTED" };
    if (current.state === "submitted") {
      const task = await deps.workflow.getTask(controller, dispatch.projectId, dispatch.taskId);
      const begin = { type: "worker.beginSeal" as const, projectId: dispatch.projectId,
        operationId: loopIntentId(current.id, "begin-seal"), submissionId: current.id,
        expectedVersion: current.version, expectedTaskVersion: task.task.version,
        sealToken: loopIntentId(current.id, "seal-token") };
      await deps.orchestration.execute(controller, begin);
      current = { ...current, state: "sealing", version: current.version + 1,
        expectedTaskVersion: task.task.version, sealToken: begin.sealToken, sealedBy: controller.actorId };
    }
    // WorkflowService writes only PostgreSQL here, with a fixed operation ID, actor, and body.
    // A missing operation after a crash may safely replay this same transactional intent.
    // This never restarts the native Run or creates a new delivery operation ID.
    let operation = await deps.workflow.getOperation(issued.principal, dispatch.projectId, current.deliveryOperationId);
    if (!operation) {
      try { await deps.workflow.execute(issued.principal, commandFor(current)); }
      catch { /* Read the original operation; its transaction may have committed. */ }
      operation = await deps.workflow.getOperation(issued.principal, dispatch.projectId, current.deliveryOperationId);
    }
    if (!operation) {
      if (current.state === "sealing" && current.sealToken && current.sealedBy === controller.actorId)
        await deps.orchestration.execute(controller, { type: "worker.finishSeal", projectId: dispatch.projectId,
          operationId: loopIntentId(current.id, "seal-unknown"), submissionId: current.id,
          sealToken: current.sealToken, result: "unknown", deliveryId: null,
          reason: "Original delivery operation has no authoritative readback" });
      return { status: "unknown", reason: "DELIVERY_OPERATION_UNCONFIRMED" };
    }
    if (operation.actorId !== actorId || operation.id !== current.deliveryOperationId) return { status: "rejected", reason: "DELIVERY_OPERATION_IDENTITY_MISMATCH" };
    const resolution = operation.result.status === "applied" ? "sealed" : "rejected";
    const deliveryId = operation.result.status === "applied" ? operation.result.revisionId ?? null : null;
    if (resolution === "sealed" && !deliveryId) return { status: "unknown", reason: "DELIVERY_ID_UNCONFIRMED" };
    try {
      if (current.state === "unknown") {
        await deps.orchestration.execute(controller, { type: "worker.reconcileSeal", projectId: dispatch.projectId,
          operationId: loopIntentId(current.id, "reconcile-seal", String(current.version)), submissionId: current.id,
          expectedVersion: current.version, resolution, deliveryId,
          evidenceRef: current.deliveryOperationId, reason: "Authoritative original operation readback" });
      } else {
        if (!current.sealToken || current.sealedBy !== controller.actorId) return { status: "unknown", reason: "SEAL_OWNER_MISMATCH" };
        await deps.orchestration.execute(controller, { type: "worker.finishSeal", projectId: dispatch.projectId,
          operationId: loopIntentId(current.id, "finish-seal"), submissionId: current.id,
          sealToken: current.sealToken, result: resolution, deliveryId,
          reason: "Authoritative original operation readback" });
      }
    } catch { return { status: "unknown", reason: "SEAL_CONFIRMATION_UNCONFIRMED" }; }
    return resolution === "sealed" ? { status: "sealed", deliveryId: deliveryId!, reason: "AUTHORITATIVE_DELIVERY" }
      : { status: "rejected", reason: "WORKFLOW_REJECTED" };
  };
}
