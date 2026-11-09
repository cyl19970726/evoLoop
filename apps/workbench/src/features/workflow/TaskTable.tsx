// 表格视图 (tasks.md 表格视图（Leader 对账）): the same list as the inner rail, as six columns for scanning and
// reconciliation. Selecting a row shows its facts in the right column without leaving the table; the open link
// goes to the task. The table scrolls sideways in its own region; the page never does.
import React from "react";
import { useQueries } from "@tanstack/react-query";
import type { Task, TaskAttentionItem } from "@evoloop/contracts";
import { ArrowUpRight, Columns3, RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, IconButton, LoadingState, StatusTag, cn } from "@evoloop/ui";
import { ApiError, api, errorText, request } from "../../shared/api";
import { isRoleOwnerId, readOwnerRole } from "../../shared/ownerRole";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { rowStatus, taskStateStatus } from "../../shared/taskStatus";
import { timingDate, timingDuration, timingStageLabel } from "../../shared/taskTiming";
import { cognitionSummary, businessNextStep } from "../../shared/workStatusPresentation";
import { waitingText, workNextStep } from "../../shared/workPresentation";
import { href } from "../../shared/ui/shared";
import { sessionHref } from "../sessions";
import { PhaseCounts, ReconciliationDetails, useAgentNames } from "./TaskReconciliation";
import { emptyListText, TaskListNotices } from "./TaskRail";
import { assignmentSessionKey, assignmentStatusLabel, isClosedTask, matchingProjection, type TaskListView } from "./taskExperience";
import { legacyDecisionLabel, taskNextStep } from "./taskListPresentation";
import { formatScheduled, nextTimingLabel, repeatLabel } from "./taskTimingPresentation";
import { latestProgressPresentation, taskType } from "./taskWorkspacePresentation";
import type { TaskListRead } from "./useTaskList";

type OptionalColumn = "responsibility" | "nextAction" | "delivery" | "revision";
const optionalColumns: { id: OptionalColumn; label: string }[] = [
  { id: "responsibility", label: "负责职责" }, { id: "nextAction", label: "下一动作" }, { id: "delivery", label: "固定成果" }, { id: "revision", label: "任务版本" },
];
const columnsKey = "evoloop:task-columns";

function readColumns(): Record<OptionalColumn, boolean> {
  const none = { responsibility: false, nextAction: false, delivery: false, revision: false };
  try { return { ...none, ...JSON.parse(localStorage.getItem(columnsKey) ?? "{}") as Partial<Record<OptionalColumn, boolean>> }; }
  catch { return none; }
}

/** Open attention items, read up to five pages; an incomplete read is said, never treated as "nothing to see". */
async function readAttention(projectId: string) {
  const items: TaskAttentionItem[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const path = `/api/projects/${encodeURIComponent(projectId)}/task-attention/items?state=open&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const result: { items: TaskAttentionItem[]; nextCursor: string | null } = await request("", path, 15000);
    if (!Array.isArray(result.items) || result.items.some(item => item.state !== "open")) throw new Error("关注列表响应无效");
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
    if (seen.has(cursor)) throw new Error("关注列表分页游标重复");
    seen.add(cursor);
  }
  return { items, complete: !cursor };
}

export function TaskTable({ projectId, list, view, selectedId, onSelect, linkFor }: {
  projectId: string; list: TaskListRead; view: TaskListView; selectedId: string | null; onSelect(taskId: string): void;
  linkFor(taskId: string, tab?: string): string;
}) {
  const [columns, setColumns] = React.useState(readColumns);
  React.useEffect(() => { try { localStorage.setItem(columnsKey, JSON.stringify(columns)); } catch { /* a display preference */ } }, [columns]);
  const rows = list.visible;
  const owners = [...new Set(rows.map(task => task.owner).filter(isRoleOwnerId))];
  const ownerReads = useQueries({ queries: owners.map(owner => ({
    queryKey: queryKeys.project(projectId, "roles", owner),
    queryFn: ({ signal }: { signal: AbortSignal }) => readOwnerRole("", projectId, owner, signal), retry: false,
  })) });
  // A failed reread shows the failure, never the name from before it.
  const ownerNames = Object.fromEntries(owners.map((owner, index) => {
    const read = ownerReads[index]!;
    return [owner, read.error ? { error: read.error instanceof ApiError && read.error.status === 404 ? "未找到已登记职责" : `职责暂不可核对：${errorText(read.error)}` }
      : read.isFetching ? { pending: true, title: undefined } : read.data ? { title: read.data.proposal.title.trim() } : { pending: true }];
  })) as Record<string, { title?: string; error?: string; pending?: boolean }>;
  const agentKeys = rows.map(task => { const item = matchingProjection(task, list.projections[task.id]); return item ? assignmentSessionKey(item) : null; }).filter((key): key is string => !!key);
  const agents = useAgentNames(projectId, agentKeys);
  const attention = useProjectQuery(projectId, ["tasks", "attention"], () => readAttention(projectId));
  // Execution times are one read per row: at most four run at once, as the old list read them.
  const [timingLimit, setTimingLimit] = React.useState(4);
  const timings = useQueries({ queries: rows.map((task, index) => ({
    queryKey: queryKeys.project(projectId, "tasks", "timing", task.id),
    queryFn: () => api().taskTiming(projectId, task.id), retry: false, enabled: index < timingLimit,
  })) });
  const timingsSettled = timings.filter(read => read.isSuccess || read.isError).length;
  React.useEffect(() => { setTimingLimit(timingsSettled + 4); }, [timingsSettled]);
  // Business work first; rows whose source is unread, and judgement records, are kept apart (never mixed in).
  const groups = [
    { id: list.groups.primaryKind === "unclassified" ? "unclassified" : "business", label: list.groups.primaryKind === "unclassified" ? "已载入任务 · 状态分类暂不可用" : "", note: "", tasks: list.groups.primary },
    { id: "unknown", label: "来源与状态待核对", note: "状态投影未读全，暂不把这些任务归为业务或判断记录。", tasks: list.groups.unknown },
    { id: "cognition", label: "判断与接续记录", note: "由正式认知派发关联；这里的本轮结果不改写任务状态。", tasks: list.groups.cognition },
  ];
  const roleNames = Object.fromEntries(Object.entries(ownerNames).map(([id, value]) => [id, value.title]));
  return <div className="flex flex-col gap-4">
    <PhaseCounts counts={list.index.first?.counts} />
    <TaskListNotices list={list} query={view.query.trim()} />
    {attention.error && <p role="status" className="text-caption text-muted-foreground">关注项暂不可读：{errorText(attention.error)}</p>}
    {attention.data && !attention.data.complete && <p role="status" className="text-caption text-muted-foreground">关注项超过当前已读范围；未显示的任务仍需打开核对。</p>}
    <div className="flex items-center gap-2">
      <p className="flex-1 text-caption text-muted-foreground">{list.loading ? "正在核对当前列表…" : list.observedAt ? `列表读于 ${list.observedAt.toLocaleString("zh-CN")}；回到窗口时自动重读。` : "列表尚未读回。"}</p>
      <IconButton compact label="重新读取列表" icon={<RefreshCw size={15} />} onClick={list.reread} />
      <details className="relative">
        <summary aria-label="列设置" className="flex cursor-pointer list-none items-center gap-1.5 rounded-full px-3 py-1 text-label text-text-secondary hover:bg-field [&::-webkit-details-marker]:hidden"><Columns3 size={15} aria-hidden="true" />列设置</summary>
        <fieldset className="absolute right-0 z-10 mt-1 flex w-44 flex-col gap-1.5 rounded-lg bg-raised p-3 shadow-md">
          <legend className="mb-1 text-caption text-muted-foreground">附加列</legend>
          {optionalColumns.map(column => <label key={column.id} className="flex items-center gap-2 text-label">
            <input type="checkbox" className="accent-[var(--brand)]" checked={columns[column.id]} onChange={event => setColumns(current => ({ ...current, [column.id]: event.target.checked }))} />{column.label}</label>)}
        </fieldset>
      </details>
    </div>
    {list.loading && <LoadingState lines={5} label="正在读取任务" />}
    {list.firstError && <ErrorState title="任务列表读取失败" happened={list.firstError} next="可以重新读取；读取失败不代表没有任务。" action={<Button size="compact" onClick={list.reread}>重新读取</Button>} />}
    {!list.loading && !list.firstError && rows.length > 0 && <div role="region" tabIndex={0} aria-label="任务表格，可横向滚动查看六列和附加列"
      className="-mx-1 overflow-x-auto px-1 outline-none focus-visible:shadow-[var(--focus-ring)]" data-task-table="">
      <table className="w-full min-w-[960px] table-fixed text-left text-label">
        <colgroup><col className="w-[30%]" /><col className="w-[8%]" /><col className="w-[15%]" /><col className="w-[17%]" /><col className="w-[13%]" /><col className="w-[17%]" />
          {optionalColumns.filter(column => columns[column.id]).map(column => <col key={column.id} className="w-[14%]" />)}</colgroup>
        <thead><tr className="border-b border-border text-caption text-muted-foreground">
          {["任务", "工作类型", "当前进展", "承接者", "创建时间", "最近进展"].map(label => <th key={label} scope="col" className="px-2 py-2 font-medium">{label}</th>)}
          {optionalColumns.filter(column => columns[column.id]).map(column => <th key={column.id} scope="col" className="px-2 py-2 font-medium">{column.label}</th>)}
        </tr></thead>
        {groups.map(group => group.tasks.length > 0 && <tbody key={group.id} data-group={group.id}>
          {group.label && <tr><th colSpan={6 + optionalColumns.filter(column => columns[column.id]).length} scope="colgroup" className="px-2 pb-1.5 pt-4 text-left text-caption font-medium text-muted-foreground">
            {group.label} · {group.tasks.length} 项已载入{group.note && <span className="ml-2 font-normal">{group.note}</span>}</th></tr>}
          {group.tasks.map(task => <TableRow key={task.id} task={task} list={list} projectId={projectId}
            selected={task.id === selectedId} onSelect={onSelect} linkFor={linkFor} columns={columns} owner={ownerNames[task.owner]}
            agents={agents} attention={attention.data?.items ?? []} timing={timings[rows.indexOf(task)]} />)}
        </tbody>)}
      </table>
    </div>}
    {!list.loading && !list.firstError && !rows.length && !list.searching && !list.awaitingAssignments && !list.searchError &&
      <EmptyState {...emptyListText(list, view)} />}
    {!list.loading && !list.firstError && <div className="flex items-center gap-3 text-caption text-muted-foreground">
      <span className="flex-1">已载入 {list.tasks.length} 项 · 匹配 {rows.length} 项</span>
      {list.hasMore && <Button size="compact" disabled={list.loadingMore || list.searching} onClick={() => void list.loadMore()}>{list.loadingMore || list.searching ? "加载中…" : "加载更多"}</Button>}
    </div>}
    <ReconciliationDetails projectId={projectId} page={list.index.first ? { ...list.index.first, items: Object.values(list.index.items) } : null}
      statuses={list.statuses} roleNames={roleNames} error={list.index.error} />
  </div>;
}

function TableRow({ task, list, projectId, selected, onSelect, linkFor, columns, owner, agents, attention, timing }: {
  task: Task; list: TaskListRead; projectId: string; selected: boolean; onSelect(id: string): void; linkFor(taskId: string, tab?: string): string;
  columns: Record<OptionalColumn, boolean>; owner: { title?: string; error?: string; pending?: boolean } | undefined;
  agents: Record<string, { name: string | null; problem: string | null }>; attention: TaskAttentionItem[];
  timing: { data?: Awaited<ReturnType<ReturnType<typeof api>["taskTiming"]>>; error: unknown } | undefined;
}) {
  const status = list.statuses[task.id];
  const cognition = status?.cognition ? cognitionSummary(status) : null;
  const projection = matchingProjection(task, list.projections[task.id]);
  const closed = isClosedTask(task.state);
  const shown = cognition ? { tone: "unknown" as const, label: cognition.phase } : rowStatus(task.state, projection?.phase);
  const key = projection ? assignmentSessionKey(projection) : null;
  const progress = latestProgressPresentation(projection);
  const next = cognition?.next ?? (projection ? workNextStep(projection.phase) : null) ?? (status && businessNextStep(task, status)) ?? taskNextStep(task.state, task.legacyDecision);
  const attentionCount = attention.filter(item => item.taskId === task.id && item.taskRevisionId === task.currentRevisionId).length;
  const title = cognition?.title ?? task.title;
  const scheduled = timing?.data;
  const latestSeries = scheduled?.occurrences.at(-1);
  const latestDone = scheduled?.occurrences.slice().reverse().find(item => item.state === "done");
  const pending = task.id && (projection?.pendingImpactCount ?? 0) > 0;
  const cell = "px-2 py-2.5 align-top";
  return <tr className={cn("border-b border-border", selected ? "bg-selected" : "hover:bg-field/50")} data-task-row={task.id}>
    <td className={cell}>
      <div className="flex items-start gap-1">
        <button type="button" aria-pressed={selected} onClick={() => onSelect(task.id)} className="min-w-0 flex-1 text-left font-medium text-foreground hover:underline">{title}</button>
        <a href={linkFor(task.id)} aria-label={`打开任务：${task.title}`} title="打开任务" className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-field hover:text-foreground"><ArrowUpRight size={15} aria-hidden="true" /></a>
      </div>
      <div className="mt-0.5 flex flex-col gap-0.5 text-caption text-muted-foreground">
        {pending && <span className="text-warning">依据待复核</span>}
        {cognition && <span>判断与接续记录 · <a className="text-primary hover:underline" href={href(projectId, "task", task.id)}>查看来源</a></span>}
        {!cognition && task.legacyDecision && <span>{legacyDecisionLabel(task.legacyDecision)}</span>}
        {attentionCount > 0 && <a className="text-primary hover:underline" href={`${linkFor(task.id, "overview")}&section=attention`}>{attentionCount} 项待关注</a>}
        {scheduled && <span>约定执行 {formatScheduled(scheduled.executeAtUtc, scheduled.timezone)} · {repeatLabel(scheduled.repeat)} · {nextTimingLabel(scheduled)}</span>}
        {scheduled?.repeat === "daily" && <span>同系列最近 {scheduled.occurrences.length} 份{latestSeries && <> · 最新 <a className="text-primary hover:underline" href={href(projectId, "task", latestSeries.taskId)}>{taskStateStatus[latestSeries.state].label}任务</a></>}{latestDone ? <> · <a className="text-primary hover:underline" href={href(projectId, "task", latestDone.taskId)}>最近已完成的结果</a></> : " · 尚无已完成结果"}</span>}
        {!!timing?.error && <span title={errorText(timing.error)}>执行时间暂未读回</span>}
      </div>
    </td>
    <td className={cell}>{taskType(projection?.taskKind ?? task.kind)}</td>
    <td className={cell}>
      <StatusTag tone={shown.tone} label={shown.label} />
      {(cognition || projection && !closed && rowStatus(task.state, projection.phase).label !== taskStateStatus[task.state].label) && <span className="mt-1 block text-caption text-muted-foreground">任务{taskStateStatus[task.state].label}</span>}
      {projection?.timing && <span className="mt-0.5 block text-caption text-muted-foreground" data-stage-time="">{timingStageLabel[projection.timing.current.stage] ?? "阶段未知"} · 本阶段 {timingDuration(projection.timing.current.elapsedMs)} · {waitingText(projection.timing.current.waitingFor, projection.assignment)}</span>}
    </td>
    <td className={cell} data-owner-cell="">
      {key ? <><a className="text-primary hover:underline" href={sessionHref(projectId, key)}>{agents[key]?.name ?? (agents[key]?.problem ? "未登记名称的智能体" : "正在读取名称…")}</a>
        <span className="mt-0.5 block text-caption text-muted-foreground">{assignmentStatusLabel(projection!)}</span></>
        : <><span className="text-text-secondary">{!projection ? "承接尚未读回" : closed ? "无当前分派" : "待具体承接"}</span>
          <span className="mt-0.5 block text-caption text-muted-foreground">{owner?.title ? `负责职责 · ${owner.title}` : owner?.error ?? "负责职责待核对"}</span></>}
    </td>
    <td className={cell}>{projection ? <><time dateTime={projection.timing?.createdAt ?? undefined}>{timingDate(projection.timing?.createdAt)}</time><span className="block text-caption text-muted-foreground">首次任务修订</span></> : <span className="text-muted-foreground">创建时间尚未读回</span>}</td>
    <td className={cell}><span className={progress.missing ? "text-muted-foreground" : "text-foreground"}>{progress.name}</span><span className="block text-caption text-muted-foreground">{progress.time || progress.source}</span></td>
    {columns.responsibility && <td className={cell}>{owner?.title ? <a className="text-primary hover:underline" href={href(projectId, "roles")}>{owner.title}</a> : <span className="text-muted-foreground">{owner?.error ?? "职责尚未读回"}</span>}</td>}
    {columns.nextAction && <td className={cell} data-next-cell="">{next}</td>}
    {columns.delivery && <td className={cell}>{projection?.delivery ? <a className="text-primary hover:underline" href={linkFor(task.id, "delivery")}>查看固定成果与使用</a> : <span className="text-muted-foreground">尚无当前交付</span>}</td>}
    {columns.revision && <td className={cell}>第 {task.version} 版</td>}
  </tr>;
}
