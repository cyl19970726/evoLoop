import { TriangleAlert } from "lucide-react";
import type { RoutineHealth, RoutineHealthItem } from "@evoloop/contracts/routine-health";
import { Button, EmptyState, Notice as UiNotice, StatusTag, cn } from "@evoloop/ui";
import { isSampleTitle } from "../../shared/sampleObjects";
import { date } from "../../shared/ui/shared";
import { taskStateLabel } from "../workflow";
import { groupRoutines, lastTriggerView, needsAttention, nextText, overdueText, periodText, routineStateLabel, routineTime, warnsSkips } from "./routineHealth";
import { scheduleRuleText, scheduleTaskHref } from "./presentation";
import { timedTaskHref } from "./timedTasks";

const muted = "text-caption text-muted-foreground";
const stateTone = { active: "progress", paused: "idle", stopped: "history" } as const;
// One warning marker for both an overdue routine and skips in a row; no row background.
const Warn = () => <><TriangleAlert size={13} aria-hidden="true" className="mr-1 inline shrink-0 align-[-2px] text-warning" /><span className="sr-only">需要注意：</span></>;
// Wide: name | last trigger | skips in a row | next | state. Narrow: two lines (name, state / last trigger, skips, next).
const columns = "desktop:grid-cols-[minmax(0,2.2fr)_minmax(0,3fr)_5rem_minmax(0,1.3fr)_5rem]";

export interface RoutineHealthView { health: RoutineHealth | null; loading: boolean; error: string | null }

/** 例行健康: one table, one row per routine (a schedule or a timed Task), what to look at first on top. */
export function RoutineHealthTable({ view, projectId, actorId, onOpen, onRetry, now }: {
  view: RoutineHealthView; projectId: string; actorId: string; onOpen(scheduleId: string): void; onRetry(): void; now?: number;
}) {
  const { health } = view;
  const groups = health ? groupRoutines(health.items, isSampleTitle) : null;
  const row = (item: RoutineHealthItem) => {
    const last = lastTriggerView(item), overdue = overdueText(item);
    const schedule = item.kind === "schedule";
    const open = () => { if (schedule) onOpen(item.id); };
    const name = schedule
      ? <Button variant="link" onClick={open} className="min-w-0 max-w-[55%] shrink-0 justify-start truncate text-small font-medium text-foreground desktop:max-w-full">{item.title}</Button>
      : <a href={timedTaskHref(projectId, item.lastTrigger?.task?.taskId ?? item.rootTaskId ?? "", { rootTaskId: item.rootTaskId ?? "", title: item.title }, actorId)} className="min-w-0 max-w-[55%] shrink-0 truncate text-small font-medium text-foreground underline desktop:max-w-full">{item.title}</a>;
    const lastCell = overdue
      ? <><span data-cell="overdue" className="block truncate font-medium" title={last.kind === "none" ? overdue : `${overdue}；上次 ${last.full}`}><Warn />{overdue}</span>
        {last.kind !== "none" && <span className={cn(muted, "hidden truncate desktop:block")}>上次 {last.at} · {last.kind === "skipped" ? `跳过：${last.reason}` : last.task.title}</span>}</>
      : last.kind === "none" ? <span data-cell="last" className="text-muted-foreground">{last.text}</span>
      : last.kind === "skipped" ? <span data-cell="last" className="block truncate" title={`${last.full} · ${last.reason}`}><span className={muted}>{last.at}</span> 跳过：{last.reason}</span>
      : <span data-cell="last" className="flex min-w-0 items-baseline gap-1" title={last.full}>
          <span className={cn(muted, "shrink-0")}>{last.at}</span>
          <a href={scheduleTaskHref(projectId, last.task.taskId, { id: item.id, title: item.title }, actorId)} className="min-w-0 truncate text-foreground underline">{last.task.title}</a>
          <span className={cn(muted, "shrink-0")}>{last.queued ? "排队中" : taskStateLabel[last.task.state as keyof typeof taskStateLabel] ?? last.task.state}</span>
        </span>;
    return <li key={`${item.kind}:${item.id}`} data-routine={item.id} data-kind={item.kind} data-attention={needsAttention(item) ? "" : undefined}
      className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 border-t border-border py-2.5 first:border-t-0", columns, schedule && "cursor-pointer")}
      onClick={event => { if (!(event.target as HTMLElement).closest("a,button")) open(); }}>
      <div className="flex min-w-0 items-baseline gap-2 desktop:flex-col desktop:gap-0">
        {name}
        <span className={cn(muted, "min-w-0 truncate")}>{periodText(item, it => it.rule ? scheduleRuleText(it.rule, it.timezone, now) : "")}</span>
      </div>
      <div className="flex justify-end desktop:col-start-5 desktop:row-start-1 desktop:justify-start"><StatusTag tone={stateTone[item.state]} label={routineStateLabel[item.state]} /></div>
      <div className="min-w-0 text-small text-foreground desktop:col-start-2 desktop:row-start-1">{lastCell}</div>
      <div className="flex items-baseline justify-end gap-3 desktop:contents">
        <span data-cell="skips" className="text-small tabular-nums text-foreground desktop:col-start-3 desktop:row-start-1 empty:hidden desktop:empty:block">
          {item.consecutiveSkips > 0 && <>{warnsSkips(item) && <Warn />}连跳 {item.consecutiveSkips}</>}
          {item.kind === "timed_series" && item.skippedTotal ? <span className={muted}>累计漏过 {item.skippedTotal}</span> : null}
        </span>
        <span data-cell="next" className="text-small text-text-secondary desktop:col-start-4 desktop:row-start-1 desktop:text-foreground" title={item.nextAtUtc ? routineTime(item.nextAtUtc, item.timezone) : undefined}>
          {item.nextAtUtc && <span className={cn(muted, "desktop:hidden")}>下次 </span>}{item.state === "stopped" ? "—" : nextText(item)}</span>
      </div>
    </li>;
  };
  const list = (items: RoutineHealthItem[]) => items.length > 0 && <ul className="m-0 flex list-none flex-col p-0">{items.map(row)}</ul>;
  return <section aria-label="例行健康" data-routine-health="" className="flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-heading font-semibold text-foreground">例行健康{health ? ` · ${health.items.length}` : ""}</h2>
      {health && <span className={muted}>读于 {date(health.observedAt)}</span>}
    </div>
    {view.error && <UiNotice tone="error"><span>健康表读不到：{view.error}。左侧的日程列表与日程详情仍可使用。</span> <Button size="compact" variant="ghost" onClick={onRetry} disabled={view.loading}>重试</Button></UiNotice>}
    {!health && !view.error && <p className="text-small text-text-secondary">正在读取例行健康…</p>}
    {health && !health.complete && <UiNotice tone="waiting">定时任务读到上限，下面不含更多的定时任务；这不表示没有。</UiNotice>}
    {groups && health && health.items.length === 0 && <EmptyState title="还没有例行" reason="日程和定时任务建立后，会按需要先看的顺序列在这里。" />}
    {groups && groups.shown.length > 0 && <div aria-hidden="true" className={cn(muted, "hidden grid-cols-1 gap-x-3 border-b border-border pb-1 desktop:grid", columns)}>
      <span>例行</span><span className="desktop:col-start-2">上次触发</span><span className="desktop:col-start-3">连续跳过</span><span className="desktop:col-start-4">下次</span><span className="desktop:col-start-5">状态</span></div>}
    {groups && list(groups.shown)}
    {groups && groups.stopped.length > 0 && <details data-stopped-fold=""><summary className="cursor-pointer py-1.5 text-small text-muted-foreground">已停止 · {groups.stopped.length}</summary>{list(groups.stopped)}</details>}
    {groups && groups.samples.length > 0 && <details data-sample-fold=""><summary className="cursor-pointer py-1.5 text-small text-muted-foreground">测试与样本 · {groups.samples.length}（默认折叠）</summary>{list(groups.samples)}</details>}
  </section>;
}
