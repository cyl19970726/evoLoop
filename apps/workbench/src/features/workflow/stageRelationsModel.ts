// What the stage relation bar says, as pure functions over what 目标与阶段 already read (the stage projection and the work index).
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";

const dayNumber = (day: string): number => { const [year, month, date] = day.split("-").map(Number); return Date.UTC(year!, month! - 1, date!) / 86_400_000; };

/** "11-28到期 · 还有 5 天" / "已过 2 天" / "今天"; no due date is not set, not guessed. `today` is the projection's own day in the reader's zone. */
export function dueText(dueOn: string | null, today: string): string | null {
  if (!dueOn || !/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const days = dayNumber(dueOn) - dayNumber(today);
  return `${dueOn.slice(5)}到期 · ${days > 0 ? `还有 ${days} 天` : days === 0 ? "就是今天" : `已过 ${-days} 天`}`;
}

/** Only tasks that are not closed: those with a delivery nobody answered yet, and those whose use failed. */
export function deliveryCounts(tasks: readonly LeaderWorkTask[]): { waiting: number; failed: number } {
  const open = tasks.filter(task => task.taskState === "todo" || task.taskState === "in_progress");
  return {
    waiting: open.filter(task => task.delivery && task.delivery.observationResult === null).length,
    failed: open.filter(task => task.delivery?.observationResult === "failed").length,
  };
}
