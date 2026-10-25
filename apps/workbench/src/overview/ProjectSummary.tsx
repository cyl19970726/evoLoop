import { useEffect, useRef, useState } from "react";
import type { Task, TaskDetail } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { ResidentQueue, QueueHoldCode } from "@evoloop/contracts/queues";
import { errorText, request } from "../api";
import { queueClient } from "../queues/client";
import { Alert, date, href } from "../ui/shared";
import { selectSummary, taskMatchesQueue, type SummaryItem } from "./summary";

interface Snapshot {
  scope: string;
  queues: ResidentQueue[];
  tasks: Record<string, Task>;
  roles: Record<string, RoleRecord>;
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
  const queues = await queueClient(token, projectId).list();
  if (signal.aborted) throw new Error("读取已取消");
  if (queues.some(queue => queue.projectId !== projectId || queue.entries.some(entry => entry.projectId !== projectId || entry.queueId !== queue.id)))
    throw new Error("队列响应与当前项目不符");
  const selection = selectSummary(queues);
  const entries = [...selection.current, ...selection.next, ...selection.held];
  const taskIds = [...new Set(entries.map(item => item.entry.taskId))];
  const roleIds = [...new Set(entries.map(item => item.entry.roleId))];
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const work = [
    ...taskIds.map(id => ({ kind: "task" as const, id })),
    ...roleIds.map(id => ({ kind: "role" as const, id })),
  ];
  const tasks: Record<string, Task> = {}, roles: Record<string, RoleRecord> = {};
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
          const result = await request<RoleRecord>(token, `${base}/roles/${encodeURIComponent(item.id)}`, 15000, { signal });
          if (result.projectId !== projectId || result.id !== item.id || !result.proposal.title.trim()) throw new Error("职责响应不匹配");
          roles[item.id] = result;
        }
      } catch { if (!signal.aborted) failedNames++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, work.length) }, () => worker()));
  if (signal.aborted) throw new Error("读取已取消");
  return { scope, queues, tasks, roles, failedNames, observedAt: new Date().toISOString() };
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
  const stale = !!current && (pending || !!error);
  return <div className="content"><h1 tabIndex={-1}>项目总览</h1>
    <p className="lede">已登记驻留队列中的当前占用、下一顺位与暂停事项。</p>
    <div className="context-links"><a href={href(projectId, "work")}>全部任务</a><a href={href(projectId, "runtime")}>分工与承载</a><a href={href(projectId, "inbox")}>待判断与复核</a></div>
    <p className="muted">{current ? `观察于 ${date(current.observedAt)}${stale ? " · 上次读回，当前状态待核对" : ""}` : pending ? "正在读取项目摘要…" : "尚未读回项目摘要"}　<button type="button" onClick={() => setReread(value => value + 1)} disabled={pending}>重新读取</button></p>
    {error && <Alert kind="error">摘要读取失败：{error}。{current ? "以下保留上次读回，不能视为当前状态。" : "请重试或进入原页面核对。"}</Alert>}
    {current?.failedNames ? <Alert>有 {current.failedNames} 个名称未读回；仅显示登记 ID，并保留原任务与承载入口。</Alert> : null}
    <section className="panel"><h2>现在由谁承接</h2>
      {selection?.current.length ? <ul>{selection.current.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="current" />)}</ul> : current && !stale ? <p className="empty">已读队列范围内没有确认的领取占用。</p> : <p>当前占用待读回。</p>}
    </section>
    <section className="panel"><h2>下一项</h2>
      {selection?.next.length ? <ul>{selection.next.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="next" />)}</ul> : current && !stale ? <p className="empty">已采纳队列中没有读到下一顺位。</p> : <p>下一顺位待读回。</p>}
    </section>
    <section className="panel"><h2>哪里需要判断</h2>
      {selection?.held.length ? <ul>{selection.held.map(item => <QueueItem key={item.entry.id} item={item} snapshot={current!} projectId={projectId} kind="held" />)}</ul> : current && !stale ? <p className="empty">已读队列范围内没有暂停项。</p> : <p>暂停事项待读回。</p>}
      <p>任务协作中的待答问题尚无项目级精确汇总；请从<a href={href(projectId, "work")}>任务列表</a>进入原任务的“协作与待处理问题”核对。</p>
    </section>
    <p className="muted">范围：项目已登记驻留队列，每轮最多展示 12 项占用、暂停与顺位；{selection?.omitted ? `另有 ${selection.omitted} 项未展开。` : "其他任务不计入此摘要。"}完整任务与队列请分别进入任务列表和分工与承载。</p>
  </div>;
}
