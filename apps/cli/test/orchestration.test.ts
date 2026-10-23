import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { runCli } from "../src/application.ts";

const projectId = randomUUID(), actorId = "worker-test-actor", apiUrl = "http://127.0.0.1:55371";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const hash = (command: unknown) => createHash("sha256").update(JSON.stringify(command, (_key, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ?
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
async function run(args: string[], state: string) {
  let stdout = "", stderr = "";
  const code = await runCli(args, { EVOLOOP_TOKEN: "private-test-token", EVOLOOP_API_URL: apiUrl,
    EVOLOOP_PROJECT: projectId, EVOLOOP_STATE_DIR: state }, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, stdout, stderr };
}
const session = () => json({ principal: { actorId, projectIds: [projectId], permissions: ["read", "write"] } });

test("standalone orchestration schema discovery and exact named read routes", async t => {
  const state = await mkdtemp(join(tmpdir(), "evoloop-orch-cli-")); t.after(() => rm(state, { recursive: true, force: true }));
  const types = JSON.parse((await run(["command", "types"], state)).stdout).types;
  assert.ok(types.includes("task.create")); assert.ok(types.includes("worker.submit")); assert.ok(types.includes("worker.beginSeal"));
  const schema = JSON.parse((await run(["command", "schema", "worker.submit"], state)).stdout);
  assert.ok(schema.required.includes("deliveryIntent"));
  const loop = randomUUID(), inbox = randomUUID(), submission = randomUUID(), paths: string[] = [];
  const fetch = mock.method(globalThis, "fetch", async (url: URL | Request | string) => {
    paths.push(new URL(String(url)).pathname); return json({ items: [] });
  });
  try {
    for (const args of [["list", "loops"], ["list", "inbox", "--loop", loop], ["list", "dispatches", "--loop", loop],
      ["read", "loop", loop, "--events"], ["read", "inbox", inbox], ["read", "submission", submission]])
      assert.equal((await run(args, state)).code, 0);
    assert.deepEqual(paths, [`/api/projects/${projectId}/orchestration/loops`,
      `/api/projects/${projectId}/orchestration/loops/${loop}/inbox`, `/api/projects/${projectId}/orchestration/loops/${loop}/dispatches`,
      `/api/projects/${projectId}/orchestration/loops/${loop}/events`, `/api/projects/${projectId}/orchestration/inbox/${inbox}`,
      `/api/projects/${projectId}/orchestration/submissions/${submission}`]);
    assert.equal((await run(["list", "inbox"], state)).code, 2);
    assert.equal((await run(["list", "loops", "--loop", loop], state)).code, 2);
  } finally { fetch.mock.restore(); }
});

test("lost orchestration response preserves actor-bound operation and reconciles without automatic POST", async t => {
  const state = await mkdtemp(join(tmpdir(), "evoloop-orch-cli-")); t.after(() => rm(state, { recursive: true, force: true }));
  const command = { type: "loop.state", projectId, operationId: randomUUID(), loopId: randomUUID(),
    expectedVersion: 2, state: "paused", reason: "Stop new dispatch while preserving work" };
  const file = join(state, "command.json"); await writeFile(file, JSON.stringify(command));
  let posts = 0, readbacks = 0;
  const fetch = mock.method(globalThis, "fetch", async (url: URL | Request | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/session") return session();
    if (init?.method === "POST") { posts++; assert.equal(path, "/api/orchestration/commands");
      assert.deepEqual(JSON.parse(String(init.body)), command); throw new Error("response lost after commit"); }
    readbacks++; assert.equal(path, `/api/projects/${projectId}/orchestration/operations/${command.operationId}`);
    return json({ id: command.operationId, projectId, actorId, commandHash: hash(command),
      result: { entityType: "loop", entityId: command.loopId, version: 3, replayed: false } });
  });
  try {
    const first = await run(["command", "run", file], state);
    assert.equal(first.code, 3); assert.equal(JSON.parse(first.stderr.split("\n").at(-2)!).error.code, "RESULT_UNCONFIRMED");
    const again = await run(["command", "run", file], state);
    assert.equal(again.code, 3); assert.equal(posts, 1);
    const recovered = await run(["receipts", "reconcile", command.operationId], state);
    assert.equal(recovered.code, 0); assert.equal(JSON.parse(recovered.stdout).state, "confirmed");
    assert.equal(JSON.parse(recovered.stdout).result.entityId, command.loopId);
    assert.equal(posts, 1); assert.equal(readbacks, 1);
  } finally { fetch.mock.restore(); }
});

test("explicit retry reuses a pure transaction ID, while seal commands stay readback-only", async t => {
  const state = await mkdtemp(join(tmpdir(), "evoloop-orch-cli-")); t.after(() => rm(state, { recursive: true, force: true }));
  const command = { type: "loop.state", projectId, operationId: randomUUID(), loopId: randomUUID(),
    expectedVersion: 1, state: "paused", reason: "Pause dispatch" };
  const file = join(state, "command.json"); await writeFile(file, JSON.stringify(command));
  let posts = 0, reads = 0;
  const fetch = mock.method(globalThis, "fetch", async (url: URL | Request | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/session") return session();
    if (init?.method === "GET") { reads++; return json({ code: "OPERATION_NOT_FOUND" }, 404); }
    posts++; assert.equal(path, "/api/orchestration/commands");
    if (posts === 1) throw new Error("lost response");
    assert.deepEqual(JSON.parse(String(init?.body)), command);
    return json({ status: "applied", operationId: command.operationId, entityId: command.loopId, revisionId: null, version: 2, replayed: true });
  });
  try {
    assert.equal((await run(["command", "run", file], state)).code, 3);
    assert.equal((await run(["receipts", "retry", command.operationId], state)).code, 0);
    assert.equal(posts, 2); assert.equal(reads, 1);
  } finally { fetch.mock.restore(); }

  const seal = { type: "worker.beginSeal", projectId, operationId: randomUUID(), submissionId: randomUUID(),
    expectedVersion: 1, expectedTaskVersion: 2, sealToken: randomUUID() };
  const sealFile = join(state, "seal.json"); await writeFile(sealFile, JSON.stringify(seal));
  let sealPosts = 0;
  const sealFetch = mock.method(globalThis, "fetch", async (url: URL | Request | string, init?: RequestInit) => {
    if (new URL(String(url)).pathname === "/api/session") return session();
    if (init?.method === "POST") { sealPosts++; throw new Error("unknown seal result"); }
    throw new Error("retry must not reach the network for seal");
  });
  try {
    assert.equal((await run(["command", "run", sealFile], state)).code, 3);
    const retry = await run(["receipts", "retry", seal.operationId], state);
    assert.equal(retry.code, 1); assert.equal(JSON.parse(retry.stderr).error.code, "RETRY_UNSUPPORTED");
    assert.equal(sealPosts, 1);
  } finally { sealFetch.mock.restore(); }
});

test("orchestration operation with another payload hash stays unconfirmed", async t => {
  const state = await mkdtemp(join(tmpdir(), "evoloop-orch-cli-")); t.after(() => rm(state, { recursive: true, force: true }));
  const command = { type: "loop.state", projectId, operationId: randomUUID(), loopId: randomUUID(),
    expectedVersion: 1, state: "paused", reason: "Pause" };
  const file = join(state, "command.json"); await writeFile(file, JSON.stringify(command));
  const fetch = mock.method(globalThis, "fetch", async (url: URL | Request | string, init?: RequestInit) => {
    if (new URL(String(url)).pathname === "/api/session") return session();
    if (init?.method === "POST") throw new Error("lost reply");
    return json({ id: command.operationId, projectId, actorId, commandHash: "0".repeat(64),
      result: { entityId: command.loopId, version: 2 } });
  });
  try {
    assert.equal((await run(["command", "run", file], state)).code, 3);
    assert.equal((await run(["receipts", "reconcile", command.operationId], state)).code, 3);
  } finally { fetch.mock.restore(); }
});
