// 定时任务 on 日程: the Tasks that carry their own execution time — a one-time time or a daily repeat (a stopped series
// included). The Task page stays the only place to change them; this page lists them and opens them. Pure, so the list
// wording and the way back are tested without a browser.
import type { TaskTimingSeriesSummary } from "../../shared/api";
import { withReturn } from "../../shared/returnLink";
import { readerZone } from "../../shared/zonedTime";
import { scheduleTime } from "./presentation";

/** The address of one timed Task on 日程 (`/schedules?timing=<首个 Task>`), which a link back from its task leads to. */
export function timingHref(projectId: string, rootTaskId: string): string {
  return `/p/${projectId}/schedules?${new URLSearchParams({ timing: rootTaskId })}`;
}

/** The timed Task an address on 日程 names, or null (another page, or none named). */
export function timingFromPath(path: string, projectId: string): string | null {
  const [pathname, query = ""] = path.split("?");
  if (pathname !== `/p/${projectId}/schedules`) return null;
  const params = new URLSearchParams(query);
  return params.getAll("timing").length === 1 ? params.get("timing") || null : null;
}

/** A task of the series, opened with the way back to this item on 日程 (“返回日程：<名称>”) for this reader. */
export function timedTaskHref(projectId: string, taskId: string, series: Pick<TaskTimingSeriesSummary, "rootTaskId" | "title">, actorId: string): string {
  return withReturn(`/p/${projectId}/tasks/${taskId}`, { href: timingHref(projectId, series.rootTaskId), actorId, title: series.title });
}

export const seriesKindText = (series: Pick<TaskTimingSeriesSummary, "repeat">): string => series.repeat === "daily" ? "每日重复" : "一次定时";
export const seriesStateText = (series: Pick<TaskTimingSeriesSummary, "seriesState">): string => series.seriesState === "stopped" ? "已停止" : "进行中";

/**
 * When it runs next, said in the Task's own zone with the reader's clock added when it differs. A stopped series has no
 * next time; a one-time Task has one only while it is still to start. Never reads as “没有”: it says why there is none.
 */
export function nextTimeText(series: TaskTimingSeriesSummary, now = Date.now(), reader = readerZone()): string {
  const at = (value: string) => scheduleTime(value, series.timezone, reader);
  if (series.seriesState === "stopped") return "已停止，不再复制后续时点";
  if (series.repeat === "daily") {
    // nextAtUtc is the slot after the latest planned one; while that Task is still todo and ahead, its own slot comes first.
    if (series.latestTask.state === "todo" && Date.parse(series.latestTask.plannedAtUtc) > now) return at(series.latestTask.plannedAtUtc);
    if (!series.nextAtUtc) return "下一时点尚未安排";
    return Date.parse(series.nextAtUtc) <= now ? `${at(series.nextAtUtc)}（已过，待协调器补上）` : at(series.nextAtUtc);
  }
  if (series.latestTask.state === "todo" && Date.parse(series.executeAtUtc) > now) return at(series.executeAtUtc);
  return `仅本次，无后续时点（约定 ${at(series.executeAtUtc)}）`;
}

/** What the series produced last: the Task and where it stands, never presented as run or accepted. */
export function latestTaskText(series: TaskTimingSeriesSummary, stateLabel: Record<string, string>): string {
  const { latestTask } = series;
  return `${latestTask.title} · ${stateLabel[latestTask.state] ?? latestTask.state}`;
}

/** The coordinator states in which a daily repeat does not copy by itself; the list says so instead of looking idle. */
export function copyBlockedByCoordinator(state: string | null | undefined): boolean {
  return !!state && ["disabled", "unavailable", "no-authority", "error", "stopped"].includes(state);
}
