import { z } from "zod";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
const base = { projectId: id, operationId: id };

/**
 * A structured request for a named identity to decide something (待我决定). The Leader (or anyone with review) creates it; only the
 * identity it names answers it; the creator can withdraw it. It is what 待我处理 lists, not a conversation message.
 */
export const decisionRequestCommands = [
  z.strictObject({ ...base, type: z.literal("decision.request.create"), requestId: id, requestedFrom: z.string().trim().min(1).max(240),
    taskId: id.optional(), subject: z.string().trim().min(1).max(240), question: text, options: z.array(z.string().trim().min(1).max(500)).max(10).default([]) }),
  z.strictObject({ ...base, type: z.literal("decision.request.answer"), requestId: id, expectedVersion: z.number().int().positive(), answer: text, reason: text }),
  z.strictObject({ ...base, type: z.literal("decision.request.withdraw"), requestId: id, expectedVersion: z.number().int().positive(), reason: text }),
] as const;
export type DecisionRequestCommand = z.infer<(typeof decisionRequestCommands)[number]>;

export interface DecisionRequest {
  projectId: string; id: string; requestedBy: string; requestedFrom: string; taskId: string | null; subject: string; question: string; options: string[];
  state: "open" | "answered" | "withdrawn"; answer: string | null; answerReason: string | null; answeredBy: string | null; answeredAt: string | null;
  withdrawnReason: string | null; version: number; createdAt: string; updatedAt: string;
}
export interface DecisionRequestTransaction {
  getDecisionRequest(id: string): Promise<DecisionRequest | null>;
  insertDecisionRequest(value: DecisionRequest): Promise<void>;
  updateDecisionRequest(value: DecisionRequest, expectedVersion: number): Promise<void>;
  listOpenDecisionRequests(requestedFrom: string): Promise<DecisionRequest[]>;
}

/** One line of 待我决定. `where` says which page decides it; the app builds the link. */
export type DecisionItem =
  | { kind: "role_proposal"; id: string; title: string; detail: string; proposedBy: string; at: string; roleId: string; version: number }
  | { kind: "stage_proposal"; id: string; title: string; detail: string; proposedBy: string; at: string; stageId: string; version: number }
  | { kind: "task_question"; id: string; title: string; detail: string; proposedBy: string; at: string; taskId: string; discussionId: string; eventId: string }
  | { kind: "decision_request"; id: string; title: string; detail: string; proposedBy: string; at: string; taskId: string | null; options: string[]; version: number };
export interface DecisionsForMe { items: DecisionItem[]; observedAt: string }
