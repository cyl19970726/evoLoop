import { z } from "zod";
import type { Stage } from "./workflow.js";
import type { AcceptanceMode } from "./workflow.js";

const scheduleText = z.string().trim().min(1).max(4000);
const scheduleRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), atUtc: z.iso.datetime() }),
  z.strictObject({ kind: z.literal("interval"), anchorUtc: z.iso.datetime(), everyMinutes: z.number().int().min(1).max(525600) }),
  z.strictObject({ kind: z.literal("daily"), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
]);
const scheduleFields = {
  projectId: z.uuid(), operationId: z.uuid(), scheduleId: z.uuid(), revisionId: z.uuid(), timezone: z.string().min(1).max(80),
  rule: scheduleRuleSchema,
  misfire: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("skip") }), z.strictObject({ kind: z.literal("latest") }), z.strictObject({ kind: z.literal("bounded"), maxCatchUp: z.number().int().min(1).max(100) })]),
  overlap: z.enum(["skip", "queue"]), template: z.strictObject({ title: scheduleText, content: z.string().min(1).max(65536), acceptance: scheduleText, owner: scheduleText,
    consumer: scheduleText.optional(), acceptanceMode: z.enum(["independent_agent", "human_required"]).optional(),
    managedTarget: z.strictObject({ loopId: z.uuid(), stageId: z.uuid() }).optional() }),
  authorization: z.strictObject({ scopeId: scheduleText, roleId: scheduleText, authorizedBy: scheduleText, expiresAtUtc: z.iso.datetime().nullable() }),
  reason: scheduleText,
};
export const scheduleCommands = [
  z.strictObject({ ...scheduleFields, type: z.literal("schedule.create"), watermarkUtc: z.iso.datetime(), state: z.literal("active") }),
  z.strictObject({ ...scheduleFields, type: z.literal("schedule.revise"), expectedVersion: z.number().int().positive(), state: z.enum(["active", "paused", "stopped"]) }),
] as const;
export type ScheduleCommand = z.infer<(typeof scheduleCommands)[number]>;

export type ScheduleRule =
  | { kind: "once"; atUtc: string }
  | { kind: "interval"; anchorUtc: string; everyMinutes: number }
  | { kind: "daily"; localTime: string };

export type MisfirePolicy = { kind: "skip" } | { kind: "latest" } | { kind: "bounded"; maxCatchUp: number };
export type OverlapPolicy = "skip" | "queue";
export interface ScheduledTaskTemplate { title: string; content: string; acceptance: string; owner: string; consumer?: string | undefined; acceptanceMode?: AcceptanceMode | undefined; managedTarget?: { loopId: string; stageId: string } | undefined }
export interface ScheduleAuthorization {
  scopeId: string;
  roleId: string;
  authorizedBy: string;
  expiresAtUtc: string | null;
}

export interface ScheduleRevision {
  projectId: string;
  scheduleId: string;
  id: string;
  version: number;
  timezone: string;
  rule: ScheduleRule;
  misfire: MisfirePolicy;
  overlap: OverlapPolicy;
  template: ScheduledTaskTemplate;
  authorization: ScheduleAuthorization;
  reason: string;
  actorId: string;
  createdAtUtc: string;
}

export interface ScheduleDefinition {
  projectId: string;
  id: string;
  version: number;
  currentRevisionId: string;
  state: "active" | "paused" | "stopped";
  watermarkUtc: string;
  revision: ScheduleRevision;
}

export interface Occurrence {
  projectId: string;
  scheduleId: string;
  revisionId: string;
  plannedAtUtc: string;
  observedAtUtc: string;
  state: "created" | "queued" | "skipped";
  taskId: string | null;
  operationId: string;
  reason: string;
}

export interface DueSelection {
  plannedAtUtc: string[];
  skippedCount: number;
  totalDue: number;
  checkedThroughUtc: string;
}

export interface ScheduleStore {
  create(definition: ScheduleDefinition): Promise<ScheduleDefinition>;
  get(projectId: string, scheduleId: string): Promise<ScheduleDefinition | null>;
  listActive(projectId: string): Promise<ScheduleDefinition[]>;
  revise(definition: ScheduleDefinition, expectedVersion: number): Promise<ScheduleDefinition>;
  /** Atomic reservation, proposed Task, operation journal, outbox and watermark advancement. */
  materialize(definition: ScheduleDefinition, plannedAtUtc: string, observedAtUtc: string, state: Occurrence["state"], reason: string): Promise<Occurrence>;
  getOccurrence(projectId: string, scheduleId: string, plannedAtUtc: string): Promise<Occurrence | null>;
  hasOpenOccurrence(projectId: string, scheduleId: string): Promise<boolean>;
  listQueued(projectId: string, scheduleId: string): Promise<Occurrence[]>;
  advanceWatermark(projectId: string, scheduleId: string, expectedVersion: number, throughUtc: string, reason: string): Promise<void>;
}

export interface SchedulingReader {
  getSchedule(id: string): Promise<ScheduleDefinition | null>;
  listSchedules(): Promise<ScheduleDefinition[]>;
  listScheduleRevisions(id: string): Promise<ScheduleRevision[]>;
  listOccurrences(id: string): Promise<Occurrence[]>;
}
export interface SchedulingTransaction extends SchedulingReader {
  getStage(id: string): Promise<Stage | null>;
  getManagedScheduleLoop(id: string): Promise<{ projectId: string; id: string; goalId: string; stageId: string | null; state: string; allowedBusinessRoleIds: string[] } | null>;
  insertSchedule(definition: ScheduleDefinition): Promise<void>;
  updateSchedule(definition: ScheduleDefinition, expectedVersion: number): Promise<void>;
}
