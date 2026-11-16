import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HUB_IDENTITY_HEADER } from "@evoloop/contracts";
import { HubConnector, isForwardablePath } from "../src/hub/connector.ts";
import { MachineCredentialSource } from "../src/hub/credentials.ts";
import { isInsideRoot, realPathInsideRoots } from "../src/hub/roots.ts";

const project = "11111111-1111-4111-8111-111111111111";
const machineId = "22222222-2222-4222-8222-222222222222";

test("only the project API and the command endpoint are forwardable, with plain segments", () => {
  assert.equal(isForwardablePath("GET", `/api/projects/${project}/tasks?limit=2`), true);
  assert.equal(isForwardablePath("POST", "/api/commands"), true);
  for (const [method, path] of [["GET", "/api/session"], ["GET", "/api/health"], ["GET", "/api/instance/drain"], ["GET", `/api/projects/${project}`], ["GET", `/api/projects/${project}/`],
    ["GET", `/api/projects/${project}/a/../b`], ["GET", `/api/projects/${project}/%2e%2e/x`], ["GET", `/api/projects/${project}/a%2fb`], ["GET", `/api/projects/${project}//x`],
    ["GET", `http://127.0.0.1:5432/api/projects/${project}/x`], ["GET", `//evil.test/api/projects/${project}/x`], ["GET", "/api/commands/../x"],
    ["TRACE", `/api/projects/${project}/x`], ["CONNECT", "/api/commands"], ["GET", `/api/projects/not-a-uuid/x`], ["GET", `/api/projects/${project}/x#frag`]] as const)
    assert.equal(isForwardablePath(method, path), false, `${method} ${path}`);
});

test("allowed roots are compared by path components, and a link that leads out of a root is outside it", async () => {
  assert.equal(isInsideRoot("/work", "/work"), true);
  assert.equal(isInsideRoot("/work", "/work/repo"), true);
  assert.equal(isInsideRoot("/work", "/work-evil"), false);
  assert.equal(isInsideRoot("/work", "/work/../etc"), false);
  assert.equal(isInsideRoot("/work", "/"), false);
  const directory = await mkdtemp(join(tmpdir(), "evoloop-roots-"));
  try {
    const { mkdir, symlink, realpath } = await import("node:fs/promises");
    await mkdir(join(directory, "root", "in"), { recursive: true });
    await mkdir(join(directory, "out"));
    await symlink(join(directory, "out"), join(directory, "root", "link"));
    const root = await realpath(join(directory, "root"));
    assert.equal(await realPathInsideRoots([root], join(directory, "root", "in")), join(root, "in"));
    assert.equal(await realPathInsideRoots([root], join(directory, "root", "link")), null);
    assert.equal(await realPathInsideRoots([root], join(directory, "missing")), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

type Fake = { hub: Server; local: Server; hubUrl: string; localUrl: string; answers: Array<{ id: string; status: number; body: string }>; localRequests: Array<{ method: string; url: string; headers: IncomingMessage["headers"] }>;
  push(frame: Record<string, unknown>): void; endStream(): void; connections: number; stop(): Promise<void> };

async function fake(connectStatus: () => { status: number; code?: string } = () => ({ status: 200 })): Promise<Fake> {
  let stream: ServerResponse | null = null;
  const state: Fake = { answers: [], localRequests: [], connections: 0, push: frame => { stream?.write(`${JSON.stringify(frame)}\n`); }, endStream: () => { stream?.end(); } } as Fake;
  state.hub = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/api/machine/connect") {
        const answer = connectStatus();
        if (answer.status !== 200) { response.writeHead(answer.status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { code: answer.code ?? "X" } })); return; }
        state.connections++;
        stream = response;
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ t: "hello", heartbeatMs: 200 })}\n`);
        return;
      }
      if (request.url === "/api/machine/respond") {
        const frame = JSON.parse(Buffer.concat(chunks).toString());
        state.answers.push({ id: frame.id, status: frame.status, body: Buffer.from(frame.body, "base64").toString() });
      }
      response.writeHead(request.url === "/api/machine/respond" ? 204 : 200, { "content-type": "application/json" });
      response.end(request.url === "/api/machine/respond" ? undefined : "{\"ok\":true}");
    });
  });
  state.local = createServer((request, response) => {
    state.localRequests.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ served: request.url }));
  });
  await new Promise<void>(done => state.hub.listen(0, "127.0.0.1", done));
  await new Promise<void>(done => state.local.listen(0, "127.0.0.1", done));
  state.hubUrl = `http://127.0.0.1:${(state.hub.address() as { port: number }).port}`;
  state.localUrl = `http://127.0.0.1:${(state.local.address() as { port: number }).port}`;
  state.stop = async () => { stream?.end(); state.hub.closeAllConnections(); state.local.closeAllConnections(); await Promise.all([new Promise(done => state.hub.close(done)), new Promise(done => state.local.close(done))]); };
  return state;
}

async function credentialsFor(hubUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-connector-"));
  const keys = generateKeyPairSync("ed25519");
  await writeFile(join(directory, "machine.json"), JSON.stringify({ version: 1, hubOrigin: hubUrl, machineId, name: "m", privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    hubPublicKeys: [{ kid: "k", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }], allowedRoots: ["/tmp"], joinedAt: new Date().toISOString() }));
  return { directory, source: new MachineCredentialSource(directory) };
}
const until = async (read: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!read()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(done => setTimeout(done, 20)); } };

test("the connector passes the Hub's identity to its own coordinator and answers; a path outside the forwarded set never leaves the connector", async () => {
  const hub = await fake();
  const { directory, source } = await credentialsFor(hub.hubUrl);
  const connector = new HubConnector({ credentials: source, coordinatorUrl: hub.localUrl, backoffMs: { initial: 50, max: 100 }, idleCheckMs: 50 });
  connector.start();
  try {
    await until(() => connector.state === "online");
    hub.push({ t: "request", id: "ok-1", method: "GET", path: `/api/projects/${project}/tasks?limit=2`, identity: "v1.a.b", contentType: null, body: null });
    for (const [id, path, method] of [["bad-1", "http://127.0.0.1:1/internal", "GET"], ["bad-2", `//evil.test/api/projects/${project}/x`, "GET"], ["bad-3", "/api/session", "GET"],
      ["bad-4", `/api/projects/${project}/a/../../../etc`, "GET"], ["bad-5", `/api/projects/${project}/x`, "TRACE"]] as const)
      hub.push({ t: "request", id, method, path, identity: "v1.a.b", contentType: null, body: null });
    hub.push({ t: "request", id: "no-identity", method: "GET", path: `/api/projects/${project}/x`, identity: "", contentType: null, body: null });
    await until(() => hub.answers.length === 7);
    const byId = Object.fromEntries(hub.answers.map(answer => [answer.id, answer]));
    assert.equal(byId["ok-1"]!.status, 200);
    assert.deepEqual(JSON.parse(byId["ok-1"]!.body), { served: `/api/projects/${project}/tasks?limit=2` });
    for (const id of ["bad-1", "bad-2", "bad-3", "bad-4", "bad-5"]) assert.equal(byId[id]!.status, 403, id);
    assert.equal(byId["no-identity"]!.status, 401);
    // Only the one good request reached the coordinator, with the Hub's identity and no credential of the machine's own.
    assert.equal(hub.localRequests.length, 1);
    assert.equal(hub.localRequests[0]!.headers[HUB_IDENTITY_HEADER], "v1.a.b");
    assert.equal(hub.localRequests[0]!.headers.authorization, undefined);
  } finally { await connector.stop(); await hub.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("the connector reconnects after the link drops, stops when the Hub says the machine was removed, and idles without credentials", async () => {
  let removed = false;
  const hub = await fake(() => removed ? { status: 401, code: "MACHINE_REMOVED" } : { status: 200 });
  const { directory, source } = await credentialsFor(hub.hubUrl);
  const connector = new HubConnector({ credentials: source, coordinatorUrl: hub.localUrl, backoffMs: { initial: 30, max: 60 }, idleCheckMs: 30 });
  connector.start();
  try {
    await until(() => hub.connections === 1 && connector.state === "online");
    hub.endStream();
    await until(() => hub.connections === 2, 4000);
    removed = true;
    hub.endStream();
    await until(() => connector.state === "removed", 4000);
    const seen = hub.connections;
    await new Promise(done => setTimeout(done, 300));
    assert.equal(hub.connections, seen, "a removed machine does not keep knocking");
    await rm(join(directory, "machine.json"));
    await until(() => connector.state === "idle");
  } finally { await connector.stop(); await hub.stop(); await rm(directory, { recursive: true, force: true }); }
});
