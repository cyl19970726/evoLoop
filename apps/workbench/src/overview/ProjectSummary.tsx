import { useEffect, useRef, useState } from "react";
import type { Task, TaskDetail } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { ResidentQueue, QueueHoldCode } from "@evoloop/contracts/queues";
import { api, errorText, request } from "../api";
import { queueClient } from "../queues/client";
import { Alert, date, href } from "../ui/shared";
import { isRoleOwnerId, readOwnerRole } from "../workflow/ownerRole";
import { scanProjectTasks, selectSummary, taskMatchesQueue, type SummaryItem } from "./summary";
import { visibleWorkGroups, type WorkTaskStatus } from "../workflow/workStatusPresentation";

import { ProjectContext } from "./ProjectContext";
import "./overview.css";

interface Snapshot {
  scope: string;
  queues: ResidentQueue[];
  activeTasks: Task[];
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
  return { scope, queues, activeTasks: shownActive, taskScan: { total: activeTasks.length, truncated: scan.truncated, pages: scan.pages },
    tasks, roles, statuses, statusError, failedNames, observedAt: new Date().toISOString() };
}

function ActiveTaskItem({ task, snapshot, projectId }: { task: Task; snapshot: Snapshot; projectId: string }) {
  const role = isRoleOwnerId(task.owner) ? snapshot.roles[task.owner] : undefined;
  const owner = role?.proposal.title?.trim() || (isRoleOwnerId(task.owner) ? `职责 ${short(task.owner)}` : task.owner || "负责人未登记");
  return <li><a href={href(projectId, "task", task.id)}>{task.title?.trim() || `任务 ${short(task.id)}`}</a> · 负责人 {role ? <a href={href(projectId, "roles")}>{owner}</a> : owner}
    {role && role.state !== "active" && role.state !== "trial" && <span> · 职责当前为 {role.state}，请核对分工</span>}
    {snapshot.statuses[task.id]?.unsettledRunState && <div className="muted">运行：{snapshot.statuses[task.id]!.unsettledRunState}</div>}
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
  const sessionLink = `${href(projectId, "runtime")}?session=${encodeURIComponent(entry.sessionId)}`;
  const reason = entry.holdCode ? holdLabels[entry.holdCode] : "队列已暂停，原因待核对";
  return <li>
    <a href={taskLink}>{taskName}</a> · <a href={href(projectId, "roles")}>{roleName}</a> · <a href={sessionLink}>Session {short(entry.sessionId)}</a>
    <div className="muted">{kind === "current" ? "队列已领取／占用；实际 Run 状态请进原任务核对" : kind === "next" ? "下一顺位；启动仍须通过依赖、授权和会话校验" : `${reason}${entry.holdReason ? `：${entry.holdReason}` : ""}`}</div>
    {!validTask && <div role="status">任务负责人、状态或固定修订未核对一致；请以<a href={taskLink}>原任务</a>为准。</div>}
    {role && role.state !== "active" && role.state !== "trial" && <div role="status">承接职责当前为 {role.state}，不能按正常承接理解；请核对<a href={href(projectId, "roles")}>分工记录</a>。</div>}
    {kind === "held" && entry.holdCode === "awaiting_acceptance" && <div>待消费者 {entry.consumerId} 使用与验收；领取不代表验收完成。<a href={`${taskLink}?tab=runtime`}>核对原任务协作与交付</a></div>}
    {queue.adoptedVersion !== queue.version && <div>队列 v{queue.version} 尚未采纳当前顺序。</div>}
  </li>;
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
  return <div className="content project-overview"><h1 tabIndex={-1}>项目总览</h1>
    <p className="lede">从目标差距、实际使用和当前责任判断下一步。</p>
    <p className="muted">{current ? `观察于 ${date(current.observedAt)}${stale ? " · 上次读回，当前状态待核对" : ""}` : pending ? "正在读取项目摘要…" : "尚未读回项目摘要"}　<button type="button" onClick={() => setReread(value => value + 1)} disabled={pending}>重新读取</button></p>
    {error && <Alert kind="error">摘要读取失败：{error}。{current ? "以下保留上次读回，不能视为当前状态。" : "请重试或进入原页面核对。"}</Alert>}
    {current?.failedNames ? <Alert>有 {current.failedNames} 个名称未读回；仅显示登记 ID，并保留原任务与承载入口。</Alert> : null}
    <ProjectContext token={token} projectId={projectId} refresh={refresh + reread} active={active} />
    <div className="context-links"><a href={href(projectId, "work")}>全部任务</a><a href={href(projectId, "runtime")}>分工与承载</a><a href={href(projectId, "inbox")}>待判断与复核</a></div>
    <section className="panel"><h2>当前业务任务</h2>
      {groups?.primary.length ? <ul>{groups.primary.slice(0,4).map(task => <ActiveTaskItem key={task.id} task={task} snapshot={current!} projectId={projectId} />)}</ul>
        : current && !stale && !current.taskScan.truncated ? <p className="empty">已读任务中没有可确认的进行中业务任务；判断接续与未分类记录见下方。</p>
          : current?.taskScan.truncated ? <p>已读范围内未见进行中的任务；后续任务尚未读到，不能判断项目为空。</p>
            : <p>进行中的任务待读回。</p>}
      {current?.statusError && <p className="muted">工作分类暂不可读：{current.statusError}；上方保留已读任务，请到原任务核对。</p>}
      {current && <p className="muted">已读 {current.taskScan.pages} 页，见到 {current.taskScan.total} 项进行中。{current.taskScan.truncated ? "后续任务尚未读完。" : ""} <a href={href(projectId, "work")}>查看全部任务</a></p>}
    </section>
    <details className="panel overview-queue-details"><summary>队列与承接明细{selection ? ` · ${selection.total.held} 条暂停或待核记录` : ""}</summary><p className="muted">队列占用、下一顺位和历史待核记录；当前任务进度仍以原任务为准。</p>
    <section className="panel"><h2>待处理</h2>
      {selection?.held.length ? <ul>{selection.held.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="held" />)}</ul> : selection?.total.held === 0 && !stale ? <p className="empty">已读队列中没有暂停项。</p> : <p>暂停事项待读回。</p>}
      {!!selection?.omittedByKind.held && <p>另有 {selection.omittedByKind.held} 项未展开。<a href={href(projectId, "runtime")}>查看完整队列</a></p>}
      <p className="muted">任务讨论中的待答问题尚无项目级精确汇总，请在原任务核对。</p>
    </section>
    <section className="panel"><h2>现在由谁承接</h2>
      {selection?.current.length ? <ul>{selection.current.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="current" />)}</ul> : selection?.total.current === 0 && !stale ? <p className="empty">已读队列范围内没有确认的领取占用。</p> : !selection?.omittedByKind.current ? <p>当前占用待读回。</p> : null}
      {!!selection?.omittedByKind.current && <p role="status">另有 {selection.omittedByKind.current} 项当前占用未展开；请看<a href={href(projectId, "runtime")}>完整队列</a>。</p>}
    </section>
    <section className="panel"><h2>下一项</h2>
      {selection?.next.length ? <ul>{selection.next.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="next" />)}</ul> : selection?.total.next === 0 && !stale ? <p className="empty">已采纳队列中没有读到下一顺位。</p> : !selection?.omittedByKind.next ? <p>下一顺位待读回。</p> : null}
      {!!selection?.omittedByKind.next && <p role="status">另有 {selection.omittedByKind.next} 项下一顺位未展开；请看<a href={href(projectId, "runtime")}>完整队列</a>。</p>}
    </section>
    </details>
    {!!(groups?.cognition.length || groups?.unknown.length) && <details className="panel"><summary>判断接续与来源待核对 · {(groups?.cognition.length ?? 0) + (groups?.unknown.length ?? 0)} 项</summary>
      <p>这些任务仍保持原状态与责任；此处按已读结构化来源分组，打开原任务可查看完整依据。</p>
      <ul>{[...(groups?.cognition ?? []), ...(groups?.unknown ?? [])].map(task => <ActiveTaskItem key={task.id} task={task} snapshot={current!} projectId={projectId} />)}</ul>
    </details>}
    <p className="muted">队列摘要范围：读取项目已登记驻留队列列表；每轮最多展示并核对 12 个队列条目的任务与职责名称。{selection?.omitted ? `另有 ${selection.omitted} 个队列条目未展开。` : "未入队任务请看上方进行中的任务。"}完整任务与队列请分别进入任务列表和分工与承载。</p>
  </div>;
}
