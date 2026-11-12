import type { SchedEvent, WorkBoardMetrics } from "@evoloop/contracts/work-board";

const seconds = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000);
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! * 10) / 10;
}
const median = (values: number[]) => percentile(values, 0.5);

/**
 * The three scheduling measures, from the event stream alone (events in seq order, as read). Whatever started before the first event given is
 * not seen: an object whose start is outside the window is left out, never guessed.
 *  - queueWait: task.queued -> task.turn of the same queue entry, grouped by who added it (the event's `from`).
 *  - sessionIdle: per Session, the time with nothing running while something waited (a queue entry, a queued message), over the window.
 *  - noticeIntake: notice.created -> the first of notice.delivered / notice.seen of its packet (found through notice.packed, whose `to` is the
 *    packet), or notice.sent of the notice itself when it never travelled in a packet.
 */
export function computeBoardMetrics(events: SchedEvent[], from: string, to: string): WorkBoardMetrics {
  // queue wait
  const queuedAt = new Map<string, { at: string; source: string }>();
  const bySource = new Map<string, number[]>();
  for (const e of events) {
    if (e.kind === "task.queued") queuedAt.set(e.subject.id, { at: e.at, source: e.from ?? "unknown" });
    else if (e.kind === "task.turn") {
      const q = queuedAt.get(e.subject.id);
      if (q) { (bySource.get(q.source) ?? bySource.set(q.source, []).get(q.source)!).push(seconds(q.at, e.at)); queuedAt.delete(e.subject.id); }
    }
  }
  const queueWait = [...bySource].sort(([a], [b]) => a.localeCompare(b)).map(([source, values]) =>
    ({ source, count: values.length, medianSeconds: median(values), p95Seconds: percentile(values, 0.95) }));

  // Session idle with work waiting
  const busyStart = new Set(["task.run_requested", "message.processing"]);
  const busyEnd = new Set(["task.run_ended", "message.replied", "message.completed_without_reply", "message.failed", "message.cancelled"]);
  const waitStart = new Set(["task.queued", "message.queued"]);
  const waitEnd = new Set(["task.turn", "task.released", "message.processing", "message.cancelled"]);
  const state = new Map<string, { busy: Set<string>; waiting: Set<string>; since: string; idle: number }>();
  for (const e of events) {
    if (!e.sessionId) continue;
    const isBusy = busyStart.has(e.kind) || busyEnd.has(e.kind), isWait = waitStart.has(e.kind) || waitEnd.has(e.kind);
    if (!isBusy && !isWait) continue;
    const s = state.get(e.sessionId) ?? state.set(e.sessionId, { busy: new Set(), waiting: new Set(), since: e.at, idle: 0 }).get(e.sessionId)!;
    if (!s.busy.size && s.waiting.size) s.idle += seconds(s.since, e.at);
    s.since = e.at;
    if (busyStart.has(e.kind)) s.busy.add(e.subject.id); else if (busyEnd.has(e.kind)) s.busy.delete(e.subject.id);
    if (waitStart.has(e.kind)) s.waiting.add(e.subject.id); else if (waitEnd.has(e.kind)) s.waiting.delete(e.subject.id);
  }
  const windowSeconds = seconds(from, to);
  const sessionIdle = [...state].sort(([a], [b]) => a.localeCompare(b)).map(([sessionId, s]) => {
    // Still idle with work at the end of the window.
    const open = !s.busy.size && s.waiting.size ? seconds(s.since, to) : 0;
    return { sessionId, idleWithWorkSeconds: Math.round((s.idle + open) * 10) / 10, windowSeconds };
  });

  // notice intake
  const created = new Map<string, string>(), packetOf = new Map<string, string>();
  const firstRead = new Map<string, string>(), sentLegacy = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "notice.created") created.set(e.subject.id, e.at);
    else if (e.kind === "notice.packed" && e.to) packetOf.set(e.subject.id, e.to);
    else if ((e.kind === "notice.delivered" || e.kind === "notice.seen") && !firstRead.has(e.subject.id)) firstRead.set(e.subject.id, e.at);
    else if (e.kind === "notice.sent") { if (!sentLegacy.has(e.subject.id)) sentLegacy.set(e.subject.id, e.at); }
  }
  const intake: number[] = [];
  for (const [noticeId, at] of created) {
    const packet = packetOf.get(noticeId);
    const end = packet ? firstRead.get(packet) ?? sentLegacy.get(packet) : sentLegacy.get(noticeId);
    if (end) intake.push(seconds(at, end));
  }
  return { from, to, events: events.length, queueWait, sessionIdle,
    noticeIntake: { count: intake.length, medianSeconds: median(intake), p95Seconds: percentile(intake, 0.95) } };
}
