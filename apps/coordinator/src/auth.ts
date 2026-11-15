import { timingSafeEqual } from "node:crypto";
import { authConfigSchema, hasDecisionAuthority, hasPermission, isProjectMember, mayAccessSession,
  principalFromAuthEntry, type AuthConfig, type Permission, type Principal } from "@evoloop/contracts";
export { authConfigSchema, legacyAuthConfigSchema, migrateLegacyAuthConfig, parseAuthConfig,
  type AuthConfig, type LegacyAuthConfig } from "@evoloop/contracts";

/** A study declaration keeps authority only while its actual reviewer credential remains configured. */
export function hasCurrentStudyReviewer(credentials: AuthConfig, projectId: string, actorId: string): boolean {
  const entries = credentials.filter(entry => entry.actorId === actorId && entry.projectIds.includes(projectId));
  // Equivalent tokens for one identity may overlap during rotation. Never combine partial grants.
  return entries.length > 0 && entries.every(entry => {
    const principal = principalFromAuthEntry(entry);
    return hasDecisionAuthority(principal, projectId, "management");
  });
}
/**
 * Some single credential of this actor grants every listed permission in the project. Grants of different credentials
 * are never added together: a request authenticates as exactly one credential (authenticate below).
 */
export function credentialGrants(credentials: AuthConfig, projectId: string, actorId: string,
  permissions: readonly Permission[], options: { decisions?: boolean } = {}): boolean {
  return credentials.some(entry => entry.actorId === actorId && entry.projectIds.includes(projectId) &&
    permissions.every(permission => entry.permissions.includes(permission)) &&
    (!options.decisions || entry.identityKind === "human" || entry.decisions === true));
}
/** The generic current-writer check: membership plus at least one object-write class. Object-specific gates follow. */
export const isProjectWriter = (credentials: AuthConfig, projectId: string, actorId: string): boolean =>
  credentials.some(entry => {
    const principal = principalFromAuthEntry(entry);
    return principal.actorId === actorId && isProjectMember(principal, projectId) &&
      ["task", "document", "session"].some(permission => hasPermission(principal, projectId, permission as Permission));
  });

export function credentialMember(credentials: AuthConfig, projectId: string, actorId: string): Principal | null {
  const entry = credentials.find(value => value.actorId === actorId && value.projectIds.includes(projectId));
  return entry ? principalFromAuthEntry(entry) : null;
}

export function credentialMayReadSession(credentials: AuthConfig, projectId: string, actorId: string, sessionId: string): boolean {
  return credentials.some(entry => {
    if (entry.actorId !== actorId) return false;
    const principal = principalFromAuthEntry(entry);
    return hasPermission(principal, projectId, "session") && mayAccessSession(principal, projectId, sessionId);
  });
}

export function authenticate(header: string | undefined, credentials: AuthConfig): Principal | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = Buffer.from(header.slice(7));
  for (const entry of credentials) {
    const expected = Buffer.from(entry.token);
    if (token.length === expected.length && timingSafeEqual(token, expected)) return principalFromAuthEntry(entry);
  }
  return null;
}
