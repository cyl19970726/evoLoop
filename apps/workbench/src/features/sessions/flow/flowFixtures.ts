// FIXTURE DATA for the 动态 page's design and sample (DEC-045 F1, first segment). Hand-written to look like the scheduling event stream and
// the work board of docs/development/agent-cli.md; it is NOT read from any instance and proves nothing about one. The page that shows
// it says so on screen ("夹具数据 · 非真实"); the real read (work board snapshot, events, SSE) is the second segment.
import type { SchedEvent, WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import type { FlowContext, NodeId } from "./flowModel";

const project = "00000000-0000-4000-8000-0000000000f1";
const sid = (n: number) => `00000000-0000-4000-8000-00000000a0${String(n).padStart(2, "0")}`;
export const fixtureSessions = [
  { id: sid(1), role: "验收", name: "acceptance-claude", actor: "acceptance-claude-agent" },
  { id: sid(2), role: "验收", name: "acceptance-2", actor: "acceptance-2-claude-agent" },
  { id: sid(3), role: "开发", name: "dev-claude", actor: "dev-claude-agent" },
  { id: sid(4), role: "开发", name: "dev-claude-2", actor: "dev-claude-2-agent" },
  { id: sid(5), role: "开发", name: "codex-dev", actor: "codex-dev-agent" },
  { id: sid(6), role: "文档", name: "文档与架构", actor: "docs-agent" },
];
const leaderId = "00000000-0000-4000-8000-00000000a000";
const subjectId = (n: number) => `00000000-0000-4000-8000-00000000b${String(n).padStart(3, "0")}`;
const taskId = (n: number) => `00000000-0000-4000-8000-00000000c${String(n).padStart(3, "0")}`;
const t0 = Date.parse("2026-11-12T09:24:00+08:00");

let seq = 100;
const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
type Opt = Partial<Omit<SchedEvent, "subject" | "taskId">> & { n: number; sub?: SchedEvent["subject"]["kind"]; t?: number; title?: string };
const ev = (minute: number, kind: string, o: Opt): SchedEvent => {
  const { n, sub, t, title: text, ...rest } = o;
  const task = t === undefined ? null : taskId(t);
  return { seq: ++seq, at: at(minute), category: kind.split(".")[0] as SchedEvent["category"], kind, from: null, to: null, sessionId: null, taskId: task,
    subject: { kind: sub ?? "task", id: t !== undefined && !sub ? taskId(t) : subjectId(n), title: text ?? null, link: null }, prior: null, next: null, ...rest };
};
const S = (i: number) => fixtureSessions[i - 1]!.id;

export const fixtureEvents: SchedEvent[] = [
  ev(0, "notice.created", { n: 1, from: "system", to: "leader", next: "pending", t: 1, title: "PR 357 合并前验收" }),
  ev(3, "message.failed", { n: 2, from: "leader", sessionId: leaderId, sub: "message", next: "failed" }),
  ev(7, "notice.created", { n: 3, from: "system", to: "leader", next: "pending", t: 3, title: "使用观察已记录" }),
  ev(12, "task.queued", { n: 4, from: "leader-actor", sessionId: S(4), sub: "queue_entry", next: "queued", t: 4, title: "变基 PR 378" }),
  ev(14, "task.turn", { n: 4, sessionId: S(4), sub: "queue_entry", prior: "queued", next: "claimed", t: 4, title: "变基 PR 378" }),
  ev(14, "task.run_requested", { n: 5, from: "dev-claude-2-agent", sessionId: S(4), sub: "run", next: "requested", t: 4, title: "变基 PR 378" }),
  ev(15, "task.run_started", { n: 5, sessionId: S(4), sub: "run", prior: "requested", next: "running", t: 4, title: "变基 PR 378" }),
  ev(18, "message.queued", { n: 6, from: "requirements-claude-agent", sessionId: leaderId, sub: "message", next: "queued" }),
  ev(22, "notice.packet_built", { n: 7, from: "system", sessionId: leaderId, sub: "packet", next: "building" }),
  ev(22, "notice.packed", { n: 1, from: "system", to: subjectId(7), sub: "notice" }),
  ev(23, "notice.sent", { n: 7, from: "system", sessionId: leaderId, sub: "packet", next: "new_turn" }),
  ev(24, "message.processing", { n: 6, sessionId: leaderId, sub: "message", prior: "queued", next: "processing" }),
  ev(30, "task.queued", { n: 8, from: "leader-actor", sessionId: S(1), sub: "queue_entry", next: "queued", t: 8, title: "核查 CI 失败" }),
  ev(31, "task.held", { n: 8, sessionId: S(1), sub: "queue_entry", prior: "queued", next: "held", t: 8, title: "核查 CI 失败" }),
  ev(36, "task.delivered", { n: 9, from: "dev-claude-agent", sessionId: S(3), sub: "delivery", next: "passed", t: 9, title: "PR 389 验收约定跟进" }),
  ev(37, "notice.created", { n: 10, from: "system", to: "leader", next: "pending", t: 9, title: "PR 389 验收约定跟进" }),
  ev(41, "acceptance.arranged", { n: 11, from: "leader-actor", to: "acceptance-2-claude-agent", sessionId: S(2), sub: "relay", next: "pending", t: 9, title: "PR 389 验收约定跟进" }),
  ev(42, "acceptance.delivered", { n: 11, sessionId: S(2), sub: "relay", prior: "pending", next: "linked", t: 9, title: "PR 389 验收约定跟进" }),
  ev(55, "message.inserted", { n: 12, from: "requirements-claude-agent", sessionId: leaderId, sub: "input", next: "accepted" }),
  ev(58, "notice.delivered", { n: 7, from: "system", sessionId: leaderId, sub: "packet", prior: "sent", next: "delivered" }),
  ev(66, "acceptance.observed", { n: 13, from: "acceptance-2-claude-agent", sub: "observation", next: "passed", t: 9, title: "PR 389 验收约定跟进" }),
  ev(67, "acceptance.closed", { n: 14, from: "requirements-claude-agent", sub: "closure", next: "accepted", t: 9, title: "PR 389 验收约定跟进" }),
  ev(70, "task.run_ended", { n: 5, sessionId: S(4), sub: "run", prior: "running", next: "completed", t: 4, title: "变基 PR 378" }),
  ev(72, "task.delivered", { n: 15, from: "dev-claude-2-agent", sessionId: S(4), sub: "delivery", next: "passed", t: 4, title: "变基 PR 378" }),
  ev(80, "acceptance.blocked", { n: 16, from: "leader-actor", to: "acceptance-claude-agent", sessionId: S(1), sub: "relay", prior: "pending", next: "blocked", t: 8, title: "核查 CI 失败" }),
  ev(95, "message.stopped", { n: 17, from: "requirements-claude-agent", sessionId: S(5), sub: "message", next: null }),
  ev(100, "notice.seen", { n: 7, from: "system", sessionId: leaderId, sub: "packet", prior: "delivered", next: "seen" }),
  ev(104, "notice.handled", { n: 1, from: "leader-actor", sub: "notice", prior: "seen", next: "handled" }),
  ev(110, "task.released", { n: 4, sessionId: S(4), sub: "queue_entry", prior: "claimed", next: "released", t: 4, title: "变基 PR 378" }),
  ev(112, "notice.future_kind_this_build_does_not_know", { n: 18, from: "system", sessionId: leaderId, sub: "packet", next: "x" }),
];

export const fixtureBoard: WorkBoardSnapshot = {
  projectId: project, observedAt: at(112), eventSeq: seq,
  sessions: [
    ...fixtureSessions.map((s, i) => ({ sessionId: s.id, roleId: `role-${i}`, roleTitle: `${s.role} · ${s.name}`, state: "ready", provider: i === 4 ? "codex" : "claude",
      current: i === 3 ? { kind: "run" as const, id: subjectId(5), taskId: taskId(4), taskTitle: "变基 PR 378", startedAt: at(15), elapsedSeconds: 5820 } : null,
      queue: i === 0 ? [{ entryId: subjectId(8), taskId: taskId(8), taskTitle: "核查 CI 失败", position: 0, state: "held", holdCode: "AUTHORIZATION_MISSING", source: "leader-actor", addedAt: at(30), waitedSeconds: 4920 }] : [],
      queuedMessages: i === 4 ? 1 : 0, health: { recoveryGate: i === 4 ? "blocked" : "open", gateCause: i === 4 ? "run" : null, providerHeld: i === 4 } })),
  ],
  readyNotQueued: [{ taskId: taskId(20), title: "补充发布流程说明", state: "todo", since: at(60) }, { taskId: taskId(21), title: "核对迁移号", state: "todo", since: at(75) }],
  awaitingLeader: [{ kind: "notice", id: subjectId(3), taskId: taskId(3), title: "使用观察已记录", state: "seen", since: at(7) }],
  graph: { nodes: [], inFlight: [], counts: { sessions: 6, running: 1, queued: 0, held: 1, claimed: 0, queuedMessages: 1, readyNotQueued: 2, openPackets: 0, pendingAcceptance: 1, awaitingLeader: 1 } },
};

export const fixtureContext: FlowContext = {
  actors: {
    "leader-actor": "leader", "requirements-claude-agent": "people.requirements", "scheduler-actor": "people.scheduler",
    ...Object.fromEntries(fixtureSessions.map(s => [s.actor, `session:${s.id}` as NodeId])),
  },
  sessionIds: new Set([leaderId, ...fixtureSessions.map(s => s.id)]), leaderSessionId: leaderId,
};
