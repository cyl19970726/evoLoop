import { z } from "zod";

/** Stable project identity. External links never acquire owned-session control. */
export const sessionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owned"), sessionId: z.uuid() }),
  z.strictObject({ kind: z.literal("external"), linkId: z.uuid() }),
]);
export type SessionTarget = z.infer<typeof sessionTargetSchema>;
/** Opaque to clients; always URL-encode when used in a route. */
export type SessionKey = string;
export interface ObservationSource {
  kind: "session" | "host-link" | "role" | "task" | "run" | "queue" | "discussion" | "document" | "stage" | "delivery" | "consumer-observation" | "message" | "session-profile" | "task-assignment";
  id: string;
  revision: string | null;
  evidence: "project-record" | "session-statement" | "independent-use";
  href: string;
}
export interface ObservationMetadata {
  generatedAt: string;
  sourceObservedAt: string | null;
  partial: boolean;
  limitations: string[];
}
export interface SessionActionCapability {
  available: boolean;
  reason: string | null;
}
export interface SessionCapabilities {
  observe: SessionActionCapability;
  send: SessionActionCapability & { mode: "owned-read-only" | "manual-handoff" | "unavailable" };
  open: SessionActionCapability & { ref: string | null };
  interrupt: SessionActionCapability;
  close: SessionActionCapability;
}
