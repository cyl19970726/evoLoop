import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button, Notice, cn } from "@evoloop/ui";
import type { Task, TaskDetail } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { ResidentQueue, QueueHoldCode } from "@evoloop/contracts/queues";
import { api, errorText, request, type TaskTimingView } from "../../shared/api";
import { queueClient } from "../../shared/queueClient";
import { date, href } from "../../shared/ui/shared";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import { isRoleOwnerId, readOwnerRole } from "../../shared/ownerRole";
import { scanProjectTasks, selectSummary, taskMatchesQueue, type SummaryItem } from "./summary";
import { visibleWorkGroups, type WorkTaskStatus } from "../../shared/workStatusPresentation";
import { formatScheduled, nextTimingLabel, repeatLabel } from "../workflow";

import { ProjectContext } from "./ProjectContext";

interface Snapshot {
  scope: string;
  queues: ResidentQueue[];
  activeTasks: Task[];
  scheduled: { task: Task; timing: TaskTimingView }[];
  timingReadFailed: number;
  timingScanLimited: boolean;
  taskScan: { total: number; truncated: boolean; pages: number };
  tasks: Record<string, Task>;
  roles: Record<string, RoleRecord>;
  statuses: Record<string, WorkTaskStatus>;
  statusError: string;
  failedNames: number;
  observedAt: string;
}
const short = (id: string) => id.slice(0, 8);
const holdLabels: Record<QueueHoldCode, string> = {
  not_adopted: "队列尚未采纳", task_changed: "任务修订已变化", task_unavailable: "任务不可承接",
  dependency: "依赖尚未放行", session_unready: "会话尚未就绪", binding_changed: "职责绑定已变化",
  grant_revoked: "授权已撤销", occupied: "会话已占用", run_in_flight: "运行仍在途",
  unknown: "运行结果未知", awaiting_acceptance: "等待消费者使用与验收", budget_exhausted: "尝试达到上限",
  manual_review: "等待人工复核",
};

async function readSnapshot(token: string, projectId: string, scope: string, signal: AbortSignal): Promise<Snapshot> {
  const [queues, scan] = await Promise.all([
    queueClient(token, projectId).list(),
    scanProjectTasks(projectId, cursor => api(token).tasks(projectId, cursor), signal),
  ]);
  if (signal.aborted) throw new Error("读取已取消");
  if (queues.some(queue => queue.projectId !== projectId || queue.entries.some(entry => entry.projectId !== projectId || entry.queueId !== queue.id)))
    throw new Error("队列响应与当前项目不符");
  const selection = selectSummary(queues);
  const entries = [...selection.current, ...selection.next, ...selection.held];
  const activeTasks = scan.items.filter(task => task.state === "in_progress");
  const timingCandidates = scan.items.filter(task => task.state === "todo" || task.state === "in_progress");
  const timingScanLimited = scan.truncated || timingCandidates.length > 60;
  const scheduled: { task: Task; timing: TaskTimingView }[] = [];
  let timingReadFailed = 0, timingCursor = 0;
  async function readTiming() {
    while (!signal.aborted && timingCursor < Math.min(60, timingCandidates.length)) {
      const task = timingCandidates[timingCursor++]!;
      try {
        const timing = await api(token).taskTiming(projectId, task.id);
        if (timing) scheduled.push({ task, timing });
      } catch { if (!signal.aborted) timingReadFailed++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, timingCandidates.length) }, () => readTiming()));
  if (signal.aborted) throw new Error("读取已取消");
  scheduled.sort((a, b) => Date.parse(a.timing.executeAtUtc) - Date.parse(b.timing.executeAtUtc));
  let statuses: Record<string, WorkTaskStatus> = {}, statusError = "";
  if (activeTasks.length) {
    const chunks: Task[][] = [];
    for (let at = 0; at < activeTasks.length; at += 50) chunks.push(activeTasks.slice(at, at + 50));
    let nextChunk = 0, failed = false;
    await Promise.all(Array.from({ length: Math.min(4, chunks.length) }, async () => {
      while (!signal.aborted && nextChunk < chunks.length) {
        const chunk = chunks[nextChunk++]!;
        try {
          const result = await api(token).workStatuses(projectId, chunk.map(task => task.id));
          for (const item of result.items) statuses[item.taskId] = item;
        } catch { failed = true; }
      }
    }));
    if (signal.aborted) throw new Error("读取已取消");
    if (failed) statusError = "部分任务的工作分类暂不可读";
  }
  const classified = visibleWorkGroups(activeTasks, statuses, !!statusError && !Object.keys(statuses).length);
  const shownActive = [...classified.primary.slice(0, 12), ...classified.unknown.slice(0, 3), ...classified.cognition.slice(0, 3)];
  const tasks: Record<string, Task> = Object.fromEntries(scan.items.map(task => [task.id, task]));
  const taskIds = [...new Set(entries.map(item => item.entry.taskId))].filter(id => !tasks[id]);
  const roleIds = [...new Set([...entries.map(item => item.entry.roleId), ...shownActive.map(task => task.owner)])].filter(isRoleOwnerId);
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const work = [
    ...taskIds.map(id => ({ kind: "task" as const, id })),
    ...roleIds.map(id => ({ kind: "role" as const, id })),
  ];
  const roles: Record<string, RoleRecord> = {};
  let cursor = 0, failedNames = 0;
  async function worker() {
    while (!signal.aborted && cursor < work.length) {
      const item = work[cursor++]!;
      try {
        if (item.kind === "task") {
          const result = await request<TaskDetail>(token, `${base}/tasks/${encodeURIComponent(item.id)}`, 15000, { signal });
          if (result.task.projectId !== projectId || result.task.id !== item.id) throw new Error("任务响应不匹配");
          tasks[item.id] = result.task;
        } else {
          roles[item.id] = await readOwnerRole(token, projectId, item.id, signal);
        }
      } catch { if (!signal.aborted) failedNames++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, work.length) }, () => worker()));
  if (signal.aborted) throw new Error("读取已取消");
  return { scope, queues, activeTasks: shownActive, scheduled, timingReadFailed, timingScanLimited,
    taskScan: { total: activeTasks.length, truncated: scan.truncated, pages: scan.pages },
    tasks, roles, statuses, statusError, failedNames, observedAt: new Date().toISOString() };
}

const muted = "text-caption text-muted-foreground";
const link = "text-foreground hover:underline";

function ActiveTaskItem({ task, snapshot, projectId }: { task: Task; snapshot: Snapshot; projectId: string }) {
  const role = isRoleOwnerId(task.owner) ? snapshot.roles[task.owner] : undefined;
  const owner = role?.proposal.title?.trim() || (isRoleOwnerId(task.owner) ? `职责 ${short(task.owner)}` : task.owner || "负责人未登记");
  return <li className="flex flex-col gap-0.5 border-t border-border py-2.5 first:border-t-0">
    <a href={href(projectId, "task", task.id)} className={cn("text-small font-medium", link)}>{task.title?.trim() || `任务 ${short(task.id)}`}</a>
    <span className={muted}>负责人 {role ? <a href={href(projectId, "roles")} className="hover:underline">{owner}</a> : owner}
      {role && role.state !== "active" && role.state !== "trial" && ` · 职责当前为 ${role.state}，请核对分工`}
      {snapshot.statuses[task.id]?.unsettledRunState && ` · 运行：${snapshot.statuses[task.id]!.unsettledRunState}`}</span>
  </li>;
}

function QueueItem({ item, snapshot, projectId, kind }: { item: SummaryItem; snapshot: Snapshot; projectId: string; kind: "current" | "next" | "held" }) {
  const { entry, queue } = item;
  const task = snapshot.tasks[entry.taskId];
  const validTask = taskMatchesQueue(task, entry);
  const taskName = task?.title?.trim() || `任务 ${short(entry.taskId)}`;
  const role = snapshot.roles[entry.roleId];
  const roleName = role?.proposal.title || `职责 ${short(entry.roleId)}`;
  const taskLink = href(projectId, "task", entry.taskId);
  const sessionLink = `${href(projectId, "sessions")}?session=${encodeURIComponent(`owned:${entry.sessionId}`)}`;
  const reason = entry.holdCode ? holdLabels[entry.holdCode] : "队列已暂停，原因待核对";
  const note = "rounded-md bg-warning-soft px-2 py-1 text-caption text-text-secondary";
  return <li className="flex flex-col gap-1 border-t border-border py-2.5 first:border-t-0">
    <a href={taskLink} className={cn("text-small font-medium", link)}>{taskName}</a>
    <span className={muted}><a href={href(projectId, "roles")} className="hover:underline">{roleName}</a> · <a href={sessionLink} className="hover:underline">智能体 {short(entry.sessionId)}</a></span>
    <span className={muted}>{kind === "current" ? "队列已领取／占用；实际运行状态请进原任务核对" : kind === "next" ? "下一顺位；启动仍须通过依赖、授权和智能体校验" : `${reason}${entry.holdReason ? `：${entry.holdReason}` : ""}`}</span>
    {!validTask && <span role="status" className={note}>任务负责人、状态或固定修订未核对一致；请以<a href={taskLink} className="underline">原任务</a>为准。</span>}
    {role && role.state !== "active" && role.state !== "trial" && <span role="status" className={note}>承接职责当前为 {role.state}，不能按正常承接理解；请核对<a href={href(projectId, "roles")} className="underline">分工记录</a>。</span>}
    {kind === "held" && entry.holdCode === "awaiting_acceptance" && <span className={muted}>待消费者 {entry.consumerId} 使用与验收；领取不代表验收完成。<a href={`${taskLink}?tab=runtime`} className="underline">核对原任务协作与交付</a></span>}
    {queue.adoptedVersion !== queue.version && <span className={muted}>队列 v{queue.version} 尚未采纳当前顺序。</span>}
  </li>;
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h2 className="text-label font-semibold text-foreground">{title}</h2>
    {children}
  </section>;
}

export function ProjectSummary({ token, projectId, refresh, active }: { token: string; projectId: string; refresh: number; active: boolean }) {
  const scope = `${projectId}:${token}`;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [reread, setReread] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    if (!active) return;
    const current = ++epoch.current;
    const controller = new AbortController();
    setPending(true); setError("");
    void readSnapshot(token, projectId, scope, controller.signal).then(value => {
      if (epoch.current === current && !controller.signal.aborted) setSnapshot(value);
    }).catch(cause => {
      if (epoch.current === current && !controller.signal.aborted) setError(errorText(cause));
    }).finally(() => {
      if (epoch.current === current && !controller.signal.aborted) setPending(false);
    });
    return () => { controller.abort(); epoch.current++; };
  }, [token, projectId, scope, refresh, reread, active]);
  useEffect(() => {
    const onFocus = () => { if (active && document.visibilityState === "visible") setReread(value => value + 1); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active]);
  const current = snapshot?.scope === scope ? snapshot : null;
  const selection = current ? selectSummary(current.queues) : null;
  const groups = current ? visibleWorkGroups(current.activeTasks, current.statuses, !!current.statusError && !Object.keys(current.statuses).length) : null;
  const stale = !!current && (pending || !!error);
  const read = current ? `观察于 ${date(current.observedAt)}${stale ? " · 上次读回，当前状态待核对" : ""}` : pending ? "正在读取项目摘要…" : "尚未读回项目摘要";
  const empty = (text: string) => <p className={muted}>{text}</p>;
  const card = "flex min-w-0 flex-col rounded-xl bg-raised px-4 py-3 shadow-sm compact:px-5";
  return <div data-ui="" className="project-overview mx-auto flex w-full max-w-[980px] flex-col gap-5 px-4 py-5 compact:px-8 compact:py-7">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>项目总览</h1>
        <p className="mt-1 text-small text-text-secondary">从目标差距、实际使用和当前责任判断下一步。</p>
        <p className={cn(muted, "mt-1")}>{read}</p>
      </div>
      <Button onClick={() => setReread(value => value + 1)} disabled={pending}><RefreshCw aria-hidden="true" className={pending ? "animate-spin" : undefined} />重新读取</Button>
    </header>
    {error && <Notice tone="error">摘要读取失败：{error}。{current ? "以下保留上次读回，不能视为当前状态。" : "请重试或进入原页面核对。"}</Notice>}
    {current?.failedNames ? <Notice tone="waiting">有 {current.failedNames} 个名称未读回；仅显示登记 ID，并保留原任务与承载入口。</Notice> : null}
    <ProjectContext token={token} projectId={projectId} refresh={refresh + reread} active={active} />

    <section className={cn(card, "overview-current-work")} aria-label="当前工作">
      <div className="flex items-center justify-between gap-2 pb-1"><h2 className="text-label font-semibold text-foreground">当前工作</h2><a href={href(projectId, "work")} className="flex items-center gap-1 text-caption text-text-secondary hover:text-foreground">全部工作 <ArrowRight size={13} aria-hidden="true" /></a></div>
      {groups?.primary.length ? <ul>{groups.primary.slice(0, 4).map(task => <ActiveTaskItem key={task.id} task={task} snapshot={current!} projectId={projectId} />)}</ul>
        : current && !stale && !current.taskScan.truncated ? empty("已读任务中没有可确认的进行中业务任务；判断接续与未分类记录见下方。")
          : current?.taskScan.truncated ? empty("已读范围内未见进行中的任务；后续任务尚未读到，不能判断项目为空。")
            : empty("进行中的任务待读回。")}
      {current?.statusError && empty(`工作分类暂不可读：${current.statusError}；上方保留已读任务，请到原任务核对。`)}
      {current && empty(`已读 ${current.taskScan.pages} 页，见到 ${current.taskScan.total} 项进行中。${current.taskScan.truncated ? "后续任务尚未读完。" : ""}`)}
    </section>
    {!!(groups?.cognition.length || groups?.unknown.length) && <details className={cn(card, "text-small")}>
      <summary className="cursor-pointer font-medium text-foreground">判断接续与来源待核对 · {(groups?.cognition.length ?? 0) + (groups?.unknown.length ?? 0)} 项</summary>
      <p className={cn(muted, "mt-1")}>这些任务仍保持原状态与责任；此处按已读结构化来源分组，打开原任务可查看完整依据。</p>
      <ul>{[...(groups?.cognition ?? []), ...(groups?.unknown ?? [])].map(task => <ActiveTaskItem key={task.id} task={task} snapshot={current!} projectId={projectId} />)}</ul>
    </details>}
    <ContextPanelContent>
      <div className="overview-panel flex flex-col gap-4">
        <PanelSection title="读取范围">
          <p className={muted}>队列摘要读取项目已登记的驻留队列；每轮最多展开并核对 12 个队列条目。{selection?.omitted ? `另有 ${selection.omitted} 个队列条目未展开。` : ""}</p>
        </PanelSection>
        <PanelSection title="约定执行">
          {current?.scheduled.length ? <ul>{current.scheduled.slice(0, 8).map(({ task, timing }) => {
            const latestDone = timing.occurrences.slice().reverse().find(item => item.state === "done");
            return <li key={task.id} className="flex flex-col gap-0.5 border-t border-border py-2.5 first:border-t-0">
              <a href={href(projectId, "task", task.id)} className={cn("text-small font-medium", link)}>{task.title}</a>
              <span className={muted}>本次 {formatScheduled(timing.executeAtUtc, timing.timezone)} · {repeatLabel(timing.repeat)} · {nextTimingLabel(timing)}</span>
              <span className={muted}>同系列最近 {timing.occurrences.length} 份
                {timing.previousTaskId && <> · <a href={href(projectId, "task", timing.previousTaskId)} className="hover:underline">上一份</a></>}
                {timing.nextTaskId && <> · <a href={href(projectId, "task", timing.nextTaskId)} className="hover:underline">后一份已生成任务</a></>}
                {latestDone ? <> · <a href={href(projectId, "task", latestDone.taskId)} className="hover:underline">最近已完成任务的结果</a></> : " · 尚无已完成结果"}
                {timing.waitingReason && ` · 等待：${timing.waitingReason}`}</span>
            </li>;
          })}</ul> : current && !stale ? empty("已读范围内没有约定执行的未结束任务。") : empty("约定执行任务待读回。")}
          {current && (current.timingScanLimited || current.timingReadFailed > 0) && empty(`最多核对已载入的前 60 项未结束任务；${current.timingReadFailed} 项执行时间未读回，完整范围请到任务列表核对。`)}
        </PanelSection>
        <PanelSection title="队列与承接">
          <p className={muted}>队列占用不等于任务进度，当前进度以原任务为准。{selection ? ` ${selection.total.held} 条暂停或待核记录。` : ""}</p>
          <section className="overview-queue flex flex-col">
            <h3 className="pt-1 text-caption font-semibold text-muted-foreground">待处理</h3>
            {selection?.held.length ? <ul>{selection.held.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="held" />)}</ul> : selection?.total.held === 0 && !stale ? empty("已读队列中没有暂停项。") : empty("暂停事项待读回。")}
            {!!selection?.omittedByKind.held && <p className={muted}>另有 {selection.omittedByKind.held} 项未展开。<a href={href(projectId, "runtime")} className="underline">查看完整队列</a></p>}
            <p className={muted}>任务讨论中的待答问题尚无项目级精确汇总，请在原任务核对。</p>
          </section>
          <section className="overview-queue flex flex-col">
            <h3 className="pt-1 text-caption font-semibold text-muted-foreground">现在由谁承接</h3>
            {selection?.current.length ? <ul>{selection.current.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="current" />)}</ul> : selection?.total.current === 0 && !stale ? empty("已读队列范围内没有确认的领取占用。") : !selection?.omittedByKind.current ? empty("当前占用待读回。") : null}
            {!!selection?.omittedByKind.current && <p role="status" className={muted}>另有 {selection.omittedByKind.current} 项当前占用未展开；请看<a href={href(projectId, "runtime")} className="underline">完整队列</a>。</p>}
          </section>
          <section className="overview-queue flex flex-col">
            <h3 className="pt-1 text-caption font-semibold text-muted-foreground">下一项</h3>
            {selection?.next.length ? <ul>{selection.next.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="next" />)}</ul> : selection?.total.next === 0 && !stale ? empty("已采纳队列中没有读到下一顺位。") : !selection?.omittedByKind.next ? empty("下一顺位待读回。") : null}
            {!!selection?.omittedByKind.next && <p role="status" className={muted}>另有 {selection.omittedByKind.next} 项下一顺位未展开；请看<a href={href(projectId, "runtime")} className="underline">完整队列</a>。</p>}
          </section>
          <div className="flex flex-wrap gap-3 text-small"><a href={href(projectId, "runtime")} className="underline">分工与承载</a><a href={href(projectId, "inbox")} className="underline">待判断与复核</a></div>
        </PanelSection>
      </div>
    </ContextPanelContent>
  </div>;
}
