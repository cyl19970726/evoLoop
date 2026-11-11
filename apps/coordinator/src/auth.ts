import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { extraCommandNames, type Principal } from "@evoloop/contracts";

export const authConfigSchema = z.array(z.strictObject({
  token: z.string().min(32),
  actorId: z.string().min(1).max(100),
  projectIds: z.array(z.uuid()).min(1),
  permissions: z.array(z.enum(["read", "write", "review"])).min(1),
  // Read when the service starts: a change to the identity file takes effect after a restart.
  extraCommands: z.array(z.enum(extraCommandNames)).optional(),
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
/**
 * Some single credential of this actor grants every listed permission in the project. Grants of different credentials
 * are never added together: a request authenticates as exactly one credential (authenticate below).
 */
export function credentialGrants(credentials: AuthConfig, projectId: string, actorId: string,
  permissions: readonly ("read" | "write" | "review")[]): boolean {
  return credentials.some(entry => entry.actorId === actorId && entry.projectIds.includes(projectId) &&
    permissions.every(permission => entry.permissions.includes(permission)));
}
/** The business writer check (main.ts currentProjectWriter): one credential with read and write in the project. */
export const isProjectWriter = (credentials: AuthConfig, projectId: string, actorId: string): boolean =>
  credentialGrants(credentials, projectId, actorId, ["read", "write"]);
export function authenticate(header: string | undefined, credentials: AuthConfig): Principal | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = Buffer.from(header.slice(7));
  for (const entry of credentials) {
    const expected = Buffer.from(entry.token);
    if (token.length === expected.length && timingSafeEqual(token, expected)) {
      return { actorId: entry.actorId, projectIds: [...entry.projectIds], permissions: [...entry.permissions], ...(entry.extraCommands ? { extraCommands: [...entry.extraCommands] } : {}), identityKind: entry.identityKind ?? "agent" };
    }
  }
  return null;
}
