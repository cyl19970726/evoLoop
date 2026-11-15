// The live side of 统筹安排 › 动态: the SSE parser, merging events by sequence number (no loss, no repeat across a reconnect), learning which
// node an actor is from the events alone, and the object links. Pure functions; the stream and the page are checked on a real instance.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SchedEvent } from "@evoloop/contracts/work-board";
import { createSseParser } from "../src/features/sessions/flow/flowClient";
import { mergeEvents } from "../src/features/sessions/flow/useFlowData";
import { learnContext, routeOf, styleOf } from "../src/features/sessions/flow/flowModel";
import { openTargetsOf } from "../src/features/sessions/flow/FlowPage";
import { DELIVERY_LOCATION, MESSAGE_LOCATION, PR_UNAVAILABLE, deliveryHref, openInfoOf } from "../src/features/sessions/flow/flowOpen";
import { FlowView } from "../src/features/sessions/flow/FlowView";
import { fixtureBoard, fixtureContext } from "../src/features/sessions/flow/flowFixtures";
import React, { createElement } from "react";
// The workbench source is compiled with the classic JSX runtime in this test loader: React must be in scope for the components it renders.
(globalThis as { React?: unknown }).React = React;
import { renderToStaticMarkup } from "react-dom/server";

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
  assert.deepEqual(openTargetsOf(p, ev(1, "task.delivered", { taskId: "T1", sessionId: "S1" })).map(t => t.label), ["打开交付", "打开 Session"]);
  assert.match(openTargetsOf(p, ev(1, "task.delivered", { taskId: "T1" }))[0]!.href, /\/tasks\/T1\?tab=delivery$/);
  assert.match(openTargetsOf(p, ev(1, "task.started", { taskId: "T1" }))[0]!.href, /\/tasks\/T1$/, "an event that is not a delivery opens the Task's first tab");
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

const P = "00000000-0000-4000-8000-000000000001";

test("a delivery event opens its Task's 交付与使用 tab at that delivery, and says where the record is when it cannot", () => {
  const delivered = ev(1, "task.delivered", { taskId: "T1", sessionId: "S1", subject: { kind: "delivery", id: "D1", title: "t", link: null } });
  const info = openInfoOf(P, delivered);
  const open = info.targets.find(t => t.label === "打开交付")!;
  assert.equal(open.href, deliveryHref(P, "T1", "D1"));
  assert.deepEqual([...new URL(open.href, "http://x").searchParams], [["tab", "delivery"], ["delivery", "D1"]], "the tab and the delivery, not just the Task");
  assert.match(open.href, /\/tasks\/T1\?/);
  assert.ok(info.notes.some(n => n.includes(DELIVERY_LOCATION) && n.includes("定位到这次交付")));
  // A delivery event that names no Task cannot be linked: it says so, and where the record is, instead of a generic link.
  const orphan = openInfoOf(P, ev(2, "task.delivered", { subject: { kind: "delivery", id: "D2", title: null, link: null } }));
  assert.deepEqual(orphan.targets, []);
  assert.ok(orphan.notes.some(n => n.includes(DELIVERY_LOCATION) && n.includes("无法直达")));
  // A Task event is not a delivery: it opens the Task, and says nothing about a delivery.
  assert.deepEqual(openInfoOf(P, ev(3, "task.started", { taskId: "T1" })).notes, []);
});

test("a message event opens the Session conversation and says there is no single-message page; without a Session it says the conversation cannot be read", () => {
  const withSession = openInfoOf(P, ev(1, "message.queued", { sessionId: "S1", subject: { kind: "message", id: "M1", title: null, link: null } }));
  assert.deepEqual(withSession.targets.map(t => t.label), ["打开该 Session 的对话"]);
  assert.match(withSession.targets[0]!.href, /sessions\?session=owned%3AS1$/);
  assert.ok(withSession.notes.includes(`${MESSAGE_LOCATION}。`));
  const noSession = openInfoOf(P, ev(2, "message.failed", { subject: { kind: "message", id: "M2", title: null, link: null } }));
  assert.deepEqual(noSession.targets, []);
  assert.ok(noSession.notes.some(n => n.includes(MESSAGE_LOCATION) && n.includes("读不到是哪个对话")));
  assert.equal(withSession.pr, null, "a message is not about a pull request");
});

test("the pull request is said to be unreadable where one would be expected, and not claimed anywhere else", () => {
  for (const kind of ["task.delivered", "acceptance.closed", "acceptance.observed", "acceptance.reviewed", "task.done"]) assert.equal(openInfoOf(P, ev(1, kind, { taskId: "T1" })).pr, PR_UNAVAILABLE, kind);
  for (const kind of ["notice.sent", "message.queued", "task.queued", "task.run_started"]) assert.equal(openInfoOf(P, ev(1, kind, { taskId: "T1", sessionId: "S1" })).pr, null, kind);
  assert.equal(PR_UNAVAILABLE, "读不到：调度事件流不含 PR");
});

test("the detail on screen shows the notes and the PR line for a live event, nothing invented for a fixture one; the 已验收 cell names its window", () => {
  const delivered = ev(5, "task.delivered", { taskId: "T1", sessionId: "S1", subject: { kind: "delivery", id: "D1", title: "交付一", link: null } });
  const render = (source: "live" | "fixture", windowHours?: number) => renderToStaticMarkup(createElement(FlowView, { board: fixtureBoard, events: [delivered], context: fixtureContext, source, selectSeq: 5,
    ...(source === "live" ? { openInfo: (e: SchedEvent) => openInfoOf(P, e), ...(windowHours ? { windowHours } : {}) } : {}) }));
  const live = render("live", 6);
  assert.match(live, /data-open="" href="[^"]*tab=delivery&amp;delivery=D1"|href="[^"]*tab=delivery&amp;delivery=D1"[^>]*data-open/);
  assert.match(live, /交付记录在该任务的“交付与使用”页签/);
  assert.match(live, /<dt[^>]*>PR<\/dt><dd data-pr="">读不到：调度事件流不含 PR<\/dd>/);
  assert.match(live, /已验收<\/span><span[^>]*data-station-window="">近 6 小时/, "the cell itself says the count is the last 6 hours");
  const fixture = render("fixture");
  assert.match(fixture, /夹具事件没有真实对象/); assert.doesNotMatch(fixture, /data-pr=|tab=delivery/);
  assert.match(fixture, /data-station-window="">窗口内/);
});
