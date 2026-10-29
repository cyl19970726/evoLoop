import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient, CliApiError } from "../src/client.js";

const origin = "http://127.0.0.1:55337";
const token = "fixture-secret-token";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
const isError = (code: string, status: number, unconfirmed: boolean) => (error: unknown): boolean => {
  assert.ok(error instanceof CliApiError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.equal(error.unconfirmed, unconfirmed);
  assert.doesNotMatch(error.message, /fixture-secret-token/);
  return true;
};

test("GET and POST stay on the configured API origin and return complete JSON", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const large = "x".repeat(200_000);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: input as URL, init: init! });
    return json(calls.length === 1 ? { items: [large], nextCursor: null } : { applied: true, nested: { value: large } });
  };
  const client = new ApiClient({ apiUrl: origin, token, fetch });
  assert.deepEqual(await client.get("/api/projects/p/tasks?limit=50&cursor=x"), { items: [large], nextCursor: null });
  const body = { projectId: "p", nested: { original: "unchanged" } };
  assert.deepEqual(await client.post("/api/commands", body), { applied: true, nested: { value: large } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url.href, `${origin}/api/projects/p/tasks?limit=50&cursor=x`);
  assert.equal(calls[0]!.init.redirect, "manual");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${token}`);
  assert.equal(calls[1]!.init.body, JSON.stringify(body));
  assert.equal((calls[1]!.init.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("rejects unsafe base and path before transport sees credentials", async () => {
  for (const apiUrl of ["https://user:password@example.test", "https://example.test/base", "https://example.test?x=1", "https://example.test/#part", "file:///tmp/x"]) {
    assert.throws(() => new ApiClient({ apiUrl, token }));
  }
  let calls = 0;
  const client = new ApiClient({ apiUrl: origin, token, fetch: async () => { calls++; return json({}); } });
  for (const path of ["https://foreign.test/api/session", "//foreign.test/api/session", "/elsewhere", "/api/../elsewhere", "/api/%2e%2e/elsewhere", "/api/session#fragment"]) {
    await assert.rejects(() => client.get(path), isError("INVALID_API_PATH", 0, false));
  }
  assert.equal(calls, 0);
});

test("never follows redirects and rejects a transport that followed one anyway", async () => {
  let calls = 0;
  const redirecting = new ApiClient({ apiUrl: origin, token, fetch: async (_input, init) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://foreign.test/collect" } });
  } });
  await assert.rejects(() => redirecting.post("/api/commands", {}), isError("REDIRECT_BLOCKED", 302, true));
  assert.equal(calls, 1);
  const followed = new ApiClient({ apiUrl: origin, token, fetch: async () => ({
    status: 200, ok: true, redirected: true, url: "https://foreign.test/collect", type: "basic",
    text: async () => JSON.stringify({ stolen: true }),
  }) as typeof globalThis.fetch });
  await assert.rejects(() => followed.get("/api/session"), isError("REDIRECT_BLOCKED", 200, false));
});

test("preserves 4xx business code and body without calling it an unknown write", async () => {
  const data = { code: "VERSION_CONFLICT", currentVersion: 7, message: "Revision changed" };
  const client = new ApiClient({ apiUrl: origin, token, fetch: async () => json(data, 409) });
  await assert.rejects(() => client.post("/api/commands", { operationId: "same-id" }), error => {
    isError("VERSION_CONFLICT", 409, false)(error);
    assert.deepEqual((error as CliApiError).data, data);
    return true;
  });
});

test("POST network failure and 5xx are unknown, without automatic retries", async () => {
  let attempts = 0;
  const lost = new ApiClient({ apiUrl: origin, token, fetch: async () => { attempts++; throw new Error("connection closed"); } });
  await assert.rejects(() => lost.post("/api/commands", { operationId: "stable" }), isError("TRANSPORT_UNKNOWN", 0, true));
  assert.equal(attempts, 1);
  const server = new ApiClient({ apiUrl: origin, token, fetch: async () => { attempts++; return json({ code: "BACKEND_BUSY" }, 503); } });
  await assert.rejects(() => server.post("/api/commands", {}), isError("BACKEND_BUSY", 503, true));
  await assert.rejects(() => server.get("/api/session"), isError("BACKEND_BUSY", 503, false));
  assert.equal(attempts, 3);
});

test("PUT sends JSON and treats a lost write response as unknown", async () => {
  let attempts = 0;
  const body = { operationId: "stable" };
  const client = new ApiClient({ apiUrl: origin, token, fetch: async (_input, init) => {
    attempts++;
    assert.equal(init?.method, "PUT");
    assert.equal(init?.body, JSON.stringify(body));
    assert.equal((init?.headers as Record<string, string>)["Content-Type"], "application/json");
    throw new Error("connection closed");
  } });
  await assert.rejects(() => client.put("/api/projects/p/work-management/tasks/t/plan", body),
    isError("TRANSPORT_UNKNOWN", 0, true));
  assert.equal(attempts, 1);
});

test("opaque transport failure cannot confirm a POST", async () => {
  const client = new ApiClient({ apiUrl: origin, token, fetch: async () => Response.error() });
  await assert.rejects(() => client.post("/api/commands", {}), isError("HTTP_0", 0, true));
  await assert.rejects(() => client.get("/api/session"), isError("HTTP_0", 0, false));
});

test("one deadline covers the response body even if injected transport ignores abort", async () => {
  let signal: AbortSignal | undefined;
  const client = new ApiClient({ apiUrl: origin, token, timeoutMs: 15, fetch: async (_input, init) => {
    signal = init?.signal ?? undefined;
    return { status: 200, ok: true, redirected: false, url: `${origin}/api/commands`, type: "basic",
      text: () => new Promise<string>(() => {}) } as Response;
  } });
  await assert.rejects(() => client.post("/api/commands", { operationId: "stable" }), isError("TIMEOUT", 0, true));
  assert.equal(signal?.aborted, true);
});

test("invalid or truncated success JSON leaves a POST unconfirmed", async () => {
  const client = new ApiClient({ apiUrl: origin, token, fetch: async () => new Response('{"status":"applied"', { status: 200 }) });
  await assert.rejects(() => client.post("/api/commands", {}), isError("INVALID_RESPONSE", 200, true));
  await assert.rejects(() => client.get("/api/session"), isError("INVALID_RESPONSE", 200, false));
});
