// Task b8460d62: two coordinators on one machine credential. Observation 3c6ba3b3 on the formal Hub: heartbeat and connect jumped from ~4/min to ~52/min
// and about half the forwarded reads failed (401 / 502) while a second coordinator shared the machine directory. This file reproduces that with a real
// Hub and real coordinators (the first subtest only measures and prints, so it can be run against the code before the fix), then holds the fix:
// a second live connection from another process is refused with a readable conflict and does not replace the first; a stale first connection is
// replaced; a coordinator without an explicit machine directory does not read the default (formal) credentials; records carry no secrets.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { buildHubApp, logGatewayEvent } from "../../apps/hub/src/server.js";
import { applyHubMigrations } from "../../apps/hub/src/migrations.js";
import { HubService } from "../../apps/hub/src/service.js";
import { HubStore } from "../../apps/hub/src/store.js";
import { Gateway } from "../../apps/hub/src/gateway.js";
import { MachineStore } from "../../apps/hub/src/machines.js";
import type { HubConfig } from "../../apps/hub/src/config.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { HubIdentityVerifier } from "../../apps/coordinator/src/hub/identity.js";
import { MachineCredentialSource, machineDirectory, unusedDefaultCredentials } from "../../apps/coordinator/src/hub/credentials.js";
import { machineRequestMessage } from "@evoloop/contracts";
import { HubConnector } from "../../apps/coordinator/src/hub/connector.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== "/evoloop_hub_test") throw new Error("Hub machine integration tests require the dedicated evoloop_hub_test database");
const HEARTBEAT_MS = 300;
const config: HubConfig = {
  publicOrigin: "http://hub.test", port: 4319, host: "127.0.0.1", sessionTtlMs: 12 * 60 * 60 * 1000, inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  loginMaxFailures: 5, loginWindowMs: 15 * 60 * 1000, loginBlockMs: 15 * 60 * 1000, bodyLimitBytes: 64 * 1024,
  machineHeartbeatMs: HEARTBEAT_MS, forwardTimeoutMs: 5000, forwardBodyLimitBytes: 128 * 1024, maxResponseBytes: 8 * 1024 * 1024,
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const wait = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function until<T>(what: string, read: () => Promise<T | null | false | undefined> | T | null | false | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await wait(50);
  }
}

test("two coordinators on one machine credential: reproduction, then explicit conflict, recovery, isolation and clean records", async t => {
  const hubSchema = `hubx_${randomUUID().replaceAll("-", "").slice(0, 16)}`, coordinatorSchema = `hubcx_${randomUUID().replaceAll("-", "").slice(0, 16)}`, otherSchema = `hubdx_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${hubSchema}"`);
  const hubPool = new pg.Pool({ connectionString: database, max: 8, options: `-c search_path=${hubSchema}` });
  await applyHubMigrations(hubPool);
  await migrate(database, coordinatorSchema);
  await migrate(database, otherSchema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${coordinatorSchema}` });
  const directory = await mkdtemp(join(tmpdir(), "evoloop-hub-conflict-"));
  const machineDir = join(directory, "machine"), allowedRoot = join(directory, "work");
  await mkdir(allowedRoot, { recursive: true });

  // ---- the Hub (its gateway events and every machine request are recorded), on a real loopback port ----
  const hubEvents: Array<Record<string, unknown>> = [];
  const machineRequests: Array<{ at: number; action: string; status: number }> = [];
  const store = new HubStore(hubPool), machines = new MachineStore(hubPool), hubService = new HubService(store, config);
  const hubLog: string[] = [];
  const hub = buildHubApp({ config, store, service: hubService, machines, logger: { level: "silent" }, onGatewayEvent: event => {
    hubEvents.push(event);
    // What the Hub itself writes to its log for this event (the same function the Hub logs with), kept as the text a log line would carry.
    logGatewayEvent({ warn: (fields: unknown, text?: string) => { hubLog.push(`WARN ${text} ${JSON.stringify(fields)}`); }, info: (fields: unknown, text?: string) => { hubLog.push(`INFO ${text} ${JSON.stringify(fields)}`); } }, event);
  } });
  hub.addHook("onResponse", async (request, reply) => {
    const action = /^\/api\/machine\/(connect|heartbeat|respond)$/.exec(request.url.split("?")[0] ?? "")?.[1];
    if (action) machineRequests.push({ at: Date.now(), action, status: reply.statusCode });
  });
  // Idle keep-alive sockets the test's own clients leave behind would hold hub.close() for the server's keep-alive timeout (72 s): they are destroyed first.
  const hubSockets = new Set<import("node:net").Socket>();
  hub.server.on("connection", socket => { hubSockets.add(socket); socket.once("close", () => hubSockets.delete(socket)); });
  const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });

  // ---- the machine's coordinator, with one project ----
  const projectId = randomUUID(), localToken = `${randomUUID()}${randomUUID()}`, localActor = "local-team-agent";
  const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash: sha } });
  const credentialSource = new MachineCredentialSource(machineDir);
  const verifier = new HubIdentityVerifier({ credentials: () => credentialSource.current(),
    isLocalProject: async id => (await pool.query("SELECT 1 FROM project WHERE project_id=$1", [id])).rowCount === 1, localActorIds: () => new Set([localActor]) });
  const coordinator = await buildServer({ service, credentials: [{ token: localToken, actorId: localActor, projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }],
    hubIdentity: { verifier, onAccepted: () => undefined, onRejected: () => undefined } });
  const coordinatorUrl = await coordinator.listen({ host: "127.0.0.1", port: 0 });
  // The second process of the incident: another real coordinator (its own project database, which does not hold this project) that read the same machine directory.
  const otherPool = new pg.Pool({ connectionString: database, options: `-c search_path=${otherSchema}` });
  const otherService = new WorkflowService({ uow: new PostgresUnitOfWork(otherPool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash: sha } });
  const otherVerifier = new HubIdentityVerifier({ credentials: () => credentialSource.current(),
    isLocalProject: async id => (await otherPool.query("SELECT 1 FROM project WHERE project_id=$1", [id])).rowCount === 1, localActorIds: () => new Set() });
  const otherCoordinator = await buildServer({ service: otherService, credentials: [{ token: `${randomUUID()}${randomUUID()}`, actorId: "other-agent", projectIds: [randomUUID()], permissions: ["task"], decisions: false }],
    hubIdentity: { verifier: otherVerifier, onAccepted: () => undefined, onRejected: () => undefined } });
  const otherUrl = await otherCoordinator.listen({ host: "127.0.0.1", port: 0 });
  const connectors: HubConnector[] = [];
  const logsA: string[] = [], logsB: string[] = [];
  const makeConnector = (log: string[], source = credentialSource, target = coordinatorUrl) => {
    const connector = new HubConnector({ credentials: source, coordinatorUrl: target, log: message => log.push(message), backoffMs: { initial: 100, max: 300 }, idleCheckMs: 100 });
    connectors.push(connector);
    return connector;
  };
  t.after(async () => {
    for (const connector of connectors) await connector.stop();
    for (const socket of hubSockets) socket.destroy();
    await hub.close().catch(() => undefined);
    await coordinator.close(); await otherCoordinator.close();
    await hubPool.end(); await pool.end(); await otherPool.end();
    await admin.query(`DROP SCHEMA "${hubSchema}" CASCADE`); await admin.query(`DROP SCHEMA "${coordinatorSchema}" CASCADE`); await admin.query(`DROP SCHEMA "${otherSchema}" CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal((await fetch(new URL("/api/commands", coordinatorUrl), { method: "POST", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId, operationId: randomUUID(), type: "project.create", title: "Conflict project" }) })).status, 200);

  // ---- Hub account, machine joined through the CLI, project placed on it, a service identity that may read ----
  const inject = (cookie: { cookie: string; csrf: string } | null, method: "GET" | "POST", url: string, payload?: unknown) => hub.inject({ method, url,
    headers: { origin: config.publicOrigin, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie: cookie.cookie, "x-hub-csrf": cookie.csrf } : {}) }, ...(payload === undefined ? {} : { payload }) });
  await hubService.initializeFirstAdmin({ email: "admin@example.test", displayName: "Hub Admin", password: "admin-password-123" });
  const loginResponse = await inject(null, "POST", "/api/auth/login", { email: "admin@example.test", password: "admin-password-123" });
  const adminSession = { cookie: (loginResponse.headers["set-cookie"] as string).split(";")[0]!, csrf: loginResponse.json<{ csrfToken: string }>().csrfToken };
  const accountId = loginResponse.json<{ account: { accountId: string } }>().account.accountId;
  const created = (await inject(adminSession, "POST", "/api/admin/machines", { name: "mac-conflict" })).json<{ machine: { machineId: string }; joinCode: string }>();
  const machineId = created.machine.machineId;
  const cli = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...args], { env: { ...process.env, EVOLOOP_MACHINE_DIR: machineDir, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
    child.once("error", reject); child.once("close", code => resolveResult({ code, stdout, stderr }));
  });
  const joined = await cli(["machine", "join", "--hub", hubUrl, "--code", created.joinCode, "--workspace-root", allowedRoot, "--yes"]);
  assert.equal(joined.code, 0, joined.stderr);
  const privateKey = (JSON.parse(await readFile(join(machineDir, "machine.json"), "utf8")) as { privateKey: string }).privateKey;
  assert.equal((await inject(adminSession, "POST", "/api/admin/projects", { projectId, name: "Conflict project", machineId, projectAdminAccountId: accountId })).statusCode, 201);
  const serviceToken = (await inject(adminSession, "POST", "/api/admin/service-identities", { actorId: "svc-reader", displayName: "Reader", ownerAccountId: accountId, purpose: "test", projectIds: [projectId] })).json<{ token: string }>().token;
  const readThroughHub = async () => (await hub.inject({ method: "GET", url: `/api/projects/${projectId}/documents`, headers: { authorization: `Bearer ${serviceToken}` } })).statusCode;
  const onlineNow = async () => ((await inject(adminSession, "GET", "/api/admin/machines")).json<{ machines: Array<{ machineId: string; online: boolean }> }>().machines.find(m => m.machineId === machineId)?.online) === true;
  const perMinute = (action: string, since: number, windowMs: number) => Math.round(machineRequests.filter(r => r.action === action && r.at >= since).length * 60_000 / windowMs);

  // ---- 1. reproduction: measured on whatever code this runs against (printed; the fix's assertions follow in later subtests) ----
  await t.test("reproduction: a second coordinator process with the same machine credentials — connect/heartbeat rates and forwarded reads", async () => {
    const first = makeConnector(logsA);
    first.start();
    await until("the machine to show online", onlineNow);
    const quietFrom = Date.now(); await wait(2000);
    const quiet = { connectPerMin: perMinute("connect", quietFrom, 2000), heartbeatPerMin: perMinute("heartbeat", quietFrom, 2000) };
    const second = makeConnector(logsB, credentialSource, otherUrl);
    second.start();
    const from = Date.now(); const reads: number[] = [];
    for (let n = 0; n < 24; n++) { reads.push(await readThroughHub()); await wait(100); }
    const windowMs = Date.now() - from;
    const tally: Record<string, number> = {}; for (const status of reads) tally[status] = (tally[status] ?? 0) + 1;
    const summary = { oneConnector: quiet, twoConnectors: { connectPerMin: perMinute("connect", from, windowMs), heartbeatPerMin: perMinute("heartbeat", from, windowMs), connectStatuses: [...new Set(machineRequests.filter(r => r.action === "connect" && r.at >= from).map(r => r.status))],
      forwardedReads: tally }, gatewayEvents: hubEvents.map(e => e.type as string).reduce<Record<string, number>>((all, type) => ({ ...all, [type]: (all[type] ?? 0) + 1 }), {}), logsA: logsA.length, logsB: logsB.length };
    console.log(`REPRO ${JSON.stringify(summary)}`);
    if (process.env.EVOLOOP_REPRO_OUT) await writeFile(process.env.EVOLOOP_REPRO_OUT, JSON.stringify({ summary, logsA: logsA.slice(0, 12), logsB: logsB.slice(0, 12) }, null, 1));
    await first.stop(); await second.stop();
    connectors.length = 0;
    await until("the machine to go offline", async () => !(await onlineNow()), 10_000);
  });

  // A raw machine connection as an older connector (no instance ID) or a test would open it: signed, then held open without ever sending a heartbeat.
  const rawConnect = async (instance: string | null) => {
    const timestamp = String(Date.now()), nonce = randomUUID();
    const signature = sign(null, Buffer.from(machineRequestMessage(machineId, "connect", timestamp, nonce, createHash("sha256").update("").digest("base64url"))), createPrivateKey(privateKey)).toString("base64url");
    // node:http, so that closing really destroys the socket (the Hub's own shutdown waits for open streams).
    return new Promise<{ response: { status: number; json(): Promise<unknown> }; close(): void }>((resolveConnect, reject) => {
      const request = httpRequest(new URL("/api/machine/connect", hubUrl), { method: "POST", agent: false, headers: { "x-evoloop-machine": machineId, "x-evoloop-machine-time": timestamp,
        "x-evoloop-machine-nonce": nonce, "x-evoloop-machine-signature": signature, ...(instance ? { "x-evoloop-machine-instance": instance } : {}) } }, res => {
        const chunks: Buffer[] = [];
        const status = res.statusCode ?? 0;
        if (status !== 200) { res.on("data", chunk => chunks.push(chunk)); res.on("end", () => resolveConnect({ response: { status, json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }, close: () => request.destroy() })); }
        else { res.resume(); resolveConnect({ response: { status, json: async () => ({}) }, close: () => { res.destroy(); request.destroy(); } }); }
      });
      request.once("error", reject);
      request.end();
    });
  };
  const openConnections = () => new Promise<number>(done => hub.server.getConnections((_e, n) => done(n)));
  const eventsOf = (type: string) => hubEvents.filter(event => event.type === type);

  // ---- 2. the fix: a second live process is refused, the first keeps its connection and its reads ----
  await t.test("a second live process on the same credentials is refused with a readable conflict; the first connection is not replaced and its reads all succeed", async () => {
    logsA.length = 0; logsB.length = 0; hubEvents.length = 0; machineRequests.length = 0; hubLog.length = 0;
    const first = makeConnector(logsA), second = makeConnector(logsB, credentialSource, otherUrl);
    first.start();
    await until("the first coordinator to be online", () => first.state === "online");
    const attachedBefore = eventsOf("attached").length;
    second.start();
    await until("the second coordinator to be told about the conflict", () => second.conflicts >= 2, 10_000);
    const reads: number[] = [];
    for (let n = 0; n < 24; n++) { reads.push(await readThroughHub()); await wait(50); }
    assert.deepEqual([...new Set(reads)], [200], "every read through the Hub reaches the first coordinator");
    // The refused process asks again every few hundred ms and is "connecting" while that request is in flight, "conflict" while it waits: either is a refusal in progress. What must never be is online.
    assert.equal(first.state, "online"); assert.ok(second.state === "conflict" || second.state === "connecting", `the refused process is not admitted (state ${second.state})`);
    assert.equal(eventsOf("replaced_stale").length + eventsOf("reattached_same_process").length, 0, "the first connection was never replaced");
    assert.equal(eventsOf("attached").length, attachedBefore, "no new connection was admitted");
    assert.ok(eventsOf("conflict").length >= 2);
    assert.equal(logsA.length, 0, "the first coordinator saw nothing happen");
    assert.match(logsB[0] ?? "", /refused this coordinator's connection \(conflict 1\)/);
    assert.ok((logsB[0] ?? "").includes(machineId) && /EVOLOOP_MACHINE_DIR/.test(logsB[0] ?? ""), "the coordinator's record names the machine and what to do");
    const conflict = eventsOf("conflict").at(-1)!;
    assert.equal(conflict.machineId, machineId); assert.notEqual(conflict.instance, conflict.existingInstance);
    assert.ok(hubLog.some(line => /REFUSED: another process is already connected/.test(line) && line.includes(machineId)), "the Hub log says so, with the machine ID");
    assert.equal(machineRequests.filter(r => r.action === "connect" && r.status === 409).length >= 2, true, "the refusal is an ordinary 409");
    const listed = (await inject(adminSession, "GET", "/api/admin/machines")).json<{ machines: Array<{ machineId: string; connectionConflicts: { count: number; lastAt: string } | null }> }>().machines.find(m => m.machineId === machineId);
    assert.ok((listed?.connectionConflicts?.count ?? 0) >= 2, "the admin machine list shows the refused connections");
    // A connector from an older release (no instance ID) is a different process too.
    const legacy = await rawConnect(null);
    assert.equal(legacy.response.status, 409); assert.equal((await legacy.response.json() as { error: { code: string } }).error.code, "MACHINE_CONNECTION_CONFLICT");
    // The second process's heartbeats and answers are not the first's: they do not keep it alive or answer for it.
    const staleBeat = await hub.inject({ method: "POST", url: "/api/machine/heartbeat", headers: { "x-evoloop-machine-instance": randomUUID() } });
    assert.equal(staleBeat.statusCode, 401, "an unsigned heartbeat is still refused");
    await second.stop(); await first.stop(); connectors.length = 0;
    await until("the machine to go offline", async () => !(await onlineNow()), 10_000);
  });

  // ---- 3. recovery: a legitimate reconnect works when the first is gone or has gone quiet, and nothing is locked ----
  await t.test("when the first process exits, the waiting one connects; when the first has gone quiet, a new process takes over; the same process reconnects at once", async () => {
    hubEvents.length = 0; logsA.length = 0; logsB.length = 0;
    const first = makeConnector(logsA), second = makeConnector(logsB, credentialSource, otherUrl);
    first.start(); await until("the first online", () => first.state === "online");
    second.start(); await until("the second to be refused", () => second.conflicts >= 1);
    const exited = Date.now();
    await first.stop();
    await until("the waiting process to connect", () => second.state === "online", 10_000);
    assert.ok(Date.now() - exited < 5000, `the takeover after the first exits is quick (${Date.now() - exited} ms)`);
    await until("the machine to be online", onlineNow);
    await second.stop(); connectors.length = 0;
    await until("the machine to go offline", async () => !(await onlineNow()), 10_000);

    // A process that connected and then went silent (dead link, hung process): after the Hub's allowance (three heartbeat intervals) a new process takes over.
    hubEvents.length = 0;
    const silent = await rawConnect(randomUUID());
    assert.equal(silent.response.status, 200);
    const refusedWhileAlive = makeConnector([], credentialSource, otherUrl);
    refusedWhileAlive.start();
    await until("the live-looking silent link to cause a conflict", () => refusedWhileAlive.conflicts >= 1);
    await until("the silent link to be replaced", () => refusedWhileAlive.state === "online", 10_000);
    // Two correct ways for the silent link to go: the new process's retry reaches the Hub after the link passed the allowance (replaced_stale), or the Hub's own
    // ping timer, which runs on the same allowance, ends it first (dropped, heartbeat_lost) and the retry finds nobody. Which one comes first depends on the phase of
    // the Hub's ping timer against the connector's retry (100-300 ms) and on how late the runner delivers timers, so both are accepted here and the
    // "a quiet link is replaced" path is held deterministically by its own subtest below. Either way the silent link is gone once, by one of the two.
    const replacedStale = eventsOf("replaced_stale").length;
    const lostBeat = eventsOf("dropped").filter(event => event.reason === "heartbeat_lost").length;
    assert.equal(replacedStale + lostBeat, 1, `the silent link ended exactly once, by takeover or by the Hub's heartbeat check (replaced_stale ${replacedStale}, heartbeat_lost ${lostBeat}; events ${JSON.stringify(hubEvents.map(event => [event.type, event.reason]))})`);
    if (replacedStale === 1) assert.ok(hubLog.some(line => /replaced: the previous connection had gone quiet/.test(line)));
    silent.close();
    await refusedWhileAlive.stop(); connectors.length = 0;
    await until("the machine to go offline", async () => !(await onlineNow()), 10_000);

    // The same process (same instance ID) reconnecting replaces its own old link at once, even though the old one still looks alive.
    hubEvents.length = 0;
    const id = randomUUID();
    const old = await rawConnect(id);
    assert.equal(old.response.status, 200);
    const again = await rawConnect(id);
    assert.equal(again.response.status, 200, "the same process is not refused");
    assert.equal(eventsOf("reattached_same_process").length, 1);
    old.close(); again.close();
    await until("the machine to go offline", async () => !(await onlineNow()), 10_000);
  });

  // The takeover of a quiet link, without a timer race: the gateway's clock is the test's, and its own ping timer (one interval of an hour) never runs in this test.
  await t.test("a different process takes over a link that has been quiet for more than three heartbeat intervals, and is refused while it is not", () => {
    const interval = 60 * 60 * 1000;
    let now = 1_000_000;
    const events: Array<{ type: string; reason?: unknown }> = [];
    const gateway = new Gateway({ heartbeatMs: interval, forwardTimeoutMs: 1000, maxResponseBytes: 1024, now: () => now, onEvent: event => { events.push(event); } });
    try {
      const sink = { write: () => true } as unknown as import("node:stream").Writable;
      const quiet = gateway.attach("machine-x", sink, "instance-quiet");
      now += interval * 3;
      assert.throws(() => gateway.attach("machine-x", sink, "instance-other"), /Another process is already connected/, "exactly three intervals of silence is still alive");
      now += 1;
      const taken = gateway.attach("machine-x", sink, "instance-other");
      assert.notEqual(taken.connectionId, quiet.connectionId);
      assert.deepEqual(events.map(event => event.type), ["attached", "conflict", "replaced_stale"]);
      assert.equal(gateway.online("machine-x"), true);
    } finally { gateway.close(); }
  });

  // ---- 4. isolation: no machine directory named, no machine credentials ----
  await t.test("a coordinator with no EVOLOOP_MACHINE_DIR does not read the default location's credentials", async () => {
    const home = join(directory, "home");
    await mkdir(join(home, ".evoloop", "machine"), { recursive: true });
    await copyFile(join(machineDir, "machine.json"), join(home, ".evoloop", "machine", "machine.json"));
    const savedHome = process.env.HOME, savedDir = process.env.EVOLOOP_MACHINE_DIR;
    try {
      process.env.HOME = home; delete process.env.EVOLOOP_MACHINE_DIR;
      assert.equal(machineDirectory(), null, "no directory named: none is chosen");
      assert.equal(new MachineCredentialSource().path, null);
      assert.equal(new MachineCredentialSource().current(), null, "the credentials at the default location are not read");
      assert.equal(unusedDefaultCredentials(), true, "the operator is told they exist and are not used");
      const idle = makeConnector([], new MachineCredentialSource());
      idle.start(); await wait(600);
      assert.equal(idle.state, "idle", "such a coordinator does not connect to the Hub");
      assert.equal(machineRequests.filter(r => r.at > Date.now() - 500).length, 0);
      await idle.stop(); connectors.length = 0;
      process.env.EVOLOOP_MACHINE_DIR = machineDir;
      assert.equal(machineDirectory(), machineDir);
      assert.notEqual(new MachineCredentialSource().current(), null, "an explicitly named directory is read");
      assert.equal(unusedDefaultCredentials(), false);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedDir === undefined) delete process.env.EVOLOOP_MACHINE_DIR; else process.env.EVOLOOP_MACHINE_DIR = savedDir;
    }
  });

  // ---- 5. the records carry no secrets ----
  await t.test("the Hub log, the gateway events and the coordinators' records contain no key, token or signature", async () => {
    const everything = [...hubLog, ...logsA, ...logsB, JSON.stringify(hubEvents)].join("\n");
    assert.ok(everything.includes(machineId), "the records do name the machine");
    const keyBody = privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    assert.ok(keyBody.length > 40);
    assert.ok(!everything.includes(keyBody.slice(0, 40)), "no private key");
    assert.ok(!everything.includes("PRIVATE KEY"));
    assert.ok(!everything.includes(serviceToken), "no service token");
    assert.ok(!/x-evoloop-machine-signature|machine-nonce/i.test(everything), "no signature material");
  });
});
