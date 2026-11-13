import type { TaskAttentionAssessment, TaskAttentionFollowUp, TaskAttentionSignal, TaskAttentionThreshold,
  TaskAttentionTimedTask } from "@evoloop/contracts";
import type { LeaderWorkTimingStage } from "@evoloop/contracts/work-index";
import { taskAttentionSource } from "@evoloop/contracts";

/** Trial policy. A project or Stage row replaces the complete phase tuple, including explicit nulls. */
export const trialAttentionThresholdMs: Partial<Record<LeaderWorkTimingStage, {
  stageOverdueMs: number | null; activityWithoutProgressMs: number | null; observationGapMs: number | null
}>> = {
  // Ready but nobody dispatched it: todo with no assignment, or sent back for rework. Without these the Leader's own memory was the only reminder.
  unassigned: {stageOverdueMs: 2*60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
  rework: {stageOverdueMs: 2*60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
  awaiting_ack: {stageOverdueMs: 4*60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
  awaiting_run: {stageOverdueMs: 2*60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
  run_reserved: {stageOverdueMs: 2*60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
  running: {stageOverdueMs:null,activityWithoutProgressMs:8*60*60*1000,observationGapMs:30*60*1000},
  awaiting_submission: {stageOverdueMs:60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
  awaiting_acceptance: {stageOverdueMs:8*60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
  awaiting_publication: {stageOverdueMs:24*60*60*1000,activityWithoutProgressMs:null,observationGapMs:null},
};
export function trialAttentionThreshold(phase:LeaderWorkTimingStage):TaskAttentionThreshold | null {
  const value=trialAttentionThresholdMs[phase];
  return value?{stageId:null,phase,version:0,...value,actorId:"system:trial",
    reason:"Fixed Task trial attention policy",updatedAt:"1970-01-01T00:00:00.000Z"}:null;
}

const unknown = (signal: TaskAttentionSignal, reason: string): TaskAttentionAssessment =>
  ({signal, status: "unknown", severity: null, reason, evidence: {}});
const clear = (signal: TaskAttentionSignal, reason: string): TaskAttentionAssessment =>
  ({signal, status: "clear", severity: null, reason, evidence: {}});
function age(now: string, then: string | null): number | null {
  if (!then) return null;
  const value = Date.parse(now) - Date.parse(then);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function threshold(signal: TaskAttentionSignal, elapsed: number | null, limit: number | null | undefined,
  evidence: Record<string, unknown>): TaskAttentionAssessment {
  if (limit === undefined) return unknown(signal, "THRESHOLD_UNCONFIGURED");
  if (limit === null) return clear(signal, "THRESHOLD_DISABLED");
  if (elapsed === null) return unknown(signal, "SOURCE_TIME_UNKNOWN");
  if (elapsed < limit) return clear(signal, "BELOW_THRESHOLD");
  return { signal, status: "triggered", severity: elapsed >= 2 * limit ? "urgent" : "watch",
    reason: "THRESHOLD_REACHED", evidence: {...evidence, elapsedMs: elapsed, thresholdMs: limit} };
}

/** Pure policy over the fixed Task projection; no Session-only activity can enter this input. */
export function assessTaskAttention(task: TaskAttentionTimedTask, configured: TaskAttentionThreshold | null,
  now: string, followUp: TaskAttentionFollowUp | null = null): TaskAttentionAssessment[] {
  const current = task.timing.current;
  const source=taskAttentionSource(task,followUp);
  const signals: TaskAttentionSignal[] = ["stage_overdue", "activity_without_progress", "observation_gap"];
  if (current.stage === "unknown" || current.stage === "closed" || current.stage === "cancelled" ||
    !source || (!current.startedAt && !followUp?.nextCheckAt))
    return signals.map(signal => unknown(signal, "CURRENT_STAGE_UNVERIFIED"));
  const stageAge = age(now, current.startedAt);
  const waiting = followUp?.taskRevisionId === task.currentRevisionId && !!followUp.waitingOn && followUp.waitingOn.kind !== "unknown" &&
    followUp.nextCheckAt && Date.parse(followUp.nextCheckAt) > Date.parse(now);
  const checkpointDue = followUp?.taskRevisionId === task.currentRevisionId && !!followUp.waitingOn &&
    followUp.waitingOn.kind !== "unknown" && !!followUp.nextCheckAt &&
    Date.parse(followUp.nextCheckAt) <= Date.parse(now);
  const stage = waiting ? clear("stage_overdue", "WAITING_FOR_NEXT_CHECKPOINT") :
    checkpointDue ? {signal:"stage_overdue",status:"triggered",severity:"watch",
      reason:"NEXT_CHECKPOINT_DUE",evidence:{nextCheckAt:followUp!.nextCheckAt}} as TaskAttentionAssessment :
    threshold("stage_overdue", stageAge, configured?.stageOverdueMs,
      {stage: current.stage, source, startedAt: current.startedAt});
  if(current.stage==="awaiting_publication" && (!followUp?.releaseHandoff ||
    followUp.taskRevisionId!==task.currentRevisionId))
    return signals.map(signal=>unknown(signal,"PUBLICATION_HANDOFF_UNVERIFIED"));
  const activity = task.timing.executionActivity;
  const sameRun = !!activity && !!task.latestRun && task.latestRun.state==="running" &&
    current.stage==="running" && source.kind==="run" &&
    source.id===activity.runId && activity.runId === task.latestRun.runId;
  const progress = task.timing.latestEffectiveProgress;
  let stalled: TaskAttentionAssessment;
  if (configured?.activityWithoutProgressMs === undefined) stalled = unknown("activity_without_progress", "THRESHOLD_UNCONFIGURED");
  else if (configured.activityWithoutProgressMs === null) stalled = clear("activity_without_progress", "THRESHOLD_DISABLED");
  else if (!sameRun || activity?.freshness !== "live") stalled = unknown("activity_without_progress", "CURRENT_RUN_ACTIVITY_UNVERIFIED");
  else if (progress && Date.parse(progress.at) > Date.parse(activity!.at))
    stalled = unknown("activity_without_progress", "PROGRESS_AFTER_ACTIVITY");
  else stalled = threshold("activity_without_progress", age(now,
    progress && current.startedAt && Date.parse(progress.at) > Date.parse(current.startedAt) ? progress.at : current.startedAt),
    configured.activityWithoutProgressMs,
    {runId: activity!.runId, activityAt: activity!.at,
      progressSourceId: progress?.sourceId ?? null, progressAt: progress?.at ?? null});
  let gap: TaskAttentionAssessment;
  if (configured?.observationGapMs === undefined) gap = unknown("observation_gap", "THRESHOLD_UNCONFIGURED");
  else if (configured.observationGapMs === null) gap = clear("observation_gap", "THRESHOLD_DISABLED");
  else if (!sameRun || activity?.freshness === "unknown") gap = unknown("observation_gap", "CURRENT_RUN_OBSERVATION_UNKNOWN");
  else if (activity!.freshness === "live") gap = clear("observation_gap", "OBSERVATION_CURRENT");
  else gap = threshold("observation_gap", age(now, activity!.at), configured.observationGapMs,
    {runId: activity!.runId, lastObservedAt: activity!.observedAt, activityAt: activity!.at});
  return [stage, stalled, gap];
}
