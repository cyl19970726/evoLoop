import type { FastifyInstance } from "fastify";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { SchedEvent, SchedEventsPage, WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import { z } from "zod";
import { briefWorkBoard } from "./brief.js";
import type { SchedEventHub } from "./hub.js";
import { computeBoardMetrics } from "./metrics.js";

export interface WorkBoardReads {
  board(projectId: string): Promise<WorkBoardSnapshot>;
  events(projectId: string, query: { after?: number; limit: number; from?: string; to?: string; category?: string }): Promise<SchedEventsPage>;
}
export interface WorkBoardRouteDeps { service: { getProject(principal: Principal, projectId: string): Promise<unknown> }; reads: WorkBoardReads; hub: SchedEventHub; keepAliveMs?: number }

const MAX_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_METRIC_EVENTS = 50_000;

/**
 * The work board and the scheduling event stream. Every read needs project read permission and returns metadata only. The stream is
 * Server-Sent Events (`/work-board/stream`, resumed by Last-Event-ID or `after`) and, with the same meaning, a long poll
 * (`/work-board/events?after=N&wait=SECONDS`). Both read through one shared hub.
 */
export function registerWorkBoardRoutes(app: FastifyInstance, deps: WorkBoardRouteDeps): void {
  const who = (request: { principal: Principal | null }) => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    return request.principal;
  };
  const project = (value: unknown) => z.object({ projectId: z.uuid() }).parse(value);
  const seq = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

  app.get("/api/projects/:projectId/work-board", async request => {
    const p = project(request.params), principal = who(request);
    const q = z.object({ brief: z.enum(["true", "false", "1", "0"]).default("false") }).parse(request.query);
    await deps.service.getProject(principal, p.projectId);
    const board = await deps.reads.board(p.projectId);
    return q.brief === "true" || q.brief === "1" ? briefWorkBoard(board) : board;
  });

  app.get("/api/projects/:projectId/work-board/events", async (request, reply) => {
    const p = project(request.params), principal = who(request);
    const q = z.object({ after: seq.optional(), limit: z.coerce.number().int().min(1).max(500).default(100), from: z.iso.datetime({ offset: true }).optional(),
      to: z.iso.datetime({ offset: true }).optional(), category: z.enum(["notice", "task", "message", "acceptance"]).optional(),
      wait: z.coerce.number().int().min(0).max(30).default(0) }).parse(request.query);
    await deps.service.getProject(principal, p.projectId);
    const read = () => deps.reads.events(p.projectId, { ...(q.after !== undefined ? { after: q.after } : {}), limit: q.limit,
      ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), ...(q.category ? { category: q.category } : {}) });
    let page = await read();
    // Long poll: nothing new yet, so wait on the shared hub (no query of its own) for the next event or the timeout.
    if (q.wait > 0 && q.after !== undefined && !page.resetRequired && !page.items.length) {
      let wake: () => void = () => undefined;
      const woken = new Promise<void>(resolve => { wake = resolve; });
      const timer = setTimeout(wake, q.wait * 1000);
      const unsubscribe = await deps.hub.subscribe(p.projectId, { onEvents: () => wake(), onReset: () => wake() });
      request.raw.once("close", wake);
      try { await woken; } finally { clearTimeout(timer); unsubscribe(); }
      page = await read();
    }
    void reply;
    return page;
  });

  app.get("/api/projects/:projectId/work-board/stream", async (request, reply) => {
    const p = project(request.params), principal = who(request);
    const q = z.object({ after: seq.optional() }).parse(request.query);
    await deps.service.getProject(principal, p.projectId);
    const header = request.headers["last-event-id"];
    // A browser EventSource opens `stream?after=<snapshot eventSeq>` and, after a drop, reconnects to the same URL with Last-Event-ID set to
    // the newest event it received: that header is the more recent position, so it wins.
    let sent = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : q.after;
    reply.hijack();
    const out = reply.raw;
    out.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const write = (event: string, data: unknown, id?: number) => out.write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let closed = false;
    const pending: SchedEvent[] = [];
    let live = false;
    const push = (items: SchedEvent[]) => { for (const e of items) if (sent === undefined || e.seq > sent) { write("sched", e, e.seq); sent = e.seq; } };
    const reset = (head: number) => { write("reset", { resetRequired: true, head }); sent = head; };
    const unsubscribe = await deps.hub.subscribe(p.projectId, { onEvents: items => { if (live) push(items); else pending.push(...items); }, onReset: head => { if (!closed) reset(head); } });
    const beat = setInterval(() => { if (!closed) out.write(": keep-alive\n\n"); }, deps.keepAliveMs ?? 15000);
    beat.unref();
    const end = () => { if (closed) return; closed = true; clearInterval(beat); unsubscribe(); out.end(); };
    request.raw.once("close", end);
    try {
      // Catch up from the caller's position to now, then hand over to the shared loop (events that arrived meanwhile are filtered by seq).
      if (sent !== undefined) {
        for (;;) {
          const page = await deps.reads.events(p.projectId, { after: sent, limit: 200 });
          if (page.resetRequired) { reset(page.head); break; }
          push(page.items);
          if (!page.more) break;
        }
      }
      push(pending.splice(0));
      live = true;
      write("ready", { head: sent ?? null });
    } catch (error) { write("error", { code: error instanceof DomainError ? error.code : "ERROR" }); end(); }
  });

  app.get("/api/projects/:projectId/work-board/metrics", async request => {
    const p = project(request.params), principal = who(request);
    const now = Date.now();
    const q = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).parse(request.query);
    const to = q.to ?? new Date(now).toISOString(), from = q.from ?? new Date(Date.parse(to) - 24 * 3600 * 1000).toISOString();
    if (!(Date.parse(from) < Date.parse(to)) || Date.parse(to) - Date.parse(from) > MAX_WINDOW_MS)
      throw new DomainError("INVALID_WINDOW", "The window must be ordered and at most 30 days");
    await deps.service.getProject(principal, p.projectId);
    const events: SchedEvent[] = [];
    let after: number | undefined;
    for (;;) {
      const page = await deps.reads.events(p.projectId, after === undefined ? { limit: 500, from, to } : { limit: 500, from, to, after });
      events.push(...page.items);
      if (!page.more || events.length >= MAX_METRIC_EVENTS) break;
      after = page.cursor; // time reads page by seq: continue behind the last one
    }
    return { ...computeBoardMetrics(events, from, to), truncated: events.length >= MAX_METRIC_EVENTS };
  });
}
