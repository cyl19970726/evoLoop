// Reads of the work board for 统筹安排 › 动态 (DEC-045 F1, second segment): the snapshot, event pages and the Server-Sent-Events stream.
// Nothing here makes up data. A browser EventSource cannot send the Authorization header the workbench signs in with, so the stream is a
// fetch that reads the same `text/event-stream` body and parses it (`parseSse`), resumed by sequence number.
import type { SchedEvent, SchedEventsPage, WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import { ApiError } from "../../../shared/api";
import { reportUnauthorized, requestAuth } from "../../../shared/identity";

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/work-board`;

async function getJson<T>(token: string, path: string, signal: AbortSignal): Promise<T> {
  const auth = requestAuth(token);
  const response = await fetch(path, { headers: auth.headers, credentials: auth.credentials, signal });
  if (response.status === 401) reportUnauthorized();
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { const body = await response.json() as { message?: unknown }; if (typeof body.message === "string") message = body.message; } catch { /* keep the status text */ }
    throw new ApiError(response.status, message);
  }
  return await response.json() as T;
}

export const readBoard = (token: string, projectId: string, signal: AbortSignal) => getJson<WorkBoardSnapshot>(token, base(projectId), signal);

export interface EventsQuery { after?: number; from?: string; to?: string; limit?: number }
export function readEventsPage(token: string, projectId: string, query: EventsQuery, signal: AbortSignal): Promise<SchedEventsPage> {
  const params = new URLSearchParams();
  if (query.after !== undefined) params.set("after", String(query.after));
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  params.set("limit", String(query.limit ?? 500));
  return getJson<SchedEventsPage>(token, `${base(projectId)}/events?${params}`, signal);
}

/** Events of a time window, oldest first. `truncated` says the window held more than the pages read (the earliest part is then what is missing). */
export async function readWindow(token: string, projectId: string, from: string, signal: AbortSignal, maxPages = 8):
  Promise<{ items: SchedEvent[]; head: number; truncated: boolean; resetRequired: boolean }> {
  const items: SchedEvent[] = [];
  let after: number | undefined, head = 0;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await readEventsPage(token, projectId, after === undefined ? { from, limit: 500 } : { from, after, limit: 500 }, signal);
    head = page.head;
    if (page.resetRequired) return { items, head, truncated: false, resetRequired: true };
    items.push(...page.items);
    if (!page.more) return { items, head, truncated: false, resetRequired: false };
    after = page.cursor;
  }
  return { items, head, truncated: true, resetRequired: false };
}

// ---- Server-Sent Events ----
export interface SseMessage { id: string | null; event: string; data: string }
/** Incremental parser: feed text chunks, get the complete messages. A comment line (": keep-alive") is not a message. */
export function createSseParser(): (chunk: string) => SseMessage[] {
  let buffer = "";
  return chunk => {
    buffer += chunk.replace(/\r\n/g, "\n");
    const out: SseMessage[] = [];
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      let id: string | null = null, event = "message"; const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = value; else if (field === "event") event = value; else if (field === "data") data.push(value);
      }
      if (data.length || event !== "message") out.push({ id, event, data: data.join("\n") });
    }
    return out;
  };
}

export interface StreamHandlers {
  onOpen(): void;
  onEvent(event: SchedEvent): void;
  /** The service says the position is gone (retention) or ahead of the head: read the snapshot again. */
  onReset(head: number): void;
  onReady(): void;
}
/**
 * One stream connection after `after`. Resolves when the server ends it, rejects when it cannot be opened or is cut; the caller reconnects
 * from the last sequence number it applied (an event with a number it already has is dropped by the caller, so a repeat is harmless).
 */
export async function streamEvents(token: string, projectId: string, after: number, signal: AbortSignal, handlers: StreamHandlers): Promise<void> {
  const auth = requestAuth(token);
  const response = await fetch(`${base(projectId)}/stream?after=${after}`, { headers: { ...auth.headers, Accept: "text/event-stream" }, credentials: auth.credentials, signal });
  if (response.status === 401) reportUnauthorized();
  if (!response.ok || !response.body) throw new ApiError(response.status, `事件流打不开（${response.status}）`);
  handlers.onOpen();
  const reader = response.body.getReader(), decoder = new TextDecoder(), parse = createSseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    for (const message of parse(decoder.decode(value, { stream: true }))) {
      if (message.event === "sched") handlers.onEvent(JSON.parse(message.data) as SchedEvent);
      else if (message.event === "reset") handlers.onReset((JSON.parse(message.data) as { head: number }).head);
      else if (message.event === "ready") handlers.onReady();
      else if (message.event === "error") throw new ApiError(0, `事件流报错（${(JSON.parse(message.data) as { code?: string }).code ?? "未知"}）`);
    }
  }
}
