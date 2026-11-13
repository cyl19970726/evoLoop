import { z } from "zod";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const version = z.number().int().nonnegative();
const base = { projectId: id, operationId: id };

/**
 * Scheduled direct dispatch (DEC-045 S1). The Leader decides who may receive scheduled work and how a schedule hands it over; all three need review
 * authority. The occurrence itself (the Task, the dispatch intent) is written by the scheduling pump, never by one of these commands.
 */
export const scheduleDispatchCommands = [
  // How one schedule hands over its Task: to the Leader (default) or straight to a Session's line. Setting "direct" approves the schedule's current
  // Task template and the Role's current revision; changing either returns the schedule to the Leader.
  z.strictObject({ ...base, type: z.literal("schedule.dispatch.set"), scheduleId: id, expectedVersion: version, mode: z.enum(["leader", "direct"]),
    state: z.enum(["active", "paused", "revoked"]).default("active"), waitLimitMinutes: z.number().int().min(1).max(1440).default(120),
    dailyRunBudget: z.number().int().min(1).max(1000).nullable().default(null), reason: note }),
  // The resident Sessions of one Role that scheduled Tasks may go to, in preference order (replaced as a whole).
  z.strictObject({ ...base, type: z.literal("schedule.directList.set"), roleId: id, expectedVersion: version, sessionIds: z.array(id).max(20), reason: note }),
  // Taking a scheduled Task out of the line it was sent to needs a choice: cancel the Task, or hand it to the Leader.
  z.strictObject({ ...base, type: z.literal("schedule.directEntry.withdraw"), entryId: id, expectedVersion: z.number().int().positive(),
    choice: z.enum(["cancel", "to_leader"]), reason: note }),
] as const;
export type ScheduleDispatchCommand = z.infer<(typeof scheduleDispatchCommands)[number]>;

export type DispatchMode = "leader" | "direct";
export type DispatchState = "active" | "paused" | "revoked" | "circuit_open";
export interface ScheduleDispatchPolicy {
  projectId: string; scheduleId: string; version: number; mode: DispatchMode; state: DispatchState; waitLimitMinutes: number; dailyRunBudget: number | null;
  setRevisionId: string; roleRevisionId: string | null; consecutiveFailures: number; consecutiveSkips: number; revertReason: string | null;
  actorId: string; reason: string; updatedAt: string;
}
export interface DirectDispatchList { projectId: string; roleId: string; version: number; sessionIds: string[]; actorId: string; reason: string; updatedAt: string }
export interface ScheduleDispatchLog {
  scheduleId: string; plannedAtUtc: string; state: "pending" | "dispatched" | "fell_back" | "skipped"; reason: string; taskId: string | null; sessionId: string | null;
  entryId: string | null; templateHash: string; roleRevisionId: string | null; executionConfig: Record<string, unknown>; decidedAt: string; dispatchedAt: string | null;
}

export interface ScheduleDispatchTransaction {
  getDispatchPolicy(scheduleId: string): Promise<ScheduleDispatchPolicy | null>;
  /** Insert (expectedVersion 0) or update with a version check; the approval fields come from the schedule's current revision and the Role's current revision. */
  saveDispatchPolicy(value: Omit<ScheduleDispatchPolicy, "setRevisionId" | "roleRevisionId" | "consecutiveFailures" | "consecutiveSkips" | "revertReason">, expectedVersion: number,
    approve: boolean): Promise<ScheduleDispatchPolicy>;
  getDirectList(roleId: string): Promise<DirectDispatchList | null>;
  saveDirectList(value: DirectDispatchList, expectedVersion: number): Promise<void>;
  /** The triage notice a Task did not get when it went straight to a line, made when it is handed to the Leader after all. */
  enqueueTodoNotice(taskId: string, at: string): Promise<void>;
  /** Marks the dispatch log row of a withdrawn scheduled Task, so the occurrence is not appended again. */
  markWithdrawn(taskId: string, choice: "cancel" | "to_leader", at: string): Promise<void>;
}
