import { z } from "zod";

export const permissionNames = ["task", "document", "session", "management"] as const;
export type Permission = (typeof permissionNames)[number];
export const legacyPermissionNames = ["read", "write", "review"] as const;
export type LegacyPermission = (typeof legacyPermissionNames)[number];
export const extraCommandNames = ["document.archive", "document.restore"] as const;
export type ExtraCommand = (typeof extraCommandNames)[number];

/**
 * A project member may read ordinary project objects. `permissions` names the object classes it may write.
 * `decisions` applies the decision-class gate on top of the owning class; humans receive it with their class,
 * while an agent service identity must be granted it explicitly. `sessionIds` limits Session writes and full
 * native-record reads; an absent or empty list means every Session in the named projects.
 */
export interface Principal {
  actorId: string;
  projectIds: string[];
  permissions: Permission[];
  decisions?: boolean | undefined;
  sessionIds?: string[] | undefined;
  extraCommands?: ExtraCommand[] | undefined;
  identityKind?: "agent" | "human" | undefined;
  senderClass?: "requirements" | "leader" | "session" | undefined;
  /**
   * Where this principal came from, set only by the code that verified it: `hub` for an identity the Hub signed for this one request (HubIdentityVerifier). The local token file
   * cannot set it (principalFromAuthEntry copies fields by name), and nothing may infer it from an actor ID. A sender grant marked `senderKind: "hub"` counts only for `hub`.
   */
  origin?: "hub" | undefined;
}

export const authConfigSchema = z.array(z.strictObject({
  token: z.string().min(32),
  actorId: z.string().min(1).max(100),
  projectIds: z.array(z.uuid()).min(1),
  permissions: z.array(z.enum(permissionNames)).default([]),
  decisions: z.boolean().optional(),
  sessionIds: z.array(z.uuid()).optional(),
  extraCommands: z.array(z.enum(extraCommandNames)).optional(),
  identityKind: z.enum(["agent", "human"]).optional(),
  senderClass: z.enum(["requirements", "leader", "session"]).optional(),
})).min(1).refine(items => new Set(items.map(x => x.token)).size === items.length, "Tokens must be unique")
  .refine(items => {
    const kinds = new Map<string, string>();
    for (const item of items) for (const projectId of item.projectIds) {
      const key = `${projectId}:${item.actorId}`, kind = item.identityKind ?? "agent";
      if (kinds.has(key) && kinds.get(key) !== kind) return false;
      kinds.set(key, kind);
    }
    return true;
  }, "One actor cannot mix human and agent credentials in a project")
  .refine(items => {
    const classes = new Map<string, string | undefined>();
    for (const item of items) for (const projectId of item.projectIds) {
      const key = `${projectId}:${item.actorId}`;
      if (classes.has(key) && classes.get(key) !== item.senderClass) return false;
      classes.set(key, item.senderClass);
    }
    return true;
  }, "One actor's credentials must state the same senderClass in a project");
export type AuthConfig = z.infer<typeof authConfigSchema>;

export const legacyAuthConfigSchema = z.array(z.strictObject({
  token: z.string().min(32),
  actorId: z.string().min(1).max(100),
  projectIds: z.array(z.uuid()).min(1),
  permissions: z.array(z.enum(legacyPermissionNames)).min(1),
  extraCommands: z.array(z.enum(extraCommandNames)).optional(),
  identityKind: z.enum(["agent", "human"]).optional(),
  senderClass: z.enum(["requirements", "leader", "session"]).optional(),
}));
export type LegacyAuthConfig = z.infer<typeof legacyAuthConfigSchema>;

export function isProjectMember(principal: Principal, projectId: string): boolean {
  return principal.actorId.trim().length > 0 && principal.projectIds.includes(projectId);
}

export function hasPermission(principal: Principal, projectId: string, permission: Permission): boolean {
  return isProjectMember(principal, projectId) && principal.permissions.includes(permission);
}

export function hasAnyObjectPermission(principal: Principal, projectId: string): boolean {
  return hasPermission(principal, projectId, "task") ||
    hasPermission(principal, projectId, "document") ||
    hasPermission(principal, projectId, "session");
}

export function hasDecisionAuthority(principal: Principal, projectId: string, permission: Permission): boolean {
  return hasPermission(principal, projectId, permission) &&
    (principal.identityKind === "human" || principal.decisions === true);
}

export function hasAnyDecisionAuthority(principal: Principal, projectId: string): boolean {
  return (principal.identityKind === "human" || principal.decisions === true) &&
    isProjectMember(principal, projectId) && principal.permissions.length > 0;
}

export function mayAccessSession(principal: Principal, projectId: string, sessionId?: string): boolean {
  if (!hasPermission(principal, projectId, "session")) return false;
  if (!sessionId || !principal.sessionIds?.length) return true;
  return principal.sessionIds.includes(sessionId);
}

const legacyError = (cause: unknown) => {
  const detail = cause instanceof Error ? ` ${cause.message}` : "";
  return new Error("Legacy identity file (read/write/review) is not accepted. Convert it with " +
    "`evoloop identity migrate --input <legacy-file> --confirm-review-as-management`, review the output, and use it as EVOLOOP_AUTH_FILE." + detail);
};

/** Parse only the current format. A legacy file gets an actionable refusal rather than an unknown-enum error. */
export function parseAuthConfig(value: unknown): AuthConfig {
  const looksLegacy = Array.isArray(value) && value.some(entry => entry && typeof entry === "object" &&
    Array.isArray((entry as { permissions?: unknown }).permissions) &&
    (entry as { permissions: unknown[] }).permissions.some(permission => permission === "read" || permission === "write" || permission === "review"));
  if (looksLegacy) throw legacyError(null);
  try { return authConfigSchema.parse(value); }
  catch (error) { throw new Error("Invalid identity file. Use task/document/session/management permissions and see the identity migration guide." + (error instanceof Error ? ` ${error.message}` : "")); }
}

export interface AuthMigration {
  config: AuthConfig;
  changes: Array<{ actorId: string; from: string[]; to: Permission[]; decisions: boolean; note: string }>;
}

/**
 * Convert legacy entries without writing the file. `review` requires an explicit acknowledgement because it is being
 * mapped to project management; it is never converted silently.
 */
export function migrateLegacyAuthConfig(value: unknown, options: { confirmReviewAsManagement?: boolean } = {}): AuthMigration {
  const legacy = legacyAuthConfigSchema.parse(value);
  if (!options.confirmReviewAsManagement && legacy.some(entry => entry.permissions.includes("review")))
    throw new Error("The file grants legacy `review`. Add --confirm-review-as-management after reviewing the before/after table.");
  const changes: AuthMigration["changes"] = [];
  const config = authConfigSchema.parse(legacy.map(entry => {
    const permissions = new Set<Permission>();
    if (entry.permissions.includes("write")) {
      permissions.add("task");
      permissions.add("document");
      permissions.add("session");
    }
    if (entry.permissions.includes("review")) permissions.add("management");
    const decisions = entry.permissions.includes("review") ? true : undefined;
    const notes: string[] = [];
    if (entry.permissions.includes("read")) notes.push("read becomes project membership read");
    if (entry.permissions.includes("write")) notes.push("write becomes task, document and session writes");
    if (entry.permissions.includes("review")) notes.push("review explicitly becomes management plus decision authority");
    changes.push({ actorId: entry.actorId, from: [...entry.permissions], to: [...permissions], decisions: decisions === true, note: notes.join("; ") });
    return {
      token: entry.token, actorId: entry.actorId, projectIds: [...entry.projectIds], permissions: [...permissions],
      ...(decisions === undefined ? {} : { decisions }),
      ...(entry.extraCommands ? { extraCommands: [...entry.extraCommands] } : {}),
      ...(entry.identityKind ? { identityKind: entry.identityKind } : {}),
      ...(entry.senderClass ? { senderClass: entry.senderClass } : {}),
    };
  }));
  return { config, changes };
}

export function principalFromAuthEntry(entry: AuthConfig[number]): Principal {
  return {
    actorId: entry.actorId, projectIds: [...entry.projectIds], permissions: [...entry.permissions],
    ...(entry.decisions === undefined ? {} : { decisions: entry.decisions }),
    ...(entry.sessionIds === undefined ? {} : { sessionIds: [...entry.sessionIds] }),
    ...(entry.extraCommands ? { extraCommands: [...entry.extraCommands] } : {}),
    ...(entry.senderClass ? { senderClass: entry.senderClass } : {}),
    identityKind: entry.identityKind ?? "agent",
  };
}
