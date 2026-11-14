import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assertCsrf, authenticate, sessionCsrfToken, type Principal } from "./auth.js";
import { clearSessionCookie, sessionCookie } from "./cookies.js";
import type { HubConfig } from "./config.js";
import { HubError } from "./errors.js";
import {
  adminPage,
  dashboardPage,
  errorPage,
  loginPage,
  oneTimeSecretPage,
  projectPage,
  registerPage,
} from "./pages.js";
import {
  hasMachineField,
  HubService,
  parseAuditLimit,
  parseInviteBody,
  parseMemberBody,
  parseProjectBody,
  parseServiceIdentityBody,
  parseTokenBody,
} from "./service.js";
import type { HubStore } from "./store.js";
import {
  asRecord,
  assertMemberUsable,
  booleanField,
  emailField,
  memberInput,
  optionalFutureDate,
  optionalTextField,
  permissionsFrom,
  sessionIdsFrom,
  textField,
  uuidField,
} from "./validation.js";

type Params = { projectId?: string; accountId?: string; tokenId?: string; serviceIdentityId?: string };

const uuid = (value: string | undefined, name: string): string => {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HubError(400, "INVALID_ID", `${name} must be a UUID.`);
  }
  return value.toLowerCase();
};

const passwordValue = (record: Record<string, unknown>, name: string): string => {
  const value = record[name];
  if (typeof value !== "string" || !value) throw new HubError(400, "INVALID_INPUT", `${name} is required.`);
  if (value.length > 256) throw new HubError(400, "PASSWORD_TOO_LONG", "The password is too long.");
  return value;
};

const redirect = (reply: FastifyReply, location: string): FastifyReply =>
  reply.code(303).header("location", location).send();

const publicPrincipal = (principal: Principal): Record<string, unknown> =>
  principal.kind === "human"
    ? {
        kind: "human",
        accountId: principal.accountId,
        actorId: principal.actorId,
        email: principal.email,
        displayName: principal.displayName,
        hubAdmin: principal.hubAdmin,
        auth: principal.auth,
        projectScope: principal.projectScope,
      }
    : {
        kind: "service",
        serviceIdentityId: principal.serviceIdentityId,
        actorId: principal.actorId,
        displayName: principal.displayName,
        ownerAccountId: principal.ownerAccountId,
        ownerName: principal.ownerName,
        purpose: principal.purpose,
        projectIds: principal.projectIds,
        auth: principal.auth,
      };

export function registerRoutes(app: FastifyInstance, service: HubService, store: HubStore, config: HubConfig): void {
  const principalFor = async (request: FastifyRequest): Promise<Principal> => {
    const principal = await authenticate(store, request, service.clock());
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in or provide a bearer token.");
    return principal;
  };

  const cookiePrincipalFor = async (request: FastifyRequest, allowAnonymous = false): Promise<Principal | null> => {
    const principal = await authenticate(store, request, service.clock());
    if (!principal) {
      if (allowAnonymous) return null;
      throw new HubError(401, "AUTH_REQUIRED", "Sign in with a browser session.");
    }
    if (principal.kind !== "human" || principal.auth !== "cookie") {
      if (allowAnonymous) return null;
      throw new HubError(403, "COOKIE_SESSION_REQUIRED", "This page requires a browser login session.");
    }
    return principal;
  };

  const setSession = (reply: FastifyReply, session: { sessionToken: string; expiresAt: string }): void => {
    reply.header("set-cookie", sessionCookie(session.sessionToken, Math.floor(config.sessionTtlMs / 1000)));
  };

  app.get("/api/health", async () => ({ status: "ok", service: "hub" }));

  app.post("/api/auth/register", async (request, reply) => {
    const record = asRecord(request.body);
    const inviteToken = typeof record.inviteToken === "string" ? record.inviteToken.trim() : "";
    if (!inviteToken) throw new HubError(400, "INVALID_INPUT", "inviteToken is required.");
    const displayName = optionalTextField(record, "displayName", { max: 120 });
    const session = await service.register({
      inviteToken,
      password: passwordValue(record, "password"),
      displayName,
    });
    setSession(reply, session);
    return reply.code(201).send({
      account: session.account,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const record = asRecord(request.body);
    const session = await service.login({
      email: emailField(record),
      password: passwordValue(record, "password"),
    });
    setSession(reply, session);
    return reply.send({
      account: session.account,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  });

  app.get("/api/session", async request => {
    const principal = await principalFor(request);
    return {
      principal: publicPrincipal(principal),
      csrfToken: sessionCsrfToken(request, principal),
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    await service.logout(principal);
    reply.header("set-cookie", clearSessionCookie());
    return reply.code(204).send();
  });

  app.post("/api/account/password", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const record = asRecord(request.body);
    const result = await service.changePassword(principal, {
      currentPassword: passwordValue(record, "currentPassword"),
      newPassword: passwordValue(record, "newPassword"),
    });
    return reply.send(result);
  });

  app.get("/api/projects", async request => {
    const principal = await principalFor(request);
    return { projects: await service.myProjects(principal) };
  });

  app.get("/api/projects/:projectId", async request => {
    const principal = await principalFor(request);
    const { projectId } = request.params as Params;
    return { project: await service.getProject(principal, uuid(projectId, "projectId")) };
  });

  app.get("/api/projects/:projectId/members", async request => {
    const principal = await principalFor(request);
    const { projectId } = request.params as Params;
    return { members: await service.listMembers(principal, uuid(projectId, "projectId")) };
  });

  app.post("/api/projects/:projectId/members", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const { projectId } = request.params as Params;
    const record = asRecord(request.body);
    const input = parseMemberBody(record);
    assertMemberUsable(input);
    const member = await service.addMember(principal, uuid(projectId, "projectId"), {
      ...input,
      email: emailField(record),
    });
    return reply.code(201).send({ member });
  });

  app.patch("/api/projects/:projectId/members/:accountId", async request => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const { projectId, accountId } = request.params as Params;
    const normalizedProjectId = uuid(projectId, "projectId");
    const normalizedAccountId = uuid(accountId, "accountId");
    const current = (await service.listMembers(principal, normalizedProjectId)).find(member => member.accountId === normalizedAccountId);
    if (!current) throw new HubError(404, "MEMBER_NOT_FOUND", "The project member does not exist.");
    const record = asRecord(request.body);
    const permissions = record.permissions === undefined && record.canTask === undefined && record.canDocument === undefined && record.canSession === undefined
      ? { canTask: current.canTask, canDocument: current.canDocument, canSession: current.canSession }
      : permissionsFrom(record);
    const input = {
      ...permissions,
      sessionIds: record.sessionIds === undefined ? current.sessionIds : sessionIdsFrom(record.sessionIds),
      isProjectAdmin: record.isProjectAdmin === undefined ? current.isProjectAdmin : booleanField(record, "isProjectAdmin"),
    };
    assertMemberUsable(input);
    return { member: await service.updateMember(principal, normalizedProjectId, normalizedAccountId, input) };
  });

  app.delete("/api/projects/:projectId/members/:accountId", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const { projectId, accountId } = request.params as Params;
    await service.removeMember(principal, uuid(projectId, "projectId"), uuid(accountId, "accountId"));
    return reply.code(204).send();
  });

  app.get("/api/tokens", async request => {
    const principal = await principalFor(request);
    return { tokens: await service.listPersonalTokens(principal) };
  });

  app.post("/api/tokens", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const record = asRecord(request.body);
    const input = parseTokenBody(record);
    const expiresAt = optionalFutureDate(record, "expiresAt", service.clock(), 365);
    return reply.code(201).send(await service.createPersonalToken(principal, { ...input, expiresAt }));
  });

  app.delete("/api/tokens/:tokenId", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const { tokenId } = request.params as Params;
    await service.revokePersonalToken(principal, uuid(tokenId, "tokenId"));
    return reply.code(204).send();
  });

  app.get("/api/audit", async request => {
    const principal = await principalFor(request);
    const query = request.query as Record<string, unknown>;
    const projectId = typeof query.projectId === "string" && query.projectId ? uuid(query.projectId, "projectId") : null;
    return { entries: await service.listAudit(principal, projectId, parseAuditLimit(query.limit)) };
  });

  app.get("/api/admin/accounts", async request => {
    const principal = await principalFor(request);
    return { accounts: await service.listAccounts(principal) };
  });

  app.post("/api/admin/invites", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const record = asRecord(request.body);
    const input = parseInviteBody(record);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new HubError(400, "INVALID_EMAIL", "Enter a valid email address.");
    const expiresAt = optionalFutureDate(record, "expiresAt", service.clock(), 30);
    return reply.code(201).send({ invite: await service.createInvite(principal, { email: input.email, expiresAt }) });
  });

  app.get("/api/admin/projects", async request => {
    const principal = await principalFor(request);
    return { projects: await service.listAdminProjects(principal) };
  });

  app.post("/api/admin/projects", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const input = parseProjectBody(request.body);
    return reply.code(201).send(await service.createProject(principal, input));
  });

  app.patch("/api/admin/projects/:projectId", async request => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const { projectId } = request.params as Params;
    const record = asRecord(request.body);
    const updateMachine = hasMachineField(record);
    const name = optionalTextField(record, "name", { max: 200 });
    const machineId = updateMachine ? optionalTextField(record, "machineId", { max: 200 }) : null;
    return { project: await service.updateProject(principal, uuid(projectId, "projectId"), { name, machineId, updateMachine }) };
  });

  app.get("/api/admin/service-identities", async request => {
    const principal = await principalFor(request);
    return { identities: await service.listServiceIdentities(principal) };
  });

  app.post("/api/admin/service-identities", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const input = parseServiceIdentityBody(request.body);
    return reply.code(201).send(await service.createServiceIdentity(principal, input));
  });

  app.delete("/api/admin/service-identities/:serviceIdentityId", async (request, reply) => {
    const principal = await principalFor(request);
    assertCsrf(request, principal);
    const { serviceIdentityId } = request.params as Params;
    await service.revokeServiceIdentity(principal, uuid(serviceIdentityId, "serviceIdentityId"));
    return reply.code(204).send();
  });

  app.get("/", async (request, reply) => {
    const principal = await cookiePrincipalFor(request, true);
    return principal ? redirect(reply, "/app") : redirect(reply, "/login");
  });

  app.get("/login", async (request, reply) => {
    const principal = await cookiePrincipalFor(request, true);
    return principal ? redirect(reply, "/app") : reply.type("text/html; charset=utf-8").send(loginPage());
  });

  app.get("/register", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const invite = typeof query.invite === "string" ? query.invite : "";
    if (!invite) return reply.code(400).type("text/html; charset=utf-8").send(errorPage(400, "邀请链接缺少 invite 参数。"));
    return reply.type("text/html; charset=utf-8").send(registerPage(invite));
  });

  app.post("/form/login", async (request, reply) => {
    const record = asRecord(request.body);
    const session = await service.login({
      email: emailField(record),
      password: passwordValue(record, "password"),
    });
    setSession(reply, session);
    return redirect(reply, "/app");
  });

  app.post("/form/register", async (request, reply) => {
    const record = asRecord(request.body);
    const inviteToken = typeof record.inviteToken === "string" ? record.inviteToken.trim() : "";
    if (!inviteToken) throw new HubError(400, "INVALID_INPUT", "inviteToken is required.");
    const session = await service.register({
      inviteToken,
      password: passwordValue(record, "password"),
      displayName: optionalTextField(record, "displayName", { max: 120 }),
    });
    setSession(reply, session);
    return redirect(reply, "/app");
  });

  app.post("/form/logout", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    await service.logout(principal);
    reply.header("set-cookie", clearSessionCookie());
    return redirect(reply, "/login");
  });

  app.get("/app", async (request, reply) => {
    const principal = await cookiePrincipalFor(request, true);
    if (!principal) return redirect(reply, "/login");
    if (principal.kind !== "human") throw new HubError(403, "COOKIE_SESSION_REQUIRED", "This page requires a human login session.");
    const projects = await service.myProjects(principal);
    const tokens = await service.listPersonalTokens(principal);
    const csrf = sessionCsrfToken(request, principal) ?? "";
    return reply.type("text/html; charset=utf-8").send(dashboardPage(principal, projects, tokens, csrf));
  });

  app.post("/form/tokens", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const input = parseTokenBody(record);
    const result = await service.createPersonalToken(principal, { ...input, expiresAt: null });
    return reply.type("text/html; charset=utf-8").send(
      oneTimeSecretPage("个人令牌已创建", "个人令牌", result.token, "/app"),
    );
  });

  app.post("/form/tokens/:tokenId/revoke", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const { tokenId } = request.params as Params;
    await service.revokePersonalToken(principal, uuid(tokenId, "tokenId"));
    return redirect(reply, "/app");
  });

  app.get("/admin", async (request, reply) => {
    const principal = await cookiePrincipalFor(request, true);
    if (!principal) return redirect(reply, "/login");
    if (principal.kind !== "human" || !principal.hubAdmin) {
      throw new HubError(403, "HUB_ADMIN_REQUIRED", "Hub administrator permission is required.");
    }
    const projects = await service.listAdminProjects(principal);
    const accounts = await service.listAccounts(principal);
    const csrf = sessionCsrfToken(request, principal) ?? "";
    return reply.type("text/html; charset=utf-8").send(adminPage(projects, accounts, csrf));
  });

  app.post("/form/admin/invites", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const invite = await service.createInvite(principal, {
      email: emailField(record),
      expiresAt: null,
    });
    return reply.type("text/html; charset=utf-8").send(
      oneTimeSecretPage("邀请已创建", "邀请链接", invite.inviteUrl, "/admin"),
    );
  });

  app.post("/form/admin/projects", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const projectRecord = {
      ...record,
      permissions: { task: true, document: true, session: true },
      isProjectAdmin: true,
    };
    await service.createProject(principal, parseProjectBody(projectRecord));
    return redirect(reply, "/admin");
  });

  app.post("/form/admin/service-identities", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const result = await service.createServiceIdentity(principal, parseServiceIdentityBody(record));
    return reply.type("text/html; charset=utf-8").send(
      oneTimeSecretPage("服务身份令牌已签发", "服务身份令牌", result.token, "/admin"),
    );
  });

  app.get("/projects/:projectId", async (request, reply) => {
    const principal = await cookiePrincipalFor(request, true);
    if (!principal) return redirect(reply, "/login");
    if (principal.kind !== "human") throw new HubError(403, "COOKIE_SESSION_REQUIRED", "This page requires a human login session.");
    const { projectId } = request.params as Params;
    const normalizedProjectId = uuid(projectId, "projectId");
    const members = await service.listMembers(principal, normalizedProjectId);
    const project = await store.getProject(normalizedProjectId);
    if (!project) throw new HubError(404, "PROJECT_NOT_FOUND", "The project does not exist.");
    const csrf = sessionCsrfToken(request, principal) ?? "";
    return reply.type("text/html; charset=utf-8").send(projectPage(project, members, csrf));
  });

  app.post("/form/projects/:projectId/members", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const { projectId } = request.params as Params;
    const input = memberInput(record);
    assertMemberUsable(input);
    await service.addMember(principal, uuid(projectId, "projectId"), { ...input, email: emailField(record) });
    return redirect(reply, `/projects/${uuid(projectId, "projectId")}`);
  });

  app.post("/form/projects/:projectId/members/:accountId/update", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const { projectId, accountId } = request.params as Params;
    const input = memberInput(record);
    assertMemberUsable(input);
    const normalizedProjectId = uuid(projectId, "projectId");
    await service.updateMember(principal, normalizedProjectId, uuid(accountId, "accountId"), input);
    return redirect(reply, `/projects/${normalizedProjectId}`);
  });

  app.post("/form/projects/:projectId/members/:accountId/remove", async (request, reply) => {
    const principal = await cookiePrincipalFor(request);
    if (!principal) throw new HubError(401, "AUTH_REQUIRED", "Sign in first.");
    const record = asRecord(request.body);
    assertCsrf(request, principal, record.csrf);
    const { projectId, accountId } = request.params as Params;
    const normalizedProjectId = uuid(projectId, "projectId");
    await service.removeMember(principal, normalizedProjectId, uuid(accountId, "accountId"));
    return redirect(reply, `/projects/${normalizedProjectId}`);
  });
}
