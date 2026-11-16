// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { machineRequestMessage, mayAccessSession, type Principal } from "@evoloop/contracts";
import { HUB_IDENTITY_HEADER } from "@evoloop/contracts";
import { buildHubApp } from "../../apps/hub/src/server.js";
import { applyHubMigrations } from "../../apps/hub/src/migrations.js";
import { HubService } from "../../apps/hub/src/service.js";
import { HubStore } from "../../apps/hub/src/store.js";
import { MachineStore } from "../../apps/hub/src/machines.js";
import { signIdentity, targetDigest, type RequestIdentity } from "../../apps/hub/src/identity.js";
import type { HubConfig } from "../../apps/hub/src/config.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { HubIdentityVerifier, type HubIdentity } from "../../apps/coordinator/src/hub/identity.js";
import { MachineCredentialSource } from "../../apps/coordinator/src/hub/credentials.js";
import { HubConnector } from "../../apps/coordinator/src/hub/connector.js";
import { loadIntegrations } from "../../apps/coordinator/src/configuration.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== "/evoloop_hub_test") {
  throw new Error("Hub machine integration tests require the dedicated evoloop_hub_test database");
}

const config: HubConfig = {
  publicOrigin: "http://hub.test", port: 4319, host: "127.0.0.1", sessionTtlMs: 12 * 60 * 60 * 1000, inviteTtlMs: 7 * 24 * 60 * 60 * 1000,
  loginMaxFailures: 5, loginWindowMs: 15 * 60 * 1000, loginBlockMs: 15 * 60 * 1000, bodyLimitBytes: 64 * 1024,
  // Short intervals so that online, offline and reconnect can be observed in a test.
  machineHeartbeatMs: 300, forwardTimeoutMs: 5000, forwardBodyLimitBytes: 128 * 1024, maxResponseBytes: 8 * 1024 * 1024,
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const password = (name: string) => `${name}-password-123`;
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

test("a machine joins a Hub, stays connected, and serves its projects only through signed, scoped, single-use identities", async t => {
  const hubSchema = `hubm_${randomUUID().replaceAll("-", "").slice(0, 16)}`, coordinatorSchema = `hubc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${hubSchema}"`);
  const hubPool = new pg.Pool({ connectionString: database, max: 8, options: `-c search_path=${hubSchema}` });
  await applyHubMigrations(hubPool);
  await migrate(database, coordinatorSchema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${coordinatorSchema}` });
  const directory = await mkdtemp(join(tmpdir(), "evoloop-hub-machine-"));
  const machineDir = join(directory, "machine"), allowedRoot = join(directory, "work"), outsideRoot = join(directory, "elsewhere");
  await mkdir(allowedRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const logs: string[] = [];

  // ---- the Hub, on a real loopback port (the machine reaches it over HTTP) ----
  const store = new HubStore(hubPool), machines = new MachineStore(hubPool), hubService = new HubService(store, config);
  let hub = buildHubApp({ config, store, service: hubService, machines, logger: { level: "silent" } });
  const hubUrl = await hub.listen({ host: "127.0.0.1", port: 0 });
  const hubPort = Number(new URL(hubUrl).port);

  // ---- the machine's coordinator, over its own project database, with one local agent identity ----
  const projectId = randomUUID(), foreignProjectId = randomUUID();
  const localToken = `${randomUUID()}${randomUUID()}`;
  const localActor = "local-team-agent";
  const service = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash: sha } });
  const credentialSource = new MachineCredentialSource(machineDir);
  const accepted: HubIdentity[] = [], rejected: string[] = [];
  const verifier = new HubIdentityVerifier({ credentials: () => credentialSource.current(),
    isLocalProject: async id => (await pool.query("SELECT 1 FROM project WHERE project_id=$1", [id])).rowCount === 1,
    localActorIds: () => new Set([localActor]) });
  const coordinator = await buildServer({ service, credentials: [{ token: localToken, actorId: localActor, projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }],
    hubIdentity: { verifier, onAccepted: identity => { accepted.push(identity); }, onRejected: reason => { rejected.push(reason); } } });
  const coordinatorUrl = await coordinator.listen({ host: "127.0.0.1", port: 0 });
  let connector = new HubConnector({ credentials: credentialSource, coordinatorUrl, log: message => logs.push(message), backoffMs: { initial: 100, max: 300 }, idleCheckMs: 100 });
  t.after(async () => {
    await connector.stop();
    await hub.close().catch(() => undefined);
    await coordinator.close();
    await hubPool.end();
    await pool.end();
    await admin.query(`DROP SCHEMA "${hubSchema}" CASCADE`);
    await admin.query(`DROP SCHEMA "${coordinatorSchema}" CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  });

  const direct = (path: string, init: RequestInit = {}, token = localToken) => fetch(new URL(path, coordinatorUrl), { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  const createDocumentCommand = (title: string, project = projectId) => ({ projectId: project, operationId: randomUUID(), type: "document.create", documentId: randomUUID(), title, body: `# ${title}`, kind: "report" });
  assert.equal((await direct("/api/commands", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, operationId: randomUUID(), type: "project.create", title: "Machine project" }) })).status, 200);

  // ---- Hub accounts ----
  type Browser = { cookie: string; csrf: string };
  const inject = async (browser: Browser | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const response = await hub.inject({ method, url, headers: { origin: config.publicOrigin, ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...(browser ? { cookie: browser.cookie, "x-hub-csrf": browser.csrf } : {}) }, ...(payload === undefined ? {} : { payload }) });
    return response;
  };
  const login = async (email: string, name: string): Promise<Browser & { accountId: string; actorId: string }> => {
    const response = await inject(null, "POST", "/api/auth/login", { email, password: password(name) });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json<{ csrfToken: string; account: { accountId: string; actorId: string } }>();
    const cookie = (response.headers["set-cookie"] as string).split(";")[0]!;
    return { cookie, csrf: body.csrfToken, accountId: body.account.accountId, actorId: body.account.actorId };
  };
  await hubService.initializeFirstAdmin({ email: "admin@example.test", displayName: "Hub Admin", password: password("admin") });
  const hubAdmin = await login("admin@example.test", "admin");
  const register = async (email: string, name: string) => {
    const invite = await inject(hubAdmin, "POST", "/api/admin/invites", { email });
    const registered = await inject(null, "POST", "/api/auth/register", { inviteToken: invite.json<{ invite: { token: string } }>().invite.token, password: password(name), displayName: name });
    assert.equal(registered.statusCode, 201, registered.body);
    return login(email, name);
  };
  const alice = await register("alice@example.test", "alice"), bob = await register("bob@example.test", "bob");
  const personalToken = async (who: Browser, project: string) => (await inject(who, "POST", "/api/tokens", { name: "cli", projectId: project })).json<{ token: string }>().token;
  const bearer = (token: string, method: "GET" | "POST", url: string, payload?: unknown) => hub.inject({ method, url,
    headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { payload }) });

  // ---- 1. join: a one-time code, a key pair made on the machine, the allowed root confirmed on the machine ----
  const sessionX = randomUUID(), sessionY = randomUUID();
  let machineId = "", joinCode = "";
  await t.test("join uses a one-time code once, uploads only the public key, and the machine shows online", async () => {
    const created = await inject(hubAdmin, "POST", "/api/admin/machines", { name: "mac-test" });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json<{ machine: { machineId: string; state: string }; joinCode: string; expiresAt: string }>();
    machineId = body.machine.machineId; joinCode = body.joinCode;
    assert.equal(body.machine.state, "pending");
    const minutes = (Date.parse(body.expiresAt) - Date.now()) / 60000;
    assert.ok(minutes > 9 && minutes <= 10, `the code lives ten minutes (${minutes})`);
    const storedCode = await hubPool.query("SELECT code_hash FROM hub_machine_join_code WHERE machine_id=$1", [machineId]);
    assert.equal(storedCode.rows[0].code_hash, sha(joinCode), "only the code's hash is stored");

    // Without the roots confirmed (non-interactive, no --yes) nothing is joined.
    const unconfirmed = await cli(["machine", "join", "--hub", hubUrl, "--code", joinCode, "--workspace-root", allowedRoot]);
    assert.notEqual(unconfirmed.code, 0);
    assert.match(unconfirmed.stderr, /CONFIRMATION_REQUIRED/);
    await assert.rejects(stat(join(machineDir, "machine.json")), "no credentials were written");
    // A root that does not exist, or the filesystem root, is refused.
    assert.match((await cli(["machine", "join", "--hub", hubUrl, "--code", joinCode, "--workspace-root", join(directory, "missing"), "--yes"])).stderr, /INVALID_INPUT/);
    assert.match((await cli(["machine", "join", "--hub", hubUrl, "--code", joinCode, "--workspace-root", "/", "--yes"])).stderr, /INVALID_INPUT/);

    const joined = await cli(["machine", "join", "--hub", hubUrl, "--code", joinCode, "--workspace-root", allowedRoot, "--yes"]);
    assert.equal(joined.code, 0, joined.stderr);
    assert.equal(JSON.parse(joined.stdout).machineId, machineId);
    const credentials = JSON.parse(await readFile(join(machineDir, "machine.json"), "utf8"));
    assert.deepEqual(credentials.allowedRoots, [await realRoot(allowedRoot)]);
    assert.equal(((await stat(join(machineDir, "machine.json"))).mode & 0o777), 0o600, "the credentials file is private");
    const registered = await hubPool.query("SELECT public_key, state FROM hub_machine WHERE machine_id=$1", [machineId]);
    assert.equal(registered.rows[0].state, "active");
    assert.ok(!JSON.stringify(registered.rows).includes("PRIVATE KEY"), "the Hub never receives the private key");
    assert.ok(credentials.privateKey.includes("PRIVATE KEY") && registered.rows[0].public_key.includes("PUBLIC KEY"));

    // The same code again, an expired code and a made-up code all fail.
    const again = await hub.inject({ method: "POST", url: "/api/machine/join", headers: { "content-type": "application/json" },
      payload: { code: joinCode, publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(), allowedRoots: [] } });
    assert.equal(again.statusCode, 403, again.body);
    assert.equal(again.json<{ error: { code: string } }>().error.code, "JOIN_CODE_INVALID");
    const second = (await inject(hubAdmin, "POST", "/api/admin/machines", { name: "mac-expired" })).json<{ machine: { machineId: string }; joinCode: string }>();
    await hubPool.query("UPDATE hub_machine_join_code SET expires_at=now() - interval '1 second' WHERE machine_id=$1", [second.machine.machineId]);
    const expired = await hub.inject({ method: "POST", url: "/api/machine/join", headers: { "content-type": "application/json" },
      payload: { code: second.joinCode, publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(), allowedRoots: [] } });
    assert.equal(expired.statusCode, 403);
    await inject(hubAdmin, "DELETE", `/api/admin/machines/${second.machine.machineId}`);

    connector.start();
    const listed = await until("the machine to show online", async () => {
      const list = (await inject(hubAdmin, "GET", "/api/admin/machines")).json<{ machines: Array<{ machineId: string; online: boolean; allowedRoots: string[] }> }>().machines;
      return list.find(machine => machine.machineId === machineId && machine.online) ?? null;
    });
    assert.deepEqual(listed.allowedRoots, [await realRoot(allowedRoot)]);
    const status = JSON.parse((await cli(["machine", "status"])).stdout);
    assert.equal(status.joined, true); assert.equal(status.hubAccepts, true); assert.equal(status.online, true);
    assert.ok(!JSON.stringify(status).includes("PRIVATE KEY"), "status never prints the private key");
  });

  // ---- members, a service identity with a grant, a read-only one, and the project placed on the machine ----
  let aliceToken = "", bobToken = "", serviceToken = "", readOnlyToken = "";
  await t.test("the project is placed on the machine and its members and service identities are set up", async () => {
    const created = await inject(hubAdmin, "POST", "/api/admin/projects", { projectId, name: "Machine project", machineId, projectAdminAccountId: alice.accountId });
    assert.equal(created.statusCode, 201, created.body);
    const bobAdded = await inject(alice, "POST", `/api/projects/${projectId}/members`, { email: "bob@example.test", permissions: { task: false, document: false, session: true }, sessionIds: [sessionX] });
    assert.equal(bobAdded.statusCode, 201, bobAdded.body);
    aliceToken = await personalToken(alice, projectId);
    bobToken = await personalToken(bob, projectId);
    const service = await inject(hubAdmin, "POST", "/api/admin/service-identities", { actorId: "svc-writer", displayName: "Writer agent", ownerAccountId: alice.accountId, purpose: "test", projectIds: [projectId], permissions: { document: true } });
    assert.equal(service.statusCode, 201, service.body);
    serviceToken = service.json<{ token: string }>().token;
    const readOnly = await inject(hubAdmin, "POST", "/api/admin/service-identities", { actorId: "svc-reader", displayName: "Reader agent", ownerAccountId: alice.accountId, purpose: "test", projectIds: [projectId] });
    readOnlyToken = readOnly.json<{ token: string }>().token;
  });

  // ---- 2. the CLI reads and writes a project through the Hub exactly as it does directly ----
  await t.test("CLI with a personal token and with a service identity token reads and writes through the Hub; results equal the direct ones", async () => {
    const written = createDocumentCommand("Written through the Hub by a person");
    await writeFile(join(directory, "command-alice.json"), JSON.stringify(written));
    const viaHub = await cli(["command", "run", join(directory, "command-alice.json")], { url: hubUrl, token: aliceToken });
    assert.equal(viaHub.code, 0, viaHub.stderr + viaHub.stdout);
    const personRead = await cli(["document", written.documentId, "--project", projectId], { url: hubUrl, token: aliceToken });
    const directRead = await cli(["document", written.documentId, "--project", projectId], { url: coordinatorUrl, token: localToken });
    assert.equal(personRead.code, 0, personRead.stderr);
    assert.deepEqual(JSON.parse(personRead.stdout), JSON.parse(directRead.stdout), "the read through the Hub equals the direct read");
    assert.equal(JSON.parse(directRead.stdout).document.title, "Written through the Hub by a person");

    const byService = createDocumentCommand("Written through the Hub by an agent");
    await writeFile(join(directory, "command-service.json"), JSON.stringify(byService));
    const serviceWrite = await cli(["command", "run", join(directory, "command-service.json")], { url: hubUrl, token: serviceToken });
    assert.equal(serviceWrite.code, 0, serviceWrite.stderr + serviceWrite.stdout);
    const serviceRead = await cli(["document", byService.documentId, "--project", projectId], { url: hubUrl, token: serviceToken });
    const directService = await cli(["document", byService.documentId, "--project", projectId], { url: coordinatorUrl, token: localToken });
    assert.deepEqual(JSON.parse(serviceRead.stdout), JSON.parse(directService.stdout));
    // The record carries who really asked (the Hub account / the service identity), not the machine or the connector.
    const journal = await pool.query("SELECT actor_id FROM operation_journal WHERE project_id=$1 AND operation_id=ANY($2::uuid[]) ORDER BY created_at", [projectId, [written.operationId, byService.operationId]]);
    assert.deepEqual(journal.rows.map(row => row.actor_id), [alice.actorId, "svc-writer"], "the original requester is kept in the record");

    // A read-only service identity can read but not write; the refusal is the coordinator's own permission check.
    const denied = createDocumentCommand("Written by a read-only agent");
    await writeFile(join(directory, "command-readonly.json"), JSON.stringify(denied));
    const refused = await cli(["command", "run", join(directory, "command-readonly.json")], { url: hubUrl, token: readOnlyToken });
    assert.notEqual(refused.code, 0);
    assert.equal((await cli(["document", written.documentId, "--project", projectId], { url: hubUrl, token: readOnlyToken })).code, 0, "a service identity may read what it is scoped to");
    // Not a member of the project: refused at the Hub, before any machine.
    assert.equal((await bearer(aliceToken, "GET", `/api/projects/${foreignProjectId}/documents`)).statusCode, 403);
    // The Hub answers /api/session itself, with the projects the caller reaches.
    const session = (await bearer(aliceToken, "GET", "/api/session")).json<{ principal: { actorId: string; projectIds: string[] } }>();
    assert.deepEqual(session.principal.projectIds, [projectId]);
    assert.equal(session.principal.actorId, alice.actorId);
  });

  // ---- 3. identities that must not be accepted ----
  const hubKey = await machines.activeSigningKey();
  const identity = (overrides: Partial<Omit<RequestIdentity, "v" | "kid">> = {}, url = `/api/projects/${projectId}/documents`, method = "GET"): { header: string; url: string } => {
    const now = Math.floor(Date.now() / 1000);
    const header = signIdentity(hubKey, { aud: machineId, jti: randomUUID(), iat: now, exp: now + 60, projectId, permissions: ["task", "document", "session"], decisions: true, sessionIds: [],
      sub: { actorId: "acct_probe", kind: "human", auth: "test" }, method, target: targetDigest(url), ...overrides });
    return { header, url };
  };
  const present = (made: { header: string; url: string }, method = "GET") => fetch(new URL(made.url, coordinatorUrl), { method, headers: { [HUB_IDENTITY_HEADER]: made.header } });
  await t.test("a signed identity is accepted once, for its own machine, project, method and path; every other case is refused", async () => {
    const good = identity();
    assert.equal((await present(good)).status, 200, "a good identity is accepted");
    assert.equal((await present(good)).status, 401, "the same identity a second time is refused");
    // Forged: right shape, signed by someone else's key (and with the right key id).
    const attacker = generateKeyPairSync("ed25519");
    const forged = identity({}, undefined, undefined);
    const forgedHeader = signIdentity({ kid: hubKey.kid, publicKey: "", privateKey: attacker.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, { aud: machineId, jti: randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60,
      projectId, permissions: ["task", "document", "session", "management"], decisions: true, sessionIds: [], sub: { actorId: "acct_probe", kind: "human", auth: "test" }, method: "GET", target: targetDigest(forged.url) });
    assert.equal((await present({ header: forgedHeader, url: forged.url })).status, 401, "forged signature");
    const flipped = identity();
    const [v, payload, signature] = flipped.header.split(".");
    const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString()); tampered.permissions = ["management"];
    assert.equal((await present({ header: `${v}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`, url: flipped.url })).status, 401, "a payload edited after signing");
    // Expired, or issued in the future, or valid for longer than a minute.
    const past = Math.floor(Date.now() / 1000) - 120;
    assert.equal((await present(identity({ iat: past, exp: past + 60 }))).status, 401, "expired");
    assert.equal((await present(identity({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }))).status, 401, "lifetime above a minute");
    // For another machine.
    assert.equal((await present(identity({ aud: randomUUID() }))).status, 401, "issued for another machine");
    // A project this machine does not hold, even though the Hub knew it.
    const elsewhere = `/api/projects/${foreignProjectId}/documents`;
    assert.equal((await present(identity({ projectId: foreignProjectId }, elsewhere))).status, 401, "project not on this machine");
    // The identity names one project and one request: not another project's path, method or target, and not a path the Hub does not forward.
    assert.equal((await present(identity({ projectId: foreignProjectId }, `/api/projects/${projectId}/documents`))).status, 401, "project differs from the path");
    const get = identity();
    assert.equal((await present(get, "POST")).status, 401, "another method");
    const other = identity();
    assert.equal((await present({ header: other.header, url: `/api/projects/${projectId}/tasks` })).status, 401, "another target");
    const notForwarded = identity({}, "/api/session");
    assert.equal((await present(notForwarded)).status, 401, "a path outside the forwarded set");
    // An Authorization header beside it makes the request ambiguous.
    const mixed = identity();
    assert.equal((await fetch(new URL(mixed.url, coordinatorUrl), { headers: { [HUB_IDENTITY_HEADER]: mixed.header, authorization: `Bearer ${localToken}` } })).status, 401);
    // A Hub account that takes the actor ID of a local identity of this machine.
    assert.equal((await present(identity({ sub: { actorId: localActor, kind: "human", auth: "test" } }))).status, 401, "a Hub actor with a local identity's ID");
    // Garbage.
    assert.equal((await fetch(new URL(`/api/projects/${projectId}/documents`, coordinatorUrl), { headers: { [HUB_IDENTITY_HEADER]: "not-an-identity" } })).status, 401);
    assert.ok(rejected.length >= 10, `every refusal is logged on the machine (${rejected.join("; ")})`);
  });

  await t.test("the identity carries only the permissions and the Session scope of the member; a member limited to one Session cannot reach another", async () => {
    accepted.length = 0;
    const read = await bearer(bobToken, "GET", `/api/projects/${projectId}/documents`);
    assert.equal(read.statusCode, 200, read.body);
    const seen = accepted.at(-1)!;
    assert.deepEqual(seen.sub.actorId, bob.actorId);
    assert.deepEqual(seen.permissions, ["session"]);
    assert.deepEqual(seen.sessionIds, [sessionX]);
    const principal: Principal = { actorId: seen.sub.actorId, projectIds: [seen.projectId], permissions: seen.permissions, sessionIds: seen.sessionIds };
    assert.equal(mayAccessSession(principal, projectId, sessionX), true);
    assert.equal(mayAccessSession(principal, projectId, sessionY), false, "another Session is out of scope");
    // Without the task and document classes, writing them is refused by the coordinator.
    const refused = await bearer(bobToken, "POST", "/api/commands", createDocumentCommand("Bob may not"));
    assert.equal(refused.statusCode, 403, refused.body);
  });

  await t.test("directories outside the roots the machine allowed are refused at load and at every start", async () => {
    const roots = (await machineRoots());
    const inside = join(allowedRoot, "repo"), link = join(allowedRoot, "link-out");
    await mkdir(inside, { recursive: true });
    await symlink(outsideRoot, link);
    const grant = (cwd: string) => ({ runtime: { enabled: true, grants: [{ projectId, actorId: "local-team-agent", roleId: "role", authorizationScope: "test", cwd, sandbox: "workspace-write" }] } });
    const file = async (cwd: string) => { const path = join(directory, `integrations-${randomUUID()}.json`); await writeFile(path, JSON.stringify(grant(cwd))); return path; };
    const refusal = /outside the roots/;
    await assert.rejects(loadIntegrations(await file(outsideRoot), { allowedRoots: roots }), refusal, "a directory beside the allowed root");
    await assert.rejects(loadIntegrations(await file(link), { allowedRoots: roots }), refusal, "a link inside the root that leads out");
    await assert.rejects(loadIntegrations(await file(`${allowedRoot}-sibling`), { allowedRoots: roots }), refusal, "a name that only starts like the root");
    await mkdir(`${allowedRoot}-sibling`, { recursive: true });
    await assert.rejects(loadIntegrations(await file(`${allowedRoot}-sibling`), { allowedRoots: roots }), refusal, "an existing sibling of the root");
    const loaded = await loadIntegrations(await file(await realRoot(inside)), { allowedRoots: roots });
    assert.equal(await loaded.allowedRuntimeCwd(projectId, await realRoot(inside)), true, "a directory inside the root is used");
    // No roots (a machine that has not joined) leaves the existing rules exactly as they were.
    const unrestricted = await loadIntegrations(await file(await realRoot(outsideRoot)), { allowedRoots: null });
    assert.equal(await unrestricted.allowedRuntimeCwd(projectId, await realRoot(outsideRoot)), true);
    // The runtime check runs again at each start: a configuration loaded while the root allowed it stops allowing it once the roots narrow.
    const narrow = await loadIntegrations(await file(await realRoot(inside)), { allowedRoots: roots });
    assert.equal(await narrow.allowedRuntimeCwd(projectId, await realRoot(outsideRoot)), false, "a directory that is not bound is not used");
  });

  // ---- 4. forwarding reaches the project's coordinator and nothing else ----
  await t.test("the Hub forwards only project paths and the command endpoint; paths that could reach anything else are refused at the Hub", async () => {
    for (const path of [`/api/projects/${projectId}/%2e%2e/%2e%2e/internal`, `/api/projects/${projectId}/a/../b`, `/api/projects/${projectId}/a%2Fb`, `/api/projects/${projectId}/a%5Cb`, `/api/projects/${projectId}//x`]) {
      const response = await bearer(aliceToken, "GET", path);
      assert.ok([400, 404].includes(response.statusCode), `${path} -> ${response.statusCode}`);
    }
    // A request for a coordinator path that is not a project path or the command endpoint is simply not a Hub route.
    assert.equal((await bearer(aliceToken, "GET", "/api/instance/drain")).statusCode, 404);
    assert.equal((await bearer(aliceToken, "GET", "/api/orchestration/commands")).statusCode, 404);
    // Member administration is the Hub's own and is never handed to a machine.
    assert.equal((await bearer(aliceToken, "POST", `/api/projects/${projectId}/members/x`, {})).statusCode, 404);
    // A project not placed on any machine, an unknown project and /api/commands without a project are refused with their own reasons.
    assert.equal((await bearer(aliceToken, "POST", "/api/commands", { operationId: randomUUID() })).statusCode, 400);
  });

  // ---- 5. the Hub stopping, restarting, and the machine restarting ----
  await t.test("the machine's coordinator keeps working while the Hub is down; the machine reconnects by itself after the Hub or the machine restarts", async () => {
    const before = listeningPorts();
    await hub.close();
    // Nothing on the machine depends on the Hub: its own team keeps reading and writing through 127.0.0.1.
    const local = createDocumentCommand("Written while the Hub is down");
    const written = await direct("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(local) });
    assert.equal(written.status, 200);
    assert.equal((await direct(`/api/projects/${projectId}/documents/${local.documentId}`)).status, 200);
    await wait(500);
    hub = buildHubApp({ config, store, service: hubService, machines, logger: { level: "silent" } });
    await hub.listen({ host: "127.0.0.1", port: hubPort });
    await until("the machine to reconnect after the Hub restarted", async () => (await inject(hubAdmin, "GET", "/api/admin/machines")).json<{ machines: Array<{ online: boolean; machineId: string }> }>().machines.find(machine => machine.machineId === machineId)?.online);
    assert.equal((await bearer(aliceToken, "GET", `/api/projects/${projectId}/documents/${local.documentId}`)).statusCode, 200, "the work done while the Hub was down is there");
    // The machine restarting: a new connector over the same saved credentials comes back with no one telling it to.
    await connector.stop();
    await until("the machine to show offline", async () => (await inject(hubAdmin, "GET", "/api/admin/machines")).json<{ machines: Array<{ online: boolean; machineId: string }> }>().machines.find(machine => machine.machineId === machineId)?.online === false);
    assert.equal((await bearer(aliceToken, "GET", `/api/projects/${projectId}/documents`)).statusCode, 503, "a machine that is offline answers 503, it is not guessed at");
    connector = new HubConnector({ credentials: credentialSource, coordinatorUrl, log: message => logs.push(message), backoffMs: { initial: 100, max: 300 }, idleCheckMs: 100 });
    connector.start();
    await until("the restarted machine to show online", async () => (await inject(hubAdmin, "GET", "/api/admin/machines")).json<{ machines: Array<{ online: boolean; machineId: string }> }>().machines.find(machine => machine.machineId === machineId)?.online);
    assert.equal((await bearer(aliceToken, "GET", `/api/projects/${projectId}/documents`)).statusCode, 200);
    // Joining the Hub added no listening port: the connector only dials out.
    const after = listeningPorts();
    t.diagnostic(`listening TCP sockets of the machine process before the connector reconnected: ${JSON.stringify(before)}; after: ${JSON.stringify(after)}`);
    if (before !== null && after !== null) assert.deepEqual(after, before, "no new listening port");
  });

  // ---- 6. removing the machine ----
  await t.test("leaving revokes the credentials at once; the project data stays and no second coordinator starts", async () => {
    const projectsBefore = (await pool.query("SELECT count(*)::int AS n FROM project")).rows[0].n, documentsBefore = (await pool.query("SELECT count(*)::int AS n FROM process_document")).rows[0].n;
    const signedBefore = identity();
    const savedKey = JSON.parse(await readFile(join(machineDir, "machine.json"), "utf8")).privateKey as string;
    // Before leaving, the machine's own signed requests work once; a replay, a stale time, another machine's ID and a wrong signature do not.
    const nonce = randomUUID();
    assert.equal((await asMachine("status", "{}", { nonce })).statusCode, 200);
    assert.equal((await asMachine("status", "{}", { nonce })).statusCode, 401, "the same signed request twice");
    assert.equal((await asMachine("status", "{}", { timestamp: Date.now() - 5 * 60_000 })).statusCode, 401, "a stale request");
    assert.equal((await asMachine("status", "{}", { machine: randomUUID() })).statusCode, 401, "a machine the Hub does not know");
    const unsigned = await hub.inject({ method: "POST", url: "/api/machine/status", headers: { "content-type": "application/vnd.evoloop-machine+json" }, payload: "{}" });
    assert.equal(unsigned.statusCode, 401, "no signature");
    const leave = await cli(["machine", "leave"]);
    assert.equal(leave.code, 0, leave.stderr);
    assert.equal(JSON.parse(leave.stdout).projectDataKept, true);
    await assert.rejects(stat(join(machineDir, "machine.json")), "the credentials file is gone");
    // The Hub no longer accepts anything this machine signs, and no longer routes the project there.
    const removed = (await hubPool.query("SELECT state FROM hub_machine WHERE machine_id=$1", [machineId])).rows[0].state;
    assert.equal(removed, "removed");
    const afterLeave = (() => {
      const timestamp = String(Date.now()), nonce = randomUUID();
      const signature = sign(null, Buffer.from(machineRequestMessage(machineId, "connect", timestamp, nonce, createHash("sha256").update("").digest("base64url"))), createPrivateKey(savedKey)).toString("base64url");
      return hub.inject({ method: "POST", url: "/api/machine/connect", headers: { "x-evoloop-machine": machineId, "x-evoloop-machine-time": timestamp, "x-evoloop-machine-nonce": nonce, "x-evoloop-machine-signature": signature } });
    })();
    const refusedAfterLeave = await afterLeave;
    assert.equal(refusedAfterLeave.statusCode, 401);
    assert.equal(refusedAfterLeave.json<{ error: { code: string } }>().error.code, "MACHINE_REMOVED", "a correctly signed request from the removed machine is refused at once");
    assert.equal((await bearer(aliceToken, "GET", `/api/projects/${projectId}/documents`)).statusCode, 409);
    // An identity the Hub signed a moment ago is no longer accepted by the machine: it has nothing to verify against.
    assert.equal((await present(signedBefore)).status, 401);
    await until("the connector to go idle", () => connector.state === "idle");
    // Its data and its coordinator are untouched, and still serve the local team.
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM project")).rows[0].n, projectsBefore);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM process_document")).rows[0].n, documentsBefore);
    assert.equal((await direct(`/api/projects/${projectId}/documents`)).status, 200);
    // Joining again with the removed machine's old code does nothing.
    const reuse = await hub.inject({ method: "POST", url: "/api/machine/join", headers: { "content-type": "application/json" }, payload: { code: joinCode, publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(), allowedRoots: [] } });
    assert.equal(reuse.statusCode, 403);
  });

  // ---- helpers ----
  /** A request to the Hub signed with this machine's own key, as the connector signs them. */
  async function asMachine(action: string, body = "", options: { timestamp?: number; nonce?: string; machine?: string } = {}) {
    const key = JSON.parse(await readFile(join(machineDir, "machine.json"), "utf8")).privateKey as string;
    const timestamp = String(options.timestamp ?? Date.now()), nonce = options.nonce ?? randomUUID(), id = options.machine ?? machineId;
    const signature = sign(null, Buffer.from(machineRequestMessage(id, action, timestamp, nonce, createHash("sha256").update(body).digest("base64url"))), createPrivateKey(key)).toString("base64url");
    return hub.inject({ method: "POST", url: `/api/machine/${action}`, headers: { "x-evoloop-machine": id, "x-evoloop-machine-time": timestamp, "x-evoloop-machine-nonce": nonce, "x-evoloop-machine-signature": signature,
      ...(body ? { "content-type": "application/vnd.evoloop-machine+json" } : {}) }, ...(body ? { payload: body } : {}) });
  }
  async function cli(args: string[], target?: { url: string; token: string }) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...args], {
        env: { ...process.env, EVOLOOP_MACHINE_DIR: machineDir, EVOLOOP_STATE_DIR: join(directory, "receipts"), EVOLOOP_PROJECT: projectId, ...(target ? { EVOLOOP_API_URL: target.url, EVOLOOP_TOKEN: target.token } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += String(data); });
      child.stderr.on("data", data => { stderr += String(data); });
      child.once("error", reject);
      child.once("close", code => resolveResult({ code, stdout, stderr }));
    });
  }
  async function realRoot(path: string): Promise<string> { return (await import("node:fs/promises")).realpath(path); }
  async function machineRoots(): Promise<string[]> { return [await realRoot(allowedRoot)]; }
});

/** The TCP ports this process listens on (by lsof), or null where lsof is not available. */
function listeningPorts(): string[] | null {
  const result = spawnSync("lsof", ["-nP", "-a", "-p", String(process.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
  if (result.error || result.status === null) return null;
  return result.stdout.split("\n").filter(line => line.startsWith("n")).map(line => line.slice(1)).sort();
}
