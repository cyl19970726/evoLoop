// The compact task list in the inner rail (docs/frontend/pages/tasks.md 布局 › 左栏): scope, search, state and kind
// filters and the sort on top; one row per task with its title and status. Rows open the task in the center.
import React from "react";
import type { Task } from "@evoloop/contracts";
import { RefreshCw } from "lucide-react";
import { Button, CollapsibleRow, EmptyState, ErrorState, IconButton, Input, ListRow, LoadingState, Notice, RefreshingIndicator, Select, StatusTag, cn } from "@evoloop/ui";
import { rowStatus } from "../../shared/taskStatus";
import { cognitionSummary } from "../../shared/workStatusPresentation";
import { taskSorts, type TaskListView } from "./taskExperience";
import { kindFilterLabels, rowMeta, sortLabels, stateFilterLabels } from "./taskListModel";
import type { TaskListRead } from "./useTaskList";

export function TaskListNotices({ list, query = "", compact = false }: { list: TaskListRead; query?: string; compact?: boolean }) {
  const line = compact ? "text-caption" : "text-label";
  return <>
    {list.statusProblem && <Notice tone="waiting" data-status-warning="" className={cn(compact && "px-3 py-2")}
      title={list.statusProblem.kind === "partial" ? "部分任务的工作进度尚未读回，已加载任务仍可查看。" : "工作进度暂时无法读取，已加载任务仍可查看。"}
      action={<Button size="compact" disabled={list.statusRetrying} onClick={() => void list.retryStatuses()}>{list.statusRetrying ? "正在重试…" : "重试读取工作进度"}</Button>}>
      <details className="text-caption"><summary className="cursor-pointer">查看诊断信息</summary><code className="break-all">{list.statusProblem.diagnostic}</code></details>
    </Notice>}
    {list.awaitingAssignments && <p role="status" className={cn(line, "text-muted-foreground")}>我的承接信息尚未读全，当前结果不完整。</p>}
    {list.searching && !list.searchError && <p role="status" className={cn(line, "text-muted-foreground")}>{query ? "正在搜索后续页面；结果尚未完整。" : "正在读取后续页面中的匹配任务…"}</p>}
    {list.searchError && <Notice tone="error" className={cn(compact && "px-3 py-2")}>搜索未完成：{list.searchError}。当前结果只覆盖已载入的任务。</Notice>}
  </>;
}

/** Why the visible list is empty: never "no tasks" while unread pages remain or the project has tasks. */
export function emptyListText(list: TaskListRead, view: TaskListView): { title: string; reason: string } {
  if (list.hasMore) return { title: "已载入范围内没有匹配任务", reason: "仍有后续页面，可继续载入或搜索全部已读取范围。" };
  const filtered = !!view.query || view.filter !== "open" || view.kind !== "all" || view.scope !== "all";
  if (list.tasks.length || filtered) return { title: "没有匹配项", reason: "可以调整筛选，查看其他状态的工作。" };
  return { title: "还没有任务", reason: "可以创建一项有明确正文与验收条件的工作，或请智能体登记。" };
}

export function TaskRail({ list, view, onView, selectedId, linkFor }: {
  list: TaskListRead; view: TaskListView; onView(next: Partial<TaskListView>): void;
  selectedId: string | null; linkFor(taskId: string): string;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  // Keep the selected row in sight when a task opens from elsewhere (a link, the table, back navigation).
  // Only the rail's own scroll container moves; the page keeps its reading position (Back restores it).
  React.useEffect(() => {
    if (!selectedId) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selectedId)}"]`);
    let box = row?.parentElement ?? null;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (!row || !box || box === document.documentElement || box === document.body) return;
    const rowRect = row.getBoundingClientRect(), boxRect = box.getBoundingClientRect();
    if (rowRect.top < boxRect.top) box.scrollTop -= boxRect.top - rowRect.top + 8;
    else if (rowRect.bottom > boxRect.bottom) box.scrollTop += rowRect.bottom - boxRect.bottom + 8;
  }, [selectedId, list.visible.length]);
  const sorted = view.sort !== "default";
  const row = (task: Task, title = task.title) => {
    const projection = list.projections[task.id];
    const status = rowStatus(task.state, projection && projection.taskId === task.id && projection.version === task.version ? projection.phase : null);
    return <li key={task.id} data-task-id={task.id}>
      <ListRow href={linkFor(task.id)} selected={task.id === selectedId} title={<span title={title}>{title}</span>}
        meta={rowMeta(task, view.sort, projection)} trailing={<StatusTag tone={status.tone} label={status.label} />} />
    </li>;
  };
  const { primary, unknown, cognition, primaryKind } = list.groups;
  const empty = !list.loading && !list.firstError && !list.searching && !list.awaitingAssignments && !list.searchError && !list.visible.length;
  return <section aria-label="任务列表" className="flex flex-col gap-2 pb-2" data-task-rail="">
    <div className="flex items-center gap-1 px-1">
      <h2 className="flex-1 text-label font-semibold text-foreground">任务列表</h2>
      {list.checking && <RefreshingIndicator label="正在核对" />}
      <IconButton compact label="重新读取列表" icon={<RefreshCw size={15} />} onClick={list.reread} />
    </div>
    <Input type="search" aria-label="搜索任务" placeholder="搜索标题或负责职责…" value={view.query} onChange={event => onView({ query: event.target.value })} className="h-8 text-label" />
    <div role="group" aria-label="任务范围" className="flex gap-1">
      {(["all", "mine"] as const).map(scope => <Button key={scope} size="compact" variant={view.scope === scope ? "secondary" : "ghost"} aria-pressed={view.scope === scope}
        className={cn("flex-1", view.scope === scope && "bg-selected")} onClick={() => onView({ scope })}>
        {scope === "all" ? "全部工作" : "我的承接"}{scope === "mine" && list.mineCount > 0 && <span className="tabular-nums text-muted-foreground">{list.mineCount}</span>}
      </Button>)}
    </div>
    <div className="grid grid-cols-2 gap-1.5">
      <Select compact aria-label="任务状态筛选" value={view.filter} onChange={event => onView({ filter: event.target.value })}>
        {Object.entries(stateFilterLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      <Select compact aria-label="任务类型筛选" value={view.kind} onChange={event => onView({ kind: event.target.value })}>
        {Object.entries(kindFilterLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
    </div>
    <Select compact aria-label="任务排序" value={view.sort} onChange={event => onView({ sort: event.target.value as TaskListView["sort"] })}>
      {taskSorts.map(sort => <option key={sort} value={sort}>排序：{sortLabels[sort]}</option>)}
    </Select>
    {sorted && <p className="px-1 text-caption text-muted-foreground" data-sort-scope="">
      按{sortLabels[view.sort]}排序只作用于已载入的 {list.tasks.length} 项{list.hasMore ? "，后续页尚未载入" : ""}；没有这项数据的任务排在最后。</p>}
    <TaskListNotices list={list} query={view.query.trim()} compact />
    {selectedId && !list.loading && list.tasks.some(task => task.id === selectedId) && !list.visible.some(task => task.id === selectedId) &&
      <p className="px-1 text-caption text-muted-foreground">打开的任务不在当前筛选结果中。</p>}
    <div ref={listRef} className="flex flex-col gap-1">
      {list.loading && <LoadingState lines={4} label="正在读取任务列表" />}
      {list.firstError && <ErrorState title="任务列表读取失败" happened={list.firstError} next="可以重新读取；读取失败不代表没有任务。"
        action={<Button size="compact" onClick={list.reread}>重新读取</Button>} />}
      {primary.length > 0 && <ul aria-label={primaryKind === "unclassified" ? "已载入任务" : "业务工作"} className="flex flex-col gap-0.5">{primary.map(task => row(task))}</ul>}
      {unknown.length > 0 && <div className="mt-2 flex flex-col gap-0.5">
        <h3 className="px-3 text-caption font-medium text-muted-foreground">来源与状态待核对 · {unknown.length}</h3>
        <ul className="flex flex-col gap-0.5">{unknown.map(task => row(task))}</ul>
      </div>}
      {cognition.length > 0 && <CollapsibleRow className="mt-2 px-3" summary={`判断与接续记录 · ${cognition.length}`}>
        <ul className="-ml-[18px] -mr-3 flex flex-col gap-0.5">{cognition.map(task => row(task, list.statuses[task.id] ? cognitionSummary(list.statuses[task.id]!).title : task.title))}</ul>
      </CollapsibleRow>}
      {empty && <EmptyState className="px-4 py-3" {...emptyListText(list, view)}
        action={<Button size="compact" onClick={() => onView({ query: "", filter: "open", kind: "all", scope: "all" })}>清除筛选</Button>} />}
    </div>
    {!list.loading && !list.firstError && <div className="flex items-center gap-2 px-1 text-caption text-muted-foreground">
      <span className="flex-1">已载入 {list.tasks.length} 项 · 匹配 {list.visible.length} 项</span>
      {list.hasMore && <Button size="compact" variant="ghost" disabled={list.loadingMore || list.searching} onClick={() => void list.loadMore()}>{list.loadingMore ? "加载中…" : "加载更多"}</Button>}
    </div>}
  </section>;
}
