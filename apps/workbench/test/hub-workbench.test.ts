import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ApiError, errorCode, hubProjectView, ownWorkbenchAddress, safeArtifactHref } from "../src/shared/api.ts";
import { deliveryTarget } from "../src/shared/deliveryPresentation.ts";
import { errorText } from "../src/shared/api.ts";
import { registerErrorCodes } from "../src/shared/errorPresentation.ts";
import { serviceErrorCodes } from "../src/shared/errorCodes.ts";
import { hubOfflineNotice, machineText } from "../src/shared/hubPresentation.ts";
import { requestAuth, scopedPrincipal, setCsrfToken, signOut } from "../src/shared/identity.ts";

const project = "11111111-1111-4111-8111-111111111111";
const doc = "22222222-2222-4222-8222-222222222222";

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = previous; }
}

test("a deep link that names the address the page is open at opens in this tab; another host, or a look-alike, does not (#219)", () => {
  const fixed = `/p/${project}/documents/${doc}?revision=${doc}`;
  const hub = "https://hub.example.test";
  assert.equal(safeArtifactHref(`${hub}/#${fixed}`, project, hub), fixed, "the hash form on the current address");
  assert.equal(safeArtifactHref(`${hub}${fixed}`, project, hub), fixed, "the path form on the current address");
  assert.equal(safeArtifactHref(`https://hub.example.test.evil.test${fixed}`, project, hub), `https://hub.example.test.evil.test${fixed}`, "a look-alike host stays an external link");
  assert.equal(safeArtifactHref(`https://other.example.test${fixed}`, project, hub), `https://other.example.test${fixed}`, "another host stays an external link");
  assert.equal(safeArtifactHref(`http://hub.example.test${fixed}`, project, hub), `http://hub.example.test${fixed}`, "another scheme is another origin");
  assert.equal(safeArtifactHref(`${hub}${fixed}`, project, undefined), `${hub}${fixed}`, "without a current address nothing is own");
  assert.equal(safeArtifactHref(`http://127.0.0.1:55337/#${fixed}`, project, hub), fixed, "the loopback pilot form still works");
  assert.equal(ownWorkbenchAddress(new URL(`${hub}/x`), hub), true);
  const other = "33333333-3333-4333-8333-333333333333";
  assert.equal(safeArtifactHref(`${hub}/p/${other}/documents/${doc}?revision=${doc}`, project, hub), `${hub}/p/${other}/documents/${doc}?revision=${doc}`, "another project's route is not opened as this project's");
  assert.deepEqual(deliveryTarget({ artifactRef: `${hub}/#${fixed}`, artifactRevision: doc, contentHash: "a".repeat(64) }, project, undefined, hub), { kind: "document", documentId: doc, revisionId: doc, href: fixed });
  assert.deepEqual(deliveryTarget({ artifactRef: `${hub}/p/${other}/documents/${doc}?revision=${doc}`, artifactRevision: doc, contentHash: "a".repeat(64) }, project, undefined, hub),
    { kind: "fallback", label: "其他项目或无法核实的本机链接", href: null }, "another project's link on the current address is not opened");
});

test("behind the Hub a write carries the CSRF token from memory, a read does not, and signing out forgets it", () => {
  signOut();
  assert.deepEqual(requestAuth("", "POST").headers, {});
  setCsrfToken("csrf-in-memory");
  assert.equal(requestAuth("", "POST").headers["X-Hub-CSRF"], "csrf-in-memory");
  assert.equal(requestAuth("", "PUT").headers["X-Hub-CSRF"], "csrf-in-memory");
  assert.equal(requestAuth("", "GET").headers["X-Hub-CSRF"], undefined);
  assert.equal(requestAuth("", "GET").credentials, "same-origin");
  assert.deepEqual(requestAuth("local-token", "POST").headers, { Authorization: "Bearer local-token" }, "a local token never sends a Hub CSRF header");
  signOut();
  assert.equal(requestAuth("", "POST").headers["X-Hub-CSRF"], undefined);
});

test("the Hub's error shape reaches the page in the coordinator's shape, and an offline machine is said in words that do not blame a Run", async () => {
  registerErrorCodes(serviceErrorCodes);
  await withFetch(async () => new Response(JSON.stringify({ error: { code: "MACHINE_OFFLINE", message: "The machine this project runs on is not connected to the Hub.", details: null } }), { status: 503, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(api("").hubProjects(), cause => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.status, 503);
      assert.equal(errorCode(cause), "MACHINE_OFFLINE");
      const text = errorText(cause);
      assert.match(text, /没有连上 Hub/);
      assert.match(text, /不代表运行失败/);
      assert.doesNotMatch(text, /Run 失败|运行失败了/);
      return true;
    });
  });
  await withFetch(async () => new Response(JSON.stringify({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect.", details: null } }), { status: 401, headers: { "content-type": "application/json" } }), async () => {
    await assert.rejects(api("").hubLogin("a@example.test", "wrong"), cause => cause instanceof ApiError && cause.status === 401 && errorCode(cause) === "INVALID_CREDENTIALS");
  });
});

test("login posts JSON with the cookie, keeps the CSRF token in memory only, and never puts a credential in a URL or in storage", async () => {
  signOut();
  const calls: Array<{ url: string; method: string; credentials: string | undefined; body: string | undefined }> = [];
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", credentials: init?.credentials, body: typeof init?.body === "string" ? init.body : undefined });
    return Response.json({ account: { actorId: "acct_x" }, csrfToken: "csrf-1" });
  }, async () => {
    await api("").hubLogin("alice@example.test", "secret-pw");
    assert.equal(calls[0]!.url, "/api/auth/login");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.credentials, "same-origin");
    assert.deepEqual(JSON.parse(calls[0]!.body!), { email: "alice@example.test", password: "secret-pw" });
    assert.doesNotMatch(calls[0]!.url, /secret|alice|token/);
    assert.equal(requestAuth("", "POST").headers["X-Hub-CSRF"], "csrf-1");
  });
  const local = (globalThis as { localStorage?: unknown }).localStorage;
  assert.equal(local, undefined, "this check runs without browser storage; the page code never calls it (see the browser test)");
  signOut();
});

test("the session and project reads of the Hub become the workbench's own shapes", async () => {
  signOut();
  await withFetch(async input => String(input) === "/api/session"
    ? Response.json({ principal: { actorId: "acct_alice", projectIds: [project], permissions: ["task", "session"], projectPermissions: { [project]: ["task"] }, kind: "human" }, capabilities: {}, csrfToken: "csrf-2" })
    : Response.json({ project: { projectId: project, name: "Hub project", machineId: "m", createdAt: "2026-11-16T00:00:00.000Z", machine: { machineId: "m", name: "mac-1", state: "active", online: false } } }), async () => {
    const session = await api("").session();
    assert.equal(session.principal.actorId, "acct_alice");
    assert.deepEqual(session.principal.projectIds, [project]);
    assert.equal((session as unknown as { csrfToken?: string }).csrfToken, undefined, "the CSRF token is kept in memory, not passed around in the session");
    assert.equal(requestAuth("", "POST").headers["X-Hub-CSRF"], "csrf-2");
    // What the page offers in one project is what the Hub says that project lets this caller do.
    assert.deepEqual(scopedPrincipal(session.principal as never, project).permissions, ["task"]);
    assert.deepEqual(scopedPrincipal(session.principal as never, null).permissions, ["task", "session"]);
    assert.deepEqual(scopedPrincipal(session.principal as never, "44444444-4444-4444-8444-444444444444").permissions, ["task", "session"], "a project the Hub did not list changes nothing");
  });
  assert.deepEqual(hubProjectView({ projectId: project, name: "Hub project", machineId: "m", createdAt: "2026-11-16T00:00:00.000Z", machine: { machineId: "m", name: "mac-1", state: "active", online: true } }),
    { id: project, title: "Hub project", createdAt: "2026-11-16T00:00:00.000Z", machine: { machineId: "m", name: "mac-1", state: "active", online: true } });
  signOut();
});

test("where a project runs: online says so; offline and removed say it is the link, never a failed Run; no machine says none", () => {
  assert.equal(machineText({ name: "mac-1", online: true, state: "active" }), "机器 mac-1 · 在线");
  assert.equal(machineText({ name: "mac-1", online: false, state: "active" }), "机器 mac-1 · 离线");
  assert.equal(machineText({ name: "mac-1", online: false, state: "removed" }), "机器 mac-1 已移除");
  assert.equal(machineText(null), "未登记机器");
  assert.equal(hubOfflineNotice({ name: "mac-1", online: true, state: "active" }), null);
  assert.equal(hubOfflineNotice(null), null);
  const offline = hubOfflineNotice({ name: "mac-1", online: false, state: "active" })!;
  assert.match(offline.text, /离线，项目内容暂时不能读写/);
  assert.match(offline.detail, /不代表运行失败/);
  assert.match(offline.detail, /都没有被改动/);
  assert.doesNotMatch(`${offline.text}${offline.detail}`, /(运行|Run)(已)?失败了|交付失败/);
  assert.match(hubOfflineNotice({ name: "mac-1", online: false, state: "removed" })!.text, /已从 Hub 移除/);
});
