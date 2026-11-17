// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { buildHubApp } from "../../apps/hub/src/server.js";
import { applyHubMigrations } from "../../apps/hub/src/migrations.js";
import { HubService } from "../../apps/hub/src/service.js";
import { HubStore } from "../../apps/hub/src/store.js";
import { MachineStore } from "../../apps/hub/src/machines.js";
import { respondBodyLimit } from "../../apps/hub/src/machine-routes.js";
import type { HubConfig } from "../../apps/hub/src/config.js";
import { MachineCredentialSource } from "../../apps/coordinator/src/hub/credentials.js";
import { HubConnector } from "../../apps/coordinator/src/hub/connector.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== "/evoloop_hub_test") throw new Error("Hub integration tests require the dedicated evoloop_hub_test database");

// Defaults as a Hub is started without HUB_BODY_LIMIT_BYTES: 64 KB for every route, 8 MB for the largest forwarded response (Task b5fe71c8).
const config: HubConfig = {
  publicOrigin: "http://hub.test", port: 4319, host: "127.0.0.1", sessionTtlMs: 12 * 60 * 60 * 1000, inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  loginMaxFailures: 5, loginWindowMs: 15 * 60 * 1000, loginBlockMs: 15 * 60 * 1000, bodyLimitBytes: 64 * 1024,
  machineHeartbeatMs: 300, forwardTimeoutMs: 6000, forwardBodyLimitBytes: 128 * 1024, maxResponseBytes: 8 * 1024 * 1024,
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const wait = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until<T>(what: string, read: () => Promise<T | null | false | undefined> | T | null | false | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await read(); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`); await wait(50); }
}
/** Deterministic bytes of a given size, so "byte for byte" is a hash comparison. */
const pattern = (size: number) => { const buffer = Buffer.alloc(size); for (let i = 0; i < size; i++) buffer[i] = (i * 31 + (i >> 8)) & 255; return buffer; };

test("a Hub with default limits delivers a 200 KB machine answer byte for byte; a too-large or refused answer is a prompt, clear 502; other routes keep 64 KB", async t => {
  const hubSchema = `hubr_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: database });
  await admin.connect(); await admin.query(`CREATE SCHEMA "${hubSchema}"`);
  const hubPool = new pg.Pool({ connectionString: database, max: 8, options: `-c search_path=${hubSchema}` });
  await applyHubMigrations(hubPool);
  const directory = await mkdtemp(join(tmpdir(), "evoloop-hub-respond-"));
  const machineDir = join(directory, "machine"), allowedRoot = join(directory, "work");
  await mkdir(allowedRoot, { recursive: true });
  const logs: string[] = [];

  const store = new HubStore(hubPool), machines = new MachineStore(hubPool), hubService = new HubService(store, config);
  const hub = buildHubApp({ config, store, service: hubService, machines, logger: { level: "silent" } });
  const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });

  // The "coordinator": answers GET /api/projects/<id>/sized?bytes=N with N deterministic bytes. (What matters here is the Hub ↔ connector leg; identity checks are tested elsewhere.)
  const requestsSeen: string[] = [];
  const fake = createServer((request, response) => {
    requestsSeen.push(request.url ?? "");
    if ((request.url ?? "").includes("/deny")) { response.writeHead(401, { "content-type": "application/json" }); response.end("{\"code\":\"UNAUTHENTICATED\"}"); return; }
    const size = Number(new URL(request.url ?? "/", "http://x").searchParams.get("bytes") ?? "0");
    response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(pattern(size));
  });
  await new Promise<void>(listening => fake.listen(0, "127.0.0.1", listening));
  const coordinatorUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const credentialSource = new MachineCredentialSource(machineDir);
  // A transport that can refuse a machine answer above a size, as a Hub with a smaller limit would (counted, so the test can see the second, small answer).
  let refuseRespondAbove: number | null = null; const respondSizes: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/api/machine/respond")) {
      const size = typeof init?.body === "string" ? init.body.length : 0; respondSizes.push(size);
      if (refuseRespondAbove !== null && size > refuseRespondAbove) return new Response(JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE" } }), { status: 413, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };
  const connector = new HubConnector({ credentials: credentialSource, coordinatorUrl, log: message => logs.push(message), backoffMs: { initial: 100, max: 300 }, idleCheckMs: 100, fetchImpl });
  t.after(async () => {
    await connector.stop(); await hub.close().catch(() => undefined); await new Promise(done => fake.close(done));
    await hubPool.end(); await admin.query(`DROP SCHEMA "${hubSchema}" CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true });
  });

  const inject = (browser: { cookie: string; csrf: string } | null, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => hub.inject({ method, url,
    headers: { origin: config.publicOrigin, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(browser ? { cookie: browser.cookie, "x-hub-csrf": browser.csrf } : {}) }, ...(payload === undefined ? {} : { payload }) });
  await hubService.initializeFirstAdmin({ email: "admin@example.test", displayName: "Hub Admin", password: "admin-password-123" });
  const loggedIn = await inject(null, "POST", "/api/auth/login", { email: "admin@example.test", password: "admin-password-123" });
  const adminBody = loggedIn.json<{ csrfToken: string; account: { accountId: string } }>();
  const hubAdmin = { cookie: (loggedIn.headers["set-cookie"] as string).split(";")[0]!, csrf: adminBody.csrfToken };

  // Join through the real CLI (the machine keeps its own key pair), then connect the real connector.
  const created = (await inject(hubAdmin, "POST", "/api/admin/machines", { name: "mac-respond" })).json<{ machine: { machineId: string }; joinCode: string }>();
  const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...args], { env: { ...process.env, EVOLOOP_MACHINE_DIR: machineDir, EVOLOOP_STATE_DIR: join(directory, "receipts") }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", d => { stdout += String(d); }); child.stderr.on("data", d => { stderr += String(d); });
    child.on("error", reject); child.on("close", code => resolveResult({ code, stdout, stderr }));
  });
  const joined = await cli(["machine", "join", "--hub", hubUrl, "--code", created.joinCode, "--workspace-root", allowedRoot, "--yes"]);
  assert.equal(joined.code, 0, joined.stderr);
  connector.start();
  await until("the machine to show online", async () => (await inject(hubAdmin, "GET", "/api/admin/machines")).json<{ machines: Array<{ machineId: string; online: boolean }> }>().machines.find(m => m.machineId === created.machine.machineId && m.online));

  // A project on that machine and a service identity scoped to it, to ask through the Hub.
  const projectId = randomUUID();
  assert.equal((await inject(hubAdmin, "POST", "/api/admin/projects", { projectId, name: "Respond limit", machineId: created.machine.machineId, projectAdminAccountId: adminBody.account.accountId })).statusCode, 201);
  const service = await inject(hubAdmin, "POST", "/api/admin/service-identities", { actorId: "svc-reader", displayName: "Reader", ownerAccountId: adminBody.account.accountId, purpose: "test", projectIds: [projectId] });
  const token = service.json<{ token: string }>().token;
  const ask = (bytes: number) => hub.inject({ method: "GET", url: `/api/projects/${projectId}/sized?bytes=${bytes}`, headers: { authorization: `Bearer ${token}` } });

  await t.test("the respond route's limit is derived from maxResponseBytes (base64 and frame included); the global limit stays 64 KB", () => {
    assert.equal(respondBodyLimit(3 * 1024), 4 * 1024 + 8 * 1024, "3 KB of answer is 4 KB of base64 plus the 8 KB frame allowance");
    assert.ok(respondBodyLimit(8 * 1024 * 1024) >= Math.ceil(8 * 1024 * 1024 * 4 / 3) + 4096);
    assert.equal(config.bodyLimitBytes, 64 * 1024);
  });

  await t.test("a 200 KB and a 5 MB answer arrive through the Hub byte for byte, with the default limits", async () => {
    for (const bytes of [200 * 1024, 5 * 1024 * 1024]) {
      const started = Date.now();
      const response = await ask(bytes);
      assert.equal(response.statusCode, 200, response.body.slice(0, 200));
      assert.equal(response.rawPayload.length, bytes); assert.equal(sha(response.rawPayload), sha(pattern(bytes)), `${bytes} bytes arrive unchanged`);
      assert.ok(Date.now() - started < 5000, "well inside the forward timeout");
    }
  });

  await t.test("an answer over 8 MB is a clear 502 at once, not a timeout", async () => {
    const started = Date.now();
    const response = await ask(8 * 1024 * 1024 + 1024);
    assert.equal(response.statusCode, 502, response.body.slice(0, 200));
    assert.equal(response.json<{ code?: string; error?: { code?: string } }>().code ?? response.json<{ error?: { code?: string } }>().error?.code, "ANSWER_TOO_LARGE");
    assert.ok(Date.now() - started < 4000, `answered in ${Date.now() - started} ms, before the 6 s forward timeout`);
  });

  await t.test("when the Hub refuses a machine answer, the connector logs one line without the body and fails the request at once with ANSWER_REJECTED", async () => {
    refuseRespondAbove = 100 * 1024; logs.length = 0; respondSizes.length = 0;
    const started = Date.now();
    const response = await ask(300 * 1024);
    refuseRespondAbove = null;
    assert.equal(response.statusCode, 502, response.body.slice(0, 200));
    assert.equal(response.json<{ code?: string; error?: { code?: string } }>().code ?? response.json<{ error?: { code?: string } }>().error?.code, "ANSWER_REJECTED");
    assert.ok(Date.now() - started < 4000, `failed in ${Date.now() - started} ms, not after the 6 s forward timeout`);
    const refusedLines = logs.filter(line => /answer was refused by the Hub/.test(line));
    assert.equal(refusedLines.length, 1, `one line: ${JSON.stringify(logs)}`);
    assert.match(refusedLines[0]!, /HTTP 413, \d+ bytes/);
    assert.ok(!logs.join("\n").includes("OCTET") && refusedLines[0]!.length < 200, "no body in the line");
    assert.equal(respondSizes.length, 2, "the big answer, then the small one");
  });

  await t.test("other routes keep the 64 KB limit: a 70 KB body to login is refused, a small one is not", async () => {
    const big = await hub.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json", origin: config.publicOrigin }, payload: JSON.stringify({ email: "a@example.test", password: "x".repeat(70 * 1024) }) });
    assert.equal(big.statusCode, 413, big.body.slice(0, 200));
    const small = await hub.inject({ method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json", origin: config.publicOrigin }, payload: JSON.stringify({ email: "a@example.test", password: "x".repeat(100) }) });
    assert.notEqual(small.statusCode, 413);
    // And the respond route itself still refuses a body far past its own limit.
    const response = await hub.inject({ method: "POST", url: "/api/machine/respond", headers: { "content-type": "application/vnd.evoloop-machine+json" }, payload: "x".repeat(respondBodyLimit(config.maxResponseBytes!) + 1024) });
    assert.equal(response.statusCode, 413, response.body.slice(0, 200));
  });

  await t.test("when the coordinator refuses a forwarded identity (401) the connector says so in one line, without the body, and the Hub passes the 401 on", async () => {
    logs.length = 0;
    const response = await hub.inject({ method: "GET", url: `/api/projects/${projectId}/deny`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 401);
    const lines = logs.filter(line => /refused a forwarded request's identity \(401\)/.test(line));
    assert.equal(lines.length, 1, JSON.stringify(logs)); assert.ok(!lines[0]!.includes("UNAUTHENTICATED"));
  });
});
