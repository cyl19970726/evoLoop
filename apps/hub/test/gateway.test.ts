import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Gateway } from "../src/gateway.ts";
import { safeProjectPath } from "../src/machine-routes.ts";

const project = "11111111-1111-4111-8111-111111111111";
const request = { method: "GET", path: `/api/projects/${project}/tasks`, identity: "v1.x.y", contentType: null, body: null };
const gateway = (overrides: Partial<ConstructorParameters<typeof Gateway>[0]> = {}) => new Gateway({ heartbeatMs: 10_000, forwardTimeoutMs: 200, maxResponseBytes: 1024, ...overrides });
const frames = (stream: PassThrough): Array<Record<string, unknown>> => String(stream.read() ?? "").split("\n").filter(Boolean).map(line => JSON.parse(line));

test("a machine's connection carries a request out and its answer back; only that connection may answer", async () => {
  const hub = gateway();
  const out = new PassThrough();
  hub.attach("machine-a", out);
  assert.equal(frames(out)[0]!.t, "hello");
  assert.equal(hub.online("machine-a"), true);
  const pending = hub.forward("machine-a", { ...request, method: "POST", contentType: "application/json", body: Buffer.from("{\"a\":1}") });
  const sent = frames(out)[0] as { t: string; id: string; method: string; path: string; body: string };
  assert.equal(sent.t, "request"); assert.equal(sent.method, "POST");
  assert.equal(Buffer.from(sent.body, "base64").toString(), "{\"a\":1}");
  assert.equal(hub.respond("machine-b", { id: sent.id, status: 200, contentType: null, body: Buffer.alloc(0) }), false, "another machine cannot answer it");
  assert.equal(hub.respond("machine-a", { id: sent.id, status: 201, contentType: "application/json", body: Buffer.from("{}") }), true);
  assert.equal((await pending).status, 201);
  assert.equal(hub.respond("machine-a", { id: sent.id, status: 200, contentType: null, body: Buffer.alloc(0) }), false, "an answer is used once");
  hub.close();
});

test("an offline machine, a silent one, a dropped link and an oversize answer each fail the request with their own reason", async () => {
  const hub = gateway();
  await assert.rejects(hub.forward("nobody", request), error => (error as { code?: string }).code === "MACHINE_OFFLINE");
  const out = new PassThrough();
  hub.attach("machine-a", out);
  frames(out);
  await assert.rejects(hub.forward("machine-a", request), error => (error as { code?: string; statusCode?: number }).code === "MACHINE_TIMEOUT");
  const dropped = hub.forward("machine-a", request);
  const sent = frames(out)[0] as { id: string };
  hub.disconnect("machine-a", "test");
  await assert.rejects(dropped, error => (error as { code?: string }).code === "MACHINE_DISCONNECTED");
  assert.equal(hub.online("machine-a"), false);
  const again = new PassThrough();
  hub.attach("machine-a", again);
  frames(again);
  const big = hub.forward("machine-a", request);
  const bigFrame = frames(again)[0] as { id: string };
  hub.respond("machine-a", { id: bigFrame.id, status: 200, contentType: null, body: Buffer.alloc(2048) });
  await assert.rejects(big, error => (error as { code?: string }).code === "MACHINE_RESPONSE_TOO_LARGE");
  assert.ok(sent.id);
  hub.close();
});

test("a newer connection replaces the older; a machine that stops beating is offline", async () => {
  let now = 1_000_000;
  const hub = gateway({ heartbeatMs: 100, now: () => now });
  const first = new PassThrough(), second = new PassThrough();
  hub.attach("machine-a", first);
  hub.attach("machine-a", second);
  assert.equal(String(first.read() ?? "").includes("\"replaced\""), true, "the older link is told why it ended");
  assert.equal(hub.online("machine-a"), true);
  now += 250;
  assert.equal(hub.online("machine-a"), true);
  now += 100;
  assert.equal(hub.online("machine-a"), false, "three silent intervals");
  assert.equal(hub.beat("machine-a"), true);
  assert.equal(hub.online("machine-a"), true);
  hub.close();
});

test("only plain project paths are handed on: no dot or empty segments, no encoded slash or backslash, no scheme, no fragment", () => {
  assert.equal(safeProjectPath(project, "tasks/abc", "limit=5"), `/api/projects/${project}/tasks/abc?limit=5`);
  assert.equal(safeProjectPath(project, "session-work/owned:abc", ""), `/api/projects/${project}/session-work/owned:abc`);
  for (const rest of ["", "a//b", "a/../b", "..", ".", "a/./b", "%2e%2e/x", "%2E/x", "a%2Fb", "a%5Cb", "a%00b", "http://x", "a b", "a#b", "a\\b", "%zz"])
    assert.throws(() => safeProjectPath(project, rest, ""), error => (error as { code?: string }).code === "INVALID_PATH", rest);
  assert.throws(() => safeProjectPath(project, "tasks", "a=1 b"), error => (error as { code?: string }).code === "INVALID_PATH");
  assert.throws(() => safeProjectPath(project, "tasks", "a=1#frag"), error => (error as { code?: string }).code === "INVALID_PATH");
});
