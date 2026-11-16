import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { MachineCredentials, Principal } from "@evoloop/contracts";

export class HubIdentityError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "HubIdentityError";
  }
}

const IDENTITY_DOMAIN = "evoloop-hub-identity-v1";
const SKEW_SECONDS = 5;
const MAX_LIFETIME_SECONDS = 60;
const uuid = z.uuid();

const payloadSchema = z.strictObject({
  v: z.literal(1),
  kid: z.string().min(1).max(100),
  aud: uuid,
  jti: z.string().min(8).max(100),
  iat: z.number().int(),
  exp: z.number().int(),
  sub: z.strictObject({
    actorId: z.string().min(1).max(100),
    kind: z.enum(["human", "service"]),
    accountId: z.string().max(100).optional(),
    serviceIdentityId: z.string().max(100).optional(),
    auth: z.string().max(40),
  }),
  projectId: uuid,
  permissions: z.array(z.enum(["task", "document", "session", "management"])).max(4),
  decisions: z.boolean(),
  sessionIds: z.array(z.string().min(1).max(200)).max(500),
  method: z.string().min(1).max(10),
  target: z.string().min(1).max(100),
});
export type HubIdentity = z.infer<typeof payloadSchema>;

export type HubIdentityDeps = {
  /** The machine's credentials as of now; null when it has none (not joined, or it left). */
  credentials(): MachineCredentials | null;
  /** Whether this coordinator holds the project (its database has it). */
  isLocalProject(projectId: string): Promise<boolean>;
  /** Actor IDs of the identities in this machine's own token file; a Hub account may not take one of them. */
  localActorIds(): ReadonlySet<string>;
  now?: () => number;
};

const PROJECT_PATH = /^\/api\/projects\/([0-9a-f-]{36})\//i;

/**
 * Accepts the identity the Hub signed for one request, and nothing else. Every check fails closed and answers the caller only "not accepted";
 * the reason is for the machine's own log.
 */
export class HubIdentityVerifier {
  private readonly seen = new Map<string, number>();
  constructor(private readonly deps: HubIdentityDeps) {}

  async verify(header: string, request: { method: string; url: string }): Promise<{ principal: Principal; identity: HubIdentity }> {
    const credentials = this.deps.credentials();
    if (!credentials) throw new HubIdentityError("this machine has no Hub credentials");
    const parts = header.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) throw new HubIdentityError("malformed identity");
    let payload: HubIdentity;
    try {
      payload = payloadSchema.parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    } catch {
      throw new HubIdentityError("unreadable identity payload");
    }
    const key = credentials.hubPublicKeys.find(item => item.kid === payload.kid);
    if (!key) throw new HubIdentityError("unknown Hub key");
    let valid = false;
    try {
      valid = verify(null, Buffer.from(`${IDENTITY_DOMAIN}\n${parts[1]}`), createPublicKey(key.publicKey), Buffer.from(parts[2], "base64url"));
    } catch { /* invalid key material is not valid */ }
    if (!valid) throw new HubIdentityError("bad signature");
    const now = Math.floor((this.deps.now ?? Date.now)() / 1000);
    if (payload.aud !== credentials.machineId) throw new HubIdentityError("issued for another machine");
    if (payload.exp <= now - 0) throw new HubIdentityError("expired");
    if (payload.iat > now + SKEW_SECONDS || payload.exp - payload.iat > MAX_LIFETIME_SECONDS) throw new HubIdentityError("lifetime not allowed");
    if (payload.method !== request.method.toUpperCase()) throw new HubIdentityError("issued for another method");
    if (payload.target !== createHash("sha256").update(request.url, "utf8").digest("base64url")) throw new HubIdentityError("issued for another target");
    const projectInPath = PROJECT_PATH.exec(request.url)?.[1]?.toLowerCase();
    if (projectInPath && projectInPath !== payload.projectId) throw new HubIdentityError("project differs from the path");
    if (!projectInPath && request.url.split("?", 1)[0] !== "/api/commands") throw new HubIdentityError("not a path the Hub forwards");
    if (this.deps.localActorIds().has(payload.sub.actorId)) throw new HubIdentityError("actor is a local identity of this machine");
    if (!await this.deps.isLocalProject(payload.projectId)) throw new HubIdentityError("project is not on this machine");
    // One use each: a signed identity captured on the loopback hop cannot be played again inside its minute.
    for (const [jti, expires] of this.seen) if (expires <= now) this.seen.delete(jti);
    if (this.seen.has(payload.jti)) throw new HubIdentityError("identity already used");
    this.seen.set(payload.jti, payload.exp);
    const principal: Principal = {
      actorId: payload.sub.actorId,
      projectIds: [payload.projectId],
      permissions: [...payload.permissions],
      identityKind: payload.sub.kind === "human" ? "human" : "agent",
      ...(payload.decisions ? { decisions: true } : {}),
      ...(payload.sessionIds.length ? { sessionIds: [...payload.sessionIds] } : {}),
    };
    return { principal, identity: payload };
  }
}
