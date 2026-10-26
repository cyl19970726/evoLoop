import { z } from "zod";
import { sessionTargetSchema, type SessionTarget } from "./session-work.js";

const id = z.uuid();
const note = z.string().trim().min(1).max(4000);
const version = z.number().int().nonnegative();
const base = { projectId: id, operationId: id };

export const sessionAssignmentCommands = [
  z.strictObject({ ...base, type: z.literal("session.profile.set"), target: sessionTargetSchema,
    expectedVersion: version, displayName: z.string().trim().min(1).max(240), purpose: z.string().trim().max(4000),
    membership: z.enum(["current", "historical", "unclassified"]), tenure: z.enum(["resident", "temporary", "unknown"]), reason: note }),
  z.strictObject({ ...base, type: z.literal("task.assignment.set"), taskId: id, expectedTaskVersion: z.number().int().positive(),
    target: sessionTargetSchema, recipientActorId: z.string().trim().min(1).max(240).nullable(), expectedVersion: version, reason: note }),
  z.strictObject({ ...base, type: z.literal("task.assignment.acknowledge"), taskId: id,
    expectedVersion: z.number().int().positive(), expectedTaskVersion: z.number().int().positive(),
    evidence: note, sourceRef: z.string().trim().min(1).max(4000).nullable().optional() }),
  z.strictObject({ ...base, type: z.literal("task.assignment.observeAcceptance"), taskId: id,
    expectedVersion: z.number().int().positive(), expectedTaskVersion: z.number().int().positive(),
    evidence: note, sourceRef: z.string().trim().min(1).max(4000).nullable().optional() }),
  z.strictObject({ ...base, type: z.literal("task.assignment.release"), taskId: id,
    expectedVersion: z.number().int().positive(), reason: note }),
] as const;
export type SessionAssignmentCommand = z.infer<(typeof sessionAssignmentCommands)[number]>;
export interface SessionProfileRecord {
  projectId: string; target: SessionTarget; version: number; displayName: string; purpose: string;
  membership: "current" | "historical" | "unclassified"; tenure: "resident" | "temporary" | "unknown";
  actorId: string; reason: string; updatedAt: string;
}
export interface TaskSessionAssignment {
  projectId: string; taskId: string; version: number; taskRevisionId: string; target: SessionTarget;
  recipientActorId: string | null; state: "assigned" | "accepted" | "released";
  ack: { method: "direct" | "lead-observed"; actorId: string | null; observerActorId: string;
    evidence: string; sourceRef: string | null; at: string } | null;
  actorId: string; reason: string; updatedAt: string;
}
export interface SessionAssignmentPage<T> { items: T[]; nextCursor: string | null }
export interface SessionAssignmentReader {
  getSessionProfile(target: SessionTarget): Promise<SessionProfileRecord | null>;
  listSessionProfileHistory(target: SessionTarget, limit: number, cursor?: string): Promise<SessionAssignmentPage<SessionProfileRecord>>;
  getTaskSessionAssignment(taskId: string): Promise<TaskSessionAssignment | null>;
  listTaskSessionAssignments(target: SessionTarget, limit: number, cursor?: string): Promise<SessionAssignmentPage<TaskSessionAssignment>>;
  listTaskSessionAssignmentHistory(taskId: string, limit: number, cursor?: string): Promise<SessionAssignmentPage<TaskSessionAssignment>>;
}
export interface SessionAssignmentTransaction extends SessionAssignmentReader {
  saveSessionProfile(value: SessionProfileRecord, expectedVersion: number): Promise<void>;
  saveTaskSessionAssignment(value: TaskSessionAssignment, expectedVersion: number): Promise<void>;
  /** Refuse reassignment/release while an unresolved Run or active queue claim owns the Task. */
  assertTaskAssignmentMovable(taskId: string): Promise<void>;
}
