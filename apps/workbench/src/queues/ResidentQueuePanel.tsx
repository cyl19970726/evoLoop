import { useEffect, useRef, useState } from "react";
import type { ResidentQueue, ResidentQueueEntry, QueueHoldCode } from "@evoloop/contracts/queues";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { Task } from "@evoloop/contracts";
import type { TaskDetail } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { errorText, request } from "../api";
import { href } from "../ui/shared";
import { queueClient, type EntryAttempts } from "./client";
import { ActionForm, option, reasonField, type MutationContext } from "../workflow/ActionForm";
import "./residentQueue.css";

const key = encodeURIComponent;
const short = (id: string) => id.slice(0, 8);
const maxNamedEntries = 24;
const sessionStateLabel: Record<RuntimeSessionRecord["state"], string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "状态待核对", closed: "已关闭",
};
const holdLabel: Record<QueueHoldCode, string> = {
  not_adopted: "队列尚未采纳", task_changed: "任务修订已变化", task_unavailable: "任务不可承接",
  dependency: "依赖尚未放行", session_unready: "会话尚未就绪", binding_changed: "职责绑定已变化",
  grant_revoked: "授权已撤销", occupied: "会话已占用", run_in_flight: "运行仍在途",
  unknown: "运行结果未知", awaiting_acceptance: "等待消费者使用与验收", budget_exhausted: "累计尝试达上限",
  manual_review: "等待人工复核",
};

export function ResidentQueuePanel({ context, token, projectId, refresh, task, sessionId, runs, sessions }: {
  context: MutationContext; token: string; projectId: string; refresh: number; task?: Task; sessionId?: string; runs: RuntimeRunRecord[]; sessions: RuntimeSessionRecord[];
}) {
  const [queues, setQueues] = useState<ResidentQueue[]>([]);
  const [queueScope, setQueueScope] = useState("");
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
      setQueues(items); setQueueScope(`${projectId}:${token}`); setListReadVersion(value => value + 1); setObservedAt(new Date().toLocaleString("zh-CN"));
    }).catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, projectId, refresh, readVersion]);
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible" && rootRef.current?.getClientRects().length) setReadVersion(value => value + 1); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);
  const currentQueues = queueScope === `${projectId}:${token}` ? queues : [];
  const visible = task || sessionId ? currentQueues.filter(queue => queue.entries.some(entry => (!task || entry.taskId === task.id) && (!sessionId || entry.sessionId === sessionId))) : currentQueues;
  return <section className="resident-queues" ref={rootRef} aria-label="驻留 Session 队列">
    <div className="resident-queues-head"><h3>驻留 Session 队列</h3><button type="button" onClick={() => setReadVersion(value => value + 1)}>重新读取队列</button></div>
    <p className="resident-queue-observed">{loading || queueScope !== `${projectId}:${token}` && !error ? "正在核对队列…" : queueScope === `${projectId}:${token}` && observedAt ? `队列读于 ${observedAt}` : "队列尚未读回"}</p>
    {error && <p role="alert" className="resident-queue-error">队列回读失败：{error}。下面是上次读回，不能视为当前状态。</p>}
    {!loading && !error && queueScope === `${projectId}:${token}` && visible.length === 0 && <p className="empty">{sessionId ? "此 Session 尚未见于已登记驻留队列。" : task ? "此任务尚未见于已登记驻留队列。" : "尚无已登记驻留队列。"}</p>}
    {visible.map(queue => <QueueCard key={`${projectId}:${queue.id}`} context={context} token={token} projectId={projectId} queue={queue} refresh={refresh} listReadVersion={listReadVersion}
      task={task} sessionId={sessionId} runs={runs} sessions={sessions} />)}
  </section>;
}

function QueueCard({ context, token, projectId, queue, refresh, listReadVersion, task, sessionId, runs, sessions }: {
  context: MutationContext; token: string; projectId: string; queue: ResidentQueue; refresh: number; listReadVersion: number; task?: Task; sessionId?: string;
  runs: RuntimeRunRecord[]; sessions: RuntimeSessionRecord[];
}) {
  const [open, setOpen] = useState(false);
  const cardRef = useRef<HTMLDetailsElement>(null);
  const [detail, setDetail] = useState<ResidentQueue | null>(null);
  const [attemptRows, setAttemptRows] = useState<EntryAttempts[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const [observedAt, setObservedAt] = useState("");
  const [names, setNames] = useState<{ scope: string; tasks: Record<string, string>; roles: Record<string, string>; failed: string[] }>({ scope: "", tasks: {}, roles: {}, failed: [] });
  useEffect(() => { if (sessionId && cardRef.current) { cardRef.current.open = true; setOpen(true); } }, [sessionId]);
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
  const namedEntries = shown.entries.filter(item => !sessionId || item.sessionId === sessionId).sort((a, b) => a.position - b.position);
  const groups = new Map<string, ResidentQueueEntry[]>();
  for (const entry of namedEntries) groups.set(entry.sessionId, [...(groups.get(entry.sessionId) ?? []), entry]);
  const priorityEntries = [...groups.values()].flatMap(entries => [
    entries.find(entry => entry.state === "claimed"), entries.find(entry => entry.state === "queued"),
  ].filter((entry): entry is ResidentQueueEntry => !!entry));
  const selectedIds = new Set<string>();
  const lookupEntries = [...priorityEntries, ...namedEntries].filter(entry => {
    if (selectedIds.has(entry.id)) return false;
    selectedIds.add(entry.id); return true;
  }).slice(0, maxNamedEntries);
  const nameScope = `${projectId}|${queue.id}|${sessionId ?? ""}|${listReadVersion}|${readVersion}|${namedEntries.map(entry => `${entry.id}:${entry.taskId}:${entry.roleId}`).join("|")}|priority:${lookupEntries.map(entry => entry.id).join(",")}`;
  useEffect(() => {
    if (!open) return;
    let active = true;
    const controller = new AbortController();
    setNames({ scope: nameScope, tasks: {}, roles: {}, failed: [] });
    const tasks = [...new Set(lookupEntries.map(entry => entry.taskId))].filter(id => id !== task?.id);
    const roles = [...new Set(lookupEntries.map(entry => entry.roleId))];
    const work: Array<{ kind: "task" | "role"; id: string }> = [
      ...tasks.map(id => ({ kind: "task" as const, id })), ...roles.map(id => ({ kind: "role" as const, id })),
    ];
    let cursor = 0;
    const base = `/api/projects/${key(projectId)}`;
    async function worker() {
      while (active && cursor < work.length) {
        const item = work[cursor++]!;
        try {
          const record = item.kind === "task"
            ? (await request<TaskDetail>(token, `${base}/tasks/${key(item.id)}`, 15000, { signal: controller.signal })).task
            : await request<RoleRecord>(token, `${base}/roles/${key(item.id)}`, 15000, { signal: controller.signal });
          if (!active) return;
          if (record.projectId !== projectId || record.id !== item.id) throw new Error("名称响应与当前项目或对象不符");
          const title = item.kind === "task" ? (record as Task).title : (record as RoleRecord).proposal.title;
          if (!title?.trim()) throw new Error("名称尚未登记");
          setNames(previous => previous.scope === nameScope ? {
            ...previous, [item.kind === "task" ? "tasks" : "roles"]: {
              ...previous[item.kind === "task" ? "tasks" : "roles"], [item.id]: title,
            },
          } : previous);
        } catch {
          if (active) setNames(previous => previous.scope === nameScope ? { ...previous, failed: [...previous.failed, item.id] } : previous);
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, work.length) }, () => worker()));
    return () => { active = false; controller.abort(); };
  }, [open, token, projectId, nameScope, task?.id]);
  const currentNames: { tasks: Record<string, string>; roles: Record<string, string>; failed: string[] } =
    names.scope === nameScope ? names : { tasks: {}, roles: {}, failed: [] };
  const taskName = (id: string) => task?.id === id ? task.title : currentNames.tasks[id] ?? `任务 ${short(id)}`;
  const roleName = (id: string) => currentNames.roles[id] ?? `职责 ${short(id)}`;
  const attempts = new Map(attemptRows?.map(row => [row.entryId, row.attempts]) ?? []);
  const total = attemptRows?.reduce((sum, row) => sum + row.attempts.length, 0);
  return <details ref={cardRef} className="resident-queue-card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>队列 {short(queue.id)} · v{queue.version} · {queue.adoptedVersion === null ? "未采纳" : `已采纳 v${queue.adoptedVersion}`} · {queue.entries.length} 项</summary>
    {open && <>
      <div className="resident-queue-meta"><span>排序理由：{shown.reason}</span><span>总运行上限 {shown.maxRuns}；累计尝试 {total ?? "待读回"}</span><span>{observedAt ? `详情读于 ${observedAt}` : "详情尚未读回"}</span><button type="button" onClick={() => setReadVersion(value => value + 1)}>回读详情与尝试</button></div>
      {loading && <p>正在读取队列详情与尝试…</p>}
      {error && <p role="alert" className="resident-queue-error">详情回读失败：{error}。下面是上次读回，不能视为当前状态。</p>}
      {namedEntries.length > maxNamedEntries && <p className="resident-queue-observed">本轮优先核对当前占用与各 Session 下一顺位，最多 {maxNamedEntries} 项名称；其余条目保留 ID，请打开任务核实。</p>}
      {currentNames.failed.length > 0 && <p className="resident-queue-observed">部分名称未读回，已保留对象 ID 供核对。</p>}
      {!loading && !error && <div className="resident-queue-actions">
        {shown.adoptedVersion !== shown.version && <ActionForm context={context} review title="采纳当前队列顺序" fields={[]}
          build={() => ({ type: "queue.adopt", queueId: shown.id, expectedVersion: shown.version })} />}
        {shown.entries.filter(entry => entry.state === "queued" || entry.state === "held").length > 1 && <ActionForm context={context} review title="调整队列顺序" fields={[
          { name: "entryId", label: "要提前的任务", kind: "select", options: shown.entries.filter(entry => entry.state === "queued" || entry.state === "held").map(entry => option(entry.id, `${taskName(entry.taskId)} · 当前第 ${entry.position + 1} 项`)) }, reasonField,
        ]} build={v => { const ids = [...shown.entries].sort((a,b) => a.position-b.position).map(entry => entry.id); const at = ids.indexOf(v.entryId);
          if (at <= 0) throw new Error("此任务已是第一项，请选择后续任务"); [ids[at-1],ids[at]]=[ids[at]!,ids[at-1]!];
          return { type: "queue.reorder", queueId: shown.id, expectedVersion: shown.version, entryIds: ids, reason: v.reason }; }} />}
        {task && shown.entries.some(entry => entry.taskId === task.id && entry.taskRevisionId !== task.currentRevisionId && entry.state === "queued") && <ActionForm context={context} review title="按当前任务修订更新队列项" fields={[reasonField]}
          build={v => ({ type: "queue.amend", queueId: shown.id, expectedVersion: shown.version,
            entryId: shown.entries.find(entry => entry.taskId === task.id && entry.taskRevisionId !== task.currentRevisionId && entry.state === "queued")!.id,
            taskRevisionId: task.currentRevisionId, reason: v.reason })} />}
      </div>}
      {[...groups].map(([sessionId, entries]) => {
        const session = sessions.find(value => value.id === sessionId);
        let priorReleased = true;
        const current = entries.find(entry => entry.state === "claimed");
        const next = entries.find(entry => entry.state === "queued");
        return <div className="resident-queue-session" key={sessionId}>
          <h4>原 Session <a href={`${href(projectId, "sessions")}?session=${key(`owned:${sessionId}`)}`}>{short(sessionId)}</a> <small>{session ? `· ${sessionStateLabel[session.state] ?? session.state}` : "· 会话状态未在此视图读到"}</small></h4>
          <p className="resident-queue-id">Session ID <code>{sessionId}</code></p>
          <p>当前占用：{current ? <>{taskName(current.taskId)} <code>{short(current.taskId)}</code></> : "无已确认占用项"}；后续顺位：{next ? <>{taskName(next.taskId)} <code>{short(next.taskId)}</code>（不代表可启动）</> : "无"}</p>
          <ol>{entries.map(entry => {
            const state = entry.state === "released" ? "已放行" : entry.state === "held" ? "暂停" : entry.state === "claimed" ? "已领取／占用" :
              shown.adoptedVersion === null ? "未采纳，不能派发" : priorReleased ? "后续顺位，待调度校验" : "等待前项放行";
            const before = priorReleased;
            if (entry.state !== "released") priorReleased = false;
            const currentAttempts = attempts.get(entry.id) ?? [];
            const last = currentAttempts.at(-1);
            const run = last ? runs.find(value => value.id === last.runId && value.taskId === entry.taskId) : undefined;
            return <li key={entry.id} className={task?.id === entry.taskId ? "queue-current-task" : ""}>
              <div><strong>第 {entry.position + 1} 项 · {state}</strong> <a href={`${href(projectId, "task", entry.taskId)}?tab=runtime${last ? `&run=${key(last.runId)}` : ""}`}>{taskName(entry.taskId)}</a></div>
              <p className="resident-queue-id">任务 ID <code>{entry.taskId}</code> · 固定修订 <code>{short(entry.taskRevisionId)}</code></p>
              <p>承接职责 <a href={href(projectId, "roles")}>{roleName(entry.roleId)}</a> <code>{short(entry.roleId)}</code> · 消费者 {entry.consumerId} · 放行规则 {entry.releaseRule === "accepted" ? entry.useRequired ? "消费者实际使用并验收" : "消费者验收" : "有界人工决定"}</p>
              {entry.dependsOn.length > 0 && <p>依赖放行：{entry.dependsOn.map(short).join("、")}</p>}
              {entry.holdCode && <p className="resident-queue-hold">{holdLabel[entry.holdCode]}{entry.holdReason ? `：${entry.holdReason}` : ""}</p>}
              {!loading && !error && entry.state === "queued" && <ActionForm context={context} review title={`暂停此任务队列项 · ${taskName(entry.taskId)}`} fields={[reasonField]}
                build={v => ({ type: "queue.hold", queueId: shown.id, entryId: entry.id, reason: v.reason })} />}
              {!loading && !error && entry.state === "held" && <ActionForm context={context} review title={`解除此任务队列项暂停 · ${taskName(entry.taskId)}`} fields={[reasonField]}
                build={v => ({ type: "queue.unhold", queueId: shown.id, entryId: entry.id, expectedEntryVersion: entry.version, reason: v.reason })} />}
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
