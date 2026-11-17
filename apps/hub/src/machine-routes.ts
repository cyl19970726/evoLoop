import { createPublicKey, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { authenticate, assertCsrf, type Principal } from "./auth.js";
import type { HubConfig } from "./config.js";
import { HubError } from "./errors.js";
import type { ConflictRecord, Gateway } from "./gateway.js";
import { IDENTITY_TTL_SECONDS, bodyDigest, machineRequestMessage, signIdentity, targetDigest, verifyMachineSignature } from "./identity.js";
import type { MachineRecord, MachineStore } from "./machines.js";
import type { HubService } from "./service.js";
import type { HubStore } from "./store.js";
import { asRecord, textField } from "./validation.js";

export const MACHINE_CONTENT_TYPE = "application/vnd.evoloop-machine+json";
const SKEW_MS = 60_000;
const SAFE_SEGMENT = /^[A-Za-z0-9._~%!$&'()*+,;=:@-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORWARDED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const publicMachine = (machine: MachineRecord, online: boolean, connectedAt: string | null, conflict: ConflictRecord | null) => ({
  machineId: machine.machineId, name: machine.name, state: machine.state, online, connectedAt, allowedRoots: machine.allowedRoots, hostLabel: machine.hostLabel,
  createdAt: machine.createdAt, joinedAt: machine.joinedAt, removedAt: machine.removedAt, lastSeenAt: machine.lastSeenAt,
  // Connections refused because another process was already connected as this machine, since the Hub started (null: none).
  connectionConflicts: conflict ? { count: conflict.count, lastAt: conflict.lastAt } : null,
});
const INSTANCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalise what follows `/api/projects/<id>/` into a path the Hub is willing to hand to a machine: plain segments only. No empty, `.` or `..`
 * segment (also percent-encoded), no encoded slash or backslash, no scheme, authority or fragment. The machine checks the same again.
 */
export function safeProjectPath(projectId: string, rest: string, rawQuery: string): string {
  const segments = rest.split("/");
  if (!rest || segments.some(segment => !SAFE_SEGMENT.test(segment))) throw new HubError(400, "INVALID_PATH", "The path is not a project API path.");
  for (const segment of segments) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new HubError(400, "INVALID_PATH", "The path is not a project API path."); }
    if (decoded === "." || decoded === ".." || /[\\/\u0000-\u001f]/.test(decoded)) throw new HubError(400, "INVALID_PATH", "The path is not a project API path.");
  }
  if (rawQuery && /[\u0000- #]/.test(rawQuery)) throw new HubError(400, "INVALID_PATH", "The query string is not allowed.");
  return `/api/projects/${projectId}/${rest}${rawQuery ? `?${rawQuery}` : ""}`;
}

export function registerMachineRoutes(app: FastifyInstance, deps: {
  config: HubConfig; store: HubStore; service: HubService; machines: MachineStore; gateway: Gateway;
}): void {
  const { config, store, machines, gateway } = deps;
  const nonces = new Map<string, number>();
  const clock = (): Date => deps.service.clock();

  // Machine requests carry a signature over their own bytes, so they are read as text and parsed by the route.
  app.addContentTypeParser(MACHINE_CONTENT_TYPE, { parseAs: "string" }, (_request, body, done) => done(null, body));

  const principalFor = async (request: FastifyRequest): Promise<Principal> => {
    const principal = await authenticate(store, request, clock());
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in or provide a bearer token.");
    return principal;
  };
  const requireAdmin = async (request: FastifyRequest, write: boolean): Promise<Principal & { kind: "human" }> => {
    const principal = await principalFor(request);
    if (principal.kind !== "human" || !principal.hubAdmin || principal.projectScope) {
      throw new HubError(403, "HUB_ADMIN_REQUIRED", "Hub administrator permission is required.");
    }
    if (write) assertCsrf(request, principal);
    return principal;
  };

  // ---- administrators: register a machine and get a one-time join code ----
  app.post("/api/admin/machines", async (request, reply) => {
    const admin = await requireAdmin(request, true);
    const name = textField(asRecord(request.body), "name", { min: 1, max: 120 });
    const now = clock();
    const { machine, code, expiresAt } = await machines.create({ name, createdBy: admin.accountId, at: now });
    await store.audit(store.pool, { at: now, actorKind: "human", actorId: admin.actorId, action: "machine.created", subject: machine.machineId, detail: { name } });
    return reply.code(201).send({
      machine: publicMachine(machine, false, null, null),
      joinCode: code,
      expiresAt: expiresAt.toISOString(),
      joinCommand: `evoloop machine join --hub ${config.publicOrigin} --code <code> --workspace-root <allowed-root>`,
    });
  });

  app.get("/api/admin/machines", async request => {
    await requireAdmin(request, false);
    return { machines: (await machines.list()).map(machine => publicMachine(machine, gateway.online(machine.machineId), gateway.connectedAt(machine.machineId), gateway.conflictRecord(machine.machineId))) };
  });

  app.delete("/api/admin/machines/:machineId", async (request, reply) => {
    const admin = await requireAdmin(request, true);
    const machineId = (request.params as { machineId: string }).machineId;
    if (!UUID.test(machineId)) throw new HubError(400, "INVALID_ID", "machineId must be a UUID.");
    const now = clock();
    const removed = await machines.remove(machineId, now);
    gateway.disconnect(machineId, "machine_removed");
    if (!removed) throw new HubError(404, "MACHINE_NOT_FOUND", "No active machine with that ID exists.");
    await store.audit(store.pool, { at: now, actorKind: "human", actorId: admin.actorId, action: "machine.removed", subject: machineId, detail: {} });
    return reply.code(204).send();
  });

  // ---- the machine, authenticated by its own signature ----
  const machineFor = async (request: FastifyRequest, action: string, raw: string): Promise<MachineRecord> => {
    const header = (name: string): string => {
      const value = request.headers[name];
      return (Array.isArray(value) ? value[0] : value) ?? "";
    };
    const machineId = header("x-evoloop-machine"), timestamp = header("x-evoloop-machine-time"), nonce = header("x-evoloop-machine-nonce"), signature = header("x-evoloop-machine-signature");
    if (!UUID.test(machineId) || !timestamp || nonce.length < 16 || nonce.length > 100 || !signature) {
      throw new HubError(401, "MACHINE_AUTH_REQUIRED", "A signed machine request is required.");
    }
    const at = Number(timestamp);
    const now = clock().getTime();
    if (!Number.isFinite(at) || Math.abs(now - at) > SKEW_MS) throw new HubError(401, "MACHINE_REQUEST_STALE", "The request time is outside the allowed window.");
    const machine = await machines.get(machineId);
    if (!machine || machine.state === "pending") throw new HubError(401, "MACHINE_AUTH_FAILED", "The machine signature was not accepted.");
    if (machine.state === "removed") throw new HubError(401, "MACHINE_REMOVED", "This machine was removed from the Hub.");
    if (!machine.publicKey || !verifyMachineSignature(machine.publicKey, machineRequestMessage(machineId, action, timestamp, nonce, bodyDigest(raw)), signature)) {
      throw new HubError(401, "MACHINE_AUTH_FAILED", "The machine signature was not accepted.");
    }
    // A nonce is good once, so a captured request cannot be replayed inside the time window.
    for (const [key, expires] of nonces) if (expires < now) nonces.delete(key);
    const key = `${machineId}:${nonce}`;
    if (nonces.has(key)) throw new HubError(401, "MACHINE_REQUEST_REPLAYED", "This signed request was already used.");
    nonces.set(key, now + 2 * SKEW_MS);
    return machine;
  };
  const rawBody = (request: FastifyRequest): string => (typeof request.body === "string" ? request.body : "");
  /** The connector's per-process random ID (not a credential): which process of the machine a connection, a beat or an answer comes from. */
  const instanceOf = (request: FastifyRequest): string | null => {
    const value = request.headers["x-evoloop-machine-instance"];
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === "string" && INSTANCE.test(text) ? text.toLowerCase() : null;
  };

  app.post("/api/machine/join", async (request, reply) => {
    const record = asRecord(request.body);
    const code = typeof record.code === "string" ? record.code.trim() : "";
    const publicKey = typeof record.publicKey === "string" ? record.publicKey : "";
    if (!code || code.length > 200) throw new HubError(400, "INVALID_INPUT", "code is required.");
    try {
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    } catch {
      throw new HubError(400, "INVALID_PUBLIC_KEY", "publicKey must be an Ed25519 public key in PEM form.");
    }
    const allowedRoots = Array.isArray(record.allowedRoots) ? record.allowedRoots.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length < 1000).slice(0, 20) : [];
    const hostLabel = typeof record.hostLabel === "string" && record.hostLabel.trim() ? record.hostLabel.trim().slice(0, 120) : null;
    const now = clock();
    const machine = await machines.join({ code, publicKey, allowedRoots, hostLabel, at: now });
    await store.audit(store.pool, { at: now, actorKind: "system", actorId: null, action: "machine.joined", subject: machine.machineId, detail: { name: machine.name, allowedRoots } });
    await machines.activeSigningKey(now);
    return reply.code(201).send({ machineId: machine.machineId, name: machine.name, hubPublicKeys: await machines.publicKeys() });
  });

  // The machine's long connection: it asks once, signed, and the answer never ends — frames, one JSON object per line, until either side closes.
  app.post("/api/machine/connect", async (request, reply) => {
    const machine = await machineFor(request, "connect", "");
    const instance = instanceOf(request);
    // A second live process is refused inside attach, before the stream is opened: the answer is an ordinary 409 the connector can read.
    const attached = gateway.attach(machine.machineId, () => {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
      return raw;
    }, instance);
    await machines.touch(machine.machineId, clock());
    const raw = reply.raw;
    // The response closes when the connection does (the request stream may end sooner, so it is not the signal).
    raw.on("close", () => attached.detach());
  });

  app.post("/api/machine/heartbeat", async (request, reply) => {
    const machine = await machineFor(request, "heartbeat", rawBody(request));
    const connected = gateway.beat(machine.machineId, instanceOf(request));
    await machines.touch(machine.machineId, clock());
    return reply.send({ ok: true, connected });
  });

  app.post("/api/machine/respond", async (request, reply) => {
    const raw = rawBody(request);
    const machine = await machineFor(request, "respond", raw);
    let record: Record<string, unknown>;
    try { record = asRecord(JSON.parse(raw)); } catch { throw new HubError(400, "INVALID_INPUT", "The response frame is not JSON."); }
    const id = typeof record.id === "string" ? record.id : "";
    const status = typeof record.status === "number" && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599 ? record.status : 0;
    if (!id || !status) throw new HubError(400, "INVALID_INPUT", "id and status are required.");
    const body = typeof record.body === "string" ? Buffer.from(record.body, "base64") : Buffer.alloc(0);
    const accepted = gateway.respond(machine.machineId, { id, status, contentType: typeof record.contentType === "string" ? record.contentType : null, body }, instanceOf(request));
    if (!accepted) throw new HubError(404, "REQUEST_NOT_PENDING", "No request with this ID is waiting on this machine.");
    return reply.code(204).send();
  });

  app.post("/api/machine/status", async (request, reply) => {
    const machine = await machineFor(request, "status", rawBody(request));
    return reply.send({ machineId: machine.machineId, name: machine.name, state: machine.state, online: gateway.online(machine.machineId), serverTime: clock().toISOString() });
  });

  app.post("/api/machine/leave", async (request, reply) => {
    const machine = await machineFor(request, "leave", rawBody(request));
    const now = clock();
    await machines.remove(machine.machineId, now);
    gateway.disconnect(machine.machineId, "machine_left");
    await store.audit(store.pool, { at: now, actorKind: "system", actorId: null, action: "machine.left", subject: machine.machineId, detail: {} });
    return reply.code(204).send();
  });

  // ---- forwarding: the Hub looks the project up, decides, signs an identity, and hands the request to the project's machine ----
  const accessFor = async (principal: Principal, projectId: string): Promise<{
    permissions: Array<"task" | "document" | "session" | "management">; decisions: boolean; sessionIds: string[];
    sub: { actorId: string; kind: "human" | "service"; accountId?: string; serviceIdentityId?: string; auth: string };
  }> => {
    if (principal.kind === "human") {
      if (principal.projectScope && principal.projectScope !== projectId) throw new HubError(403, "PROJECT_ACCESS_DENIED", "This token is limited to another project.");
      const member = await store.getMembership(projectId, principal.accountId);
      if (!member) throw new HubError(403, "PROJECT_ACCESS_DENIED", "You are not a member of this project.");
      const permissions: Array<"task" | "document" | "session" | "management"> = [];
      if (member.canTask) permissions.push("task");
      if (member.canDocument) permissions.push("document");
      if (member.canSession) permissions.push("session");
      if (member.isProjectAdmin) permissions.push("management");
      return { permissions, decisions: true, sessionIds: member.sessionIds, sub: { actorId: principal.actorId, kind: "human", accountId: principal.accountId, auth: principal.auth } };
    }
    if (!principal.projectIds.includes(projectId)) throw new HubError(403, "PROJECT_ACCESS_DENIED", "This service identity is not scoped to the project.");
    const grant = await store.getServiceGrant(principal.serviceIdentityId, projectId);
    if (!grant) throw new HubError(403, "PROJECT_ACCESS_DENIED", "This service identity is not scoped to the project.");
    const permissions: Array<"task" | "document" | "session" | "management"> = [];
    if (grant.canTask) permissions.push("task");
    if (grant.canDocument) permissions.push("document");
    if (grant.canSession) permissions.push("session");
    return { permissions, decisions: grant.decisions, sessionIds: grant.sessionIds, sub: { actorId: principal.actorId, kind: "service", serviceIdentityId: principal.serviceIdentityId, auth: principal.auth } };
  };

  const forward = async (request: FastifyRequest, reply: import("fastify").FastifyReply, projectId: string, requested: string, body: unknown) => {
    let path = requested;
    const principal = await principalFor(request);
    if (principal.kind === "human" && principal.auth === "cookie" && request.method !== "GET") assertCsrf(request, principal);
    const access = await accessFor(principal, projectId);
    const project = await store.getProject(projectId);
    if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "The project does not exist.");
    const machineId = project.machineId;
    // A placeholder that is not a registered machine's ID (the Hub kept free text there before machines existed) is no machine.
    if (!machineId || !UUID.test(machineId)) throw new HubError(409, "PROJECT_HAS_NO_MACHINE", "No machine is registered for this project.");
    const machine = await machines.get(machineId);
    if (!machine || machine.state !== "active") throw new HubError(409, "PROJECT_HAS_NO_MACHINE", "No active machine is registered for this project.");
    // The machine re-serialises the path when it sends it on; the digest is over that same form, so a query with characters the URL parser rewrites still matches.
    const url = new URL(path, "http://machine.invalid");
    path = `${url.pathname}${url.search}`;
    const key = await machines.activeSigningKey(clock());
    const now = Math.floor(clock().getTime() / 1000);
    const method = request.method.toUpperCase();
    const identity = signIdentity(key, {
      aud: machine.machineId, jti: randomUUID(), iat: now, exp: now + IDENTITY_TTL_SECONDS, sub: access.sub, projectId,
      permissions: access.permissions, decisions: access.decisions, sessionIds: access.sessionIds, method, target: targetDigest(path),
    });
    const payload = body === undefined || body === null || method === "GET" ? null : Buffer.from(JSON.stringify(body), "utf8");
    const response = await gateway.forward(machine.machineId, { method, path, identity, contentType: payload ? "application/json" : null, body: payload });
    if (method !== "GET") {
      await store.audit(store.pool, { at: clock(), actorKind: principal.kind === "human" ? "human" : "service", actorId: principal.actorId, action: "forward.request", projectId,
        subject: machine.machineId, detail: { method, path: path.split("?", 1)[0], status: response.status } });
    }
    reply.code(response.status);
    if (response.contentType) reply.type(response.contentType);
    return reply.send(response.body);
  };

  for (const method of FORWARDED_METHODS) {
    app.route({
      method, url: "/api/projects/:projectId/*", bodyLimit: config.forwardBodyLimitBytes ?? 128 * 1024,
      handler: async (request, reply) => {
        const params = request.params as { projectId: string; "*": string };
        if (!UUID.test(params.projectId)) throw new HubError(400, "INVALID_ID", "projectId must be a UUID.");
        // Members and the rest of project administration are the Hub's own; they are never handed to a machine.
        if (params["*"] === "members" || params["*"].startsWith("members/")) throw new HubError(404, "NOT_FOUND", "The Hub route does not exist.");
        const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "";
        const path = safeProjectPath(params.projectId.toLowerCase(), params["*"], query);
        return forward(request, reply, params.projectId.toLowerCase(), path, request.body);
      },
    });
  }

  app.post("/api/commands", { bodyLimit: config.forwardBodyLimitBytes ?? 128 * 1024 }, async (request, reply) => {
    const record = asRecord(request.body);
    const projectId = typeof record.projectId === "string" ? record.projectId : "";
    if (!UUID.test(projectId)) throw new HubError(400, "INVALID_INPUT", "projectId must be a UUID.");
    return forward(request, reply, projectId.toLowerCase(), "/api/commands", request.body);
  });

}
