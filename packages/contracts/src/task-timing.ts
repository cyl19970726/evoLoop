import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
/** The one stored form of a Task's planned instant; also the example every rejection shows. */
export const canonicalUtcExample = "2026-11-12T04:00:00.000Z";
// A UTC instant without milliseconds ("…:00Z") means the same moment, so it is accepted and stored in the canonical form.
const withoutMillis = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
export const executeAtUtcSchema = z.preprocess(
  value => typeof value === "string" && withoutMillis.test(value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : value,
  z.iso.datetime({ error: `executeAtUtc 必须是以 Z 结尾的 UTC 时间，例如 ${canonicalUtcExample}（毫秒可省略，会按规范形式保存）` }));
export const taskTimingSchema = z.strictObject({
  executeAtUtc: executeAtUtcSchema,
  timezone: z.string().trim().min(1).max(80),
  repeat: z.enum(["none", "daily"]),
});
export type TaskTimingInput = z.infer<typeof taskTimingSchema>;
/** A grant must name this exact Task series, starting with its original Task. */
export const taskTimingScopeId = (rootTaskId: string) => `task-timing:${rootTaskId}`;

export const taskTimingCommands = [
  z.strictObject({ type: z.literal("task.timing.set"), projectId: id, operationId: id,
    taskId: id, expectedTaskVersion: z.number().int().positive(), expectedTimingVersion: z.number().int().nonnegative(),
    ...taskTimingSchema.shape, scope: z.enum(["this", "this_and_future", "future"]),
    title: text.optional(), content: z.string().min(1).max(65536).optional(), acceptance: text.optional(), reason: text }),
  z.strictObject({ type: z.literal("task.timing.stop"), projectId: id, operationId: id,
    taskId: id, expectedTimingVersion: z.number().int().positive(), reason: text }),
] as const;
export type TaskTimingCommand = z.infer<(typeof taskTimingCommands)[number]>;

export interface TaskTimingView extends TaskTimingInput {
  projectId: string;
  taskId: string;
  seriesId: string;
  rootTaskId: string;
  version: number;
  seriesState: "active" | "stopped";
  previousTaskId: string | null;
  /** Already materialized successor in the chain; it may be completed history. */
  nextTaskId: string | null;
  /** Next unmaterialized calendar slot, only while daily repetition is active. */
  nextAtUtc: string | null;
  waitingReason: string | null;
  futureTemplate: { title: string; content: string; acceptance: string };
  occurrences: { taskId: string; executeAtUtc: string; state: "todo" | "in_progress" | "done" | "cancelled" }[];
}

/** One timed series for the project list: a one-time Task or a daily series, active or stopped. */
export interface TaskTimingSeriesSummary extends TaskTimingInput {
  projectId: string;
  seriesId: string;
  rootTaskId: string;
  version: number;
  seriesState: "active" | "stopped";
  /** The series name: its current future-template title. */
  title: string;
  /** Next unmaterialized daily slot; null for a one-time or stopped series. */
  nextAtUtc: string | null;
  skippedCount: number;
  occurrenceCount: number;
  /** The Task the series produced most recently (the root Task until the first copy). */
  latestTask: { taskId: string; title: string; state: "todo" | "in_progress" | "done" | "cancelled"; plannedAtUtc: string };
}
export interface TaskTimingSeriesPage { items: TaskTimingSeriesSummary[]; nextCursor: string | null }

export interface TaskTimingQueries {
  get(taskId: string): Promise<TaskTimingView | null>;
  /** Series of this project, most recently changed first; a Task without timing is never listed. */
  list(limit: number, cursor?: string): Promise<TaskTimingSeriesPage>;
  create(taskId: string, timing: TaskTimingInput, actorId: string, nowUtc: string): Promise<void>;
  set(command: Extract<TaskTimingCommand, { type: "task.timing.set" }>, actorId: string, nowUtc: string): Promise<TaskTimingView>;
  stop(command: Extract<TaskTimingCommand, { type: "task.timing.stop" }>, actorId: string, nowUtc: string): Promise<TaskTimingView>;
  updateFuture?(taskId: string, template: { title: string; content: string; acceptance: string }, expectedTimingVersion: number, actorId: string, nowUtc: string): Promise<void>;
}
