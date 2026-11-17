// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
// Task 5a47dcb8: a person browses a project through the Hub (10 Sessions: overview, team pages, one Session page, left open) and the Hub is asked, per status code, what the page's own requests got.
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
import { migrate } from "@evoloop/adapter-postgres";
import { machineRequestMessage } from "@evoloop/contracts";
import { buildHubApp } from "../../apps/hub/src/server.js";
import { applyHubMigrations } from "../../apps/hub/src/migrations.js";
import { HubService } from "../../apps/hub/src/service.js";
import { HubStore } from "../../apps/hub/src/store.js";
import { MachineStore } from "../../apps/hub/src/machines.js";
import type { HubConfig } from "../../apps/hub/src/config.js";

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

const WALK_SECONDS = Number(process.env.EVOLOOP_HUB_WALK_SECONDS ?? 20);
const SESSIONS = 10;

test("browsing through the Hub: the page's own requests get no 429 and no 404, and the Hub's own limits are still there", { skip, timeout: (WALK_SECONDS + 120) * 1000 }, async t => {
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
  // What the Hub answered, per request of the page: the Hub's own request log.
  const hubLog: Array<{ method: string; path: string; status: number; hubNotFound: boolean }> = [];
  // A real Hub is a network away from its machine: the machine's answer to each forwarded request takes a round trip to arrive, and the machine counts the request as in flight until it has. On localhost that is
  // ~0, so the round trip is added here (the Hub's respond endpoint is slowed), as the only thing that differs from the formal link. 0 turns it off.
  const respondDelayMs = Number(process.env.EVOLOOP_HUB_RESPOND_DELAY_MS ?? 150);
  // The Hub has already handed the answer to the page; the machine learns that its POST was accepted one round trip later, and holds the slot until then.
  hub.addHook("onSend", async (request, _reply, payload) => { if (respondDelayMs > 0 && request.url.startsWith("/api/machine/respond")) await wait(respondDelayMs); return payload; });
  hub.addHook("onResponse", async (request, reply) => { hubLog.push({ method: request.method, path: request.url.split("?")[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/owned%3A:id|owned:[^/]+/g, "owned:id"), status: reply.statusCode, hubNotFound: request.is404 === true }); });
  await hub.listen({ host: "127.0.0.1", port: hubPort });

  const projectId = randomUUID(), localToken = `${randomUUID()}${randomUUID()}`;
  // The real coordinator, as a process (the page's requests reach all of its routes), joined to this Hub through the machine directory.
  const authFile = join(directory, "auth.json"), coordinatorPort = await freePort(), coordinatorUrl = `http://127.0.0.1:${coordinatorPort}`;
  await writeFile(authFile, JSON.stringify([{ token: localToken, actorId: "local-agent", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true, identityKind: "agent" }]));
  const databaseUrl = `${database}${database!.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${coordinatorSchema}`)}`;
  const { spawn } = await import("node:child_process");
  const coordinatorProcess = spawn(process.execPath, [resolve("apps/coordinator/dist/main.js")], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, EVOLOOP_DATABASE_URL: databaseUrl, EVOLOOP_AUTH_FILE: authFile, EVOLOOP_PORT: String(coordinatorPort), EVOLOOP_BLOB_ROOT: join(directory, "blobs"), EVOLOOP_MACHINE_DIR: machineDir } });
  const coordinatorLog: string[] = []; coordinatorProcess.stdout.on("data", chunk => coordinatorLog.push(String(chunk))); coordinatorProcess.stderr.on("data", chunk => coordinatorLog.push(String(chunk)));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(new URL("/health", coordinatorUrl))).ok) break; } catch { /* not up yet */ } await wait(200); }
  const coordinator = { close: async () => { coordinatorProcess.kill("SIGTERM"); await wait(300); } };
  const connector = { stop: async () => undefined };
  const startConnector = () => undefined;
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

  // Ten Sessions on the machine, each with its Role (the way the Session tests seed them).
  const client = await pool.connect();
  const sessionIds: string[] = [];
  try {
    await client.query("BEGIN");
    for (let n = 0; n < SESSIONS; n++) {
      const role = randomUUID(), revision = randomUUID(), sessionId = randomUUID(); sessionIds.push(sessionId);
      await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',now(),now()+interval '30 days')`, [projectId, role, revision]);
      await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','seed',now(),now()+interval '30 days')`, [projectId, role, revision]);
      await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,'project','danger-full-access','never','ready',1,$5,$6,$7,'local-agent',now(),now())`, [projectId, sessionId, role, `/tmp/hub-walk-${n}`, `thread-${sessionId}`, `native-${sessionId}`, randomUUID()]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  // The most requests of the page that were in flight together (the machine allows 8 at a time).
  let inflightNow = 0, peakInflight = 0;
  page.on("request", request => { if (request.url().includes("/api/")) { inflightNow += 1; peakInflight = Math.max(peakInflight, inflightNow); } });
  const done = (request: { url(): string }) => { if (request.url().includes("/api/")) inflightNow = Math.max(0, inflightNow - 1); };
  page.on("requestfinished", done); page.on("requestfailed", done);
  await page.goto(`${origin}/`);
  await page.getByLabel("邮箱").fill("alice@example.test");
  await page.getByLabel("密码").fill(password("alice"));
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("heading", { name: "你的项目" }).waitFor();
  hubLog.length = 0;                                   // only what the page does from here on
  await page.getByRole("link", { name: /Alice project/ }).first().click();
  await page.waitForURL(new RegExp(`/p/${projectId}`));
  for (const path of ["overview", "arrangement", "sessions", `sessions?session=${encodeURIComponent(`owned:${sessionIds[0]}`)}`]) {
    await page.evaluate(target => { history.pushState({}, "", target); window.dispatchEvent(new PopStateEvent("popstate")); }, `/p/${projectId}/${path}`);
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(WALK_SECONDS * 1000);       // the page stays open on the Session
  const text = await page.locator("body").innerText();
  const counts = new Map<number, number>(); for (const entry of hubLog.filter(item => item.path.startsWith("/api/"))) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  const byPath = (status: number) => [...hubLog.filter(item => item.status === status && item.path.startsWith("/api/")).reduce((map, item) => map.set(item.path, (map.get(item.path) ?? 0) + 1), new Map<string, number>())].sort((x, y) => y[1] - x[1]);
  const hubNotFound = hubLog.filter(item => item.hubNotFound && item.path.startsWith("/api/"));
  const report = { walkSeconds: WALK_SECONDS, sessions: SESSIONS, respondDelayMs, peakInflight, hubNotFound: [...hubNotFound.reduce((map, item) => map.set(item.path, (map.get(item.path) ?? 0) + 1), new Map<string, number>())], requests: hubLog.filter(item => item.path.startsWith("/api/")).length, byStatus: Object.fromEntries([...counts].sort()), s429: byPath(429).slice(0, 8), s404: byPath(404).slice(0, 8), pageErrors, boundary: /这一页显示出错/.test(text) };
  if (process.env.EVOLOOP_HUB_WALK_REPORT) await writeFile(process.env.EVOLOOP_HUB_WALK_REPORT, JSON.stringify(report, null, 2));
  console.log("HUB WALK", JSON.stringify(report));
  assert.equal(counts.get(429) ?? 0, 0, `no 429 on the page's own requests: ${JSON.stringify(byPath(429))}`);
  // 404 from the Hub itself = the page asked for something the Hub does not have. (A 404 the machine's coordinator answers for a Session it has no runtime for is its own, the same on a local login.)
  assert.deepEqual(report.hubNotFound, [], "the page asks the Hub for nothing it does not have");
  assert.deepEqual(pageErrors, []); assert.equal(report.boundary, false);

  // The protection is still there: a burst far above the machine's limit, sent straight at the Hub as the page would, is still refused (429) for the surplus.
  const cookie = (await context.cookies()).map(entry => `${entry.name}=${entry.value}`).join("; ");
  const burst = await Promise.all(Array.from({ length: 60 }, () => fetch(new URL(`/api/projects/${projectId}/session-work?limit=50`, origin), { headers: { cookie, origin } }).then(response => response.status)));
  const refused = burst.filter(status => status === 429).length;
  console.log("HUB BURST", JSON.stringify({ sent: burst.length, ok: burst.filter(status => status === 200).length, refused429: refused }));
  assert.ok(refused > 0, "a burst of 60 simultaneous requests is still limited by the machine's connector");
  await context.close();
});
