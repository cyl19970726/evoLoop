import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";

export const authConfigSchema = z.array(z.strictObject({
  token: z.string().min(32),
  actorId: z.string().min(1).max(100),
  projectIds: z.array(z.uuid()).min(1),
  permissions: z.array(z.enum(["read", "write", "review"])).min(1),
  identityKind: z.enum(["agent", "human"]).optional(),
})).min(1).refine(items => new Set(items.map(x => x.token)).size === items.length, "Tokens must be unique")
  .refine(items => {
    const kinds = new Map<string, string>();
    for (const item of items) for (const projectId of item.projectIds) {
      const key = `${projectId}:${item.actorId}`, kind = item.identityKind ?? "agent";
      if (kinds.has(key) && kinds.get(key) !== kind) return false;
      kinds.set(key, kind);
    }
    return true;
  }, "One actor cannot mix human and agent credentials in a project");
export type AuthConfig = z.infer<typeof authConfigSchema>;
/** A study declaration keeps authority only while its actual reviewer credential remains configured. */
export function hasCurrentStudyReviewer(credentials: AuthConfig, projectId: string, actorId: string): boolean {
  const entries = credentials.filter(entry => entry.actorId === actorId && entry.projectIds.includes(projectId));
  // Equivalent tokens for one identity may overlap during rotation. Never combine partial grants.
  return entries.length > 0 && entries.every(entry =>
    (["read", "write", "review"] as const).every(permission => entry.permissions.includes(permission)));
}
export function authenticate(header: string | undefined, credentials: AuthConfig): Principal | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = Buffer.from(header.slice(7));
  for (const entry of credentials) {
    const expected = Buffer.from(entry.token);
    if (token.length === expected.length && timingSafeEqual(token, expected)) {
      return { actorId: entry.actorId, projectIds: [...entry.projectIds], permissions: [...entry.permissions], identityKind: entry.identityKind ?? "agent" };
    }
  }
  return null;
}
