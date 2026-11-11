import { z } from "zod";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const version = z.number().int().positive();
const base = { projectId: id, operationId: id };

/**
 * Session line (DEC-045 Q1). The Leader appends, moves one step and removes; the line pump drives the entry at the head
 * through advance/suspend/withdraw. Every command needs review authority.
 */
export const sessionLineCommands = [
  z.strictObject({ ...base, type: z.literal("line.append"), sessionId: id, taskId: id, expectedTaskVersion: version,
    source: z.enum(["leader", "schedule"]).default("leader"), scheduleId: id.optional(), reason: note }),
  z.strictObject({ ...base, type: z.literal("line.move"), entryId: id, expectedVersion: version, direction: z.enum(["forward", "back"]) }),
  z.strictObject({ ...base, type: z.literal("line.remove"), entryId: id, expectedVersion: version, reason: note }),
  z.strictObject({ ...base, type: z.literal("line.resume"), entryId: id, expectedVersion: version, reason: note }),
  // The pump's steps for the entry at the head. Operation ids are fixed by the entry and the attempt so every step replays safely.
  z.strictObject({ ...base, type: z.literal("line.begin"), entryId: id, expectedVersion: version,
    assignOperationId: id, startOperationId: id, reassignOperationId: id, reserveOperationId: id, messageId: id }),
  z.strictObject({ ...base, type: z.literal("line.advance"), entryId: id, expectedVersion: version, to: z.enum(["confirm", "start"]) }),
  z.strictObject({ ...base, type: z.literal("line.started"), entryId: id, expectedVersion: version, runId: id }),
  z.strictObject({ ...base, type: z.literal("line.suspend"), entryId: id, expectedVersion: version,
    code: z.string().trim().min(1).max(100), reason: note }),
  z.strictObject({ ...base, type: z.literal("line.withdrawReturned"), entryId: id, expectedVersion: version, reason: note }),
] as const;
export type SessionLineCommand = z.infer<(typeof sessionLineCommands)[number]>;

export type SessionLineEntryState = "queued" | "suspended" | "starting" | "started" | "withdrawn";
export type SessionLineStep = "assign" | "confirm" | "start";
export interface SessionLine { projectId: string; sessionId: string; controllerActorId: string; version: number; createdAt: string; updatedAt: string }
export interface SessionLineEntry {
  projectId: string; id: string; sessionId: string; taskId: string; position: number; state: SessionLineEntryState;
  step: SessionLineStep | null; attempt: number;
  assignOperationId: string | null; startOperationId: string | null; reassignOperationId: string | null; reserveOperationId: string | null; messageId: string | null;
  suspendReason: string | null; withdrawnReason: string | null;
  source: "leader" | "schedule"; sourceActorId: string; scheduleId: string | null; releaseRule: "run_end";
  runId: string | null; version: number; appendedAt: string; updatedAt: string;
}
export interface SessionLineEvent {
  projectId: string; seq: number; sessionId: string; entryId: string | null; taskId: string | null; kind: string;
  detail: Record<string, unknown>; actorId: string; at: string;
}
export interface SessionLineReader {
  getSessionLine(sessionId: string): Promise<SessionLine | null>;
  listSessionLineEntries(sessionId: string, includeEnded?: boolean): Promise<SessionLineEntry[]>;
  getSessionLineEntry(entryId: string): Promise<SessionLineEntry | null>;
  listSessionLines(): Promise<SessionLine[]>;
  listSessionLineEvents(afterSeq: number, limit: number, sessionId?: string): Promise<SessionLineEvent[]>;
  /** The live entry (queued, suspended or starting) holding this Task, if any. */
  getLiveSessionLineEntryForTask(taskId: string): Promise<SessionLineEntry | null>;
}
export interface SessionLineTransaction extends SessionLineReader {
  insertSessionLine(value: SessionLine): Promise<void>;
  touchSessionLine(sessionId: string, expectedVersion: number, at: string): Promise<void>;
  /** Append at the tail (position = last + 1). */
  insertSessionLineEntry(value: Omit<SessionLineEntry, "position">): Promise<SessionLineEntry>;
  updateSessionLineEntry(value: SessionLineEntry, expectedVersion: number): Promise<void>;
  /** Exchange positions with the nearest neighbour that has not ended; false at the end of the line. */
  swapSessionLineEntry(entryId: string, direction: "forward" | "back", at: string): Promise<boolean>;
  appendSessionLineEvent(value: Omit<SessionLineEvent, "seq">): Promise<void>;
  /** QUEUED_IN_SESSION_LINE unless the call is one of the entry's own registered line operations. */
  assertNotQueuedInLine(taskId: string, operationId: string): Promise<void>;
}
