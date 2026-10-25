export type { ResidentQueueEntry, QueueSourceFacts, QueueReleaseEvidence } from "../../../contracts/src/queues.js";
import type { ResidentQueueEntry, QueueSourceFacts, QueueReleaseEvidence, QueueHoldCode } from "../../../contracts/src/queues.js";

export interface QueueDecision { ready: boolean; code: QueueHoldCode | null; reason: string | null }
const held = (code: QueueHoldCode, reason: string): QueueDecision => ({ ready: false, code, reason });
export function evaluateQueueEntry(entry: ResidentQueueEntry, facts: QueueSourceFacts, dependencyReleased: boolean): QueueDecision {
  if (!dependencyReleased) return held("dependency", "a prerequisite entry has not been accepted or explicitly released");
  if (!facts.currentTaskRevisionId || facts.taskState === "done" || facts.taskState === "cancelled" || facts.taskState === "other") return held("task_unavailable", "task is not executable");
  if (facts.currentTaskRevisionId !== entry.taskRevisionId) return held("task_changed", "fixed task revision is no longer current");
  if (!facts.sessionReady || !facts.nativeThreadId) return held("session_unready", "owned session has no ready native thread");
  if (!facts.bindingCurrent) return held("binding_changed", "role to session binding is no longer current");
  if (!facts.grantCurrent) return held("grant_revoked", "current exact grant does not authorize a new start");
  if (facts.conflictingRun) return held("run_in_flight", "task or session has an active or unknown run");
  return { ready: true, code: null, reason: null };
}

export function evaluateQueueRelease(entry: ResidentQueueEntry, evidence: QueueReleaseEvidence): QueueDecision {
  if (evidence.taskRevisionId !== entry.taskRevisionId) return held("task_changed", "release refers to another task revision");
  if (evidence.closureCurrent && evidence.closureId && evidence.taskState === "done" && evidence.deliveryCurrent && evidence.deliveryPassed && evidence.deliveryId &&
    (!entry.useRequired || (evidence.observationId && evidence.observationUsed && evidence.observationConsumerId === entry.consumerId))) return { ready: true, code: null, reason: null };
  if (entry.releaseRule === "bounded_decision" && evidence.boundedDecisionId && evidence.boundedDecisionActorId && evidence.boundedDecisionReason?.trim() && evidence.nextResponsibility?.trim() && evidence.taskState === "in_progress")
    return { ready: true, code: null, reason: null };
  return held("awaiting_acceptance", "current delivery, consumer use and task closure or bounded Lead decision are not verified");
}
