import { z } from "zod";
import type { SessionMessageDispatchGrant } from "./session-messages.js";

export interface DirectInputGrant extends SessionMessageDispatchGrant {
  canSteer: boolean;
  canStart: boolean;
}

/** One user submission. A steer is attached to the original Run or message processing. */
export const directInputCommand = z.strictObject({
  inputId: z.uuid(), operationId: z.uuid(),
  content: z.string().trim().min(1).max(16000),
  expectedTurnId: z.string().trim().min(1).max(256).nullable(),
});
export type DirectInputCommand = z.infer<typeof directInputCommand>;
export type DirectInputState = "pending" | "attempted" | "accepted" | "rejected" | "unknown";
export type DirectInputSource = { kind: "run" | "message"; id: string; processingId: string | null };
export interface DirectInputRecord {
  projectId: string; sessionId: string; inputId: string; operationId: string;
  actorId: string; content: string; mode: "steer" | "start";
  source: DirectInputSource; expectedTurnId: string | null; actualTurnId: string | null;
  nativeItemId: string | null; state: DirectInputState; reason: string | null;
  version: number; createdAt: string; updatedAt: string;
  /** Set on a refused steer whose text was saved as one queued ordinary message: that message has the same ID as the input. */
  queuedMessageId?: string | null;
}
/** Public receipt never contains native tool output or private model reasoning. */
export type DirectInputReceipt = Omit<DirectInputRecord, "content">;
export const publicDirectInput = ({content: _content, ...receipt}: DirectInputRecord): DirectInputReceipt => receipt;
export interface DirectInputCapability {
  available: boolean; mode: "steer" | "start" | null; expectedTurnId: string | null;
  reasonCode: string; observedAt: string;
  /** Which authorization or condition is missing, in words, when the grant is the reason. */
  detail?: string;
}
