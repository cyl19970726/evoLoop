import { HubError } from "./errors.js";

export type Permissions = {
  canTask: boolean;
  canDocument: boolean;
  canSession: boolean;
};

export type MemberInput = Permissions & {
  sessionIds: string[];
  isProjectAdmin: boolean;
};

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HubError(400, "INVALID_BODY", "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function textField(
  record: Record<string, unknown>,
  name: string,
  options: { min?: number; max?: number; fallback?: string } = {},
): string {
  const value = record[name];
  if (value === undefined) {
    if (options.fallback !== undefined) return options.fallback;
    throw new HubError(400, "INVALID_INPUT", `${name} is required.`);
  }
  if (typeof value !== "string") throw new HubError(400, "INVALID_INPUT", `${name} must be text.`);
  const text = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 500;
  if (text.length < min || text.length > max) {
    throw new HubError(400, "INVALID_INPUT", `${name} must contain between ${min} and ${max} characters.`);
  }
  return text;
}

export function optionalTextField(
  record: Record<string, unknown>,
  name: string,
  options: { max?: number } = {},
): string | null {
  const value = record[name];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HubError(400, "INVALID_INPUT", `${name} must be text.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > (options.max ?? 500)) {
    throw new HubError(400, "INVALID_INPUT", `${name} is too long.`);
  }
  return text;
}

export function emailField(record: Record<string, unknown>, name = "email"): string {
  const email = textField(record, name, { min: 3, max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HubError(400, "INVALID_EMAIL", "Enter a valid email address.");
  return email;
}

export function optionalEmailField(record: Record<string, unknown>, name = "email"): string | null {
  const value = record[name];
  if (value === undefined || value === null || value === "") return null;
  return emailField(record, name);
}

export function uuidField(record: Record<string, unknown>, name: string): string {
  const value = textField(record, name, { min: 36, max: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HubError(400, "INVALID_ID", `${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function optionalUuidField(record: Record<string, unknown>, name: string): string | null {
  const value = record[name];
  if (value === undefined || value === null || value === "") return null;
  return uuidField(record, name);
}

export function booleanField(record: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = record[name];
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "on" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new HubError(400, "INVALID_INPUT", `${name} must be true or false.`);
}

export function permissionsFrom(record: Record<string, unknown>, fallback = false): Permissions {
  const value = record.permissions;
  if (value === undefined) {
    return {
      canTask: booleanField(record, "canTask", fallback),
      canDocument: booleanField(record, "canDocument", fallback),
      canSession: booleanField(record, "canSession", fallback),
    };
  }
  const permissions = asRecord(value);
  return {
    canTask: booleanField(permissions, "task", fallback),
    canDocument: booleanField(permissions, "document", fallback),
    canSession: booleanField(permissions, "session", fallback),
  };
}

export function memberInput(
  record: Record<string, unknown>,
  options: { defaultPermissions?: boolean; defaultAdmin?: boolean } = {},
): MemberInput {
  const permissions = permissionsFrom(record, options.defaultPermissions ?? false);
  return {
    ...permissions,
    sessionIds: sessionIdsFrom(record.sessionIds),
    isProjectAdmin: booleanField(record, "isProjectAdmin", options.defaultAdmin ?? false),
  };
}

export function sessionIdsFrom(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!values) throw new HubError(400, "INVALID_SESSION_IDS", "sessionIds must be a list.");
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") throw new HubError(400, "INVALID_SESSION_IDS", "Every Session ID must be text.");
    const value = raw.trim();
    if (!value) continue;
    if (value.length > 200) throw new HubError(400, "INVALID_SESSION_IDS", "A Session ID is too long.");
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  if (unique.length > 200) throw new HubError(400, "INVALID_SESSION_IDS", "At most 200 Session IDs can be listed.");
  return unique;
}

export function assertMemberUsable(input: MemberInput): void {
  if (!input.isProjectAdmin && !input.canTask && !input.canDocument && !input.canSession) {
    throw new HubError(400, "EMPTY_PERMISSIONS", "A member needs a project permission or the project-admin role.");
  }
}

export function optionalFutureDate(record: Record<string, unknown>, name: string, now: Date, maxDays = 30): Date | null {
  const value = record[name];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HubError(400, "INVALID_INPUT", `${name} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new HubError(400, "INVALID_INPUT", `${name} must be an ISO timestamp.`);
  if (parsed.getTime() <= now.getTime()) throw new HubError(400, "INVALID_INPUT", `${name} must be in the future.`);
  if (parsed.getTime() > now.getTime() + maxDays * 86_400_000) {
    throw new HubError(400, "INVALID_INPUT", `${name} is too far in the future.`);
  }
  return parsed;
}
