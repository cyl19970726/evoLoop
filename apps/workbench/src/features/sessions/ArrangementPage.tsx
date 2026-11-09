// 统筹安排: the /sessions page when no agent is selected. The center shows the board (each agent with what it is
// doing, what is assigned and what is queued; unassigned Tasks apart), the right column the conflicts the records
// prove. The Leader's own overview document has no marker yet, so the page says so instead of guessing one.
import { useEffect, type ReactNode } from "react";
import { CalendarClock, MessageSquare, RefreshCw, TriangleAlert } from "lucide-react";
import { AgentAvatar, Button, EmptyState, ErrorState, LoadingState, Notice, cn } from "@evoloop/ui";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { MutationContext } from "../../shared/ActionForm";
import { api, errorText } from "../../shared/api";
import { sessionClient } from "../../shared/sessionClient";
import { queueClient } from "../../shared/queueClient";
import { appendLeaderWorkPage, leaderPhaseLabel } from "../../shared/leaderWorkLoad";
import { useProjectQuery } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { readSessionDirectoryPages } from "./useSessionDirectoryGroup";
import { sessionHref } from "./SessionNavigation";
import { agentStatusLabel } from "./sessionStatusPresentation";
import {
  buildArrangement, freeAgents, type Arrangement, type ArrangementRisk, type ArrangementRow, type QueuedWork,
} from "./arrangementModel";

const maxSessionPages = 10;
const maxTaskPages = 20;

async function readOpenTasks(token: string, projectId: string): Promise<{ items: LeaderWorkTask[]; complete: boolean; observedAt: string }> {
  const client = api(token);
  const read = async (cursor?: string) => await client.leaderWork(projectId, "tasks", cursor) as LeaderWorkPage<LeaderWorkTask>;
  let page = await read();
  for (let pages = 1; page.nextCursor && pages < maxTaskPages; pages++) page = appendLeaderWorkPage(page, await read(page.nextCursor));
  return { items: page.items.filter(item => item.kind === "task"), complete: !page.nextCursor && !page.partial, observedAt: page.observedAt };
}

const heading = "text-label font-semibold text-foreground";
const shortDate = (value: string) => {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

function TaskLine({ projectId, task, extra }: { projectId: string; task: LeaderWorkTask; extra?: string }) {
  const due = task.plan?.dueAt;
  return <li className="min-w-0">
    <a href={href(projectId, "task", task.taskId)} className="block truncate text-small text-foreground hover:underline" title={task.title}>{task.title}</a>
    <span className="block text-caption text-muted-foreground">
      {leaderPhaseLabel[task.phase]}{task.plan?.priority ? ` · P${task.plan.priority}` : ""}{due ? ` · 截止 ${shortDate(due)}` : ""}{extra ? ` · ${extra}` : ""}
    </span>
  </li>;
}

function QueuedLine({ projectId, item }: { projectId: string; item: QueuedWork }) {
  return <li className="min-w-0">
    <a href={href(projectId, "task", item.taskId)} className="block truncate text-small text-foreground hover:underline" title={item.title}>{item.title}</a>
    <span className="block text-caption text-muted-foreground">第 {item.position} 位{item.held ? " · 暂停中" : ""}</span>
  </li>;
}

function Column({ label, empty, children }: { label: string; empty: string; children: ReactNode[] }) {
  return <div className={cn("min-w-0", !children.length && "hidden @2xl:block")}>
    <span className="mb-1 block text-caption text-muted-foreground @2xl:hidden">{label}</span>
    {children.length ? <ul className="flex flex-col gap-1.5">{children}</ul> : <span className="text-caption text-muted-foreground">{empty}</span>}
  </div>;
}

const loadDot: Record<ArrangementRow["load"], string> = {
  overloaded: "bg-destructive", busy: "bg-primary", idle: "bg-border", unknown: "bg-transparent shadow-[inset_0_0_0_1px_var(--border-strong)]",
};

function BoardRow({ projectId, row, tasksRead }: { projectId: string; row: ArrangementRow; tasksRead: boolean }) {
  const { session } = row;
  const roles = session.roles.map(role => role.title).join("、") || "职责待核对";
  const nothing = !row.running.length && !session.currentTask && !row.assigned.length && !row.queued.length;
  return <li className="arrangement-row grid grid-cols-1 gap-3 border-t border-border py-3 first:border-t-0 @2xl:grid-cols-[minmax(200px,1.1fr)_repeat(3,minmax(0,1fr))] @2xl:gap-4">
    <div className="flex min-w-0 items-start gap-2.5">
      <AgentAvatar seed={session.key} roleSeed={session.roles[0]?.id ?? session.title} size={34} />
      <div className="min-w-0">
        <a href={sessionHref(projectId, session.key)} className="block truncate font-medium text-foreground hover:underline" title={session.title}>{session.title}</a>
        <span className="block truncate text-caption text-text-secondary" title={roles}>{roles}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-caption text-muted-foreground">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", loadDot[row.load])} />{row.load === "overloaded" ? `同时做 ${row.running.length} 项` : agentStatusLabel(session)}
        </span>
      </div>
    </div>
    <Column label="正在做" empty={tasksRead ? "—" : "任务未读取"}>
      {row.running.length ? row.running.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} />)
        : session.currentTask ? [<li key="current" className="min-w-0"><a href={href(projectId, "task", session.currentTask.id)} className="block truncate text-small text-foreground hover:underline">{session.currentTask.title}</a><span className="block text-caption text-muted-foreground">智能体回报的当前任务</span></li>] : []}
    </Column>
    <Column label="已分派" empty={tasksRead ? "—" : "任务未读取"}>{row.assigned.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} />)}</Column>
    <Column label="排队" empty="—">{row.queued.map(item => <QueuedLine key={item.taskId} projectId={projectId} item={item} />)}</Column>
    {nothing && <span className="text-caption text-muted-foreground @2xl:hidden">{tasksRead ? "没有在做、分派或排队的工作" : "任务未读取"}</span>}
  </li>;
}

function RiskItem({ projectId, risk }: { projectId: string; risk: ArrangementRisk }) {
  const target = risk.sessionKey ? sessionHref(projectId, risk.sessionKey) : href(projectId, "task", risk.taskIds[0]!);
  return <li className="flex gap-2.5">
    <TriangleAlert size={16} aria-hidden="true" className={cn("mt-0.5 shrink-0", risk.kind === "overdue" || risk.kind === "parallel" ? "text-destructive" : "text-warning")} />
    <div className="min-w-0">
      <a href={target} className="block text-small text-foreground hover:underline">{risk.title}</a>
      {(risk.detail || risk.at) && <span className="block text-caption text-muted-foreground">{risk.at ? `截止于 ${shortDate(risk.at)}` : risk.detail}</span>}
    </div>
  </li>;
}

function PanelSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2.5 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h2 className={heading}>{title}{count !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>}</h2>
    {children}
  </section>;
}

function ArrangementPanel({ projectId, board, tasksError, tasksComplete }: {
  projectId: string; board: Arrangement; tasksError: string; tasksComplete: boolean;
}) {
  const free = freeAgents(board);
  const overloaded = board.rows.filter(row => row.load === "overloaded");
  const unknown = board.rows.filter(row => row.load === "unknown").length;
  const muted = (text: string) => <p className="text-caption text-muted-foreground">{text}</p>;
  return <ContextPanelContent>
    <div className="arrangement-panel flex flex-col gap-4">
      <PanelSection title="冲突与风险" count={tasksError ? undefined : board.risks.length}>
        {tasksError ? muted(`任务暂不可读取，无法判断冲突：${tasksError}`)
          : board.risks.length ? <ul className="flex flex-col gap-3">{board.risks.map((risk, index) => <RiskItem key={`${risk.kind}:${risk.taskIds.join(",")}:${index}`} projectId={projectId} risk={risk} />)}</ul>
            : muted("记录里没有看出冲突。总览文档里写的冲突以文档为准。")}
        {!tasksError && !tasksComplete && muted("任务较多，只核对了已读取的部分。")}
      </PanelSection>
      <PanelSection title="空闲与过载">
        {overloaded.length > 0 && <ul className="flex flex-col gap-1.5">{overloaded.map(row => <li key={row.session.key} className="text-small"><a href={sessionHref(projectId, row.session.key)} className="hover:underline">{row.session.title}</a><span className="text-caption text-muted-foreground"> · 同时做 {row.running.length} 项</span></li>)}</ul>}
        {free.length ? <ul className="flex flex-col gap-1.5">{free.map(row => <li key={row.session.key} className="flex items-center gap-2 text-small">
          <AgentAvatar seed={row.session.key} roleSeed={row.session.roles[0]?.id ?? row.session.title} size={22} />
          <a href={sessionHref(projectId, row.session.key)} className="truncate hover:underline">{row.session.title}</a><span className="shrink-0 text-caption text-muted-foreground">空闲</span>
        </li>)}</ul> : muted("没有空闲的智能体：每个都有在做、已分派或排队的工作。")}
        {unknown > 0 && muted(`另有 ${unknown} 个智能体的占用待核对，不算空闲。`)}
      </PanelSection>
      <PanelSection title="截止临近" count={tasksError ? undefined : board.dueSoon.length}>
        {board.dueSoon.length ? <ul className="flex flex-col gap-2">{board.dueSoon.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} />)}</ul>
          : muted(tasksError ? "任务暂不可读取。" : "三天内没有到期的任务。")}
      </PanelSection>
    </div>
  </ContextPanelContent>;
}

function Stat({ label, value, tone, onClick }: { label: string; value: number | string; tone?: "danger"; onClick?: () => void }) {
  const body = <><span className={cn("text-heading font-semibold tabular-nums", tone === "danger" && "text-destructive")}>{value}</span><span className="text-caption text-muted-foreground">{label}</span></>;
  const box = "flex min-w-0 flex-col gap-0.5 rounded-xl bg-field px-4 py-3 text-left";
  return onClick ? <button type="button" onClick={onClick} className={cn(box, "hover:bg-selected")}>{body}</button> : <div className={box}>{body}</div>;
}

export function ArrangementPage({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { token, projectId } = context;
  const panel = useContextPanel();
  const sessions = useProjectQuery(projectId, ["arrangement", "agents"],
    signal => readSessionDirectoryPages(sessionClient(token, projectId), "current", "", maxSessionPages, signal));
  const tasks = useProjectQuery(projectId, ["arrangement", "tasks"], () => readOpenTasks(token, projectId));
  const queues = useProjectQuery(projectId, ["arrangement", "queues"], async () => {
    const items = await queueClient(token, projectId).list();
    if (items.some(item => item.projectId !== projectId)) throw new Error("队列响应与当前项目不符");
    return items;
  });
  const reread = () => { void sessions.refetch(); void tasks.refetch(); void queues.refetch(); };
  useEffect(() => { if (refresh) reread(); }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = sessions.isFetching || tasks.isFetching || queues.isFetching;
  const tasksError = tasks.error ? errorText(tasks.error) : "";
  const queuesError = queues.error ? errorText(queues.error) : "";
  const agents = sessions.data?.items ?? [];
  const board = sessions.data ? buildArrangement(agents, tasks.data?.items ?? [], queues.data ?? [], Date.now()) : null;
  const moreAgents = !!sessions.data?.page.nextCursor;
  const working = board?.rows.filter(row => row.load === "busy" || row.load === "overloaded").length ?? 0;
  const free = board ? freeAgents(board).length : 0;
  return <div data-ui="" className="arrangement-page mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 py-5 compact:px-8 compact:py-7">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>统筹安排</h1>
        <p className="mt-1 text-small text-text-secondary">谁在做什么、谁空闲、哪里有冲突。要调整安排，回到与统筹的对话。</p>
      </div>
      <div className="flex items-center gap-2">
        {board?.leader && <Button asChild variant="primary"><a href={sessionHref(projectId, board.leader.key)}><MessageSquare aria-hidden="true" />与统筹对话</a></Button>}
        <Button onClick={reread} disabled={busy}><RefreshCw aria-hidden="true" className={busy ? "animate-spin" : undefined} />重新读取</Button>
      </div>
    </header>
    {sessions.error && !sessions.data ? <ErrorState title="智能体目录暂不可读取" happened={errorText(sessions.error)} next="稍后重试；如果一直失败，检查与服务的连接。" action={<Button onClick={reread}>重试</Button>} />
      : !board ? <LoadingState label="正在读取智能体与任务" lines={4} />
        : <>
          <div className="grid grid-cols-2 gap-2 compact:grid-cols-4" aria-label="概况">
            <Stat label="个智能体在做事" value={working} />
            <Stat label="个智能体空闲" value={free} />
            <Stat label="项任务没有承接者" value={tasksError ? "?" : board.unassigned.length} />
            <Stat label="个冲突与风险" value={tasksError ? "?" : board.risks.length} tone={board.risks.length ? "danger" : undefined} onClick={() => panel?.setOpen(true)} />
          </div>
          <section aria-labelledby="arrangement-overview" className="flex flex-col gap-2">
            <h2 id="arrangement-overview" className={heading}>统筹总览</h2>
            <Notice tone="info">系统还没有标出哪份文档是当前的编排总览，这里暂时不能固定显示。统筹写的过程文档在<a href={href(projectId, "documents")} className="underline">文档</a>里。</Notice>
          </section>
          <section aria-labelledby="arrangement-board" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="arrangement-board" className={heading}>安排看板</h2>
              <span className="text-caption text-muted-foreground">{tasks.data ? `任务读于 ${date(tasks.data.observedAt)}` : ""}</span>
            </div>
            {tasksError && <Notice tone="error" title="任务暂不可读取">{tasksError}。看板只显示智能体自己回报的当前任务。</Notice>}
            {queuesError && <Notice tone="waiting" title="队列暂不可读取">{queuesError}。“排队”一栏不完整。</Notice>}
            {tasks.data && !tasks.data.complete && <Notice tone="waiting">任务较多，看板只包含已读取的前 {tasks.data.items.length} 项。</Notice>}
            {board.rows.length ? <div className="@container rounded-xl bg-raised px-4 shadow-sm">
              <div aria-hidden="true" className="hidden grid-cols-[minmax(200px,1.1fr)_repeat(3,minmax(0,1fr))] gap-4 border-b border-border py-2 text-caption text-muted-foreground @2xl:grid">
                <span>智能体</span><span>正在做</span><span>已分派</span><span>排队</span>
              </div>
              <ul aria-label="各智能体的安排">{board.rows.map(row => <BoardRow key={row.session.key} projectId={projectId} row={row} tasksRead={!tasksError && !!tasks.data} />)}</ul>
            </div> : <EmptyState title="还没有智能体" reason="项目里还没有当前的智能体。可以在左侧目录里连接或建立一个。" />}
            {moreAgents && <p className="text-caption text-muted-foreground">智能体较多，看板只包含前 {agents.length} 个。</p>}
          </section>
          {board.elsewhere.map(group => <section key={group.target} aria-label={group.label} className="flex flex-col gap-2">
            <h2 className={heading}>{group.label}<span className="ml-1.5 font-normal text-muted-foreground">{group.tasks.length}</span></h2>
            <ul className="flex flex-col gap-2 rounded-xl bg-raised px-4 py-3 shadow-sm">{group.tasks.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} />)}</ul>
          </section>)}
          {!tasksError && tasks.data && <section aria-labelledby="arrangement-unassigned" className="flex flex-col gap-2">
            <h2 id="arrangement-unassigned" className={heading}>没有承接者的任务<span className="ml-1.5 font-normal text-muted-foreground">{board.unassigned.length}</span></h2>
            {board.unassigned.length ? <ul className="flex flex-col gap-2 rounded-xl bg-raised px-4 py-3 shadow-sm">{board.unassigned.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} extra={task.nextAction || undefined} />)}</ul>
              : <p className="text-caption text-muted-foreground">每项进行中的任务都有承接者。</p>}
          </section>}
          <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><CalendarClock size={14} aria-hidden="true" />优先级、截止时间和依赖由统筹经 CLI 设置；这里只读。</p>
          <ArrangementPanel projectId={projectId} board={board} tasksError={tasksError} tasksComplete={!!tasks.data?.complete} />
        </>}
  </div>;
}
