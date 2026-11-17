// Task 5a47dcb8: behind the Hub the page keeps its own requests below the machine's limit of 8 at a time, asks a busy machine again, and leaves a local login alone.
import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiError, request } from "../src/shared/api";
import { busyRetryDelayMs, createRequestPacer, maxBusyRetries } from "../src/shared/requestPacing";

const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

test("the pacer lets at most maxInflight through at once, in order, and a release lets the next in", async () => {
  const pacer = createRequestPacer({ maxInflight: 3, minGapMs: 0 });
  let inflight = 0, peak = 0; const order: number[] = [];
  await Promise.all(Array.from({ length: 12 }, async (_, n) => {
    const release = await pacer.acquire(); inflight += 1; peak = Math.max(peak, inflight); order.push(n);
    await sleep(5); inflight -= 1; release(); release();   // a second release does nothing
  }));
  assert.equal(peak, 3); assert.deepEqual(order, Array.from({ length: 12 }, (_, n) => n), "first come, first served");
});

test("the pacer spaces starts by the gap, and a request aborted while waiting leaves the line without taking a place", async () => {
  const starts: number[] = [];
  const pacer = createRequestPacer({ maxInflight: 5, minGapMs: 30 });
  await Promise.all(Array.from({ length: 4 }, async () => { const release = await pacer.acquire(); starts.push(Date.now()); release(); }));
  for (let n = 1; n < starts.length; n++) assert.ok(starts[n]! - starts[n - 1]! >= 25, `gap ${starts[n]! - starts[n - 1]!} ms`);
  const busy = createRequestPacer({ maxInflight: 1, minGapMs: 0 });
  const hold = await busy.acquire();
  const controller = new AbortController();
  const waiting = busy.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await assert.rejects(busy.acquire(AbortSignal.abort()), { name: "AbortError" }, "already aborted: refused at once");
  hold();
  const next = await busy.acquire(); next();
});

test("the busy retry waits a little, then longer, with spread, and there are two of them", () => {
  assert.equal(maxBusyRetries, 2);
  assert.equal(busyRetryDelayMs(1, () => 0.5), 350); assert.equal(busyRetryDelayMs(2, () => 0.5), 900);
  assert.ok(busyRetryDelayMs(1, () => 0) < 350 && busyRetryDelayMs(1, () => 1) > 350);
});

/** A page behind the Hub (the Hub marks its page with <meta name="evoloop-auth" content="hub">) or a local login (no mark), with a fetch that records what it was asked. */
function page(mode: "hub" | "token", answer: (url: string, call: number) => Response | Promise<Response>) {
  const calls: string[] = []; let inflight = 0, peak = 0; const perUrl = new Map<string, number>();
  const g = globalThis as unknown as { document?: unknown; fetch: unknown };
  const before = { document: g.document, fetch: g.fetch };
  g.document = mode === "hub" ? { querySelector: () => ({ getAttribute: () => "hub" }) } : undefined;
  g.fetch = async (url: string) => {
    calls.push(String(url)); inflight += 1; peak = Math.max(peak, inflight);
    const n = (perUrl.get(String(url)) ?? 0) + 1; perUrl.set(String(url), n);
    try { await sleep(15); return await answer(String(url), n); } finally { inflight -= 1; }
  };
  return { calls, peak: () => peak, restore: () => { g.document = before.document; g.fetch = before.fetch; } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("behind the Hub, twenty reads started together never have more than four in flight; a local login is left alone", async () => {
  const hub = page("hub", () => json({ ok: true }));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, n) => api("").projectRepositories ? api("").goals(`p${n}`).catch(() => null) : null));
    assert.ok(hub.peak() <= 4, `peak in flight behind the Hub: ${hub.peak()}`); assert.equal(hub.calls.length, 20);
  } finally { hub.restore(); }
  const local = page("token", () => json({ ok: true }));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, n) => api("t".repeat(40)).goals(`p${n}`).catch(() => null)));
    assert.equal(local.peak(), 20, "a local login sends them as before, all at once");
  } finally { local.restore(); }
});

test("a read the machine refused as busy is asked again and succeeds; a write is not; other 429s and other errors are not retried", async () => {
  const busy = { code: "CONNECTOR_BUSY", message: "The machine is handling too many forwarded requests." };
  const hub = page("hub", (url, n) => url.includes("/busy-twice") ? (n <= 2 ? json(busy, 429) : json({ ok: true })) : url.includes("/always-busy") ? json(busy, 429) : url.includes("/other-429") ? json({ code: "LOGIN_RATE_LIMITED", message: "x" }, 429) : json({ ok: true }));
  try {
    const client = api("");
    assert.deepEqual(await (client as unknown as { goals(p: string): Promise<unknown> }).goals("busy-twice"), { ok: true }, "ok after two busy answers");
    assert.equal(hub.calls.filter(url => url.includes("busy-twice")).length, 3);
    await assert.rejects(client.goals("always-busy"), (error: unknown) => error instanceof ApiError && error.status === 429);
    assert.equal(hub.calls.filter(url => url.includes("always-busy")).length, 3, "the first try and two more, then it gives up and says so");
    await assert.rejects(client.goals("other-429"), (error: unknown) => error instanceof ApiError && error.status === 429);
    assert.equal(hub.calls.filter(url => url.includes("other-429")).length, 1, "only the machine's CONNECTOR_BUSY is asked again");
    await assert.rejects(request("", "/api/projects/always-busy/commands", 5000, { method: "POST", body: "{}" }), (error: unknown) => error instanceof ApiError && error.status === 429);
    assert.equal(hub.calls.filter(url => url.includes("/commands")).length, 1, "a write is not asked again by the page: its own recovery goes by operation ID");
  } finally { hub.restore(); }
});

test("the drain state and the version are read at the project's path behind the Hub, and at the instance paths for a local login", async () => {
  const hub = page("hub", () => json({}));
  try { await api("").instanceDrain(undefined, "proj-1"); await api("").version(undefined, "proj-1"); assert.deepEqual(hub.calls, ["/api/projects/proj-1/instance-drain", "/api/projects/proj-1/version"]); } finally { hub.restore(); }
  const local = page("token", () => json({}));
  try { await api("t".repeat(40)).instanceDrain(undefined, "proj-1"); await api("t".repeat(40)).version(undefined, "proj-1"); assert.deepEqual(local.calls, ["/api/instance/drain", "/api/version"], "a local login: unchanged"); } finally { local.restore(); }
});

test("a long wait (the live read, up to 15 s) does not hold one of the four places: short reads go on past it", async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const hub = page("hub", async url => { if (url.includes("/long")) await gate; return json({ ok: true }); });
  try {
    const longs = Array.from({ length: 6 }, () => request("", "/api/projects/p/long", 25000, {}));
    await sleep(30);
    assert.deepEqual(await Promise.all(Array.from({ length: 6 }, (_, n) => request("", `/api/projects/p/short-${n}`, 5000, {}))), Array(6).fill({ ok: true }), "six short reads finish while six long ones are open");
    release(); await Promise.all(longs);
  } finally { release(); hub.restore(); }
});
