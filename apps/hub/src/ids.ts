import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const newId = (): string => crypto.randomUUID();

export const newToken = (): string => randomBytes(32).toString("base64url");

export const hashToken = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const csrfTokenFor = (sessionToken: string): string =>
  createHash("sha256").update(`evoloop-hub-csrf:${sessionToken}`, "utf8").digest("base64url");

export function tokenMatches(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
