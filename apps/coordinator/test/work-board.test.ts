import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SchedEvent, SchedEventsPage, WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import { BRIEF_BYTE_LIMIT, briefWorkBoard } from "../src/work-board/brief.ts";
import { SchedEventHub } from "../src/work-board/hub.ts";
import { computeBoardMetrics } from "../src/work-board/metrics.ts";

const t0 = Date.parse("2026-11-12T00:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
let counter = 0;
const ev = (s: number, kind: string, subject: string, extra: Partial<SchedEvent> = {}): SchedEvent => ({
  seq: ++counter, at: at(s), category: kind.split(".")[0] as SchedEvent["category"], kind, from: null, to: null, sessionId: null, taskId: null,
  subject: { kind: "task", id: subject, title: null, link: null }, prior: null, next: null, ...extra });

test("queue wait is task.queued to task.turn of the same entry, grouped by who added it", () => {
  const events = [
    ev(0, "task.queued", "e1", { from: "leader" }), ev(10, "task.queued", "e2", { from: "scheduler" }), ev(60, "task.turn", "e1"),
    ev(100, "task.turn", "e2"), ev(120, "task.queued", "e3", { from: "leader" }), // never got its turn: not counted
    ev(200, "task.turn", "e-before-window"),                                    // queued before the window: not guessed
  ];
  const m = computeBoardMetrics(events, at(0), at(300));
  assert.deepEqual(m.queueWait, [{ source: "leader", count: 1, medianSeconds: 60, p95Seconds: 60 }, { source: "scheduler", count: 1, medianSeconds: 90, p95Seconds: 90 }]);
});

test("a Session is idle with work waiting only while nothing runs and something queued", () => {
  const s = "session-1";
  const events = [
    ev(0, "task.queued", "e1", { sessionId: s }),          // waiting, nothing running: idle from 0
    ev(30, "task.run_requested", "r1", { sessionId: s }),  // 30 s idle with work; now busy
    ev(30, "task.turn", "e1", { sessionId: s }),
    ev(100, "message.queued", "m1", { sessionId: s }),     // waiting while busy: not idle
    ev(160, "task.run_ended", "r1", { sessionId: s }),     // busy -> free with m1 waiting: idle again
    ev(190, "message.processing", "m1", { sessionId: s }), // 30 s idle with work
    ev(250, "message.replied", "m1", { sessionId: s }),
  ];
  const m = computeBoardMetrics(events, at(0), at(300));
  assert.deepEqual(m.sessionIdle, [{ sessionId: s, idleWithWorkSeconds: 60, windowSeconds: 300 }]);
  // Still waiting with nothing running at the end of the window counts to the end.
  const open = computeBoardMetrics([ev(0, "message.queued", "m9", { sessionId: "s2" })], at(0), at(100));
  assert.equal(open.sessionIdle[0]!.idleWithWorkSeconds, 100);
});

test("notice intake: created to the first read of its packet, or to the notice's own send when it never travelled in a packet", () => {
  const events = [
    ev(0, "notice.created", "n1"), ev(5, "notice.created", "n2"), ev(8, "notice.created", "n3"),
    ev(20, "notice.packed", "n1", { to: "p1" }), ev(20, "notice.packed", "n2", { to: "p1" }),
    ev(30, "notice.sent", "p1", { next: "steer" }), ev(32, "notice.delivered", "p1"), ev(90, "notice.seen", "p1"),
    ev(48, "notice.sent", "n3"),                    // the old path: one notice, one message
  ];
  const m = computeBoardMetrics(events, at(0), at(300));
  assert.equal(m.noticeIntake.count, 3);
  assert.equal(m.noticeIntake.medianSeconds, 32, "n1 32 s, n2 27 s, n3 40 s: the median is 32");
  assert.equal(m.noticeIntake.p95Seconds, 40);
});

const snapshot = (sessions: number, queue: number): WorkBoardSnapshot => {
  const task = () => ({ taskId: randomUUID(), title: "调度架构：一个相当长的任务标题用来占位 ".repeat(3) });
  return {
    projectId: randomUUID(), observedAt: at(0), eventSeq: 4242,
    sessions: Array.from({ length: sessions }, (_, i) => ({ sessionId: randomUUID(), roleId: randomUUID(), roleTitle: `功能开发 ${i}`, state: "ready", provider: "codex",
      current: { kind: "run" as const, id: randomUUID(), taskId: randomUUID(), taskTitle: task().title, startedAt: at(0), elapsedSeconds: 600 },
      queue: Array.from({ length: queue }, (_, j) => ({ entryId: randomUUID(), taskId: randomUUID(), taskTitle: task().title, position: j, state: "queued", holdCode: null, source: "leader-actor", addedAt: at(0), waitedSeconds: 900 })),
      queuedMessages: 1, health: { recoveryGate: "open", gateCause: null, providerHeld: false } })),
    readyNotQueued: Array.from({ length: 10 }, () => ({ ...task(), state: "todo", since: at(0) })),
    awaitingLeader: Array.from({ length: 8 }, () => ({ kind: "notice" as const, id: randomUUID(), taskId: randomUUID(), title: task().title, state: "seen", since: at(0) })),
    graph: { nodes: [], inFlight: [], counts: { sessions, running: sessions } },
  };
};

test("the brief stays within 6 KB and is at most half the full output, also for a large board", () => {
  for (const [sessions, queue] of [[4, 3], [12, 5], [40, 8]] as const) {
    const board = snapshot(sessions, queue);
    const full = Buffer.byteLength(JSON.stringify(board), "utf8"), brief = Buffer.byteLength(JSON.stringify(briefWorkBoard(board)), "utf8");
    assert.ok(brief <= BRIEF_BYTE_LIMIT, `${sessions}x${queue}: ${brief} > limit`);
    assert.ok(brief * 2 <= full, `${sessions}x${queue}: brief ${brief} is not at most half of ${full}`);
  }
  const out = briefWorkBoard(snapshot(2, 2)) as { sessions: Array<{ id: string; now: { task: string } }> };
  assert.equal(out.sessions[0]!.id.length, 36, "IDs stay whole: the Leader acts on them");
});

const page = (items: SchedEvent[], cursor: number, more = false): SchedEventsPage => ({ items, cursor, head: cursor, resetRequired: false, more });

test("the hub reads nothing while nobody is subscribed, and one read serves every subscriber", async () => {
  let heads = 0, reads = 0, head = 5;
  const hub = new SchedEventHub({ head: async () => { heads++; return head; },
    read: async (_p, after) => { reads++; return page([ev(0, "task.queued", "x", { })].map(e => ({ ...e, seq: after + 1 })), after + 1); } }, 1_000_000);
  await hub.tick("p1");
  assert.deepEqual([heads, reads, hub.activeProjects()], [0, 0, 0], "no subscriber, no query");
  const a: number[] = [], b: number[] = [];
  const offA = await hub.subscribe("p1", { onEvents: i => a.push(...i.map(e => e.seq)), onReset: () => undefined });
  const offB = await hub.subscribe("p1", { onEvents: i => b.push(...i.map(e => e.seq)), onReset: () => undefined });
  assert.equal(heads, 1, "the first subscriber looks at the head once; the second shares the loop");
  await hub.tick("p1");
  assert.equal(reads, 0, "head unchanged: no read");
  head = 6; await hub.tick("p1");
  assert.deepEqual([a, b, reads], [[6], [6], 1], "one read, both subscribers served");
  offA(); assert.equal(hub.subscribers("p1"), 1);
  offB(); assert.equal(hub.activeProjects(), 0, "the loop stops with the last subscriber");
});

test("a head that went backwards, or a read that says resetRequired, resets every subscriber", async () => {
  let head = 10; const resets: number[] = [];
  const hub = new SchedEventHub({ head: async () => head, read: async () => ({ items: [], cursor: 12, head: 12, resetRequired: true, more: false }) }, 1_000_000);
  const off = await hub.subscribe("p", { onEvents: () => undefined, onReset: h => resets.push(h) });
  head = 3; await hub.tick("p");
  head = 12; await hub.tick("p");
  assert.deepEqual(resets, [3, 12]);
  off();
});

test("defect 52eb5ecf: a direct input that starts a Turn on an idle Session is busy time, not waiting and not idle", () => {
  const s = "session-i";
  // 5 minutes of direct-input work in a 1 hour window: started (busy) ... replied (free). Nothing waits: no idle time.
  const events = [ev(600, "message.started", "m1", { sessionId: s }), ev(900, "message.replied", "m1", { sessionId: s })];
  const m = computeBoardMetrics(events, at(0), at(3600));
  assert.equal(m.sessionIdle.length === 0 || m.sessionIdle[0]!.idleWithWorkSeconds === 0, true, JSON.stringify(m.sessionIdle));
  // The same text recorded the old way (queued, then processing) would have counted as waiting; a real queued message still does.
  const queued = computeBoardMetrics([ev(0, "message.queued", "m2", { sessionId: s }), ev(120, "message.processing", "m2", { sessionId: s }), ev(300, "message.replied", "m2", { sessionId: s })], at(0), at(3600));
  assert.equal(queued.sessionIdle[0]!.idleWithWorkSeconds, 120, "a message that waited 120 s with nothing running is idle-with-work for 120 s");
});

test("defect 52eb5ecf: line entries wait from task.queued (or task.resumed) to task.turn; a suspended or removed entry is not work waiting for a free Session", () => {
  const s = "session-l";
  const events = [ev(0, "task.queued", "e1", { sessionId: s, from: "lead" }), ev(60, "task.held", "e1", { sessionId: s }),
    ev(100, "task.resumed", "e1", { sessionId: s }), ev(160, "task.turn", "e1", { sessionId: s }), ev(160, "task.run_requested", "r1", { sessionId: s })];
  const m = computeBoardMetrics(events, at(0), at(300));
  assert.deepEqual(m.queueWait, [{ source: "lead", count: 1, medianSeconds: 160, p95Seconds: 160 }], "queued at 0, its turn at 160 (a hold in between does not reset the first queueing)");
  assert.equal(m.sessionIdle[0]!.idleWithWorkSeconds, 60 + 60, "waiting and idle 0-60 and 100-160; held 60-100 is not waiting");

test("defect d6dd0a1e rework 2: a recovery gate item is never cut from the brief for room — 21 other waiting items do not push it out, and the brief stays within 6 KB", () => {
  const board = snapshot(6, 3);
  const others = Array.from({ length: 21 }, (_, i) => ({ kind: (i % 2 ? "notice" : "decision") as "notice" | "decision", id: randomUUID(), taskId: randomUUID(), title: `其它待办项 ${i} 一个相当长的标题用来占位`.repeat(2), state: "seen", since: at(0) }));
  const gate = { kind: "recovery_gate" as const, id: randomUUID(), taskId: null, title: "模拟用户：恢复门 blocked 超过 30 分钟，2 条消息排在后面", state: "blocked", since: at(0), waitingOn: { kind: "actor" as const, id: "requirements-claude-agent" } };
  // The gate is last in the data the brief is given: it must still come first and stay.
  const out = briefWorkBoard({ ...board, awaitingLeader: [...others, gate] }) as { leader: Array<{ kind: string; id: string; waitingOn?: string }>; leaderMore?: number };
  assert.equal(out.leader[0]!.kind, "recovery_gate", "gate first");
  assert.equal(out.leader[0]!.id, gate.id); assert.equal(out.leader[0]!.waitingOn, "requirements-claude-agent");
  assert.ok(Buffer.byteLength(JSON.stringify(out), "utf8") <= BRIEF_BYTE_LIMIT, "still within 6 KB");
  assert.ok(out.leader.length + (out.leaderMore ?? 0) === 22, "every item is either listed or counted");
  // Several gates are all kept, even where the tiers would have cut the list down.
  const gates = Array.from({ length: 4 }, (_, i) => ({ ...gate, id: randomUUID(), title: `会话 ${i}：恢复门 blocked` }));
  const many = briefWorkBoard({ ...snapshot(40, 8), awaitingLeader: [...others, ...gates] }) as { leader: Array<{ kind: string }> };
  assert.equal(many.leader.filter(i => i.kind === "recovery_gate").length, 4, "all four gates are listed");
  assert.ok(Buffer.byteLength(JSON.stringify(many), "utf8") <= BRIEF_BYTE_LIMIT);

});
