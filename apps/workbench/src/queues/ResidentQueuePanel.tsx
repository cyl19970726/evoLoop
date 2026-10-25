import { useEffect, useRef, useState } from "react";
import type { ResidentQueue, ResidentQueueEntry, QueueHoldCode } from "@evoloop/contracts/queues";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { Task } from "@evoloop/contracts";
import { errorText } from "../api";
import { href } from "../ui/shared";
import { queueClient, type EntryAttempts } from "./client";
import "./residentQueue.css";

const key = encodeURIComponent;
const short = (id: string) => id.slice(0, 8);
const holdLabel: Record<QueueHoldCode, string> = {
  not_adopted: "队列尚未采纳", task_changed: "任务修订已变化", task_unavailable: "任务不可承接",
  dependency: "依赖尚未放行", session_unready: "会话尚未就绪", binding_changed: "职责绑定已变化",
  grant_revoked: "授权已撤销", occupied: "会话已占用", run_in_flight: "运行仍在途",
  unknown: "运行结果未知", awaiting_acceptance: "等待消费者使用与验收", budget_exhausted: "累计尝试达上限",
  manual_review: "等待人工复核",
};

export function ResidentQueuePanel({ token, projectId, refresh, task, runs, sessions }: {
  token: string; projectId: string; refresh: number; task?: Task; runs: RuntimeRunRecord[]; sessions: RuntimeSessionRecord[];
}) {
  const [queues, setQueues] = useState<ResidentQueue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [observedAt, setObservedAt] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const [listReadVersion, setListReadVersion] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void queueClient(token, projectId).list().then(items => {
      if (!active) return;
      if (items.some(item => item.projectId !== projectId)) throw new Error("队列响应与当前项目不符");
      setQueues(items); setListReadVersion(value => value + 1); setObservedAt(new Date().toLocaleString("zh-CN"));
    }).catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, projectId, refresh, readVersion]);
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible" && rootRef.current?.getClientRects().length) setReadVersion(value => value + 1); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);
  const visible = task ? queues.filter(queue => queue.entries.some(entry => entry.taskId === task.id)) : queues;
  return <section className="resident-queues" ref={rootRef} aria-label="驻留 Session 队列">
    <div className="resident-queues-head"><h3>驻留 Session 队列</h3><button type="button" onClick={() => setReadVersion(value => value + 1)}>重新读取队列</button></div>
    <p className="resident-queue-observed">{loading ? "正在核对队列…" : observedAt ? `队列读于 ${observedAt}` : "队列尚未读回"}</p>
    {error && <p role="alert" className="resident-queue-error">队列回读失败：{error}。下面是上次读回，不能视为当前状态。</p>}
    {!loading && !error && visible.length === 0 && <p className="empty">{task ? "此任务尚未见于已登记驻留队列。" : "尚无已登记驻留队列。"}</p>}
    {visible.map(queue => <QueueCard key={queue.id} token={token} projectId={projectId} queue={queue} refresh={refresh} listReadVersion={listReadVersion}
      task={task} runs={runs} sessions={sessions} />)}
  </section>;
}

function QueueCard({ token, projectId, queue, refresh, listReadVersion, task, runs, sessions }: {
  token: string; projectId: string; queue: ResidentQueue; refresh: number; listReadVersion: number; task?: Task;
  runs: RuntimeRunRecord[]; sessions: RuntimeSessionRecord[];
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ResidentQueue | null>(null);
  const [attemptRows, setAttemptRows] = useState<EntryAttempts[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const [observedAt, setObservedAt] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError(""); setDetail(null); setAttemptRows(null); setObservedAt("");
    const client = queueClient(token, projectId);
    void Promise.all([client.detail(queue.id), client.attempts(queue.id)]).then(([current, rows]) => {
      if (!active) return;
      if (current.projectId !== projectId || current.id !== queue.id || rows.some(row => row.attempts.some(attempt => attempt.projectId !== projectId)))
        throw new Error("队列详情或尝试记录不属于当前项目");
      setDetail(current); setAttemptRows(rows); setObservedAt(new Date().toLocaleString("zh-CN"));
    }).catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, token, projectId, queue.id, queue.version, refresh, listReadVersion, readVersion]);
  const shown = detail ?? queue;
  const groups = new Map<string, ResidentQueueEntry[]>();
  for (const entry of [...shown.entries].sort((a, b) => a.position - b.position)) {
    groups.set(entry.sessionId, [...(groups.get(entry.sessionId) ?? []), entry]);
  }
  const attempts = new Map(attemptRows?.map(row => [row.entryId, row.attempts]) ?? []);
  const total = attemptRows?.reduce((sum, row) => sum + row.attempts.length, 0);
  return <details className="resident-queue-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>队列 {short(queue.id)} · v{queue.version} · {queue.adoptedVersion === null ? "未采纳" : `已采纳 v${queue.adoptedVersion}`} · {queue.entries.length} 项</summary>
    {open && <>
      <div className="resident-queue-meta"><span>排序理由：{shown.reason}</span><span>总运行上限 {shown.maxRuns}；累计尝试 {total ?? "待读回"}</span><span>{observedAt ? `详情读于 ${observedAt}` : "详情尚未读回"}</span><button type="button" onClick={() => setReadVersion(value => value + 1)}>回读详情与尝试</button></div>
      {loading && <p>正在读取队列详情与尝试…</p>}
      {error && <p role="alert" className="resident-queue-error">详情回读失败：{error}。下面是上次读回，不能视为当前状态。</p>}
      {[...groups].map(([sessionId, entries]) => {
        const session = sessions.find(value => value.id === sessionId);
        let priorReleased = true;
        const current = entries.find(entry => entry.state === "claimed");
        const next = entries.find(entry => entry.state === "queued");
        return <div className="resident-queue-session" key={sessionId}>
          <h4>原 Session <a href={`${href(projectId, "runtime")}?session=${key(sessionId)}`}>{short(sessionId)}</a> <small>{session ? `· ${session.state}` : "· 会话状态未在此视图读到"}</small></h4>
          <p>当前占用：{current ? `任务 ${short(current.taskId)}` : "无已确认占用项"}；后续顺位：{next ? `任务 ${short(next.taskId)}（不代表可启动）` : "无"}</p>
          <ol>{entries.map(entry => {
            const state = entry.state === "released" ? "已放行" : entry.state === "held" ? "暂停" : entry.state === "claimed" ? "已领取／占用" :
              shown.adoptedVersion === null ? "未采纳，不能派发" : priorReleased ? "后续顺位，待调度校验" : "等待前项放行";
            const before = priorReleased;
            if (entry.state !== "released") priorReleased = false;
            const currentAttempts = attempts.get(entry.id) ?? [];
            const last = currentAttempts.at(-1);
            const run = last ? runs.find(value => value.id === last.runId && value.taskId === entry.taskId) : undefined;
            return <li key={entry.id} className={task?.id === entry.taskId ? "queue-current-task" : ""}>
              <div><strong>第 {entry.position + 1} 项 · {state}</strong> <a href={`${href(projectId, "task", entry.taskId)}?tab=runtime${last ? `&run=${key(last.runId)}` : ""}`}>{task?.id === entry.taskId ? task.title : `任务 ${short(entry.taskId)}`}</a></div>
              <p>固定任务修订 <code>{short(entry.taskRevisionId)}</code> · 承接职责 <code>{short(entry.roleId)}</code> · 消费者 {entry.consumerId} · 放行规则 {entry.releaseRule === "accepted" ? entry.useRequired ? "消费者实际使用并验收" : "消费者验收" : "有界人工决定"}</p>
              {entry.dependsOn.length > 0 && <p>依赖放行：{entry.dependsOn.map(short).join("、")}</p>}
              {entry.holdCode && <p className="resident-queue-hold">{holdLabel[entry.holdCode]}{entry.holdReason ? `：${entry.holdReason}` : ""}</p>}
              {entry.state === "claimed" && <p>此项占用当前 Session；后项即使已有序号也不表示已启动。</p>}
              {entry.state === "claimed" && run && ["completed", "failed", "interrupted"].includes(run.state) && <p>本轮运行已结束，仍占用 Session；等待交付／验收或明确接续，不代表后项已经运行。</p>}
              {entry.state === "queued" && before && shown.adoptedVersion !== null && <p>还需核对当前任务修订、依赖、授权、会话及占用；这里只表示顺位。</p>}
              {last ? <p>累计尝试 {currentAttempts.length} 次 · <a href={`${href(projectId, "task", entry.taskId)}?tab=runtime&run=${key(last.runId)}`}>最近 Run {short(last.runId)}</a> · {run ? `已读运行状态 ${run.state}` : "Run 状态尚未在此视图读到"}</p> : <p>累计尝试 {attemptRows ? 0 : "待读回"} 次；没有已读到的 Run。</p>}
            </li>;
          })}</ol>
        </div>;
      })}
    </>}
  </details>;
}
