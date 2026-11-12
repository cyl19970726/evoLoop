// The model of 统筹安排 › 动态 (DEC-045 F1). Pure: scheduling events and the board snapshot in, what the canvas and the list show out.
// The canvas never invents a state: what the data does not say is "未知" or "读不到", and a count is the count of the data it was
// given. Colours are tones (a token each, never green); every tone has a glyph and words beside it.
import type { SchedEvent, WorkBoardSnapshot } from "@evoloop/contracts/work-board";

export type FlowGroup = "message" | "notice" | "task" | "accept" | "system";
export type FlowTone = "accent" | "warning" | "danger" | "brand" | "neutral";
export interface KindStyle { label: string; glyph: string; group: FlowGroup; tone: FlowTone; known: boolean }

export const GROUPS: Array<{ id: FlowGroup; label: string; tone: FlowTone }> = [
  { id: "message", label: "消息", tone: "accent" }, { id: "notice", label: "通知", tone: "warning" }, { id: "task", label: "派发与运行", tone: "accent" },
  { id: "accept", label: "交付与验收", tone: "neutral" }, { id: "system", label: "系统", tone: "danger" },
];

const S = (label: string, glyph: string, group: FlowGroup, tone: FlowTone): KindStyle => ({ label, glyph, group, tone, known: true });
/** Every kind the event stream can carry today (docs/development/agent-cli.md 调度板与调度事件流). */
const KINDS: Record<string, KindStyle> = {
  "notice.created": S("通知产生", "•", "notice", "warning"), "notice.packet_built": S("通知包合成", "▤", "notice", "brand"), "notice.packed": S("进入通知包", "▤", "notice", "brand"),
  "notice.sent": S("通知包送达", "▤", "notice", "brand"), "notice.delivered": S("通知被读到", "▤", "notice", "brand"), "notice.seen": S("通知已看到", "▤", "notice", "neutral"),
  "notice.handled": S("通知已处置", "✓", "notice", "neutral"), "notice.deferred": S("通知延后", "…", "notice", "warning"), "notice.withdrawn": S("通知撤回", "×", "notice", "neutral"),
  "notice.blocked": S("通知受阻", "!", "notice", "danger"), "notice.returned": S("通知退回待发", "↺", "notice", "warning"), "notice.unknown": S("通知结果未知", "?", "notice", "warning"),
  "task.created": S("任务建立", "+", "task", "neutral"), "task.confirmed": S("执行确认", "✓", "task", "accent"), "task.returned": S("任务退回", "!", "task", "danger"),
  "task.queued": S("追加进队伍", "→", "task", "accent"), "task.turn": S("轮到执行", "→", "task", "accent"), "task.held": S("队伍项挂起", "!", "task", "danger"),
  "task.released": S("放行或撤下", "↑", "task", "brand"), "task.reordered": S("队伍重排", "⇅", "task", "accent"), "task.run_requested": S("预留 Run", "→", "task", "accent"),
  "task.run_started": S("Run 开始", "▶", "task", "accent"), "task.run_ended": S("Run 结束", "■", "task", "neutral"), "task.delivered": S("交付", "◆", "accept", "neutral"),
  "task.started": S("任务开始", "▶", "task", "accent"), "task.done": S("任务完成", "✓", "task", "neutral"), "task.cancelled": S("任务取消", "×", "task", "neutral"), "task.todo": S("任务回到待办", "↺", "task", "warning"),
  "message.queued": S("消息排队", "✉", "message", "accent"), "message.processing": S("消息开始处理", "✉", "message", "accent"), "message.replied": S("消息已回复", "✉", "message", "neutral"),
  "message.completed_without_reply": S("消息处理完成", "✉", "message", "neutral"), "message.failed": S("消息失败", "!", "message", "danger"), "message.cancelled": S("消息取消", "×", "message", "neutral"),
  "message.inserted": S("插入当前一轮", "↳", "message", "accent"), "message.started": S("即时输入开一轮", "↳", "message", "accent"), "message.stopped": S("叫停", "!", "message", "danger"),
  "message.unknown": S("消息结果未知", "?", "message", "warning"),
  "acceptance.arranged": S("安排验收", "→", "accept", "accent"), "acceptance.delivered": S("验收已送达", "→", "accept", "accent"), "acceptance.blocked": S("验收受阻", "!", "accept", "danger"),
  "acceptance.superseded": S("验收安排被取代", "×", "accept", "neutral"), "acceptance.released": S("验收安排释放", "↑", "accept", "neutral"),
  "acceptance.observed": S("验收观察", "✓", "accept", "neutral"), "acceptance.closed": S("任务关闭", "✓", "accept", "neutral"), "acceptance.reviewed": S("复核", "✓", "accept", "neutral"),
  "acceptance.precondition_marked": S("前置条件已满足", "✓", "accept", "neutral"),
};
const UNKNOWN: KindStyle = { label: "未知事件", glyph: "?", group: "system", tone: "neutral", known: false };
/** An event kind this build does not know is shown as "未知事件" with its own name, never mapped onto a known meaning. */
export const styleOf = (kind: string): KindStyle => KINDS[kind] ?? UNKNOWN;

/** An event that says something is stuck: refused, failed, blocked, held, or an outcome nobody knows. */
export function isStuck(event: Pick<SchedEvent, "kind" | "next">): boolean {
  return /(?:blocked|failed|stopped|held|returned|unknown)$/.test(event.kind) || ["blocked", "failed", "unknown"].includes(event.next ?? "");
}

// ---- nodes and routes ----
export type PeopleId = "people.user" | "people.requirements" | "people.scheduler" | "people.notices" | "people.external";
export type NodeId = PeopleId | "leader" | "packets" | `session:${string}`;
export const PEOPLE: Array<{ id: PeopleId; label: string; sub: string }> = [
  { id: "people.user", label: "使用者", sub: "工作台与对话" }, { id: "people.requirements", label: "需求 Session", sub: "新 Task 与签字" },
  { id: "people.scheduler", label: "定时代班", sub: "日程到点" }, { id: "people.notices", label: "结果通知", sub: "交付与观察产生" }, { id: "people.external", label: "其他身份", sub: "外部会话与未识别" },
];
export interface FlowContext {
  /** actor ID -> the node it signs for (the page fills this from the Session directory; an actor nobody knows is "其他身份"). */
  actors: Record<string, NodeId>;
  sessionIds: ReadonlySet<string>;
  leaderSessionId: string | null;
}
const session = (id: string | null, ctx: FlowContext): NodeId | null => id && ctx.sessionIds.has(id) ? (id === ctx.leaderSessionId ? "leader" : `session:${id}`) : null;
const actor = (ref: string | null, ctx: FlowContext): NodeId => ref === "leader" ? "leader" : ref === "system" ? "people.notices" : ref && ctx.actors[ref] ? ctx.actors[ref]! : "people.external";

/** From which node to which node an event travels. Unrecoverable endpoints fall back to "其他身份" and say so in the detail. */
export function routeOf(event: SchedEvent, ctx: FlowContext): { from: NodeId; to: NodeId; known: boolean } {
  const target = session(event.sessionId, ctx);
  switch (event.category) {
    case "notice":
      if (/\.(?:created)$/.test(event.kind)) return { from: "people.notices", to: "packets", known: true };
      if (/\.(?:packed|packet_built)$/.test(event.kind)) return { from: "people.notices", to: "packets", known: true };
      return { from: "packets", to: target ?? "leader", known: true };
    case "message": {
      const to = target ?? "leader";
      return { from: event.from ? actor(event.from, ctx) : "leader", to, known: !!target || event.sessionId === null };
    }
    case "task":
      if (event.kind === "task.delivered") return { from: target ?? "leader", to: "people.notices", known: !!target };
      return { from: "leader", to: target ?? "leader", known: !!target || event.sessionId === null };
    case "acceptance":
      return { from: target ?? "leader", to: event.to ? actor(event.to, ctx) : "people.requirements", known: !!target || event.sessionId === null };
  }
}

// ---- packets on the canvas ----
export interface Packet { key: string; event: SchedEvent; from: NodeId; to: NodeId; style: KindStyle; folded: number }
/**
 * At most `cap` packets at once: the newest ones stay individual, the rest merge into one "×N" packet per route. The merged count is
 * the exact number of events it stands for, so the sum over packets always equals the events given.
 */
export function foldPackets(events: SchedEvent[], ctx: FlowContext, cap: number): Packet[] {
  const all = events.map(event => ({ event, ...routeOf(event, ctx) }));
  if (all.length <= cap) return all.map(({ event, from, to }) => ({ key: String(event.seq), event, from, to, style: styleOf(event.kind), folded: 1 }));
  const keep = all.slice(all.length - (cap - 1)), rest = all.slice(0, all.length - (cap - 1));
  const merged = new Map<string, Packet>();
  for (const { event, from, to } of rest) {
    const id = `${from}>${to}`, have = merged.get(id);
    if (have) { have.folded += 1; have.event = event; have.key = `x${event.seq}`; }
    else merged.set(id, { key: `x${event.seq}`, event, from, to, style: styleOf(event.kind), folded: 1 });
  }
  // The merged packets together may not push the count over the cap: fold all of them into one if they would.
  const out = [...merged.values(), ...keep.map(({ event, from, to }) => ({ key: String(event.seq), event, from, to, style: styleOf(event.kind), folded: 1 }))];
  if (out.length <= cap) return out;
  const total = [...merged.values()].reduce((n, p) => n + p.folded, 0);
  return [{ key: `x${rest.at(-1)!.event.seq}`, event: rest.at(-1)!.event, from: "leader", to: "leader", style: UNKNOWN, folded: total }, ...keep.map(({ event, from, to }) => ({ key: String(event.seq), event, from, to, style: styleOf(event.kind), folded: 1 }))];
}

// ---- the object track ----
export const STATIONS = ["待派发", "队伍", "运行中", "待验收", "已验收", "已合并", "已发布"] as const;
/** One count per station, from the snapshot; null is "读不到" (the stream does not carry merges and releases today). */
export function stationCounts(board: WorkBoardSnapshot, closedInWindow: number | null): Array<{ station: (typeof STATIONS)[number]; count: number | null }> {
  const c = board.graph.counts;
  const n = (key: string) => typeof c[key] === "number" ? c[key]! : null;
  const queued = n("queued") === null || n("held") === null || n("claimed") === null ? null : n("queued")! + n("held")! + n("claimed")!;
  return [{ station: "待派发", count: board.readyNotQueued.length }, { station: "队伍", count: queued }, { station: "运行中", count: n("running") },
    { station: "待验收", count: n("pendingAcceptance") }, { station: "已验收", count: closedInWindow }, { station: "已合并", count: null }, { station: "已发布", count: null }];
}

/** Where the board is stuck, from the snapshot alone: held line entries, a closed recovery gate, a held provider, blocked packets. */
export function stuckSpots(board: WorkBoardSnapshot): Array<{ node: NodeId; text: string }> {
  const spots: Array<{ node: NodeId; text: string }> = [];
  for (const s of board.sessions) {
    if (s.health.recoveryGate !== "open") spots.push({ node: `session:${s.sessionId}`, text: `${s.roleTitle ?? s.roleId}：恢复门 ${s.health.recoveryGate}` });
    if (s.health.providerHeld) spots.push({ node: `session:${s.sessionId}`, text: `${s.roleTitle ?? s.roleId}：模型服务暂停` });
    for (const q of s.queue) if (q.state === "held") spots.push({ node: `session:${s.sessionId}`, text: `${q.taskTitle ?? q.taskId}：队伍项挂起${q.holdCode ? `（${q.holdCode}）` : ""}` });
  }
  for (const item of board.awaitingLeader) if (item.kind === "blocked_packet") spots.push({ node: "packets", text: "通知包受阻，等 Leader 恢复" });
  return spots;
}

/** Events up to and including `index` of the stream the replay is at; the canvas state is a function of this, not of what was animated. */
export const upTo = (events: SchedEvent[], index: number): SchedEvent[] => events.slice(0, Math.max(0, index + 1));
