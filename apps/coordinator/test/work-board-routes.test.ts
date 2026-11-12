import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Fastify from "fastify";
import type { SchedEvent, SchedEventsPage } from "@evoloop/contracts/work-board";
import { SchedEventHub } from "../src/work-board/hub.ts";
import { registerWorkBoardRoutes } from "../src/work-board/routes.ts";

const projectId = randomUUID();
const event = (seq: number): SchedEvent => ({ seq, at: new Date(Date.UTC(2026, 10, 12, 0, 0, seq)).toISOString(), category: "task", kind: "task.queued", from: "leader", to: null,
  sessionId: null, taskId: null, subject: { kind: "queue_entry", id: randomUUID(), title: null, link: null }, prior: null, next: "queued" });

/** A scripted event table: seqs 1..head, with a purge floor. Counts the reads the routes and the hub make. */
function fixture(initial: { head: number; floor?: number }) {
  const state = { head: initial.head, floor: initial.floor ?? 0, reads: 0, heads: 0 };
  const reads = {
    board: async () => { throw new Error("not used"); },
    events: async (_p: string, query: { after?: number; limit: number }): Promise<SchedEventsPage> => {
      state.reads++;
      const after = query.after ?? 0;
      if (query.after !== undefined && (query.after < state.floor || query.after > state.head)) return { items: [], cursor: state.head, head: state.head, resetRequired: true, more: false };
      const items = Array.from({ length: Math.max(0, Math.min(query.limit, state.head - after)) }, (_, i) => event(after + i + 1));
      return { items, cursor: items.at(-1)?.seq ?? after, head: state.head, resetRequired: false, more: after + items.length < state.head };
    },
  };
  const hub = new SchedEventHub({ head: async () => { state.heads++; return state.head; }, read: (p, after, limit) => reads.events(p, { after, limit }) }, 20);
  return { state, reads, hub };
}
async function build(f: ReturnType<typeof fixture>, permitted = true) {
  const app = Fastify();
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async request => { request.principal = { actorId: "reader", projectIds: [projectId], permissions: ["read"] } as never; });
  app.setErrorHandler((error, _request, reply) => { reply.code(403).send({ code: error.message }); });
  registerWorkBoardRoutes(app, { service: { getProject: async () => { if (!permitted) throw new Error("FORBIDDEN"); } }, reads: f.reads as never, hub: f.hub, keepAliveMs: 50 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/projects/${projectId}/work-board` };
}

test("tail read by cursor: in order, paged, and resetRequired when retention passed the cursor or the cursor is ahead of the head", async () => {
  const f = fixture({ head: 10, floor: 4 });
  const { app, base } = await build(f);
  try {
    const first = await (await fetch(`${base}/events?after=4&limit=3`)).json() as SchedEventsPage;
    assert.deepEqual(first.items.map(e => e.seq), [5, 6, 7]); assert.equal(first.more, true); assert.equal(first.cursor, 7);
    const rest = await (await fetch(`${base}/events?after=${first.cursor}&limit=100`)).json() as SchedEventsPage;
    assert.deepEqual(rest.items.map(e => e.seq), [8, 9, 10]); assert.equal(rest.more, false);
    const purged = await (await fetch(`${base}/events?after=2`)).json() as SchedEventsPage;
    assert.equal(purged.resetRequired, true); assert.equal(purged.head, 10); assert.deepEqual(purged.items, []);
    assert.equal(((await (await fetch(`${base}/events?after=99`)).json()) as SchedEventsPage).resetRequired, true);
    for (const bad of ["after=x", "limit=0", "limit=501", "wait=31", "category=other"]) assert.equal((await fetch(`${base}/events?${bad}`)).ok, false, bad);
  } finally { await app.close(); }
});

test("no read permission: nothing is returned", async () => {
  const f = fixture({ head: 3 });
  const { app, base } = await build(f, false);
  try {
    for (const path of ["/events", "/metrics", ""]) assert.equal((await fetch(`${base}${path}`)).status, 403, path);
    assert.equal(f.state.reads, 0);
  } finally { await app.close(); }
});

test("long poll returns at once with news, waits on the shared hub without its own query, and wakes for a new event", async () => {
  const f = fixture({ head: 5 });
  const { app, base } = await build(f);
  try {
    assert.equal(((await (await fetch(`${base}/events?after=3&wait=5`)).json()) as SchedEventsPage).items.length, 2, "news: no waiting");
    const readsBefore = f.state.reads;
    const waiting = fetch(`${base}/events?after=5&wait=5`).then(r => r.json() as Promise<SchedEventsPage>);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(f.state.reads, readsBefore + 1, "one read to find nothing; the wait itself reads nothing for this request");
    assert.equal(f.hub.subscribers(projectId), 1);
    f.state.head = 6;
    const page = await waiting;
    assert.deepEqual(page.items.map(e => e.seq), [6]);
    assert.equal(f.hub.subscribers(projectId), 0, "nobody waiting: the loop is gone");
  } finally { await app.close(); }
});

/** Reads an event stream until `until` returns true or the time is up; returns the raw frames. */
async function frames(url: string, headers: Record<string, string>, until: (text: string) => boolean, ms = 3000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const response = await fetch(url, { headers, signal: controller.signal });
  assert.equal(response.headers.get("content-type")?.startsWith("text/event-stream"), true);
  let text = "";
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { text += Buffer.from(chunk).toString("utf8"); if (until(text)) break; }
  } catch { /* aborted */ } finally { clearTimeout(timer); controller.abort(); }
  return text;
}

test("stream: Last-Event-ID resumes without loss or repeat, new events arrive in order, and a gap answers reset", async () => {
  const f = fixture({ head: 8, floor: 2 });
  const { app, base } = await build(f);
  try {
    const seqs = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
    setTimeout(() => { f.state.head = 10; }, 150);
    const text = await frames(`${base}/stream`, { "last-event-id": "5" }, t => seqs(t).includes(10));
    assert.deepEqual(seqs(text), [6, 7, 8, 9, 10], "resumed after 5: no loss, no repeat, then the live ones");
    assert.match(text, /event: ready/);
    const gap = await frames(`${base}/stream?after=1`, {}, t => /event: reset/.test(t));
    assert.match(gap, /event: reset\ndata: \{"resetRequired":true,"head":10\}/);
    assert.equal(seqs(gap).length, 0);
    const heartbeat = await frames(`${base}/stream?after=10`, {}, t => t.includes(": keep-alive"));
    assert.match(heartbeat, /: keep-alive/);
  } finally { await app.close(); }
  void once;
});

test("with no stream open the hub is idle: no timer, no head lookups", async () => {
  const f = fixture({ head: 3 });
  const { app, base } = await build(f);
  try {
    await fetch(`${base}/events?after=0`);
    const heads = f.state.heads;
    await new Promise(r => setTimeout(r, 120));
    assert.equal(f.state.heads, heads); assert.equal(f.hub.activeProjects(), 0);
  } finally { await app.close(); }
});
