// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { buildHubApp } from "../../apps/hub/src/server.js";
import { applyHubMigrations } from "../../apps/hub/src/migrations.js";
import { HubService, type PublicAccount } from "../../apps/hub/src/service.js";
import { HubStore } from "../../apps/hub/src/store.js";
import type { HubConfig } from "../../apps/hub/src/config.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== "/evoloop_hub_test") {
  throw new Error("Hub integration tests require the dedicated evoloop_hub_test database");
}

const config: HubConfig = {
  publicOrigin: "http://hub.test",
  port: 4319,
  host: "127.0.0.1",
  sessionTtlMs: 12 * 60 * 60 * 1000,
  inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  loginMaxFailures: 3,
  loginWindowMs: 15 * 60 * 1000,
  loginBlockMs: 15 * 60 * 1000,
  bodyLimitBytes: 64 * 1024,
};

const passwordFor = (name: string): string => `${name}-password-123`;
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

test("Hub H1 account, invitation, session, token, service identity and membership boundaries", async t => {
  const schema = `hub_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const pool = new pg.Pool({
    connectionString: database,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await applyHubMigrations(pool);
  assert.deepEqual(await applyHubMigrations(pool), [], "migrations are idempotent");

  const store = new HubStore(pool);
  const service = new HubService(store, config);
  const app = buildHubApp({ config, store, service, logger: { level: "error" } });
  t.after(async () => {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  const browser = () => new Browser(app, config.publicOrigin);
  const raw = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers, payload });

  type Account = PublicAccount;
  const createAccount = async (email: string, displayName: string): Promise<{ account: Account; browser: Browser }> => {
    const hubAdmin = await loginHubAdmin();
    const inviteResponse = await hubAdmin.post("/api/admin/invites", { email });
    assert.equal(inviteResponse.statusCode, 201, inviteResponse.body);
    const invite = inviteResponse.json<{ invite: { token: string } }>().invite;
    const client = browser();
    const response = await client.post("/api/auth/register", {
      inviteToken: invite.token,
      password: passwordFor(displayName),
      displayName,
    });
    assert.equal(response.statusCode, 201, response.body);
    return { account: response.json<{ account: Account }>().account, browser: client };
  };

  const loginHubAdmin = async (): Promise<Browser> => {
    const client = browser();
    const response = await client.post("/api/auth/login", {
      email: "admin@example.test",
      password: passwordFor("admin"),
    });
    assert.equal(response.statusCode, 200, response.body);
    return client;
  };

  await t.test("first Hub administrator is created only by the server bootstrap", async () => {
    const initialized = await service.initializeFirstAdmin({
      email: "admin@example.test",
      displayName: "Hub Admin",
      password: passwordFor("admin"),
    });
    assert.equal(initialized.isHubAdmin, true);
    await assert.rejects(
      service.initializeFirstAdmin({
        email: "another-admin@example.test",
        displayName: "Another",
        password: passwordFor("another"),
      }),
      error => (error as { code?: string }).code === "HUB_ADMIN_EXISTS",
    );
    const stored = await pool.query<{ password_hash: string }>("SELECT password_hash FROM hub_account WHERE email=$1", ["admin@example.test"]);
    assert.match(stored.rows[0]!.password_hash, /^\$argon2id\$v=19\$m=32768,t=2,p=1\$/);
  });

  await t.test("missing or cross-site Origin is rejected before login", async () => {
    const missing = await raw("POST", "/api/auth/login", { email: "admin@example.test", password: passwordFor("admin") });
    assert.equal(missing.statusCode, 403, missing.body);
    assert.equal(missing.json<{ error: { code: string } }>().error.code, "ORIGIN_REQUIRED");
    const crossSite = await raw("POST", "/api/auth/login", { email: "admin@example.test", password: passwordFor("admin") }, {
      origin: "http://evil.test",
      "content-type": "application/json",
    });
    assert.equal(crossSite.statusCode, 403, crossSite.body);
    assert.equal(crossSite.json<{ error: { code: string } }>().error.code, "ORIGIN_MISMATCH");
    assert.equal((await raw("GET", "/api/projects")).statusCode, 401, "unauthenticated project reads are refused");
    assert.equal((await raw("GET", "/api/health")).statusCode, 200, "health is public");
  });

  const adminBrowser = await loginHubAdmin();

  await t.test("login returns an HttpOnly Secure SameSite cookie and stores only its hash", async () => {
    const response = await browser().post("/api/auth/login", {
      email: "admin@example.test",
      password: passwordFor("admin"),
    });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = firstCookie(response);
    assert.match(cookie, /^__Host-hub_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    const sessionCookie = cookie.split(";")[0]!;
    const token = decodeURIComponent(sessionCookie.slice("__Host-hub_session=".length));
    assert.ok(!response.body.includes(token), "session token is not in the JSON body");
    const stored = await pool.query<{ token_hash: string }>("SELECT token_hash FROM hub_login_session WHERE token_hash=$1", [hash(token)]);
    assert.equal(stored.rowCount, 1, "the session is stored by SHA-256 hash");
    assert.equal((await pool.query("SELECT 1 FROM hub_login_session WHERE token_hash=$1", [token])).rowCount, 0);
  });

  let memberA: { account: Account; browser: Browser };
  let memberB: { account: Account; browser: Browser };

  await t.test("invitations are one-time and expire", async () => {
    const inviteResponse = await adminBrowser.post("/api/admin/invites", { email: "a@example.test" });
    assert.equal(inviteResponse.statusCode, 201, inviteResponse.body);
    const invite = inviteResponse.json<{ invite: { token: string; inviteUrl: string; inviteId: string } }>().invite;
    assert.match(invite.inviteUrl, /^http:\/\/hub\.test\/register\?invite=/);
    const stored = await pool.query<{ token_hash: string }>("SELECT token_hash FROM hub_invite WHERE invite_id=$1", [invite.inviteId]);
    assert.equal(stored.rows[0]!.token_hash, hash(invite.token));
    assert.notEqual(stored.rows[0]!.token_hash, invite.token);
    const a = browser();
    const registered = await a.post("/api/auth/register", {
      inviteToken: invite.token,
      password: passwordFor("a"),
      displayName: "Member A",
    });
    assert.equal(registered.statusCode, 201, registered.body);
    memberA = { account: registered.json<{ account: Account }>().account, browser: a };
    const reused = await browser().post("/api/auth/register", {
      inviteToken: invite.token,
      password: passwordFor("a"),
      displayName: "Member A again",
    });
    assert.equal(reused.statusCode, 409, reused.body);
    assert.equal(reused.json<{ error: { code: string } }>().error.code, "INVITE_USED");

    const expiredInviteResponse = await adminBrowser.post("/api/admin/invites", { email: "expired@example.test" });
    const expiredInvite = expiredInviteResponse.json<{ invite: { token: string; inviteId: string } }>().invite;
    await pool.query("UPDATE hub_invite SET expires_at=now()-interval '1 second' WHERE invite_id=$1", [expiredInvite.inviteId]);
    const expired = await browser().post("/api/auth/register", {
      inviteToken: expiredInvite.token,
      password: passwordFor("expired"),
      displayName: "Expired",
    });
    assert.equal(expired.statusCode, 410, expired.body);
    assert.equal(expired.json<{ error: { code: string } }>().error.code, "INVITE_EXPIRED");

    memberB = await createAccount("b@example.test", "b");
  });

  await t.test("consecutive login failures are rate-limited", async () => {
    const rateLimited = await createAccount("rate@example.test", "rate");
    const client = browser();
    for (let attempt = 0; attempt < config.loginMaxFailures; attempt += 1) {
      const response = await client.post("/api/auth/login", {
        email: "rate@example.test",
        password: "wrong-password-123",
      });
      assert.equal(response.statusCode, 401, response.body);
    }
    const blocked = await client.post("/api/auth/login", {
      email: "rate@example.test",
      password: passwordFor("rate"),
    });
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.equal(blocked.json<{ error: { code: string } }>().error.code, "LOGIN_RATE_LIMITED");
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    await pool.query("DELETE FROM hub_login_throttle WHERE email_key=$1", ["rate@example.test"]);
    assert.equal(rateLimited.account.email, "rate@example.test");
  });

  await t.test("cookie writes require CSRF and the exact Origin", async () => {
    const withoutCsrf = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { origin: config.publicOrigin, cookie: adminBrowser.cookie!, "content-type": "application/json" },
      payload: { name: "no csrf" },
    });
    assert.equal(withoutCsrf.statusCode, 403, withoutCsrf.body);
    assert.equal(withoutCsrf.json<{ error: { code: string } }>().error.code, "CSRF_REQUIRED");
    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { origin: "http://evil.test", cookie: adminBrowser.cookie!, "x-hub-csrf": adminBrowser.csrf!, "content-type": "application/json" },
      payload: { name: "wrong origin" },
    });
    assert.equal(wrongOrigin.statusCode, 403, wrongOrigin.body);
    assert.equal(wrongOrigin.json<{ error: { code: string } }>().error.code, "ORIGIN_MISMATCH");
  });

  await t.test("logout and password change invalidate old browser sessions", async () => {
    const first = browser();
    const firstLogin = await first.post("/api/auth/login", { email: "a@example.test", password: passwordFor("a") });
    assert.equal(firstLogin.statusCode, 200, firstLogin.body);
    const second = browser();
    const secondLogin = await second.post("/api/auth/login", { email: "a@example.test", password: passwordFor("a") });
    assert.equal(secondLogin.statusCode, 200, secondLogin.body);
    const logout = await second.post("/api/auth/logout", {});
    assert.equal(logout.statusCode, 204, logout.body);
    assert.equal((await second.get("/api/session")).statusCode, 401, "logged-out cookie is rejected");
    const third = browser();
    assert.equal((await third.post("/api/auth/login", { email: "a@example.test", password: passwordFor("a") })).statusCode, 200);
    const changed = await first.post("/api/account/password", {
      currentPassword: passwordFor("a"),
      newPassword: "a-new-password-456",
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await third.get("/api/session")).statusCode, 401, "other sessions are revoked after a password change");
    assert.equal((await first.get("/api/session")).statusCode, 200, "the current session remains valid");
    assert.equal((await browser().post("/api/auth/login", { email: "a@example.test", password: passwordFor("a") })).statusCode, 401);
    memberA.browser = first;
  });

  let projectA = "";
  let projectB = "";

  await t.test("Hub administrators create projects and do not gain project membership", async () => {
    const createA = await adminBrowser.post("/api/admin/projects", {
      name: "Project A",
      projectAdminAccountId: memberA.account.accountId,
    });
    assert.equal(createA.statusCode, 201, createA.body);
    projectA = createA.json<{ project: { projectId: string } }>().project.projectId;
    const createB = await adminBrowser.post("/api/admin/projects", {
      name: "Project B",
      projectAdminAccountId: memberB.account.accountId,
    });
    assert.equal(createB.statusCode, 201, createB.body);
    projectB = createB.json<{ project: { projectId: string } }>().project.projectId;
    assert.notEqual(projectA, projectB);
    const adminView = await adminBrowser.get(`/api/projects/${projectA}`);
    assert.equal(adminView.statusCode, 403, adminView.body);
    assert.equal(adminView.json<{ error: { code: string } }>().error.code, "PROJECT_ACCESS_DENIED");
    const metadata = await adminBrowser.get("/api/admin/projects");
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.equal(metadata.json<{ projects: unknown[] }>().projects.length, 2);
  });

  await t.test("my projects contains only my memberships and project admins manage permissions", async () => {
    const aProjects = await memberA.browser.get("/api/projects");
    assert.equal(aProjects.statusCode, 200, aProjects.body);
    assert.deepEqual(aProjects.json<{ projects: Array<{ projectId: string }> }>().projects.map(project => project.projectId), [projectA]);
    const bProjects = await memberB.browser.get("/api/projects");
    assert.deepEqual(bProjects.json<{ projects: Array<{ projectId: string }> }>().projects.map(project => project.projectId), [projectB]);
    const addB = await memberA.browser.post(`/api/projects/${projectA}/members`, {
      email: "b@example.test",
      permissions: { task: true, document: true, session: true },
      sessionIds: ["session-one", "session-two"],
      isProjectAdmin: false,
    });
    assert.equal(addB.statusCode, 201, addB.body);
    const bMember = addB.json<{ member: { accountId: string; sessionIds: string[]; canTask: boolean; canDocument: boolean; canSession: boolean } }>().member;
    assert.deepEqual(bMember.sessionIds, ["session-one", "session-two"]);
    const bUpdate = await memberB.browser.patch(`/api/projects/${projectA}/members/${bMember.accountId}`, {
      permissions: { task: false, document: true, session: true },
    });
    assert.equal(bUpdate.statusCode, 403, bUpdate.body);
    assert.equal(bUpdate.json<{ error: { code: string } }>().error.code, "PROJECT_ADMIN_REQUIRED");
    const update = await memberA.browser.patch(`/api/projects/${projectA}/members/${bMember.accountId}`, {
      permissions: { task: false, document: true, session: true },
      sessionIds: ["session-two"],
    });
    assert.equal(update.statusCode, 200, update.body);
    const updated = update.json<{ member: { canTask: boolean; canDocument: boolean; canSession: boolean; sessionIds: string[] } }>().member;
    assert.deepEqual(
      { canTask: updated.canTask, canDocument: updated.canDocument, canSession: updated.canSession, sessionIds: updated.sessionIds },
      { canTask: false, canDocument: true, canSession: true, sessionIds: ["session-two"] },
    );
    const removedLastAdmin = await memberA.browser.delete(`/api/projects/${projectA}/members/${memberA.account.accountId}`);
    assert.equal(removedLastAdmin.statusCode, 409, removedLastAdmin.body);
    assert.equal(removedLastAdmin.json<{ error: { code: string } }>().error.code, "LAST_PROJECT_ADMIN");
  });

  await t.test("personal tokens are shown once, stored as hashes, project-scoped and revocable", async () => {
    const created = await memberA.browser.post("/api/tokens", { name: "scoped A", projectId: projectA });
    assert.equal(created.statusCode, 201, created.body);
    const token = created.json<{ token: string; record: { tokenId: string; tokenHash?: string } }>();
    assert.ok(token.token.length > 20);
    assert.equal(token.record.tokenHash, undefined, "the response does not expose the stored hash");
    const stored = await pool.query<{ token_hash: string }>("SELECT token_hash FROM hub_personal_token WHERE token_id=$1", [token.record.tokenId]);
    assert.equal(stored.rows[0]!.token_hash, hash(token.token));
    const overflow = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM hub_personal_token WHERE token_hash=$1 OR name=$1",
      [token.token],
    );
    assert.equal(overflow.rows[0]!.count, "0", "the plaintext token is not stored anywhere in the row");
    const list = await memberA.browser.get("/api/tokens");
    assert.ok(!list.body.includes(token.token));
    assert.ok(!list.body.includes(stored.rows[0]!.token_hash));
    const withToken = await bearertInject(app, token.token, "GET", "/api/projects");
    assert.equal(withToken.statusCode, 200, withToken.body);
    assert.deepEqual(withToken.json<{ projects: Array<{ projectId: string }> }>().projects.map(project => project.projectId), [projectA]);
    assert.equal((await bearertInject(app, token.token, "GET", `/api/projects/${projectB}`)).statusCode, 403);
    const revoked = await memberA.browser.delete(`/api/tokens/${token.record.tokenId}`);
    assert.equal(revoked.statusCode, 204, revoked.body);
    assert.equal((await bearertInject(app, token.token, "GET", "/api/projects")).statusCode, 401);
  });

  await t.test("minimal browser forms render and a form token is created with the page CSRF field", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/login" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/register?invite=fixture-token" })).statusCode, 200);
    const dashboard = await memberA.browser.get("/app");
    assert.equal(dashboard.statusCode, 200, dashboard.body);
    assert.match(dashboard.body, /我的项目/);
    const adminPage = await adminBrowser.get("/admin");
    assert.equal(adminPage.statusCode, 200, adminPage.body);
    assert.match(adminPage.body, /Hub 管理/);
    const formBody = new URLSearchParams({
      name: "form-token",
      projectId: projectA,
      csrf: memberA.browser.csrf!,
    }).toString();
    const created = await app.inject({
      method: "POST",
      url: "/form/tokens",
      headers: {
        origin: config.publicOrigin,
        cookie: memberA.browser.cookie!,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: formBody,
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.match(created.body, /个人令牌已创建/);
  });

  let serviceToken = "";
  let serviceIdentityId = "";

  await t.test("service identities require a Hub admin, have an owner and purpose, and cannot log in", async () => {
    const forbidden = await memberA.browser.post("/api/admin/service-identities", {
      actorId: "service-a",
      displayName: "Service A",
      ownerAccountId: memberA.account.accountId,
      purpose: "Project A automation",
      projectIds: [projectA],
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    const created = await adminBrowser.post("/api/admin/service-identities", {
      actorId: "service-a",
      displayName: "Service A",
      ownerAccountId: memberA.account.accountId,
      purpose: "Project A automation",
      projectIds: [projectA],
    });
    assert.equal(created.statusCode, 201, created.body);
    const result = created.json<{ token: string; identity: { serviceIdentityId: string; ownerName: string; purpose: string; projectIds: string[] } }>();
    serviceToken = result.token;
    serviceIdentityId = result.identity.serviceIdentityId;
    assert.equal(result.identity.ownerName, "Member A");
    assert.equal(result.identity.purpose, "Project A automation");
    assert.deepEqual(result.identity.projectIds, [projectA]);
    const serviceSession = await bearertInject(app, serviceToken, "GET", "/api/session");
    assert.equal(serviceSession.statusCode, 200, serviceSession.body);
    assert.equal(serviceSession.json<{ principal: { kind: string } }>().principal.kind, "service");
    assert.equal(serviceSession.json<{ csrfToken: string | null }>().csrfToken, null);
    assert.equal((await bearertInject(app, serviceToken, "GET", `/api/projects/${projectA}`)).statusCode, 200);
    assert.equal((await bearertInject(app, serviceToken, "GET", `/api/projects/${projectB}`)).statusCode, 403);
    assert.equal((await bearertInject(app, serviceToken, "GET", `/api/projects/${projectA}/members`)).statusCode, 403);
    const loginAttempt = await browser().post("/api/auth/login", { email: "service-a", password: "service-password-123" });
    assert.ok([400, 401].includes(loginAttempt.statusCode), loginAttempt.body);
    assert.equal(firstCookieOrNull(loginAttempt), null, "a service identity never receives a browser cookie");
    const collision = await adminBrowser.post("/api/admin/service-identities", {
      actorId: memberA.account.actorId,
      displayName: "Collision",
      ownerAccountId: memberA.account.accountId,
      purpose: "Must not collide",
      projectIds: [projectA],
    });
    assert.equal(collision.statusCode, 409, collision.body);
    assert.equal(collision.json<{ error: { code: string } }>().error.code, "ACTOR_ID_TAKEN");
    const listed = await adminBrowser.get("/api/admin/service-identities");
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json<{ identities: unknown[] }>().identities.length, 1);
    assert.ok(!listed.body.includes(serviceToken));
    const audit = await adminBrowser.get("/api/audit");
    assert.equal(audit.statusCode, 200, audit.body);
    assert.ok(audit.body.includes("service_identity.created"));
    assert.ok(!audit.body.includes(serviceToken));
    const projectAdminAudit = await memberA.browser.get(`/api/audit?projectId=${projectA}`);
    assert.equal(projectAdminAudit.statusCode, 200, projectAdminAudit.body);
    assert.equal((await memberB.browser.get(`/api/audit?projectId=${projectA}`)).statusCode, 403);
  });

  await t.test("revoked service identity tokens stop working", async () => {
    const revoked = await adminBrowser.delete(`/api/admin/service-identities/${serviceIdentityId}`);
    assert.equal(revoked.statusCode, 204, revoked.body);
    assert.equal((await bearertInject(app, serviceToken, "GET", "/api/session")).statusCode, 401);
  });

  await t.test("a project-scoped Hub administrator token cannot cross the project boundary", async () => {
    const adminAccount = (await adminBrowser.get("/api/admin/accounts")).json<{ accounts: PublicAccount[] }>().accounts
      .find(account => account.email === "admin@example.test")!;
    const ownProject = await adminBrowser.post("/api/admin/projects", {
      name: "Admin's project",
      projectAdminAccountId: adminAccount.accountId,
    });
    assert.equal(ownProject.statusCode, 201, ownProject.body);
    const ownProjectId = ownProject.json<{ project: { projectId: string } }>().project.projectId;
    const tokenResponse = await adminBrowser.post("/api/tokens", {
      name: "scoped Hub admin",
      projectId: ownProjectId,
    });
    assert.equal(tokenResponse.statusCode, 201, tokenResponse.body);
    const scopedToken = tokenResponse.json<{ token: string }>().token;

    const projects = await bearertInject(app, scopedToken, "GET", "/api/projects");
    assert.deepEqual(
      projects.json<{ projects: Array<{ projectId: string }> }>().projects.map(project => project.projectId),
      [ownProjectId],
    );
    assert.equal((await bearertInject(app, scopedToken, "GET", `/api/projects/${projectA}`)).statusCode, 403);
    const adminProjects = await bearertInject(app, scopedToken, "GET", "/api/admin/projects");
    assert.equal(adminProjects.statusCode, 403, adminProjects.body);
    assert.equal(adminProjects.json<{ error: { code: string } }>().error.code, "TOKEN_PROJECT_SCOPE");
    const crossProjectAudit = await bearertInject(app, scopedToken, "GET", `/api/audit?projectId=${projectA}`);
    assert.equal(crossProjectAudit.statusCode, 403, crossProjectAudit.body);
    assert.equal(crossProjectAudit.json<{ error: { code: string } }>().error.code, "TOKEN_PROJECT_SCOPE");
    const ownAudit = await bearertInject(app, scopedToken, "GET", "/api/audit");
    assert.equal(ownAudit.statusCode, 200, ownAudit.body);
    assert.ok(ownAudit.json<{ entries: Array<{ projectId: string | null }> }>().entries.every(entry => entry.projectId === ownProjectId));
  });

  await t.test("audit records do not contain password or token material", async () => {
    const rows = await pool.query<{ content: string }>(
      `SELECT coalesce(action,'') || ' ' || coalesce(subject,'') || ' ' || detail::text AS content FROM hub_audit`,
    );
    const all = rows.rows.map(row => row.content).join("\n");
    assert.ok(!all.includes(passwordFor("a")));
    assert.ok(!all.includes(passwordFor("admin")));
    assert.ok(!all.includes(serviceToken));
    assert.ok(!all.includes(adminBrowser.cookie!.split("=")[1]!));
  });
});

class Browser {
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(
    private readonly app: ReturnType<typeof buildHubApp>,
    private readonly origin: string,
  ) {}

  async get(url: string) {
    return this.app.inject({
      method: "GET",
      url,
      headers: {
        origin: this.origin,
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
    });
  }

  async post(url: string, payload: unknown) {
    return this.request("POST", url, payload);
  }

  async patch(url: string, payload: unknown) {
    return this.request("PATCH", url, payload);
  }

  async delete(url: string) {
    return this.request("DELETE", url);
  }

  private async request(method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
    const response = await this.app.inject({
      method,
      url,
      headers: {
        origin: this.origin,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { "x-hub-csrf": this.csrf } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    const cookie = firstCookieOrNull(response);
    if (cookie) this.cookie = /Max-Age=0/i.test(cookie) ? null : cookie.split(";")[0]!;
    const body = response.body ? response.json<{ csrfToken?: string | null }>() : null;
    if (body?.csrfToken) this.csrf = body.csrfToken;
    return response;
  }
}

async function bearertInject(
  app: ReturnType<typeof buildHubApp>,
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { payload }),
  });
}

function firstCookieOrNull(response: { headers: Record<string, unknown> }): string | null {
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return values.find(value => value.startsWith("__Host-hub_session=")) ?? null;
}

function firstCookie(response: { headers: Record<string, unknown> }): string {
  const cookie = firstCookieOrNull(response);
  assert.ok(cookie, "response did not set the Hub session cookie");
  return cookie;
}
