import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SchedEvent } from "@evoloop/contracts/work-board";
import { fixtureBoard, fixtureContext, fixtureEvents } from "../src/features/sessions/flow/flowFixtures.ts";
import { GROUPS, STATIONS, foldPackets, isStuck, routeOf, stationCounts, stuckSpots, styleOf, upTo } from "../src/features/sessions/flow/flowModel.ts";

const sqlKinds = (): string[] => {
  // Every kind the database triggers write (migration 105) must have a picture; the picture of a kind nobody emits is harmless.
  const sql = readFileSync(join(import.meta.dirname, "../../../packages/adapter-postgres/schema/105_sched_event.sql"), "utf8");
  const literal = [...sql.matchAll(/'((?:notice|task|message|acceptance)\.[a-z_]+)'/g)].map(m => m[1]!);
  const computed = [...sql.matchAll(/'(notice|task|message|acceptance)\.'\|\|/g)].map(m => m[1]!);
  return [...new Set(literal)].concat(computed.length ? [] : []);
};

test("every event kind the triggers write literally has a known picture; an unknown kind is shown as unknown, not as something else", () => {
  const missing = sqlKinds().filter(kind => !styleOf(kind).known);
  assert.deepEqual(missing, []);
  // The computed kinds (notice.<packet state>, task.<queue/task state>, message.<message state>, acceptance.<relay state>) that can occur.
  for (const kind of ["notice.delivered", "notice.seen", "notice.blocked", "notice.returned", "task.held", "task.released", "task.done", "message.replied", "message.failed",
    "message.cancelled", "message.completed_without_reply", "acceptance.blocked", "acceptance.delivered"]) assert.ok(styleOf(kind).known, kind);
  const unknown = styleOf("notice.something_new");
  assert.equal(unknown.known, false); assert.equal(unknown.label, "未知事件"); assert.equal(unknown.glyph, "?");
});

test("every kind has a glyph and words beside its colour, and no tone is green", () => {
  for (const kind of [...new Set(fixtureEvents.map(e => e.kind)), "task.queued", "message.inserted", "acceptance.closed"]) {
    const style = styleOf(kind);
    assert.ok(style.glyph.length > 0 && style.label.length > 0, kind);
    assert.ok(["accent", "warning", "danger", "brand", "neutral"].includes(style.tone), kind);
  }
  assert.ok(GROUPS.every(g => g.label.length > 0));
});

test("stuck is what the event says: refused, failed, blocked, held, returned or unknown", () => {
  assert.equal(isStuck({ kind: "task.held", next: "held" }), true);
  assert.equal(isStuck({ kind: "message.failed", next: "failed" }), true);
  assert.equal(isStuck({ kind: "acceptance.blocked", next: "blocked" }), true);
  assert.equal(isStuck({ kind: "task.queued", next: "queued" }), false);
  assert.equal(isStuck({ kind: "task.run_ended", next: "completed" }), false);
  assert.equal(isStuck({ kind: "notice.sent", next: "unknown" }), true);
});

test("routes: a notice goes through the tray to the Leader, a dispatch from the Leader to the Session, a delivery out to the notices, an unknown Session is not guessed", () => {
  const byKind = (kind: string) => fixtureEvents.find(e => e.kind === kind)!;
  assert.deepEqual(routeOf(byKind("notice.created"), fixtureContext), { from: "people.notices", to: "packets", known: true });
  assert.deepEqual(routeOf(byKind("notice.sent"), fixtureContext), { from: "packets", to: "leader", known: true });
  const queued = routeOf(byKind("task.queued"), fixtureContext);
  assert.equal(queued.from, "leader"); assert.match(queued.to, /^session:/);
  assert.equal(routeOf(byKind("task.delivered"), fixtureContext).to, "people.notices");
  assert.equal(routeOf(byKind("message.inserted"), fixtureContext).from, "people.requirements");
  const stray: SchedEvent = { ...byKind("task.queued"), sessionId: "00000000-0000-4000-8000-0000000000ee" };
  assert.equal(routeOf(stray, fixtureContext).known, false, "a Session that is not on the board is not drawn as a known one");
  const stranger: SchedEvent = { ...byKind("message.inserted"), from: "nobody-we-know" };
  assert.equal(routeOf(stranger, fixtureContext).from, "people.external");
});

test("at most the cap of packets at once, and the merged ×N counts add up to the events given", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...fixtureEvents[i % fixtureEvents.length]!, seq: 1000 + i }));
  for (const cap of [12, 5, 3]) {
    const packets = foldPackets(many, fixtureContext, cap);
    assert.ok(packets.length <= cap, `cap ${cap}: ${packets.length}`);
    assert.equal(packets.reduce((n, p) => n + p.folded, 0), many.length, "no event is lost in the merge");
  }
  const few = foldPackets(many.slice(0, 5), fixtureContext, 12);
  assert.equal(few.length, 5); assert.ok(few.every(p => p.folded === 1));
});

test("the track counts are the snapshot's own; what the stream does not carry is 读不到, never 0", () => {
  const counts = stationCounts(fixtureBoard, 3);
  assert.deepEqual(counts.map(c => c.station), [...STATIONS]);
  const by = Object.fromEntries(counts.map(c => [c.station, c.count]));
  assert.equal(by["待派发"], fixtureBoard.readyNotQueued.length);
  assert.equal(by["队伍"], 1); assert.equal(by["运行中"], 1); assert.equal(by["待验收"], 1); assert.equal(by["已验收"], 3);
  assert.equal(by["已合并"], null); assert.equal(by["已发布"], null);
  const unread = stationCounts({ ...fixtureBoard, graph: { ...fixtureBoard.graph, counts: {} } }, null);
  assert.equal(unread.find(c => c.station === "队伍")!.count, null, "a count the snapshot does not give is unread, not zero");
});

test("stuck spots come only from the snapshot: a held entry, a closed gate, a held provider", () => {
  const spots = stuckSpots(fixtureBoard).map(s => s.text).join("|");
  assert.match(spots, /队伍项挂起（AUTHORIZATION_MISSING）/); assert.match(spots, /恢复门 blocked/); assert.match(spots, /模型服务暂停/);
  assert.deepEqual(stuckSpots({ ...fixtureBoard, sessions: fixtureBoard.sessions.map(s => ({ ...s, queue: [], health: { recoveryGate: "open", gateCause: null, providerHeld: false } })), awaitingLeader: [] }), []);
});

test("the replay is a function of the cursor: the same position shows the same events however it was reached", () => {
  assert.equal(upTo(fixtureEvents, 4).length, 5); assert.equal(upTo(fixtureEvents, -1).length, 0); assert.equal(upTo(fixtureEvents, 999).length, fixtureEvents.length);
});

test("fixture events carry the on-screen warning: the component says they are not real", () => {
  const view = readFileSync(join(import.meta.dirname, "../src/features/sessions/flow/FlowView.tsx"), "utf8");
  assert.match(view, /夹具数据 · 非真实/);
  const header = readFileSync(join(import.meta.dirname, "../src/features/sessions/flow/flowFixtures.ts"), "utf8");
  assert.match(header, /NOT read from any instance/);
});
