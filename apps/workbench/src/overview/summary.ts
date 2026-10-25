import type { Page, Task } from "@evoloop/contracts";
import type { ResidentQueue, ResidentQueueEntry } from "@evoloop/contracts/queues";

export interface SummaryItem { queue: ResidentQueue; entry: ResidentQueueEntry }
type SummaryCounts = { current: number; next: number; held: number };
export interface SummarySelection {
  current: SummaryItem[]; next: SummaryItem[]; held: SummaryItem[];
  total: SummaryCounts; omittedByKind: SummaryCounts; omitted: number;
}

export async function scanProjectTasks(
  projectId: string,
  read: (cursor?: string) => Promise<Page<Task>>,
  signal: AbortSignal,
  maxPages = 10,
): Promise<{ items: Task[]; truncated: boolean; pages: number }> {
  const items: Task[] = [];
  const ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 1; pages <= maxPages; pages++) {
    const result = await read(cursor);
    if (signal.aborted) throw new Error("读取已取消");
    if (!Array.isArray(result.items) || result.items.length > 50 || items.length + result.items.length > 500 ||
      result.items.some(task => task.projectId !== projectId || !task.id) ||
      result.nextCursor !== null && typeof result.nextCursor !== "string")
      throw new Error("任务分页响应与当前项目或读取上限不符");
    for (const task of result.items) {
      if (ids.has(task.id)) throw new Error("任务分页含重复对象，无法确认当前状态");
      ids.add(task.id); items.push(task);
    }
    if (!result.nextCursor) return { items, truncated: false, pages };
    if (result.nextCursor === cursor || cursors.has(result.nextCursor)) throw new Error("任务分页游标重复，无法确认当前状态");
    cursors.add(result.nextCursor);
    if (pages === maxPages || items.length === 500) return { items, truncated: true, pages };
    cursor = result.nextCursor;
  }
  throw new Error("任务分页超出读取上限");
}

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
  const categorized = {
    current: current.filter(item => !item.entry.holdCode),
    held,
    next: next.filter(item => !item.entry.holdCode),
  };
  const ordered = [...categorized.current, ...categorized.held, ...categorized.next];
  const unique = [...new Map(ordered.map(item => [item.entry.id, item])).values()];
  const shown = unique.slice(0, limit);
  const ids = new Set(shown.map(item => item.entry.id));
  const visible = {
    current: categorized.current.filter(item => ids.has(item.entry.id)),
    held: categorized.held.filter(item => ids.has(item.entry.id)),
    next: categorized.next.filter(item => ids.has(item.entry.id)),
  };
  const total = { current: categorized.current.length, held: categorized.held.length, next: categorized.next.length };
  return {
    ...visible,
    total,
    omittedByKind: {
      current: total.current - visible.current.length,
      held: total.held - visible.held.length,
      next: total.next - visible.next.length,
    },
    omitted: unique.length - shown.length,
  };
}

export function taskMatchesQueue(task: Task | undefined, entry: ResidentQueueEntry): boolean {
  return !!task && task.id === entry.taskId && task.projectId === entry.projectId &&
    task.currentRevisionId === entry.taskRevisionId && task.state === "in_progress" && task.owner === entry.roleId;
}
