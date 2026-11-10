// 统筹安排: the /sessions page when no agent is selected. The center shows the board (each agent with what it is
// doing, what is assigned and what is queued; unassigned Tasks apart), the right column the conflicts the records
// prove. The Leader's own overview document has no marker yet, so the page says so instead of guessing one.
// A read that is still running or failed is never shown as "free", "no conflict" or 0; a failed reread that keeps
// the previous answer says it is the previous answer.
import { useEffect, type ReactNode } from "react";
import { CalendarClock, MessageSquare, RefreshCw, TriangleAlert } from "lucide-react";
import { AgentAvatar, Button, EmptyState, ErrorState, LoadingState, Notice, cn } from "@evoloop/ui";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { SessionDirectory } from "@evoloop/contracts/session-observation";
import type { MutationContext } from "../../shared/ActionForm";
import { api, errorText } from "../../shared/api";
import { sessionClient } from "../../shared/sessionClient";
import { queueClient } from "../../shared/queueClient";
import { appendLeaderWorkPage } from "../../shared/leaderWorkLoad";
import { withReturn, type ReturnFrom } from "../../shared/returnLink";
import { useProjectQuery } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { readSessionDirectoryPages } from "./useSessionDirectoryGroup";
import { sessionHref } from "./SessionNavigation";
import { agentStatusLabel } from "./sessionStatusPresentation";
import {
  buildArrangement, freeCapacity, type Arrangement, type ArrangementRisk, type ArrangementRow, type QueuedWork,
} from "./arrangementModel";
import {
  boardPhaseText, capacityUnknownReason, directoryWorkCaption, noConflictText, noFreeAgentText, readStateOf,
  staleLabel, type ReadState,
} from "./arrangementPresentation";
import { workNextStep } from "../../shared/workPresentation";

const maxSessionPages = 10;
const maxTaskPages = 20;

async function readOpenTasks(token: string, projectId: string, signal: AbortSignal): Promise<{ items: LeaderWorkTask[]; complete: boolean; observedAt: string }> {
  const client = api(token);
  const read = async (cursor?: string) => await client.leaderWork(projectId, "tasks", cursor, false, signal) as LeaderWorkPage<LeaderWorkTask>;
  let page = await read();
  for (let pages = 1; page.nextCursor && pages < maxTaskPages; pages++) {
    signal.throwIfAborted(); // another project or a newer read took over: stop paging
    page = appendLeaderWorkPage(page, await read(page.nextCursor));
  }
  return { items: page.items.filter(item => item.kind === "task"), complete: !page.nextCursor && !page.partial, observedAt: page.observedAt };
}

const heading = "text-label font-semibold text-foreground";
const shortDate = (value: string) => {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Links out of 统筹安排 come back to it (“返回统筹安排”). */
const taskHref = (projectId: string, taskId: string, from: ReturnFrom) => withReturn(href(projectId, "task", taskId), from);

function TaskLine({ projectId, task, extra, from, stale }: {
  projectId: string; task: LeaderWorkTask; extra?: string | undefined; from: ReturnFrom; stale: Arrangement["stale"];
}) {
  const due = task.plan?.dueAt;
  const staleKind = stale.get(task.taskId) ?? null;
  return <li className="min-w-0" data-stale-assignment={staleKind ? "" : undefined}>
    <a href={taskHref(projectId, task.taskId, from)} className="block truncate text-small text-foreground hover:underline" title={task.title}>{task.title}</a>
    <span className={cn("block text-caption", staleKind ? "text-warning" : "text-muted-foreground")}>
      {boardPhaseText(task, staleKind)}{task.plan?.priority ? ` · P${task.plan.priority}` : ""}{due ? ` · 截止 ${shortDate(due)}` : ""}{extra ? ` · ${extra}` : ""}
    </span>
  </li>;
}

function QueuedLine({ projectId, item, from }: { projectId: string; item: QueuedWork; from: ReturnFrom }) {
  return <li className="min-w-0">
    <a href={taskHref(projectId, item.taskId, from)} className="block truncate text-small text-foreground hover:underline" title={item.title}>{item.title}</a>
    <span className="block text-caption text-muted-foreground">第 {item.position} 位{item.held ? " · 暂停中" : ""}</span>
  </li>;
}

function Column({ label, empty, children }: { label: string; empty: string; children: ReactNode[] }) {
  return <div role="group" aria-label={label} className={cn("min-w-0", !children.length && "hidden @2xl:block")}>
    <span className="mb-1 block text-caption text-muted-foreground @2xl:hidden">{label}</span>
    {children.length ? <ul className="flex flex-col gap-1.5">{children}</ul> : <span className="text-caption text-muted-foreground">{empty}</span>}
  </div>;
}

const loadDot: Record<ArrangementRow["load"], string> = {
  overloaded: "bg-destructive", busy: "bg-primary", idle: "bg-border", unknown: "bg-transparent shadow-[inset_0_0_0_1px_var(--border-strong)]",
};

const unreadText = (state: ReadState, what: string) => state === "loading" ? "正在读取" : state === "failed" ? `${what}未读取` : "—";

function BoardRow({ projectId, row, claimed, stale, tasks, queues, from }: {
  projectId: string; row: ArrangementRow; claimed: ReadonlySet<string>; stale: Arrangement["stale"]; tasks: ReadState; queues: ReadState; from: ReturnFrom;
}) {
  const { session } = row;
  const roles = session.roles.map(role => role.title).join("、") || "职责待核对";
  // The directory's current work is derived from assignments and queue claims, not reported by the agent.
  // It stands in only while Tasks cannot be read, under 已分派 and with its source.
  const fallback = tasks === "failed" ? session.currentTask : null;
  const line = (task: LeaderWorkTask) =>
    <TaskLine key={task.taskId} projectId={projectId} task={task} extra={claimed.has(task.taskId) ? "从排队中领取" : undefined} from={from} stale={stale} />;
  const nothing = !row.running.length && !fallback && !row.assigned.length && !row.queued.length;
  const nothingText = tasks === "loading" ? "正在读取任务" : tasks === "failed" ? "任务未读取"
    : queues === "ready" || queues === "stale" ? "没有在做、分派或排队的工作"
      : `没有在做或分派的工作；排队${queues === "loading" ? "正在读取" : "未读取"}`;
  return <li className="arrangement-row grid grid-cols-1 gap-3 border-t border-border py-3 first:border-t-0 @2xl:grid-cols-[minmax(200px,1.1fr)_repeat(3,minmax(0,1fr))] @2xl:gap-4">
    <div className="flex min-w-0 items-start gap-2.5">
      <AgentAvatar seed={session.key} roleSeed={session.roles[0]?.id ?? session.title} size={34} />
      <div className="min-w-0">
        <a href={sessionHref(projectId, session.key, from)} className="block truncate font-medium text-foreground hover:underline" title={session.title}>{session.title}</a>
        <span className="block truncate text-caption text-text-secondary" title={roles}>{roles}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-caption text-muted-foreground">
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", loadDot[row.load])} />{row.load === "overloaded" ? `同时做 ${row.running.length} 项` : agentStatusLabel(session)}
        </span>
      </div>
    </div>
    <Column label="正在做" empty={unreadText(tasks, "任务")}>{row.running.map(line)}</Column>
    <Column label="已分派" empty={unreadText(tasks, "任务")}>
      {fallback ? [<li key="directory" className="min-w-0">
        <a href={taskHref(projectId, fallback.id, from)} className="block truncate text-small text-foreground hover:underline" title={fallback.title}>{fallback.title}</a>
        <span className="block text-caption text-muted-foreground">{directoryWorkCaption(fallback.relation)}</span>
      </li>] : row.assigned.map(line)}
    </Column>
    <Column label="排队" empty={unreadText(queues, "队列")}>{row.queued.map(item => <QueuedLine key={item.taskId} projectId={projectId} item={item} from={from} />)}</Column>
    {nothing && <span className="text-caption text-muted-foreground @2xl:hidden">{nothingText}</span>}
  </li>;
}

function RiskItem({ projectId, risk, from }: { projectId: string; risk: ArrangementRisk; from: ReturnFrom }) {
  const target = risk.sessionKey ? sessionHref(projectId, risk.sessionKey, from) : taskHref(projectId, risk.taskIds[0]!, from);
  return <li className="flex gap-2.5">
    <TriangleAlert size={16} aria-hidden="true" className={cn("mt-0.5 shrink-0", risk.kind === "overdue" || risk.kind === "parallel" ? "text-destructive" : "text-warning")} />
    <div className="min-w-0">
      <a href={target} className="block text-small text-foreground hover:underline">{risk.title}</a>
      {(risk.detail || risk.at) && <span className="block text-caption text-muted-foreground">{risk.at ? `截止于 ${shortDate(risk.at)}` : risk.detail}</span>}
    </div>
  </li>;
}

function PanelSection({ title, count, children }: { title: string; count?: number | string | undefined; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2.5 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h2 className={heading}>{title}{count !== undefined && <span className="ml-1.5 font-normal text-muted-foreground">{count}</span>}</h2>
    {children}
  </section>;
}

interface Reads {
  tasks: ReadState;
  tasksComplete: boolean;
  tasksError: string;
  queues: ReadState;
  /** Some part of what is on screen is a previous answer kept after a failed reread. */
  stale: boolean;
}

function ArrangementPanel({ projectId, board, reads, from }: { projectId: string; board: Arrangement; reads: Reads; from: ReturnFrom }) {
  const capacity = freeCapacity(board);
  const unknownReason = capacityUnknownReason(reads.tasks, reads.tasksComplete, reads.queues);
  const tasksShown = reads.tasks === "ready" || reads.tasks === "stale";
  const overloaded = board.rows.filter(row => row.load === "overloaded");
  const muted = (text: string) => <p className="text-caption text-muted-foreground">{text}</p>;
  return <ContextPanelContent>
    <div className="arrangement-panel flex flex-col gap-4">
      {reads.stale && <Notice tone="waiting" title={staleLabel}>重新读取失败，下面沿用上次读回的记录。</Notice>}
      <PanelSection title="冲突与风险" count={tasksShown ? board.risks.length : undefined}>
        {tasksShown && board.risks.length ? <ul className="flex flex-col gap-3">{board.risks.map((risk, index) => <RiskItem key={`${risk.kind}:${risk.taskIds.join(",")}:${index}`} projectId={projectId} risk={risk} from={from} />)}</ul>
          : muted(noConflictText(reads.tasks, reads.tasksComplete, reads.tasksError))}
        {tasksShown && !reads.tasksComplete && board.risks.length > 0 && muted("任务较多，只核对了已读取的部分。")}
      </PanelSection>
      <PanelSection title="空闲与过载">
        {overloaded.length > 0 && <ul className="flex flex-col gap-1.5">{overloaded.map(row => <li key={row.session.key} className="text-small"><a href={sessionHref(projectId, row.session.key, from)} className="hover:underline">{row.session.title}</a><span className="text-caption text-muted-foreground"> · 同时做 {row.running.length} 项</span></li>)}</ul>}
        {unknownReason ? muted(unknownReason)
          : capacity.free.length ? <ul className="flex flex-col gap-1.5">{capacity.free.map(row => <li key={row.session.key} className="flex items-center gap-2 text-small">
            <AgentAvatar seed={row.session.key} roleSeed={row.session.roles[0]?.id ?? row.session.title} size={22} />
            <a href={sessionHref(projectId, row.session.key, from)} className="truncate hover:underline">{row.session.title}</a><span className="shrink-0 text-caption text-muted-foreground">空闲</span>
          </li>)}</ul> : muted(noFreeAgentText(capacity))}
        {!unknownReason && capacity.unknown > 0 && capacity.unknown < capacity.others && muted(`另有 ${capacity.unknown} 个智能体的状态待核对，不算空闲。`)}
      </PanelSection>
      <PanelSection title="截止临近" count={tasksShown ? board.dueSoon.length : undefined}>
        {tasksShown && board.dueSoon.length ? <ul className="flex flex-col gap-2">{board.dueSoon.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} from={from} stale={board.stale} />)}</ul>
          : muted(reads.tasks === "loading" ? "正在读取任务。" : reads.tasks === "failed" ? "任务暂不可读取。"
            : reads.tasksComplete ? "三天内没有到期的任务。" : "已读取的任务里三天内没有到期的。")}
      </PanelSection>
    </div>
  </ContextPanelContent>;
}

function Stat({ label, value, note, tone, onClick }: { label: string; value: number | string; note?: string | undefined; tone?: "danger" | undefined; onClick?: () => void }) {
  const body = <>
    <span className={cn("text-heading font-semibold tabular-nums", tone === "danger" && "text-destructive")}>{value}</span>
    <span className="text-caption text-muted-foreground">{label}{note && <span className="text-text-secondary"> · {note}</span>}</span>
  </>;
  const box = "flex min-w-0 flex-col gap-0.5 rounded-xl bg-field px-4 py-3 text-left";
  return onClick ? <button type="button" onClick={onClick} className={cn(box, "hover:bg-selected")}>{body}</button> : <div className={box}>{body}</div>;
}

/** Project-wide counts the agent directory reports, independent of how many agents were read. */
function Waiting({ attention, stale }: { attention: SessionDirectory["attention"]; stale: boolean }) {
  return <p className="text-caption text-muted-foreground">
    项目里：{attention.pendingMessages} 条待处理消息 · {attention.unansweredQuestions} 个待答问题 · {attention.pendingAcceptance === null ? "待验收数待核对" : `${attention.pendingAcceptance} 项待验收`}{stale ? ` · ${staleLabel}` : ""}
  </p>;
}

export function ArrangementPage({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { token, projectId } = context;
  const panel = useContextPanel();
  const from: ReturnFrom = { href: href(projectId, "sessions"), actorId: context.principal.actorId };
  const sessions = useProjectQuery(projectId, ["arrangement", "agents"],
    signal => readSessionDirectoryPages(sessionClient(token, projectId), "current", "", maxSessionPages, signal));
  const tasks = useProjectQuery(projectId, ["arrangement", "tasks"], signal => readOpenTasks(token, projectId, signal));
  const queues = useProjectQuery(projectId, ["arrangement", "queues"], async signal => {
    const items = await queueClient(token, projectId).list(signal);
    if (items.some(item => item.projectId !== projectId)) throw new Error("队列响应与当前项目不符");
    return items;
  });
  const reread = () => { void sessions.refetch(); void tasks.refetch(); void queues.refetch(); };
  useEffect(() => { if (refresh) reread(); }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = sessions.isFetching || tasks.isFetching || queues.isFetching;
  const sessionRead = readStateOf(sessions);
  const reads: Reads = {
    tasks: readStateOf(tasks), tasksComplete: !!tasks.data?.complete, tasksError: tasks.error ? errorText(tasks.error) : "",
    queues: readStateOf(queues), stale: false,
  };
  reads.stale = reads.tasks === "stale" || reads.queues === "stale" || sessionRead === "stale";
  const queuesError = queues.error ? errorText(queues.error) : "";
  const agents = sessions.data?.items ?? [];
  const board = sessions.data ? buildArrangement(agents, tasks.data?.items ?? [], queues.data ?? [], Date.now(), {
    tasksComplete: reads.tasksComplete, queuesRead: !!queues.data, directoryComplete: !sessions.data.page.nextCursor,
  }) : null;
  const moreAgents = !!sessions.data?.page.nextCursor;
  const tasksShown = reads.tasks === "ready" || reads.tasks === "stale";
  const working = board?.rows.filter(row => row.load === "busy" || row.load === "overloaded").length ?? 0;
  const capacity = board ? freeCapacity(board) : null;
  const capacityKnown = !capacityUnknownReason(reads.tasks, reads.tasksComplete, reads.queues);
  const taskNote = reads.tasks === "stale" ? "上次读回" : tasksShown && !reads.tasksComplete ? "已读部分" : undefined;
  const stale = (state: ReadState) => state === "stale" ? "上次读回" : undefined;
  return <div data-ui="" className="arrangement-page mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-4 py-5 compact:px-8 compact:py-7">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>统筹安排</h1>
        <p className="mt-1 text-small text-text-secondary">谁在做什么、谁空闲、哪里有冲突。要调整安排，回到与统筹的对话。</p>
      </div>
      <div className="flex items-center gap-2">
        {board?.leader && <Button asChild variant="primary"><a href={sessionHref(projectId, board.leader.key, from)}><MessageSquare aria-hidden="true" />与统筹对话</a></Button>}
        <Button onClick={reread} disabled={busy}><RefreshCw aria-hidden="true" className={busy ? "animate-spin" : undefined} />重新读取</Button>
      </div>
    </header>
    {sessionRead === "failed" ? <ErrorState title="智能体目录暂不可读取" happened={errorText(sessions.error)} next="稍后重试；如果一直失败，检查与服务的连接。" action={<Button onClick={reread}>重试</Button>} />
      : !board || !capacity ? <LoadingState label="正在读取智能体与任务" lines={4} />
        : <>
          <div className="grid grid-cols-2 gap-2 compact:grid-cols-4" aria-label="概况">
            <Stat label="个智能体在做事" value={working} note={stale(sessionRead)} />
            <Stat label="个智能体空闲" value={capacityKnown ? capacity.free.length : "?"} note={capacityKnown && reads.stale ? "上次读回" : undefined} />
            <Stat label="项任务没有承接者" value={tasksShown ? board.unassigned.length : "?"} note={taskNote} />
            <Stat label="个冲突与风险" value={tasksShown ? board.risks.length : "?"} note={taskNote}
              tone={tasksShown && board.risks.length ? "danger" : undefined} onClick={() => panel?.setOpen(true)} />
          </div>
          {sessions.data && <Waiting attention={sessions.data.page.attention} stale={sessionRead === "stale"} />}
          <section aria-labelledby="arrangement-overview" className="flex flex-col gap-2">
            <h2 id="arrangement-overview" className={heading}>统筹总览</h2>
            <Notice tone="info">系统还没有标出哪份文档是当前的编排总览，这里暂时不能固定显示。统筹写的过程文档在<a href={href(projectId, "documents")} className="underline">文档</a>里。</Notice>
          </section>
          <section aria-labelledby="arrangement-board" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="arrangement-board" className={heading}>安排看板</h2>
              <span className="text-caption text-muted-foreground">{tasks.data ? `任务${reads.tasks === "stale" ? "上次" : ""}读于 ${date(tasks.data.observedAt)}` : reads.tasks === "loading" ? "正在读取任务…" : ""}</span>
            </div>
            {sessionRead === "stale" && <Notice tone="waiting" title={`智能体目录重新读取失败 · ${staleLabel}`}>{errorText(sessions.error)}。看板沿用上次读回的智能体。</Notice>}
            {reads.tasks === "failed" && <Notice tone="error" title="任务暂不可读取">{reads.tasksError}。“已分派”里只列出智能体目录记录的当前工作，阶段未读取；空闲、冲突和没有承接者的任务都无法判断。</Notice>}
            {reads.tasks === "stale" && <Notice tone="waiting" title={`任务重新读取失败 · ${staleLabel}`}>{reads.tasksError}。看板沿用 {date(tasks.data!.observedAt)} 读回的任务。</Notice>}
            {reads.queues === "failed" && <Notice tone="waiting" title="队列暂不可读取">{queuesError}。“排队”一栏不完整，谁空闲也无法确认。</Notice>}
            {reads.queues === "stale" && <Notice tone="waiting" title={`队列重新读取失败 · ${staleLabel}`}>{queuesError}。“排队”一栏沿用上次读回的记录。</Notice>}
            {tasks.data && !tasks.data.complete && <Notice tone="waiting">任务较多，看板只包含已读取的前 {tasks.data.items.length} 项。</Notice>}
            {board.rows.length ? <div className="@container rounded-xl bg-raised px-4 shadow-sm">
              <div aria-hidden="true" className="hidden grid-cols-[minmax(200px,1.1fr)_repeat(3,minmax(0,1fr))] gap-4 border-b border-border py-2 text-caption text-muted-foreground @2xl:grid">
                <span>智能体</span><span>正在做</span><span>已分派</span><span>排队</span>
              </div>
              <ul aria-label="各智能体的安排">{board.rows.map(row => <BoardRow key={row.session.key} projectId={projectId} row={row} claimed={board.claimed} stale={board.stale} tasks={reads.tasks} queues={reads.queues} from={from} />)}</ul>
            </div> : <EmptyState title="还没有智能体" reason="项目里还没有当前的智能体。可以在左侧目录里连接或建立一个。" />}
            {moreAgents && <p className="text-caption text-muted-foreground">智能体较多，看板只包含前 {agents.length} 个；其余智能体承接的任务列在“未读到”的分组里。</p>}
          </section>
          {board.elsewhere.map(group => <section key={group.target} aria-label={group.label} className="flex flex-col gap-2">
            <h2 className={heading}>{group.label}<span className="ml-1.5 font-normal text-muted-foreground">{group.tasks.length}</span></h2>
            <ul className="flex flex-col gap-2 rounded-xl bg-raised px-4 py-3 shadow-sm">{group.tasks.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} from={from} stale={board.stale} />)}</ul>
          </section>)}
          {tasksShown && <section aria-labelledby="arrangement-unassigned" className="flex flex-col gap-2">
            <h2 id="arrangement-unassigned" className={heading}>没有承接者的任务<span className="ml-1.5 font-normal text-muted-foreground">{board.unassigned.length}</span></h2>
            {board.unassigned.length ? <ul className="flex flex-col gap-2 rounded-xl bg-raised px-4 py-3 shadow-sm">{board.unassigned.map(task => <TaskLine key={task.taskId} projectId={projectId} task={task} extra={workNextStep(task.phase)} from={from} stale={board.stale} />)}</ul>
              : <p className="text-caption text-muted-foreground">{reads.tasksComplete ? "每项未关闭的任务都有承接者。" : "已读取的任务都有承接者。"}</p>}
            {(reads.queues === "failed" || reads.queues === "loading") && <p className="text-caption text-muted-foreground">队列还没读到：从排队中领取的任务也可能列在这里。</p>}
          </section>}
          <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><CalendarClock size={14} aria-hidden="true" />优先级、截止时间和依赖由统筹经 CLI 设置；这里只读。</p>
          <ArrangementPanel projectId={projectId} board={board} reads={reads} from={from} />
        </>}
  </div>;
}
