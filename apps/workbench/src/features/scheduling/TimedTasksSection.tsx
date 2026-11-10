import { useEffect } from "react";
import { CalendarClock } from "lucide-react";
import { Button, EmptyState, Notice as UiNotice, cn } from "@evoloop/ui";
import type { MutationContext } from "../../shared/ActionForm";
import { api, type TaskTimingSeriesSummary } from "../../shared/api";
import { useProjectPages } from "../../shared/query";
import { date } from "../../shared/ui/shared";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { taskStateLabel } from "../workflow";
import type { SchedulingStatus } from "./client";
import { copyBlockedByCoordinator, latestTaskText, nextTimeText, seriesKindText, seriesStateText, timedTaskHref } from "./timedTasks";

const muted = "text-caption text-muted-foreground";

export interface TimedTasksReadView {
  items: TaskTimingSeriesSummary[]; loaded: boolean; error: string | null; hasMore: boolean; fetching: boolean; fetchingMore: boolean;
  pageFailed: boolean; readAt: string | null;
}

/** 定时任务: the Tasks with an execution time of their own, beside the schedule definitions. Changing one stays on its Task page. */
export function TimedTasksSection({ context, status, focus }: { context: MutationContext; status: SchedulingStatus | null; focus: string | null }) {
  const read = useProjectPages(context.projectId, ["task-timings"], (cursor, signal) => api(context.token).taskTimings(context.projectId, cursor, signal));
  const view: TimedTasksReadView = {
    items: read.data?.pages.flatMap(page => page.items) ?? [], loaded: read.data !== undefined,
    error: read.isError ? (read.error instanceof Error ? read.error.message : "暂时无法读取") : null,
    hasMore: !!read.hasNextPage, fetching: read.isFetching, fetchingMore: read.isFetchingNextPage, pageFailed: read.pageFailed,
    readAt: read.data ? new Date(read.dataUpdatedAt).toISOString() : null,
  };
  return <TimedTasksView view={view} projectId={context.projectId} actorId={context.principal.actorId} coordinator={status?.state ?? null} focus={focus}
    onRefresh={() => void read.refetch()} onMore={() => void read.fetchNextPage()} />;
}

export function TimedTasksView({ view, projectId, actorId, coordinator, focus, onRefresh, onMore, now }: {
  view: TimedTasksReadView; projectId: string; actorId: string; coordinator: string | null; focus: string | null;
  onRefresh(): void; onMore(): void; now?: number;
}) {
  const { items, loaded } = view;
  // A link back from a timed Task lands on its item.
  useEffect(() => {
    if (!focus || !items.some(item => item.rootTaskId === focus)) return;
    document.getElementById(`timing-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const copyBlocked = copyBlockedByCoordinator(coordinator) && items.some(item => item.repeat === "daily" && item.seriesState === "active");
  return <section aria-label="定时任务" className="flex flex-col gap-3 rounded-xl bg-raised p-4 shadow-sm compact:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-heading font-semibold text-foreground">定时任务{loaded ? ` · ${items.length}${view.hasMore ? "+" : ""}` : ""}</h2>
      <Button size="compact" variant="ghost" onClick={onRefresh} disabled={view.fetching}>{view.fetching ? "读取中…" : "重新读取"}</Button>
    </div>
    <p className={muted}>这里列出自己设了执行时间的任务：一次定时与每日重复（含已停止的系列）。修改仍在任务详情里做；列出不等于已执行，也不等于已验收。</p>
    {view.error && <UiNotice tone="error">定时任务本次没有读到：{view.error}。这不表示没有定时任务。{loaded ? "下面保留上次读回，待核对。" : ""}</UiNotice>}
    {copyBlocked && <UiNotice tone="error">协调器当前{coordinator === "disabled" ? "未启用" : coordinator === "no-authority" ? "没有可运行授权" : "不可用"}：进行中的每日重复不会自行复制出新任务。</UiNotice>}
    {!loaded && !view.error && <p className="text-small text-text-secondary">正在读取定时任务…</p>}
    {loaded && items.length === 0 && !view.error && <EmptyState title="本项目没有设了执行时间的任务" reason="在任务详情的“执行时间与重复”里设置后，会出现在这里。" />}
    {items.length > 0 && <ul className="flex flex-col">{items.map(item => <li key={item.seriesId} id={`timing-${item.rootTaskId}`}
      className={cn("flex flex-col gap-1 border-t border-border py-3 first:border-t-0", focus === item.rootTaskId && "rounded-lg px-3 outline outline-2 outline-offset-2 outline-foreground/30")}>
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock size={15} aria-hidden="true" className="text-muted-foreground" />
        <a href={timedTaskHref(projectId, item.latestTask.taskId, item, actorId)} className="text-small font-medium text-foreground underline">{item.title}</a>
        <span className="rounded-full bg-field px-2.5 py-0.5 text-caption text-muted-foreground">{seriesKindText(item)}</span>
        <span className={cn("rounded-full px-2.5 py-0.5 text-caption", item.seriesState === "stopped" ? "bg-field text-muted-foreground" : "bg-accent text-foreground")}>{seriesStateText(item)}</span>
      </div>
      <dl className="m-0 flex flex-col gap-0.5 text-small">
        <div className="flex flex-wrap gap-x-2"><dt className={muted}>下次时间</dt><dd className="m-0 text-foreground">{nextTimeText(item, now)}</dd></div>
        <div className="flex flex-wrap gap-x-2"><dt className={muted}>最近产生的任务</dt><dd className="m-0 text-foreground">{latestTaskText(item, taskStateLabel)}</dd></div>
        {item.occurrenceCount > 1 || item.skippedCount > 0 ? <div className="flex flex-wrap gap-x-2"><dt className={muted}>已产生</dt>
          <dd className="m-0 text-foreground">{item.occurrenceCount} 份{item.skippedCount > 0 ? `，漏过 ${item.skippedCount} 个时点` : ""}</dd></div> : null}
      </dl>
      {item.rootTaskId !== item.latestTask.taskId && <a href={timedTaskHref(projectId, item.rootTaskId, item, actorId)} className="w-fit text-caption text-foreground underline">打开首个任务</a>}
      <FullIdentifiers rows={[{ label: "系列", value: item.seriesId }, { label: "首个任务", value: item.rootTaskId }, { label: "最近任务", value: item.latestTask.taskId }]} />
    </li>)}</ul>}
    {view.hasMore && <Button className="w-fit" onClick={onMore} disabled={view.fetchingMore}>{view.fetchingMore ? "继续读取中…" : "加载更多定时任务"}</Button>}
    {view.pageFailed && <UiNotice tone="error">下一页没有读到，已显示的是已读部分。</UiNotice>}
    {view.readAt && <p className={muted}>读于 {date(view.readAt)}。</p>}
  </section>;
}
