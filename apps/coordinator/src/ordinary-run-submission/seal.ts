import { createHash } from "node:crypto";
import type { Principal, RuntimeRunRecord, Operation } from "@evoloop/contracts";
import type { Delivery } from "@evoloop/contracts/workflow";
import type { OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import type { WorkflowService } from "@evoloop/core";
import { canonicalJson } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";

export type OrdinarySealResult = { status: "sealed" | "pending" | "unknown" | "rejected" | "absent"; reason: string; deliveryId?: string };

/** updateSubmission must compare expectedVersion and persist the complete next record atomically. */
export interface OrdinaryRunSealerDependencies {
  readSubmission(projectId: string, runId: string): Promise<OrdinaryRunSubmissionRecord | null>;
  updateSubmission(next: OrdinaryRunSubmissionRecord, expectedVersion: number): Promise<boolean>;
  readRun(projectId: string, runId: string): Promise<RuntimeRunRecord | null>;
  /** Resolve current authority, including revocation, for the original signer only. */
  resolveSubmittedActor(projectId: string, actorId: string): Promise<Principal | null>;
  workflow: Pick<WorkflowService, "getTask" | "getOperation" | "execute">;
  readDelivery(projectId: string, deliveryId: string): Promise<Delivery | null>;
  sealer: Principal;
  now(): string;
  canWrite(): boolean;
}

const terminal = (run: RuntimeRunRecord) => ["completed", "failed", "interrupted"].includes(run.state);
const hash = (actorId: string, command: unknown) => createHash("sha256").update(canonicalJson({ actorId, command })).digest("hex");

function deliveryCommand(s: OrdinaryRunSubmissionRecord) {
  if (!Number.isInteger(s.expectedTaskVersion) || (s.expectedTaskVersion ?? 0) < 1) return null;
  return { type: "delivery.record" as const, projectId: s.projectId, operationId: s.deliveryOperationId,
    taskId: s.taskId, runId: s.runId, expectedVersion: s.expectedTaskVersion!, ...s.deliveryIntent };
}

function matchesDelivery(s: OrdinaryRunSubmissionRecord, d: Delivery | null): boolean {
  const intent = s.deliveryIntent;
  return !!d && d.projectId === s.projectId && d.taskId === s.taskId && d.runId === s.runId &&
    d.actorId === s.submittedBy && d.submittedByActorId === s.submittedBy &&
    d.sourceRunVersion === s.terminalRunVersion &&
    d.artifactRef === intent.artifactRef &&
    d.artifactRevision === intent.artifactRevision && d.contentHash === intent.contentHash &&
    d.technicalResult === intent.technicalResult && d.technicalEvidence === intent.technicalEvidence &&
    d.reason === intent.reason;
}

export function createOrdinaryRunSealer(deps: OrdinaryRunSealerDependencies) {
  const fence = () => { if (!deps.canWrite()) throw new DomainError("LEASE_LOST", "Coordinator lease lost before ordinary seal write"); };
  const save = async (s: OrdinaryRunSubmissionRecord, patch: Partial<OrdinaryRunSubmissionRecord>) => {
    fence();
    return deps.updateSubmission({ ...s, ...patch, version: s.version + 1, updatedAtUtc: deps.now() }, s.version);
  };
  const blocked = async (s: OrdinaryRunSubmissionRecord, reason: string): Promise<OrdinarySealResult> => {
    if (s.state !== "blocked" || s.reason !== reason)
      await save(s, { state: "blocked", reason });
    return { status: "pending", reason };
  };

  return async function seal(projectId: string, runId: string): Promise<OrdinarySealResult> {
    let s = await deps.readSubmission(projectId, runId);
    if (!s) return { status: "absent", reason: "SUBMISSION_ABSENT" };
    if (s.projectId !== projectId || s.runId !== runId) return { status: "rejected", reason: "SUBMISSION_RUN_MISMATCH" };
    const run = await deps.readRun(projectId, runId);
    if (!run || run.id !== s.runId || run.projectId !== s.projectId || run.taskId !== s.taskId ||
      run.sessionId !== s.sessionId || run.taskRevisionId !== s.taskRevisionId || run.inputHash !== s.runInputHash)
      return blocked(s, "SUBMISSION_BINDING_MISMATCH");
    if (!terminal(run)) return { status: "pending", reason: "TERMINAL_RUN_REQUIRED" };
    if (s.state === "sealed") {
      if (!s.deliveryId) return { status: "rejected", reason: "SEALED_WITHOUT_DELIVERY" };
      if (s.terminalRunVersion !== run.version ||
        (s.deliveryIntent.technicalResult === "passed" && run.state !== "completed"))
        return { status: "pending", reason: "TERMINAL_RUN_VERSION_CHANGED" };
      return { status: "sealed", reason: "ALREADY_SEALED", deliveryId: s.deliveryId };
    }
    if (s.state === "rejected") return { status: "rejected", reason: s.reason ?? "WORKFLOW_REJECTED" };
    if (run.state !== "completed" && s.deliveryIntent.technicalResult !== "failed")
      return blocked(s, "FAILED_RUN_CANNOT_PASS_TECHNICAL_RESULT");
    const actor = await deps.resolveSubmittedActor(s.projectId, s.submittedBy);
    if (!actor || actor.actorId !== s.submittedBy || !actor.projectIds.includes(s.projectId) ||
      !actor.permissions.includes("read") || !actor.permissions.includes("write"))
      return blocked(s, "SUBMITTED_ACTOR_UNAVAILABLE");

    if (s.state === "submitted" || (s.state === "blocked" && s.expectedTaskVersion === null)) {
      const detail = await deps.workflow.getTask(deps.sealer, s.projectId, s.taskId);
      if (detail.task.projectId !== s.projectId || detail.task.currentRevisionId !== s.taskRevisionId ||
        detail.task.state !== "in_progress" || detail.deliveries?.some(d => d.runId === runId))
        return blocked(s, "TASK_INPUT_OR_DELIVERY_CHANGED");
      const fixed = { expectedTaskVersion: detail.task.version, terminalRunVersion: run.version,
        state: "sealing" as const, sealedBy: deps.sealer.actorId };
      const command = deliveryCommand({ ...s, ...fixed });
      if (!command) return { status: "unknown", reason: "DELIVERY_COMMAND_UNAVAILABLE" };
      const signed = { ...fixed, deliveryCommandHash: hash(s.submittedBy, command) };
      if (!await save(s, signed)) return { status: "unknown", reason: "SUBMISSION_VERSION_CONFLICT" };
      s = { ...s, ...signed, version: s.version + 1 };
    }
    if (s.sealedBy !== deps.sealer.actorId || !deliveryCommand(s))
      return { status: "unknown", reason: "SEAL_OWNER_OR_TASK_VERSION_MISSING" };
    const command = deliveryCommand(s)!;
    if (s.deliveryCommandHash !== hash(s.submittedBy, command))
      return blocked(s, "DELIVERY_COMMAND_MISMATCH");
    let operation: Operation | null;
    try { operation = await deps.workflow.getOperation(actor, s.projectId, s.deliveryOperationId); }
    catch { return { status: "unknown", reason: "DELIVERY_OPERATION_UNCONFIRMED" }; }
    if (!operation) {
      if (s.terminalRunVersion !== null && s.terminalRunVersion !== run.version)
        return blocked(s, "TERMINAL_RUN_VERSION_CHANGED");
      if (s.state === "blocked") {
        if (!await save(s, { state: "sealing", reason: null })) return { status: "unknown", reason: "SUBMISSION_VERSION_CONFLICT" };
        s = { ...s, state: "sealing", reason: null, version: s.version + 1 };
      }
      const detail = await deps.workflow.getTask(deps.sealer, s.projectId, s.taskId);
      if (detail.task.version !== s.expectedTaskVersion || detail.task.currentRevisionId !== s.taskRevisionId ||
        detail.task.state !== "in_progress" || detail.deliveries?.some(d => d.runId === runId))
        return blocked(s, "TASK_INPUT_OR_DELIVERY_CHANGED");
      const currentRun = await deps.readRun(projectId, runId);
      if (!currentRun || currentRun.version !== s.terminalRunVersion ||
        (s.deliveryIntent.technicalResult === "passed" && currentRun.state !== "completed"))
        return blocked(s, "TERMINAL_RUN_VERSION_CHANGED");
      fence();
      try { await deps.workflow.execute(actor, command); }
      catch { /* A lost response can follow a committed transaction. */ }
      try { operation = await deps.workflow.getOperation(actor, s.projectId, s.deliveryOperationId); }
      catch { operation = null; }
    }
    if (!operation) {
      if (s.state !== "unknown") await save(s, { state: "unknown", reason: "DELIVERY_OPERATION_UNCONFIRMED" });
      return { status: "unknown", reason: "DELIVERY_OPERATION_UNCONFIRMED" };
    }
    if (operation.projectId !== s.projectId || operation.id !== s.deliveryOperationId ||
      operation.actorId !== s.submittedBy || operation.commandType !== "delivery.record" ||
      operation.commandHash !== s.deliveryCommandHash ||
      operation.result.operationId !== s.deliveryOperationId ||
      (operation.result.status === "applied" && operation.result.entityId !== s.taskId))
      return blocked(s, "DELIVERY_OPERATION_MISMATCH");
    if (operation.result.status === "rejected") {
      if (!await save(s, { state: "rejected", reason: operation.result.code }))
        return { status: "unknown", reason: "SUBMISSION_VERSION_CONFLICT" };
      return { status: "rejected", reason: operation.result.code };
    }
    let confirmedRun: RuntimeRunRecord | null;
    try { confirmedRun = await deps.readRun(projectId, runId); }
    catch { return { status: "unknown", reason: "TERMINAL_RUN_UNCONFIRMED" }; }
    if (!confirmedRun || confirmedRun.version !== s.terminalRunVersion ||
      (s.deliveryIntent.technicalResult === "passed" && confirmedRun.state !== "completed"))
      return blocked(s, "TERMINAL_RUN_VERSION_CHANGED");
    const deliveryId = operation.result.revisionId;
    let delivery: Delivery | null = null;
    try { if (deliveryId) delivery = await deps.readDelivery(s.projectId, deliveryId); }
    catch { return { status: "unknown", reason: "DELIVERY_UNCONFIRMED" }; }
    if (!deliveryId || !matchesDelivery(s, delivery))
      return blocked(s, "DELIVERY_MISMATCH");
    if (!await save(s, { state: "sealed", deliveryId, reason: "AUTHORITATIVE_DELIVERY" }))
      return { status: "unknown", reason: "SUBMISSION_VERSION_CONFLICT" };
    return { status: "sealed", deliveryId, reason: "AUTHORITATIVE_DELIVERY" };
  };
}
