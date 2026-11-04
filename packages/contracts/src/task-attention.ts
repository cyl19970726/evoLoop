import { z } from "zod";
import type { LeaderWorkTask, LeaderWorkTimingStage } from "./work-index.js";

const id = z.uuid();
const reason = z.string().trim().min(1).max(4000);
const stamp = z.iso.datetime({ offset: true });
const label = z.string().trim().min(1).max(500);
export const taskAttentionStageSchema = z.enum(["unassigned", "awaiting_ack", "awaiting_run",
  "run_reserved", "running", "awaiting_submission", "awaiting_delivery", "awaiting_publication",
  "awaiting_acceptance", "rework", "blocked", "closed", "cancelled", "unknown"]);
const duration = z.number().int().min(1000).max(365 * 24 * 60 * 60 * 1000).nullable();
const common = { projectId: id, operationId: id, reason };
export const taskAttentionThresholdsSetSchema = z.strictObject({ ...common,
  type: z.literal("task.attention.thresholds.set"), expectedVersion: z.number().int().nonnegative(),
  stageId: id.nullable(), phase: taskAttentionStageSchema,
  stageOverdueMs: duration, activityWithoutProgressMs: duration, observationGapMs: duration,
});
export const taskAttentionFollowUpSetSchema = z.strictObject({ ...common,
  type: z.literal("task.attention.followUp.set"), taskId: id,
  expectedTaskVersion: z.number().int().positive(), expectedTaskRevisionId: id,
  expectedVersion: z.number().int().nonnegative(),
  waitingOn: z.strictObject({kind: z.enum(["session", "consumer", "leader", "publisher", "user", "task", "unknown"]),
    id: label.nullable()}).nullable(),
  decision: z.enum(["checked", "waiting", "acted"]), actionTaken: reason,
  evidenceRef: label.nullable(),
  nextCheckAt: stamp.nullable(),
  releaseHandoff: z.strictObject({ recipient: label, artifactRef: label, note: reason,
    readyForPublicationAt: stamp }).nullable(),
}).superRefine((value,ctx)=>{
  if(value.decision==="waiting"&&!value.waitingOn)
    ctx.addIssue({code:"custom",path:["waitingOn"],message:"Waiting decision needs a waiting party"});
});
export const taskAttentionPublicationRecordSchema = z.strictObject({ ...common,
  type: z.literal("task.attention.publication.record"), taskId: id,
  expectedTaskVersion: z.number().int().positive(), expectedTaskRevisionId: id,
  expectedVersion: z.number().int().positive(), publishedAt: stamp, publicationRef: label,
});
export const taskAttentionResolveSchema = z.strictObject({ ...common,
  type: z.literal("task.attention.resolve"), itemId: id,
  expectedVersion: z.number().int().positive(),
  disposition: z.enum(["resolved", "source_expired"]),
});
export const taskAttentionCommands = [taskAttentionThresholdsSetSchema,
  taskAttentionFollowUpSetSchema, taskAttentionPublicationRecordSchema,
  taskAttentionResolveSchema] as const;
export type TaskAttentionCommand = z.infer<(typeof taskAttentionCommands)[number]>;
export type TaskAttentionSignal = "stage_overdue" | "activity_without_progress" | "observation_gap";
export type TaskAttentionSeverity = "watch" | "urgent";
export interface TaskAttentionThreshold {
  stageId: string | null; phase: LeaderWorkTimingStage; version: number;
  stageOverdueMs: number | null; activityWithoutProgressMs: number | null;
  observationGapMs: number | null; actorId: string; reason: string; updatedAt: string;
}
export interface TaskAttentionFollowUp {
  taskId: string; taskRevisionId: string; version: number;
  waitingOn: {kind: "session" | "consumer" | "leader" | "publisher" | "user" | "task" | "unknown"; id: string | null} | null;
  decision: "checked" | "waiting" | "acted"; actionTaken: string; evidenceRef: string | null;
  nextCheckAt: string | null;
  releaseHandoff: {recipient: string; artifactRef: string; note: string;
    readyForPublicationAt: string} | null;
  publication: { publishedAt: string; publicationRef: string } | null;
  actorId: string; reason: string; updatedAt: string;
}
export interface TaskAttentionItem {
  id: string; taskId: string; taskRevisionId: string; stageId: string | null;
  phase: LeaderWorkTimingStage; signal: TaskAttentionSignal;
  waitingOn: {kind:string;id:string|null} | null;
  reason: string;
  state: "open" | "resolved"; severity: TaskAttentionSeverity; version: number;
  firstDetectedAt: string; lastDetectedAt: string; sourceObservedAt: string;
  evidence: Record<string, unknown>; noticeId: string | null;
  resolvedAt: string | null; resolutionReason: string | null;
}
export interface TaskAttentionAssessment {
  signal: TaskAttentionSignal; status: "triggered" | "clear" | "unknown";
  severity: TaskAttentionSeverity | null; reason: string;
  evidence: Record<string, unknown>;
}
export type TaskAttentionTimedTask = Pick<LeaderWorkTask, "taskId" | "currentRevisionId" | "stage" | "latestRun" | "timing">;
/** A verified current-revision checkpoint may supply a source when the timing gate has none. */
export function taskAttentionSource(task:TaskAttentionTimedTask,followUp:TaskAttentionFollowUp|null):
  {kind:string;id:string}|null {
  if(task.timing.current.source)return task.timing.current.source;
  return followUp?.taskRevisionId===task.currentRevisionId && followUp.waitingOn &&
    followUp.waitingOn.kind!=="unknown" && followUp.nextCheckAt
    ? {kind:"follow_up",id:`${task.taskId}@${followUp.version}`} : null;
}
