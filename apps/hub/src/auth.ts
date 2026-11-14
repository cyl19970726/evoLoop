import type { FastifyRequest } from "fastify";
import { csrfTokenFor, hashToken, tokenMatches } from "./ids.js";
import { SESSION_COOKIE, parseCookie } from "./cookies.js";
import type { HubStore } from "./store.js";
import { HubError } from "./errors.js";

export type HumanPrincipal = {
  kind: "human";
  accountId: string;
  actorId: string;
  email: string;
  displayName: string;
  hubAdmin: boolean;
  auth: "cookie" | "token";
  sessionId: string | null;
  tokenId: string | null;
  projectScope: string | null;
};

export type ServicePrincipal = {
  kind: "service";
  serviceIdentityId: string;
  actorId: string;
  displayName: string;
  ownerAccountId: string;
  ownerName: string;
  purpose: string;
  projectIds: string[];
  auth: "service-token";
};

export type Principal = HumanPrincipal | ServicePrincipal;

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export function cookieSessionToken(request: FastifyRequest): string | null {
  return parseCookie(headerValue(request.headers.cookie), SESSION_COOKIE);
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = headerValue(request.headers.authorization);
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

export async function authenticate(store: HubStore, request: FastifyRequest, at: Date): Promise<Principal | null> {
  const bearer = bearerToken(request);
  if (bearer) {
    const tokenHash = hashToken(bearer);
    const personal = await store.findPersonalToken(tokenHash, at);
    if (personal) {
      await store.touchPersonalToken(store.pool, personal.token.tokenId, at);
      return {
        kind: "human",
        accountId: personal.account.accountId,
        actorId: personal.account.actorId,
        email: personal.account.email,
        displayName: personal.account.displayName,
        hubAdmin: personal.account.isHubAdmin,
        auth: "token",
        sessionId: null,
        tokenId: personal.token.tokenId,
        projectScope: personal.token.projectId,
      };
    }
    const service = await store.findServiceIdentityByTokenHash(tokenHash);
    if (!service) return null;
    return {
      kind: "service",
      serviceIdentityId: service.serviceIdentityId,
      actorId: service.actorId,
      displayName: service.displayName,
      ownerAccountId: service.ownerAccountId,
      ownerName: service.ownerName,
      purpose: service.purpose,
      projectIds: service.projectIds,
      auth: "service-token",
    };
  }
  const cookieToken = cookieSessionToken(request);
  if (!cookieToken) return null;
  const found = await store.findLoginSession(hashToken(cookieToken), at);
  if (!found) return null;
  await store.touchLoginSession(store.pool, found.session.sessionId, at);
  return {
    kind: "human",
    accountId: found.account.accountId,
    actorId: found.account.actorId,
    email: found.account.email,
    displayName: found.account.displayName,
    hubAdmin: found.account.isHubAdmin,
    auth: "cookie",
    sessionId: found.session.sessionId,
    tokenId: null,
    projectScope: null,
  };
}

export function assertCsrf(request: FastifyRequest, principal: Principal, formToken?: unknown): void {
  if (principal.kind !== "human" || principal.auth !== "cookie") return;
  const cookieToken = cookieSessionToken(request);
  if (!cookieToken) throw new HubError(401, "SESSION_REQUIRED", "A login session is required.");
  const supplied = headerValue(request.headers["x-hub-csrf"]) ?? (typeof formToken === "string" ? formToken : "");
  if (!supplied || !tokenMatches(csrfTokenFor(cookieToken), supplied)) {
    throw new HubError(403, "CSRF_REQUIRED", "A valid CSRF token is required for this request.");
  }
}

export function sessionCsrfToken(request: FastifyRequest, principal: Principal): string | null {
  if (principal.kind !== "human" || principal.auth !== "cookie") return null;
  const token = cookieSessionToken(request);
  return token ? csrfTokenFor(token) : null;
}
