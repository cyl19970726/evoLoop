import { z } from "zod";
import { sessionTargetSchema, type SessionTarget } from "./session-work.js";

export const identityColors = ["violet", "copper", "blue", "teal", "magenta", "olive", "coral", "plum"] as const;
export const identityMarks = ["diamond", "dot", "layers", "brackets", "spark", "grid", "check", "code"] as const;
export type IdentityColor = typeof identityColors[number];
export type IdentityMark = typeof identityMarks[number];

export interface SessionIdentity {
  projectId: string;
  target: SessionTarget;
  version: number;
  color: IdentityColor;
  mark: IdentityMark;
  actorId: string;
  reason: string;
  updatedAt: string;
}

export const sessionIdentityCommand = z.strictObject({
  type: z.literal("session.identity.set"), projectId: z.uuid(), operationId: z.uuid(),
  target: sessionTargetSchema, expectedVersion: z.number().int().positive(),
  color: z.enum(identityColors), mark: z.enum(identityMarks),
  reason: z.string().trim().min(1).max(4000),
});

/** Stable display fallback for a pre-migration read; persisted identity takes precedence. */
export function fallbackSessionIdentity(target: SessionTarget): Pick<SessionIdentity, "color" | "mark"> {
  const key = target.kind === "owned" ? target.sessionId : target.linkId;
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const index = (hash >>> 0) % identityColors.length;
  return { color: identityColors[index]!, mark: identityMarks[index]! };
}
