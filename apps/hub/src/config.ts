import { HubError } from "./errors.js";

export type HubConfig = {
  publicOrigin: string;
  port: number;
  host: string;
  sessionTtlMs: number;
  inviteTtlMs: number;
  loginMaxFailures: number;
  loginWindowMs: number;
  loginBlockMs: number;
  bodyLimitBytes: number;
};

const positiveInteger = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
};

export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HUB_PUBLIC_ORIGIN must be an absolute http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("HUB_PUBLIC_ORIGIN must use http or https.");
  if (url.username || url.password) throw new Error("HUB_PUBLIC_ORIGIN must not contain credentials.");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("HUB_PUBLIC_ORIGIN must be a bare origin.");
  return url.origin;
}

export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig & { databaseUrl: string } {
  const databaseUrl = loadHubDatabaseUrl(env);
  const publicOrigin = normalizeOrigin(env.HUB_PUBLIC_ORIGIN ?? "");
  return {
    databaseUrl,
    publicOrigin,
    port: positiveInteger(env.HUB_PORT, 4319, "HUB_PORT"),
    host: env.HUB_HOST ?? "127.0.0.1",
    sessionTtlMs: positiveInteger(env.HUB_SESSION_TTL_SECONDS, 12 * 60 * 60, "HUB_SESSION_TTL_SECONDS") * 1000,
    inviteTtlMs: positiveInteger(env.HUB_INVITE_TTL_SECONDS, 7 * 24 * 60 * 60, "HUB_INVITE_TTL_SECONDS") * 1000,
    loginMaxFailures: positiveInteger(env.HUB_LOGIN_MAX_FAILURES, 5, "HUB_LOGIN_MAX_FAILURES"),
    loginWindowMs: positiveInteger(env.HUB_LOGIN_WINDOW_SECONDS, 15 * 60, "HUB_LOGIN_WINDOW_SECONDS") * 1000,
    loginBlockMs: positiveInteger(env.HUB_LOGIN_BLOCK_SECONDS, 15 * 60, "HUB_LOGIN_BLOCK_SECONDS") * 1000,
    bodyLimitBytes: positiveInteger(env.HUB_BODY_LIMIT_BYTES, 64 * 1024, "HUB_BODY_LIMIT_BYTES"),
  };
}

export function loadHubDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = env.HUB_DATABASE_URL;
  if (!databaseUrl) throw new Error("Set HUB_DATABASE_URL to the dedicated Hub database.");
  const projectDatabaseUrl = env.EVOLOOP_DATABASE_URL;
  if (projectDatabaseUrl && databaseIdentity(databaseUrl) === databaseIdentity(projectDatabaseUrl)) {
    throw new Error("HUB_DATABASE_URL must identify a database separate from EVOLOOP_DATABASE_URL.");
  }
  return databaseUrl;
}

function databaseIdentity(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Database URLs must be valid PostgreSQL URLs.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Database URLs must use PostgreSQL.");
  return `${url.hostname.toLowerCase()}:${url.port || "5432"}${url.pathname}`;
}

export function assertSameOrigin(origin: string | undefined, expected: string): void {
  if (!origin) throw new HubError(403, "ORIGIN_REQUIRED", "A same-origin Origin header is required.");
  if (origin !== expected) throw new HubError(403, "ORIGIN_MISMATCH", "The request origin is not allowed.");
}
