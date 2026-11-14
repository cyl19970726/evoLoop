// The live side of 统筹安排 › 动态: the SSE parser, merging events by sequence number (no loss, no repeat across a reconnect), learning which
// node an actor is from the events alone, and the object links. Pure functions; the stream and the page are checked on a real instance.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchedEvent } from "@evoloop/contracts/work-board";
import { createSseParser } from "../src/features/sessions/flow/flowClient";
import { mergeEvents } from "../src/features/sessions/flow/useFlowData";
import { learnContext, routeOf, styleOf } from "../src/features/sessions/flow/flowModel";
import { openTargetsOf } from "../src/features/sessions/flow/FlowPage";

const ev = (seq: number, kind: string, o: Partial<SchedEvent> = {}): SchedEvent => ({ seq, at: new Date(1_700_000_000_000 + seq * 1000).toISOString(), category: kind.split(".")[0] as SchedEvent["category"],
  kind, from: null, to: null, sessionId: null, subject: { kind: "task", id: "s", title: null, link: null }, taskId: null, prior: null, next: null, ...o });

test("the SSE parser returns whole messages across chunk boundaries and ignores comments", () => {
  const parse = createSseParser();
  assert.deepEqual(parse(": keep-alive\n\nid: 7\nevent: sch"), []);
  const out = parse(`ed\ndata: {"seq":7}\n\nevent: ready\ndata: {"head":7}\n\n`);
  assert.deepEqual(out, [{ id: "7", event: "sched", data: '{"seq":7}' }, { id: null, event: "ready", data: '{"head":7}' }]);
  assert.deepEqual(parse("event: reset\r\ndata: {\"resetRequired\":true,\"head\":9}\r\n\r\n"), [{ id: null, event: "reset", data: '{"resetRequired":true,"head":9}' }]);
});

test("events merge by sequence number: a repeat after a reconnect adds nothing, a gap is not filled, order stays ascending", () => {
  const first = [ev(1, "task.created"), ev(2, "task.queued"), ev(4, "task.turn")];
  const again = mergeEvents(first, [ev(2, "task.queued"), ev(4, "task.turn")]);
  assert.equal(again, first, "nothing new: the same array, so nothing re-renders");
  const more = mergeEvents(first, [ev(6, "task.run_started"), ev(4, "task.turn"), ev(5, "task.run_requested")]);
  assert.deepEqual(more.map(e => e.seq), [1, 2, 4, 5, 6], "no number twice, ascending, the missing 3 stays missing");
  const many = mergeEvents([], Array.from({ length: 6000 }, (_, i) => ev(i + 1, "task.created")));
  assert.equal(many.length, 5000); assert.equal(many[0]!.seq, 1001, "the newest are kept");
});

test("actors are placed only by what the events say; everyone else stays 其他身份", () => {
  const leaderSession = "L", dev = "D", acceptor = "A";
  const base = { sessionIds: new Set([leaderSession, dev, acceptor]), leaderSessionId: leaderSession };
  const events = [
    ev(1, "acceptance.arranged", { from: "lead-actor", to: "acc-actor", sessionId: acceptor }),
    ev(2, "task.delivered", { from: "dev-actor", sessionId: dev }),
    ev(3, "task.run_requested", { from: "lead-actor", sessionId: dev }),
    ev(4, "message.queued", { from: "stranger", sessionId: dev }),
  ];
  const ctx = learnContext(base, events);
  assert.equal(ctx.actors["acc-actor"], `session:${acceptor}`, "the recipient of an arrangement is the Session the event names");
  assert.equal(ctx.actors["dev-actor"], `session:${dev}`, "the signer of a delivery is the Session it names");
  assert.equal(ctx.actors["lead-actor"], "leader", "who arranges acceptance or reserves a Run is the Leader");
  assert.equal(ctx.actors["stranger"], undefined);
  assert.deepEqual(routeOf(events[3]!, ctx), { from: "people.external", to: `session:${dev}`, known: true }, "an unplaced sender is drawn as 其他身份, not guessed");
  assert.deepEqual(routeOf(ev(5, "message.queued", { from: "lead-actor", sessionId: dev }), ctx).from, "leader");
});

test("kinds the service emits today all have a picture; a new one is shown as 未知事件 with its own name", () => {
  for (const kind of ["task.resumed", "task.removed", "task.started", "task.cancelled", "task.done", "acceptance.closed"]) assert.equal(styleOf(kind).known, true, kind);
  assert.equal(styleOf("task.brand_new").known, false);
});

test("an event opens the real objects it names: its Task and its Session, nothing it does not carry", () => {
  const p = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(openTargetsOf(p, ev(1, "task.delivered", { taskId: "T1", sessionId: "S1" })).map(t => t.label), ["打开任务", "打开 Session"]);
  assert.match(openTargetsOf(p, ev(1, "task.delivered", { taskId: "T1" }))[0]!.href, /\/tasks\/T1$/);
  assert.deepEqual(openTargetsOf(p, ev(2, "notice.sent")), []);
});

test("a response that is not a board or an events page is refused as a failed read, never handed to the drawing code", async () => {
  const { checkedBoard, checkedEventsPage } = await import("../src/features/sessions/flow/flowClient");
  for (const bad of [{}, null, [], "x", { sessions: 1 }, { sessions: [], readyNotQueued: [], awaitingLeader: [], eventSeq: 1, graph: {} }]) assert.throws(() => checkedBoard(bad), /不是预期的格式/);
  for (const bad of [{}, null, { items: [] }, { items: {}, cursor: 1, head: 1 }]) assert.throws(() => checkedEventsPage(bad), /不是预期的格式/);
  const board = { sessions: [], readyNotQueued: [], awaitingLeader: [], eventSeq: 3, graph: { counts: {}, nodes: [], inFlight: [] } };
  assert.equal(checkedBoard(board), board);
  const page = { items: [], cursor: 3, head: 3, resetRequired: false, more: false };
  assert.equal(checkedEventsPage(page), page);
});
