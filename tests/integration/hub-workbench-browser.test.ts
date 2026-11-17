// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
// Opt-in: needs a browser (EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE) and the built workbench (apps/workbench/dist). EVOLOOP_HUB_SCREENSHOT_DIR=<dir> also writes the screenshots.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { machineRequestMessage } from "@evoloop/contracts";
import { buildHubApp } from "../../apps/hub/src/server.js";
import { applyHubMigrations } from "../../apps/hub/src/migrations.js";
import { HubService } from "../../apps/hub/src/service.js";
import { HubStore } from "../../apps/hub/src/store.js";
import { MachineStore } from "../../apps/hub/src/machines.js";
import type { HubConfig } from "../../apps/hub/src/config.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { HubIdentityVerifier } from "../../apps/coordinator/src/hub/identity.js";
import { MachineCredentialSource } from "../../apps/coordinator/src/hub/credentials.js";
import { HubConnector } from "../../apps/coordinator/src/hub/connector.js";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (and build apps/workbench) to run the Hub browser walk";
const shots = process.env.EVOLOOP_HUB_SCREENSHOT_DIR;
const database = process.env.TEST_DATABASE_URL;
if (!skip && (!database || new URL(database).pathname !== "/evoloop_hub_test")) throw new Error("Hub integration tests require the dedicated evoloop_hub_test database");

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const password = (name: string) => `${name}-password-123`;
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
const freePort = () => new Promise<number>(done => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });

test("a person signs in at the Hub, sees only their project with its machine, opens it, sees the machine go offline and come back, and signs out", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const hubSchema = `hubb_${randomUUID().replaceAll("-", "").slice(0, 16)}`, coordinatorSchema = `hubbc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${hubSchema}"`);
  const hubPool = new pg.Pool({ connectionString: database, max: 8, options: `-c search_path=${hubSchema}` });
  await applyHubMigrations(hubPool);
  await migrate(database!, coordinatorSchema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${coordinatorSchema}` });
  const directory = await mkdtemp(join(tmpdir(), "evoloop-hub-browser-"));
  const machineDir = join(directory, "machine");
  await mkdir(machineDir, { recursive: true });
  const hubPort = await freePort(), origin = `http://127.0.0.1:${hubPort}`;
  const config: HubConfig = { publicOrigin: origin, port: hubPort, host: "127.0.0.1", sessionTtlMs: 12 * 60 * 60 * 1000, inviteTtlMs: 7 * 24 * 60 * 60 * 1000, loginMaxFailures: 5,
    loginWindowMs: 15 * 60 * 1000, loginBlockMs: 15 * 60 * 1000, bodyLimitBytes: 64 * 1024, machineHeartbeatMs: 300, forwardTimeoutMs: 5000, forwardBodyLimitBytes: 128 * 1024,
    maxResponseBytes: 8 * 1024 * 1024, webRoot: resolve("apps/workbench/dist") };
  const store = new HubStore(hubPool), machines = new MachineStore(hubPool), hubService = new HubService(store, config);
  const hub = buildHubApp({ config, store, service: hubService, machines, logger: { level: "silent" } });
  await hub.listen({ host: "127.0.0.1", port: hubPort });

  const projectId = randomUUID(), localToken = `${randomUUID()}${randomUUID()}`;
  const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash: sha } });
  const credentialSource = new MachineCredentialSource(machineDir);
  const verifier = new HubIdentityVerifier({ credentials: () => credentialSource.current(), isLocalProject: async id => (await pool.query("SELECT 1 FROM project WHERE project_id=$1", [id])).rowCount === 1, localActorIds: () => new Set(["local-agent"]) });
  const coordinator = await buildServer({ service, credentials: [{ token: localToken, actorId: "local-agent", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }], hubIdentity: { verifier } });
  const coordinatorUrl = await coordinator.listen({ host: "127.0.0.1", port: 0 });
  let connector: HubConnector | null = null;
  const startConnector = () => { connector = new HubConnector({ credentials: credentialSource, coordinatorUrl, backoffMs: { initial: 100, max: 300 }, idleCheckMs: 100 }); connector.start(); };
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => {
    await browser.close(); await connector?.stop(); await hub.close().catch(() => undefined); await coordinator.close(); await hubPool.end(); await pool.end();
    await admin.query(`DROP SCHEMA "${hubSchema}" CASCADE`); await admin.query(`DROP SCHEMA "${coordinatorSchema}" CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true });
  });

  // The project and one document live on the machine; the Hub knows the project, its members and the machine.
  const local = (body: unknown) => fetch(new URL("/api/commands", coordinatorUrl), { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await local({ projectId, operationId: randomUUID(), type: "project.create", title: "Alice project" })).status, 200);
  assert.equal((await local({ projectId, operationId: randomUUID(), type: "document.create", documentId: randomUUID(), title: "Written on the machine", body: "# From the machine", kind: "report" })).status, 200);
  const inject = (cookie: string | null, csrf: string | null, method: "GET" | "POST", url: string, payload?: unknown) => hub.inject({ method, url,
    headers: { origin, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(csrf ? { "x-hub-csrf": csrf } : {}) }, ...(payload === undefined ? {} : { payload }) });
  await hubService.initializeFirstAdmin({ email: "admin@example.test", displayName: "Hub Admin", password: password("admin") });
  const adminLogin = await inject(null, null, "POST", "/api/auth/login", { email: "admin@example.test", password: password("admin") });
  const adminCookie = (adminLogin.headers["set-cookie"] as string).split(";")[0]!, adminCsrf = adminLogin.json<{ csrfToken: string }>().csrfToken;
  const register = async (email: string, name: string) => {
    const invite = await inject(adminCookie, adminCsrf, "POST", "/api/admin/invites", { email });
    const registered = await inject(null, null, "POST", "/api/auth/register", { inviteToken: invite.json<{ invite: { token: string } }>().invite.token, password: password(name), displayName: name });
    return registered.json<{ account: { accountId: string } }>().account.accountId;
  };
  const aliceId = await register("alice@example.test", "alice"), bobId = await register("bob@example.test", "bob");
  // The machine joins the Hub (what `evoloop machine join` does), then the coordinator's connector comes up.
  const created = (await inject(adminCookie, adminCsrf, "POST", "/api/admin/machines", { name: "mac-e2e" })).json<{ machine: { machineId: string }; joinCode: string }>();
  const keys = generateKeyPairSync("ed25519");
  const joined = await fetch(new URL("/api/machine/join", origin), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: created.joinCode, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), allowedRoots: [directory] }) });
  const answer = await joined.json() as { machineId: string; name: string; hubPublicKeys: Array<{ kid: string; publicKey: string }> };
  await writeFile(join(machineDir, "machine.json"), JSON.stringify({ version: 1, hubOrigin: origin, machineId: answer.machineId, name: answer.name, privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    hubPublicKeys: answer.hubPublicKeys, allowedRoots: [directory], joinedAt: new Date().toISOString() }));
  void createPrivateKey; void sign; void machineRequestMessage;
  assert.equal((await inject(adminCookie, adminCsrf, "POST", "/api/admin/projects", { projectId, name: "Alice project", machineId: answer.machineId, projectAdminAccountId: aliceId })).statusCode, 201);
  assert.equal((await inject(adminCookie, adminCsrf, "POST", "/api/admin/projects", { name: "Bob's project", projectAdminAccountId: bobId })).statusCode, 201);
  startConnector();
  const machineState = async () => (await inject(adminCookie, adminCsrf, "GET", "/api/admin/machines")).json<{ machines: Array<{ online: boolean }> }>().machines[0]!.online;
  for (let i = 0; i < 80 && !await machineState(); i++) await wait(100);
  assert.equal(await machineState(), true, "the machine is online before the walk starts");
  if (shots) await mkdir(shots, { recursive: true });

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await t.test(`${width}x${height}: login page → login → own projects only → open → offline → back → sign out`, async () => {
      const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
      const page = await context.newPage();
      const pageErrors: string[] = [], requested: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      page.on("request", request => requested.push(request.url()));
      await page.goto(`${origin}/`);
      // Not signed in: the login form and nothing else; no project name, no token field.
      await page.getByLabel("邮箱").waitFor();
      assert.equal(await page.getByLabel("访问令牌").count(), 0, "no pasted-token field behind the Hub");
      assert.equal(await page.getByText("Alice project").count(), 0);
      assert.equal(await page.getByText("Bob's project").count(), 0);
      if (shots) await page.screenshot({ path: join(shots, `hub-login-${width}x${height}.png`), fullPage: true });
      // A wrong password says so and keeps the page on the form.
      await page.getByLabel("邮箱").fill("alice@example.test");
      await page.getByLabel("密码").fill("not-the-password");
      await page.getByRole("button", { name: "登录" }).click();
      await page.getByRole("alert").filter({ hasText: "邮箱或密码不对" }).waitFor();
      await page.getByLabel("密码").fill(password("alice"));
      await page.getByRole("button", { name: "登录" }).click();
      // Own projects only, each with where it runs.
      await page.getByRole("heading", { name: "你的项目" }).waitFor();
      await page.getByText("Alice project").waitFor();
      assert.equal(await page.getByText("Bob's project").count(), 0, "another person's project is not listed");
      const item = page.locator("[data-machine]").first();
      await item.waitFor();
      assert.match(await item.innerText(), /机器 mac-e2e · 在线/);
      assert.equal(await item.getAttribute("data-machine"), "online");
      if (shots) await page.screenshot({ path: join(shots, `hub-projects-online-${width}x${height}.png`), fullPage: true });
      // A reload keeps the login (the cookie), without asking again.
      await page.reload();
      await page.getByRole("heading", { name: "你的项目" }).waitFor();
      // Nothing secret in the address or in storage.
      assert.doesNotMatch(page.url(), /token|password|csrf|session/i);
      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
      assert.doesNotMatch(stored, /hub_session|csrf|password-123|Bearer/i, `storage: ${stored}`);
      assert.equal(await page.evaluate(() => document.cookie), "", "the session cookie is HttpOnly: the page cannot read it");
      // Open the project: its content comes from the machine through the Hub.
      await page.getByRole("link", { name: /Alice project/ }).click();
      await page.waitForURL(new RegExp(`/p/${projectId}`));
      await page.goto(`${origin}/p/${projectId}/documents`);
      await page.getByText("Written on the machine").first().waitFor({ timeout: 15000 });
      if (shots) await page.screenshot({ path: join(shots, `hub-project-documents-${width}x${height}.png`), fullPage: true });
      // The machine goes away: the project stays listed, says offline, and the page does not call it a failed Run.
      await connector!.stop();
      await page.getByText(/现在离线，项目内容暂时不能读写/).waitFor({ timeout: 20000 });
      const notice = await page.locator("body").innerText();
      assert.doesNotMatch(notice, /运行失败了|Run 失败|交付失败/);
      if (shots) await page.screenshot({ path: join(shots, `hub-project-offline-${width}x${height}.png`), fullPage: true });
      await page.goto(`${origin}/`);
      await page.locator('[data-machine="offline"]').waitFor();
      assert.match(await page.locator("[data-machine]").first().innerText(), /离线 · 暂不可读写（不代表运行失败）/);
      if (shots) await page.screenshot({ path: join(shots, `hub-projects-offline-${width}x${height}.png`), fullPage: true });
      // It comes back by itself.
      startConnector();
      for (let i = 0; i < 80 && !await machineState(); i++) await wait(100);
      await page.getByRole("button", { name: "刷新项目" }).click();
      await page.locator('[data-machine="online"]').waitFor({ timeout: 15000 });
      // Sign out: back to the login form, and the old cookie is no longer a login.
      await page.getByRole("button", { name: "退出" }).click();
      await page.getByLabel("邮箱").waitFor();
      assert.equal((await context.cookies()).filter(cookie => cookie.name === "__Host-hub_session" && cookie.value).length, 0, "the Hub cleared the cookie");
      assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
      assert.ok(requested.every(url => url.startsWith(origin)), "every request of the page went to the Hub's own address");
      assert.ok(!requested.some(url => /token|password|csrf/i.test(url)), "no credential in any request URL");
      await context.close();
    });
  }

  await t.test("an expired session shows the login again with an expiry notice, and nothing of the project stays on the page", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    await page.goto(`${origin}/`);
    await page.getByLabel("邮箱").fill("alice@example.test");
    await page.getByLabel("密码").fill(password("alice"));
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByRole("heading", { name: "你的项目" }).waitFor();
    await hubPool.query("UPDATE hub_login_session SET expires_at=now() - interval '1 minute' WHERE account_id=$1", [aliceId]);
    await page.getByRole("button", { name: "刷新项目" }).click();
    await page.getByRole("alert").filter({ hasText: "登录已失效" }).waitFor({ timeout: 15000 });
    await page.getByLabel("邮箱").waitFor();
    assert.equal(await page.getByText("Alice project").count(), 0, "the project list is gone with the login");
    if (shots) await page.screenshot({ path: join(shots, "hub-session-expired-1440x900.png"), fullPage: true });
    await context.close();
  });
});
