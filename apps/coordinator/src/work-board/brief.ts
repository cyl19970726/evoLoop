import type { WorkBoardSnapshot } from "@evoloop/contracts/work-board";

/** The most the brief may be: the Leader reads it every round (Task: not more than 6 KB). */
export const BRIEF_BYTE_LIMIT = 6 * 1024;
const cut = (value: string | null, n: number) => value === null ? null : value.length > n ? `${value.slice(0, n - 1)}…` : value;
// Full IDs: the Leader acts on them, and an 8-character prefix cannot be read back.
const short = (id: string) => id;

/**
 * What arranging work needs from the board, and nothing else: per Session the current work and the first queue items, counts of the
 * rest, what is ready but in no line, and what waits for the Leader. IDs are kept whole (the Leader acts on them); titles are cut and
 * fields that carry nothing in the usual case (state ready, gate open) are left out. If the result still exceeds the limit, the tails of the lists are dropped and said so.
 */
export function briefWorkBoard(board: WorkBoardSnapshot): Record<string, unknown> {
  const build = (queueItems: number, readyItems: number, leaderItems: number, sessionItems: number) => ({
    brief: true, observedAt: board.observedAt, eventSeq: board.eventSeq, counts: board.graph.counts,
    sessions: board.sessions.slice(0, sessionItems).map(s => ({
      id: short(s.sessionId), role: cut(s.roleTitle ?? s.roleId, 24), state: s.state === "ready" ? undefined : s.state,
      now: s.current ? { kind: s.current.kind, task: s.current.taskId ? short(s.current.taskId) : null, title: cut(s.current.taskTitle, 40), mins: s.current.elapsedSeconds === null ? null : Math.round(s.current.elapsedSeconds / 60) } : null,
      queue: s.queue.slice(0, queueItems).map(q => ({ task: short(q.taskId), title: cut(q.taskTitle, 40), pos: q.position, state: q.state === "queued" ? undefined : q.state, by: cut(q.source, 20), waitMins: Math.round(q.waitedSeconds / 60) })),
      more: s.queue.length > queueItems ? s.queue.length - queueItems : undefined,
      msgs: s.queuedMessages || undefined,
      gate: s.health.recoveryGate === "open" ? undefined : s.health.recoveryGate, held: s.health.providerHeld || undefined,
    })),
    sessionsOmitted: board.sessions.length > sessionItems ? board.sessions.length - sessionItems : undefined,
    ready: board.readyNotQueued.slice(0, readyItems).map(t => ({ task: short(t.taskId), title: cut(t.title, 40) })),
    readyMore: board.readyNotQueued.length > readyItems ? board.readyNotQueued.length - readyItems : undefined,
    leader: board.awaitingLeader.slice(0, leaderItems).map(i => ({ kind: i.kind, id: short(i.id), task: i.taskId ? short(i.taskId) : undefined, title: cut(i.title, 40), state: i.state })),
    leaderMore: board.awaitingLeader.length > leaderItems ? board.awaitingLeader.length - leaderItems : undefined,
    full: "work board (without --brief) has every field and the full IDs",
  });
  for (const [q, r, l, s] of [[5, 20, 20, 100], [3, 10, 10, 60], [2, 5, 5, 40], [1, 3, 3, 25], [0, 0, 3, 15]] as const) {
    const out = build(q, r, l, s);
    if (Buffer.byteLength(JSON.stringify(out), "utf8") <= BRIEF_BYTE_LIMIT) return out;
  }
  return build(0, 0, 0, 10);
}
