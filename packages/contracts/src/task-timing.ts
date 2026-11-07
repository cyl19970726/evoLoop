import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
export const taskTimingSchema = z.strictObject({
  executeAtUtc: z.iso.datetime(),
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
  nextTaskId: string | null;
  nextAtUtc: string | null;
  waitingReason: string | null;
  futureTemplate: { title: string; content: string; acceptance: string };
  occurrences: { taskId: string; executeAtUtc: string; state: "todo" | "in_progress" | "done" | "cancelled" }[];
}

export interface TaskTimingQueries {
  get(taskId: string): Promise<TaskTimingView | null>;
  create(taskId: string, timing: TaskTimingInput, actorId: string, nowUtc: string): Promise<void>;
  set(command: Extract<TaskTimingCommand, { type: "task.timing.set" }>, actorId: string, nowUtc: string): Promise<TaskTimingView>;
  stop(command: Extract<TaskTimingCommand, { type: "task.timing.stop" }>, actorId: string, nowUtc: string): Promise<TaskTimingView>;
  updateFuture?(taskId: string, template: { title: string; content: string; acceptance: string }, expectedTimingVersion: number, actorId: string, nowUtc: string): Promise<void>;
}
