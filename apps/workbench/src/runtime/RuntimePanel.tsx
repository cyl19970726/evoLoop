import { useEffect, useState } from "react";
import type { Task } from "@evoloop/contracts";
import type { RuntimeRecordEvent, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { ApiError, errorText } from "../api";
import { ActionForm, Notice, option, reasonField, type MutationContext } from "../workflow/ActionForm";
import { runtimeClient, type NativeResult, type RuntimeStatus } from "./client";

function readErrorText(cause: unknown): string {
  if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500))
    return "原生历史读取失败或超时。已保存的运行记录仍可查看；请检查执行连接后重试读取，不要重发运行。";
  return errorText(cause);
}

const pending = ["requested", "dispatching", "running", "unknown"];
const grantKey = (g: { roleId: string; cwd: string; authorizationScope: string; sandbox: string }) => JSON.stringify([g.roleId, g.cwd, g.authorizationScope, g.sandbox]);
export function RuntimePanel({ context, refresh, task }: { context: MutationContext; refresh: number; task?: Task }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [sessions, setSessions] = useState<RuntimeSessionRecord[]>([]);
  const [runs, setRuns] = useState<RuntimeRunRecord[]>([]);
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    let active = true, fetching = false;
    const client = runtimeClient(context.token, context.projectId);
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const [s, list, work] = await Promise.all([client.status(), client.sessions(), client.runs(task?.id)]);
        if (active) { setStatus(s); setSessions(list); setRuns(work); setError(""); }
      } catch (cause) { if (active) setError(errorText(cause)); }
      finally { fetching = false; }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [context.token, context.projectId, task?.id, refresh, epoch]);
  async function recover() {
    setRecovering(true);
    try { await runtimeClient(context.token, context.projectId).recover(); setEpoch(e => e + 1); }
    catch (cause) { setError(errorText(cause)); }
    finally { setRecovering(false); }
  }
  const grants = status?.grants ?? [];
  return <section className="panel"><div className="panel-head"><h2>受管执行会话</h2><button onClick={() => setEpoch(e => e + 1)}>读取运行状态</button></div>
    {error && <Notice error>{error}</Notice>}
    {!status ? <p>正在读取执行服务…</p> : !status.available && <Notice>{status.error || "Codex 执行服务尚未接通。已有运行记录仍保留；不自动重发未知启动。"}</Notice>}
    {status && !status.available && context.principal.permissions.includes("review") && <button disabled={recovering} onClick={recover}>{recovering ? "恢复核对中…" : "受控恢复执行连接"}</button>}
    {sessions.length === 0 && <p className="empty">还没有受管会话。仅管理在本项目明确授权并由 evoLoop 创建的会话。</p>}
    {sessions.map(session => <details className="workflow-detail" key={session.id}><summary>{session.roleId} · {session.state}</summary>
      <dl><div><dt>授权工作范围</dt><dd>{session.authorizationScope}</dd></div><div><dt>工作区</dt><dd>{session.cwd}</dd></div><div><dt>权限</dt><dd>{session.sandbox}</dd></div><div><dt>稳定会话 ID</dt><dd>{session.id}</dd></div><div><dt>原生线程</dt><dd>{session.nativeThreadId ?? "尚未确认"}</dd></div></dl>
      {session.state === "unknown" && <Notice error>创建结果未知，不能用新 ID 重复创建来代替核对。</Notice>}
      <SessionHistory context={context} sessionId={session.id} />
      <RuntimeEvidence load={() => runtimeClient(context.token, context.projectId).sessionEvents(session.id)} label="阅读会话与审批回执" />
    </details>)}
    {status?.available && grants.length > 0 && <details className="workflow-detail"><summary>创建授权范围内的新会话</summary><ActionForm context={context} review title="登记并创建会话" fields={[
      { name: "grant", label: "已配置的授权", kind: "select", options: grants.map(g => option(grantKey(g), `${g.roleId} · ${g.authorizationScope} · ${g.sandbox} · ${g.cwd}`)) },
      { name: "model", label: "模型（可留空沿用 Codex 配置）", optional: true },
    ]} build={v => {
      const grant = grants.find(g => grantKey(g) === v.grant);
      if (!grant) throw new Error("需要有效授权");
      return { type: "runtime.session.reserve", sessionId: crypto.randomUUID(), roleId: grant.roleId, authorizationScope: grant.authorizationScope,
        cwd: grant.cwd, sandbox: grant.sandbox, approvalPolicy: "on-request", ...(v.model ? { model: v.model } : {}) };
    }} /></details>}
    {task && status?.available && task.state === "in_progress" && <ActionForm key={`${task.id}:${task.version}`} context={context} title="派发本次任务运行" fields={[
      { name: "sessionId", label: "承接会话", kind: "select", options: sessions.filter(s => s.state === "ready" && s.roleId === task.owner).map(s => option(s.id, `${s.roleId} · ${s.authorizationScope} · ${s.id.slice(0,8)}`)) },
      { name: "input", label: "本次有界工作与停止条件", kind: "textarea", hint: "系统会附带任务的固定依据；原生运行结束后还需交付与使用验收。" },
    ]} build={v => ({ type: "runtime.run.reserve", runId: crypto.randomUUID(), taskId: task.id, expectedVersion: task.version, ...v })} />}
    <h3>运行记录</h3>{runs.length === 0 && <p className="empty">没有已登记运行。</p>}
    {runs.map(run => <RunCard key={`${run.id}:${run.version}`} context={context} run={run} mayAbandon={sessions.some(s=>s.id===run.sessionId && s.sandbox==="read-only")} />)}
    <p className="muted">收到通知、读取材料、采用判断与真实效果分别留证。原生完成状态不会自动关闭任务。</p>
  </section>;
}
function RuntimeEvidence({ load, label }: { load(): Promise<RuntimeRecordEvent[]>; label: string }) {
  const [events,setEvents] = useState<RuntimeRecordEvent[]>([]);
  const [error,setError] = useState("");
  return <div><button onClick={async () => { try { setEvents(await load()); setError(""); } catch (cause) { setError(errorText(cause)); } }}>{label}</button>
    {error && <Notice error>{error}</Notice>}{events.map(event => <div className="decision" key={event.id}><strong>{event.kind}</strong><p>{event.detail}</p><small>{event.actorId} · {event.createdAt}</small></div>)}
  </div>;
}
function RunCard({ context, run, mayAbandon }: { context: MutationContext; run: RuntimeRunRecord; mayAbandon: boolean }) {
  const [nativeResult, setNativeResult] = useState<NativeResult | null>(null);
  const [error,setError] = useState("");
  return <details className="workflow-detail"><summary>运行 {run.id.slice(0,8)} · {run.state}</summary>
    <p>任务修订 <code>{run.taskRevisionId}</code></p><p>依据集合 <code>{run.basisSetId}</code></p>
    {run.state === "unknown" && <Notice error>派发或状态仍未知，须沿已绑定线程回查；不会自动再发一次。</Notice>}
    {mayAbandon && run.state === "unknown" && !run.nativeTurnId && <details className="workflow-detail"><summary>复核只读派发并保留失败记录</summary><p>仅适用于没有绑定 Turn 的只读运行。放弃会关闭旧会话的后续派发；不证明外部未执行，也不自动重发。</p><ActionForm context={context} review title="复核并放弃未知只读派发" fields={[reasonField,{name:"evidence",label:"所属线程历史与失败原因核对证据",kind:"textarea"}]} build={v=>({type:"runtime.run.abandonReadOnly",runId:run.id,expectedVersion:run.version,...v})} /></details>}
    {run.resultSummary && <p className="history-body">已保存的结果摘要（可能截断，不能代替原生全文）：{run.resultSummary}</p>}
    {run.nativeTurnId && <button onClick={async () => { try { setNativeResult(await runtimeClient(context.token,context.projectId).result(run.id)); setError(""); } catch(cause) { setError(readErrorText(cause)); } }}>读取原生答复</button>}
    {error && <Notice error>{error}</Notice>}{nativeResult && <><p>来源：自有原生线程历史 · 读回时间 {nativeResult.observedAt} · {nativeResult.finalPhaseConfirmed ? "已确认最终答复阶段" : "原生记录未标记最终答复阶段，以下内容需复核"}</p>{nativeResult.messages.length === 0 && <p className="empty">当前原生记录没有可显示的答复。</p>}{nativeResult.messages.map((text,index)=><pre className="runtime-result" key={index}>{text}</pre>)}</>}
    {run.nativeTurnId && ["completed","failed","interrupted"].includes(run.state) && context.principal.permissions.includes("review") && <ReconcileRun context={context} run={run} />}
    <RuntimeEvidence label="阅读运行、交接与审批回执" load={() => runtimeClient(context.token,context.projectId).events(run.id)} />
    {pending.includes(run.state) && run.nativeTurnId && !run.interruptRequested && <ActionForm context={context} review title="请求中断本次运行" fields={[reasonField]} build={v=>({type:"runtime.run.interrupt",runId:run.id,...v})} />}
    {run.state === "completed" && <ActionForm context={context} title="记录本次交接使用" fields={[
      {name:"stage",label:"本身份的交接阶段",kind:"select",options:[option("received","收到材料"),option("read","实际阅读"),option("adopted","已采用到行动"),option("effect","观察到实际后果")]},
      {name:"evidence",label:"实际路径、采用动作或后果的证据",kind:"textarea",hint:"按本身份逐步记录；这是署名观察，不自动代表消费者验收或真人使用。"},
    ]} build={v=>({type:"runtime.handoff.record",runId:run.id,...v})} />}
    {run.interruptRequested && <Notice>已登记中断请求；是否停止以原生运行终态为准。</Notice>}
  </details>;
}

function ReconcileRun({ context, run }: { context: MutationContext; run: RuntimeRunRecord }) {
  const [reason,setReason] = useState("");
  const [attempted,setAttempted] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  return <details className="workflow-detail"><summary>核对已绑定运行的终态观察</summary>
    <p>仅回读同一原生 Turn；保留旧观察并登记修正，不再启动工作，也不自动关闭任务。</p>
    <form className="workflow-form" onSubmit={async event => {
      event.preventDefault(); if (!reason.trim() || busy || attempted || context.blocked) return;
      setAttempted(true); setBusy(true);
      try { await runtimeClient(context.token,context.projectId).reconcile(run.id,run.version,reason.trim()); setMessage("终态观察已核对，请阅读运行回执中的新记录。"); context.onChanged(); }
      catch (cause) { setMessage(`${errorText(cause)}。请先回读当前状态与运行回执，确认结果后再操作。`); }
      finally { setBusy(false); }
    }}><label>复核理由<textarea required value={reason} onChange={event=>setReason(event.target.value)} /></label>
      <button disabled={busy || attempted || context.blocked || !reason.trim()}>{busy?"核对中…":"回读原生终态并登记观察"}</button>
      {message && <Notice>{message}</Notice>}
    </form>
  </details>;
}

function SessionHistory({context,sessionId}:{context:MutationContext;sessionId:string}) {
  const [history,setHistory]=useState<Awaited<ReturnType<ReturnType<typeof runtimeClient>["history"]>>|null>(null);
  const [error,setError]=useState("");
  return <div><button onClick={async()=>{try{setHistory(await runtimeClient(context.token,context.projectId).history(sessionId));setError("");}catch(cause){setError(readErrorText(cause));}}}>读取所属线程历史</button>{error&&<Notice error>{error}</Notice>}{history&&<><p>读回 {history.turns.length} 个 Turn · {history.observedAt} · {history.truncated?"有更多历史未读，不代表完整":"当前范围读取完成"}</p>{history.turns.map(turn=><details key={turn.id}><summary>{turn.id} · {turn.status}</summary>{turn.messages.map((m,i)=><pre className="runtime-result" key={i}>{m.type}: {m.text}</pre>)}</details>)}</>}</div>;
}
