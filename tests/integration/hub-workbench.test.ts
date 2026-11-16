// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import pg from "pg";
import { buildHubApp } from "../../apps/hub/src/server.js";
import { applyHubMigrations } from "../../apps/hub/src/migrations.js";
import { HubService } from "../../apps/hub/src/service.js";
import { HubStore } from "../../apps/hub/src/store.js";
import { MachineStore } from "../../apps/hub/src/machines.js";
import { Gateway } from "../../apps/hub/src/gateway.js";
import type { HubConfig } from "../../apps/hub/src/config.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== "/evoloop_hub_test") throw new Error("Hub integration tests require the dedicated evoloop_hub_test database");

const password = (name: string) => `${name}-password-123`;

test("the Hub serves the workbench and answers its session, project list and machine state; sign-in, sign-out, expiry and other people's projects behave", async t => {
  const schema = `hubw_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: database, max: 6, options: `-c search_path=${schema}` });
  await applyHubMigrations(pool);
  const webRoot = await mkdtemp(join(tmpdir(), "evoloop-hub-web-"));
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "index.html"), '<!doctype html><html><head>\n    <meta charset="UTF-8" />\n    <script type="module" src="/assets/index-AAAA.js"></script>\n  </head><body><div id="root"></div></body></html>');
  await writeFile(join(webRoot, "assets", "index-AAAA.js"), "export const live = true;");
  await writeFile(join(webRoot, "assets", "index-AAAA.css"), "body{}");
  await writeFile(join(webRoot, "favicon.svg"), "<svg/>");
  await writeFile(join(webRoot, "theme-init.js"), "// theme");
  const config: HubConfig = { publicOrigin: "http://hub.test", port: 4319, host: "127.0.0.1", sessionTtlMs: 12 * 60 * 60 * 1000, inviteTtlMs: 7 * 24 * 60 * 60 * 1000, loginMaxFailures: 5,
    loginWindowMs: 15 * 60 * 1000, loginBlockMs: 15 * 60 * 1000, bodyLimitBytes: 64 * 1024, webRoot };
  const store = new HubStore(pool), machines = new MachineStore(pool), service = new HubService(store, config);
  const gateway = new Gateway({ heartbeatMs: 300, forwardTimeoutMs: 2000, maxResponseBytes: 1024 * 1024 });
  const app = buildHubApp({ config, store, service, machines, gateway, logger: { level: "silent" } });
  t.after(async () => { await app.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(webRoot, { recursive: true, force: true }); });

  type Who = { cookie: string; csrf: string; accountId: string; actorId: string };
  const inject = (who: Who | null, method: "GET" | "POST", url: string, payload?: unknown, extra: Record<string, string> = {}) => app.inject({ method, url,
    headers: { origin: config.publicOrigin, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(who ? { cookie: who.cookie, "x-hub-csrf": who.csrf } : {}), ...extra }, ...(payload === undefined ? {} : { payload }) });
  const login = async (email: string, name: string): Promise<Who> => {
    const response = await inject(null, "POST", "/api/auth/login", { email, password: password(name) });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ csrfToken: string; account: { accountId: string; actorId: string } }>();
    return { cookie: (response.headers["set-cookie"] as string).split(";")[0]!, csrf: body.csrfToken, accountId: body.account.accountId, actorId: body.account.actorId };
  };
  await service.initializeFirstAdmin({ email: "admin@example.test", displayName: "Hub Admin", password: password("admin") });
  const hubAdmin = await login("admin@example.test", "admin");
  const register = async (email: string, name: string) => {
    const invite = await inject(hubAdmin, "POST", "/api/admin/invites", { email });
    const registered = await inject(null, "POST", "/api/auth/register", { inviteToken: invite.json<{ invite: { token: string } }>().invite.token, password: password(name), displayName: name });
    assert.equal(registered.statusCode, 201, registered.body);
    return login(email, name);
  };
  const alice = await register("alice@example.test", "alice"), bob = await register("bob@example.test", "bob");

  await t.test("the workbench pages and files come from the Hub; the pages know they are behind it; the Hub's own pages keep their strict policy", async () => {
    const root = await app.inject({ method: "GET", url: "/" });
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /<meta name="evoloop-auth" content="hub" \/>/);
    assert.match(root.body, /<div id="root">/);
    assert.match(String(root.headers["content-security-policy"]), /script-src 'self'/);
    assert.doesNotMatch(String(root.headers["content-security-policy"]), /default-src 'none'/);
    for (const url of ["/ui", `/p/${randomUUID()}/work`]) {
      const page = await app.inject({ method: "GET", url });
      assert.equal(page.statusCode, 200, url);
      assert.match(page.body, /evoloop-auth/);
    }
    assert.equal((await app.inject({ method: "GET", url: "/assets/index-AAAA.js" })).body, "export const live = true;");
    assert.match(String((await app.inject({ method: "GET", url: "/assets/index-AAAA.css" })).headers["content-type"]), /text\/css/);
    assert.equal((await app.inject({ method: "GET", url: "/favicon.svg" })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/theme-init.js" })).statusCode, 200);
    const login = await app.inject({ method: "GET", url: "/login" });
    assert.match(String(login.headers["content-security-policy"]), /default-src 'none'/, "the plain pages keep the strict policy");
    // A file that was in an older release and is gone: a script gets the "workbench was updated, reload" module; the login is not part of the message; other files are plain 404s.
    const stale = await app.inject({ method: "GET", url: "/assets/OldPage-OLD1.js" });
    assert.equal(stale.statusCode, 200);
    assert.match(stale.body, /工作台已经更新到新版本/);
    assert.match(stale.body, /登录仍然有效，不需要重新填写令牌/);
    assert.equal((await app.inject({ method: "GET", url: "/assets/OldStyle-OLD1.css" })).statusCode, 404);
    for (const url of ["/assets/..%2Findex.html", "/assets/%2e%2e", "/assets/a%2fb.js", "/assets/.hidden", "/theme-init.js/../x"]) {
      const response = await app.inject({ method: "GET", url });
      // Either refused, or (a dot segment the HTTP layer resolved away) the workbench's own index page; never a file from anywhere else.
      assert.ok([400, 404].includes(response.statusCode) || (response.statusCode === 200 && /<div id="root">/.test(response.body) && !response.body.includes("export const live")), `${url} -> ${response.statusCode}`);
    }
  });

  let project = "";
  await t.test("signed out there is nothing but the login; signing in gives the workbench's session with only the caller's projects and what each lets them do", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/session" })).statusCode, 401, "no login, no session");
    assert.equal((await app.inject({ method: "GET", url: "/api/projects" })).statusCode, 401);
    const wrong = await inject(null, "POST", "/api/auth/login", { email: "alice@example.test", password: "wrong" });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json<{ error: { code: string } }>().error.code, "INVALID_CREDENTIALS");
    assert.equal(wrong.headers["set-cookie"], undefined, "a failed login sets no cookie");
    const machine = await machines.create({ name: "mac-ui", createdBy: hubAdmin.accountId, at: new Date() });
    await pool.query("UPDATE hub_machine SET state='active', public_key='k', joined_at=now() WHERE machine_id=$1", [machine.machine.machineId]);
    const created = await inject(hubAdmin, "POST", "/api/admin/projects", { name: "Alice project", machineId: machine.machine.machineId, projectAdminAccountId: alice.accountId });
    assert.equal(created.statusCode, 201, created.body);
    project = created.json<{ project: { projectId: string } }>().project.projectId;
    await inject(hubAdmin, "POST", "/api/admin/projects", { name: "Other project", projectAdminAccountId: bob.accountId });
    const session = (await inject(alice, "GET", "/api/session")).json<{ principal: { actorId: string; projectIds: string[]; permissions: string[]; projectPermissions: Record<string, string[]>; identityKind: string }; capabilities: unknown; csrfToken: string }>();
    assert.deepEqual(session.principal.projectIds, [project], "only the caller's own project");
    assert.equal(session.principal.identityKind, "human");
    assert.deepEqual(session.principal.projectPermissions[project]!.sort(), ["document", "management", "session", "task"]);
    assert.deepEqual(session.capabilities, {});
    assert.equal(session.csrfToken, alice.csrf);
    const bobSession = (await inject(bob, "GET", "/api/session")).json<{ principal: { projectIds: string[] } }>();
    assert.equal(bobSession.principal.projectIds.includes(project), false, "another person's project is not listed");
    const list = (await inject(alice, "GET", "/api/projects")).json<{ projects: Array<{ projectId: string; name: string }> }>().projects;
    assert.deepEqual(list.map(item => item.name), ["Alice project"]);
    // The administrator of the Hub is not a member of anyone's project.
    assert.deepEqual((await inject(hubAdmin, "GET", "/api/projects")).json<{ projects: unknown[] }>().projects, []);
    // Opening another person's project, with or without the machine behind it, is refused at the Hub.
    const foreign = (await inject(bob, "GET", "/api/projects")).json<{ projects: Array<{ projectId: string }> }>().projects[0]!.projectId;
    assert.equal((await inject(alice, "GET", `/api/projects/${foreign}`)).statusCode, 403, "cross-project read");
    assert.equal((await inject(alice, "GET", `/api/projects/${foreign}/documents`)).statusCode, 403, "cross-project forwarded read");
  });

  await t.test("the project list says where each project runs and whether the machine is connected now; a machine going away is offline, and says nothing about any Run", async () => {
    const read = async () => (await inject(alice, "GET", `/api/projects/${project}`)).json<{ project: { machine: { name: string; state: string; online: boolean } | null } }>().project.machine;
    assert.deepEqual(await read(), { machineId: (await read() as never as { machineId: string }).machineId, name: "mac-ui", state: "active", online: false }, "registered, not connected yet: offline");
    const machineId = (await pool.query("SELECT machine_id FROM hub_machine WHERE name='mac-ui'")).rows[0].machine_id as string;
    const out = new PassThrough();
    const attached = gateway.attach(machineId, out);
    assert.equal((await read())!.online, true, "connected");
    assert.equal((await inject(alice, "GET", "/api/projects")).json<{ projects: Array<{ machine: { online: boolean } }> }>().projects[0]!.machine.online, true);
    // While it is offline a forwarded read answers MACHINE_OFFLINE (503) with its own code; it does not touch anything on the machine.
    attached.detach();
    assert.equal((await read())!.online, false, "disconnected: offline again");
    const offline = await inject(alice, "GET", `/api/projects/${project}/documents`);
    assert.equal(offline.statusCode, 503);
    assert.equal(offline.json<{ error: { code: string } }>().error.code, "MACHINE_OFFLINE");
    // Removed machines are listed as removed, not as a failure.
    await machines.remove(machineId, new Date());
    assert.equal((await inject(alice, "GET", "/api/projects")).json<{ projects: Array<{ machine: unknown }> }>().projects[0]!.machine, null, "after removal the project points at no machine");
  });

  await t.test("signing out ends the Hub session; an expired session is refused; neither leaves a credential in a URL or a body", async () => {
    const second = await login("alice@example.test", "alice");
    assert.equal((await inject(second, "GET", "/api/session")).statusCode, 200);
    const logout = await inject(second, "POST", "/api/auth/logout", undefined);
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await inject(second, "GET", "/api/session")).statusCode, 401, "the old cookie is no longer a login");
    // A logout without the CSRF token is refused, so another site cannot sign a person out.
    const third = await login("alice@example.test", "alice");
    const noCsrf = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: config.publicOrigin, cookie: third.cookie } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((await inject(third, "GET", "/api/session")).statusCode, 200, "and it did not sign out");
    // Expiry: the session row's time runs out.
    await pool.query("UPDATE hub_login_session SET expires_at=now() - interval '1 minute' WHERE account_id=$1", [third.accountId]);
    const expired = await inject(third, "GET", "/api/session");
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.json<{ error: { code: string } }>().error.code, "AUTH_REQUIRED");
    // The CSRF token and the cookie come in the login answer's headers and body only; the answer never carries the cookie value.
    const fresh = await inject(null, "POST", "/api/auth/login", { email: "alice@example.test", password: password("alice") });
    assert.ok(!fresh.body.includes(String(fresh.headers["set-cookie"]).split(";")[0]!.split("=")[1]!), "the session cookie value is not in the body");
    assert.match(String(fresh.headers["set-cookie"]), /HttpOnly/);
    assert.match(String(fresh.headers["set-cookie"]), /SameSite=Strict/);
  });
});
