import type { Task } from "@evoloop/contracts";
import type { ResidentQueue, ResidentQueueEntry } from "@evoloop/contracts/queues";

export interface SummaryItem { queue: ResidentQueue; entry: ResidentQueueEntry }
export interface SummarySelection { current: SummaryItem[]; next: SummaryItem[]; held: SummaryItem[]; omitted: number }

/** Queue claims are occupancy evidence; only the Task itself can confirm its current revision. */
export function selectSummary(queues: ResidentQueue[], limit = 12): SummarySelection {
  const current: SummaryItem[] = [], next: SummaryItem[] = [], held: SummaryItem[] = [];
  for (const queue of queues) {
    const bySession = new Map<string, ResidentQueueEntry[]>();
    for (const entry of queue.entries) bySession.set(entry.sessionId, [...(bySession.get(entry.sessionId) ?? []), entry]);
    for (const entries of bySession.values()) {
      const ordered = [...entries].sort((a, b) => a.position - b.position);
      const claim = ordered.find(entry => entry.state === "claimed");
      if (claim) current.push({ queue, entry: claim });
      const first = ordered.find(entry => entry.state !== "released" && entry.state !== "claimed");
      if (first?.state === "queued" && queue.adoptedVersion === queue.version) next.push({ queue, entry: first });
      for (const entry of ordered) if (entry.state === "held" || entry.holdCode) held.push({ queue, entry });
    }
  }
  const ordered = [...current, ...held, ...next];
  const unique = [...new Map(ordered.map(item => [item.entry.id, item])).values()];
  const shown = unique.slice(0, limit);
  const ids = new Set(shown.map(item => item.entry.id));
  return {
    current: current.filter(item => ids.has(item.entry.id) && !item.entry.holdCode),
    next: next.filter(item => ids.has(item.entry.id) && !item.entry.holdCode),
    held: held.filter(item => ids.has(item.entry.id)),
    omitted: unique.length - shown.length,
  };
}

export function taskMatchesQueue(task: Task | undefined, entry: ResidentQueueEntry): boolean {
  return !!task && task.id === entry.taskId && task.projectId === entry.projectId &&
    task.currentRevisionId === entry.taskRevisionId && task.state === "in_progress" && task.owner === entry.roleId;
}
