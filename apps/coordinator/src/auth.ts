import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";

export const authConfigSchema = z.array(z.strictObject({
  token: z.string().min(32),
  actorId: z.string().min(1).max(100),
  projectIds: z.array(z.uuid()).min(1),
  permissions: z.array(z.enum(["read", "write", "review"])).min(1),
})).min(1).refine(items => new Set(items.map(x => x.token)).size === items.length, "Tokens must be unique");
export type AuthConfig = z.infer<typeof authConfigSchema>;
export function authenticate(header: string | undefined, credentials: AuthConfig): Principal | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = Buffer.from(header.slice(7));
  for (const entry of credentials) {
    const expected = Buffer.from(entry.token);
    if (token.length === expected.length && timingSafeEqual(token, expected)) {
      return { actorId: entry.actorId, projectIds: [...entry.projectIds], permissions: [...entry.permissions] };
    }
  }
  return null;
}
