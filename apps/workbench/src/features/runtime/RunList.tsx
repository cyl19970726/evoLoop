// Runs in 分工与运行: each recorded run, the task and agent it belongs to, what the service saved about its result, and
// the checks a reader may make on it (native answer, receipts, terminal reconcile, interrupt, handoff use). A run's
// state never stands for task acceptance; the task page keeps the full task context.
import { useState } from "react";
import type { RuntimeRecordEvent, RuntimeReconcilePartial, RuntimeRunRecord } from "@evoloop/contracts/runtime";
import { Button, Notice, StatusTag, Textarea } from "@evoloop/ui";
import { ApiError, errorText } from "../../shared/api";
import { ActionForm, option, reasonField, type MutationContext } from "../../shared/ActionForm";
import { runtimeClient, type NativeResult } from "../../shared/runtimeClient";
import { taskSectionHref } from "../../shared/taskNavigation";
import { hereOrigin } from "../../shared/returnLink";
import { FactList, mutedText } from "../../shared/ui/PageParts";
import { useTaskName } from "../../shared/ui/RecordName";
import { nameOnly } from "../../shared/workPresentation";
import { sessionHref } from "../sessions";
import { useAgentName } from "./AgentName";
import { executionHref, pendingRun, runStateText, runStateTone, uuidPattern } from "./executionPresentation";
import { preflightPresentation, preflightView } from "../../shared/preflightPresentation";
import { diagnosticOf, failureOf, type Failure } from "../../shared/errorPresentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const stamp = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

export function nativeReadError(cause: unknown): string {
  if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500))
    return "原生历史读取失败或超时。已保存的运行记录仍可查看；请检查执行连接后重试读取，不要重发运行。";
  return errorText(cause);
}

export function RunList({ context, runs, readOnlySessions, empty }: { context: MutationContext; runs: readonly RuntimeRunRecord[]; readOnlySessions: ReadonlySet<string>; empty: string }) {
  if (!runs.length) return <p className="text-small text-text-secondary">{empty}</p>;
  const sorted = [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return <ul aria-label="运行记录" className="flex flex-col overflow-hidden rounded-xl bg-raised shadow-sm">
    {sorted.map(run => <li key={`${run.id}:${run.version}`} className="border-t border-border first:border-t-0">
      <RunItem context={context} run={run} mayAbandon={readOnlySessions.has(run.sessionId)} />
    </li>)}
  </ul>;
}

function RunItem({ context, run, mayAbandon }: { context: MutationContext; run: RuntimeRunRecord; mayAbandon: boolean }) {
  const [native, setNative] = useState<NativeResult | null>(null);
  const [nativeError, setNativeError] = useState<Failure | null>(null);
  const client = runtimeClient("", context.projectId);
  const report = run.resultSummary ? preflightPresentation(run.resultSummary) : null;
  const preflight = report ? preflightView(report) : null;
  const review = context.principal.permissions.includes("review");
  const linkable = run.projectId === context.projectId && uuidPattern.test(run.sessionId);
  // A run has no name of its own: it is named by the task it ran and the agent that ran it; the run's ID stays in 来源与完整标识.
  const taskName = nameOnly("任务", useTaskName(context.projectId, uuidPattern.test(run.taskId) ? run.taskId : null));
  const agentName = useAgentName(context.projectId, run.sessionId);
  return <details aria-label={`运行：${taskName} · ${agentName}`} data-run-id={run.id} className="group min-w-0 px-4 py-3">
    <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-small text-foreground">
      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{taskName}<span className="font-normal text-text-secondary"> · {agentName}</span></span>
      <StatusTag tone={runStateTone(run.state)} label={runStateText[run.state]} />
      <span className={mutedText}>{stamp(run.createdAt)}</span>
    </summary>
    <div className="mt-3 flex min-w-0 flex-col gap-3">
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-small">
        {uuidPattern.test(run.taskId) && <a className="text-primary hover:underline" href={`${taskSectionHref(context.projectId, run.taskId, { tab: "runtime" })}&run=${encodeURIComponent(run.id)}`}>在任务中查看此运行</a>}
        {linkable && <a className="text-primary hover:underline" href={executionHref(context.projectId, run.sessionId)}>承接的受管智能体</a>}
        {linkable && <a className="text-primary hover:underline" href={sessionHref(context.projectId, `owned:${run.sessionId}`, hereOrigin(context.principal.actorId))}>在智能体空间打开</a>}
      </p>
      <p className={mutedText}>链接只定位来源；运行的状态不代表任务验收或当前接手。</p>
      {run.state === "unknown" && <Notice tone="error">派发或状态仍未知，须沿已绑定线程回查；不会自动再发一次。</Notice>}
      {preflight && <Notice tone="error" title={`派发前检查没通过：${preflight.title}`} data-preflight="">模型尚未开始。{[preflight.source, preflight.size].filter(Boolean).join("，")}{preflight.source || preflight.size ? "。" : ""}下一步：{preflight.next}</Notice>}
      {run.resultSummary && !preflight && <p className="whitespace-pre-wrap break-words text-small text-text-secondary" data-run-summary="">已保存的结果摘要（可能截断，不能代替原生全文）：{run.resultSummary}</p>}
      {run.interruptRequested && <Notice>已登记中断请求；是否停止以原生运行终态为准。</Notice>}
      <div className="flex flex-wrap gap-2">
        {run.nativeTurnId && <Button size="compact" onClick={async () => {
          try { setNative(await client.result(run.id)); setNativeError(null); } catch (cause) { setNativeError({ text: nativeReadError(cause), detail: diagnosticOf(cause) }); }
        }}>读取原生答复</Button>}
      </div>
      {nativeError && <Notice tone="error">{nativeError.text}<ErrorDetails failure={nativeError} /></Notice>}
      {native && <div className="flex flex-col gap-2">
        <p className={mutedText}>来源：自有原生线程历史 · 读回时间 {native.observedAt} · {native.finalPhaseConfirmed ? "已确认最终答复阶段" : "原生记录未标记最终答复阶段，以下内容需复核"}</p>
        {native.messages.length === 0 && <p className="text-small text-text-secondary">当前原生记录没有可显示的答复。</p>}
        {native.messages.map((text, index) => <pre key={index} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-3 font-mono text-caption text-foreground">{text}</pre>)}
      </div>}
      <Receipts label="阅读运行、交接与审批回执" load={() => client.events(run.id)} />
      {run.nativeTurnId && ["completed", "failed", "interrupted"].includes(run.state) && review && <Reconcile context={context} run={run} />}
      {mayAbandon && run.state === "unknown" && !run.nativeTurnId && <details className="text-small">
        <summary className="cursor-pointer text-primary">复核只读派发并保留失败记录</summary>
        <p className={`${mutedText} mt-2`}>仅适用于没有绑定一轮的只读运行。放弃会关闭旧智能体的后续派发；不证明外部未执行，也不自动重发。</p>
        <ActionForm context={context} review embedded title="复核并放弃未知只读派发" baseline={{ runVersion: run.version }}
          fields={[reasonField, { name: "evidence", label: "所属线程历史与失败原因核对证据", kind: "textarea" }]}
          build={v => ({ type: "runtime.run.abandonReadOnly", runId: run.id, expectedVersion: run.version, ...v })} />
      </details>}
      {pendingRun(run.state) && run.nativeTurnId && !run.interruptRequested && <ActionForm context={context} review title="请求中断本次运行" fields={[reasonField]}
        build={v => ({ type: "runtime.run.interrupt", runId: run.id, ...v })} />}
      {run.state === "completed" && <ActionForm context={context} title="记录本次交接使用" fields={[
        { name: "stage", label: "本身份的交接阶段", kind: "select", options: [option("received", "收到材料"), option("read", "实际阅读"), option("adopted", "已采用到行动"), option("effect", "观察到实际后果")] },
        { name: "evidence", label: "实际路径、采用动作或后果的证据", kind: "textarea", hint: "按本身份逐步记录；这是署名观察，不自动代表消费者验收或真人使用。" },
      ]} build={v => ({ type: "runtime.handoff.record", runId: run.id, ...v })} />}
      <details className="text-caption text-muted-foreground">
        <summary className="cursor-pointer">来源与完整标识</summary>
        <FactList rows={[["运行", run.id], ["任务", run.taskId], ["任务修订", run.taskRevisionId], ["依据集合", run.basisSetId], ["受管智能体", run.sessionId], ["原操作", run.operationId],
          ...preflight?.ids ?? []]} />
      </details>
    </div>
  </details>;
}

const eventText: Record<RuntimeRecordEvent["kind"], string> = {
  "session.reserved": "已预留", "session.creating": "创建中", "session.bound": "已绑定原生线程", "session.unknown": "创建结果未知",
  "session.closeRequested": "已请求关闭", "session.archiveAttempted": "已尝试归档", "session.closed": "已核实关闭",
  "run.requested": "已请求运行", "run.dispatching": "派发中", "run.dispatchWithdrawn": "派发已撤回", "run.preflightRejected": "派发前检查未通过",
  "run.dispatchRejected": "派发被拒绝", "run.bound": "已绑定一轮", "run.status": "状态更新", "run.unknown": "运行结果未知", "run.reviewed": "已复核",
  "message.preTurnReviewed": "消息派发前已复核", "run.reconciled": "终态已核对", "run.interruptRequested": "已请求中断", "run.interruptResult": "中断结果",
  "session.executionProfile.activationStarted": "执行配置开始激活", "session.executionProfile.active": "执行配置已激活",
  "session.executionProfile.unknown": "执行配置激活结果未知", "session.executionProfile.rejected": "执行配置激活被拒绝",
  "runtime.approvalDeclined": "审批被拒绝", "native.childDiagnostic": "原生进程诊断", "handoff.received": "交接：收到材料",
  "handoff.read": "交接：实际阅读", "handoff.adopted": "交接：已采用", "handoff.effect": "交接：观察到后果",
};
export function Receipts({ label, load }: { label: string; load(): Promise<RuntimeRecordEvent[]> }) {
  const [events, setEvents] = useState<RuntimeRecordEvent[] | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  return <div className="flex flex-col gap-2">
    <Button size="compact" variant="ghost" className="w-fit" onClick={async () => {
      try { setEvents(await load()); setError(null); } catch (cause) { setError(failureOf(cause)); }
    }}>{label}</Button>
    {error && <Notice tone="error">{error.text}<ErrorDetails failure={error} /></Notice>}
    {events && events.length === 0 && <p className="text-small text-text-secondary">没有已登记回执。</p>}
    {events && events.length > 0 && <ul className="flex flex-col gap-2">{events.map(event => <li key={event.id} className="flex min-w-0 flex-col gap-0.5">
      <span className="text-small font-medium text-foreground">{eventText[event.kind] ?? "其他回执"}</span>
      <span className="whitespace-pre-wrap break-words text-small text-text-secondary">{event.detail}</span>
      <span className={mutedText}>{event.actorId} · {stamp(event.createdAt)}</span>
    </li>)}</ul>}
  </div>;
}

/** Re-read the same native turn page by page; a partial read changes nothing and keeps the reason and cursor. */
function Reconcile({ context, run }: { context: MutationContext; run: RuntimeRunRecord }) {
  const [reason, setReason] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [partial, setPartial] = useState<RuntimeReconcilePartial | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  return <details className="text-small">
    <summary className="cursor-pointer text-primary">核对已绑定运行的终态观察</summary>
    <form className="mt-2 flex flex-col gap-2" onSubmit={async event => {
      event.preventDefault(); if (!reason.trim() || busy || attempted || context.blocked) return;
      setBusy(true);
      try {
        const requestedReason = partial?.reason ?? reason.trim();
        const result = await runtimeClient("", context.projectId).reconcile(run.id, run.version, requestedReason, partial?.nextTurnCursor);
        if ("status" in result && result.status === "partial") {
          if (result.changed !== false || result.projectId !== context.projectId || result.runId !== run.id || result.nativeTurnId !== run.nativeTurnId
            || result.expectedVersion !== run.version || result.reason !== requestedReason || !result.nextTurnCursor || result.nextTurnCursor === partial?.nextTurnCursor)
            throw new Error("续页响应与当前运行或上次游标不符");
          setPartial(result);
          setMessage("尚未定位该运行，运行记录没有修改。可沿同一版本、理由和游标继续核对。"); setDetail(undefined);
        } else {
          if ("status" in result || result.projectId !== context.projectId || result.id !== run.id || result.sessionId !== run.sessionId
            || result.nativeTurnId !== run.nativeTurnId || result.version <= run.version) throw new Error("核对响应与当前运行不符");
          setAttempted(true); setMessage("终态观察已核对，请阅读运行回执中的新记录。"); setDetail(undefined); context.onChanged();
        }
      } catch (cause) { setAttempted(true); setMessage(`${errorText(cause)}。请先回读当前状态与运行回执，确认结果后再操作。`); setDetail(diagnosticOf(cause)); }
      finally { setBusy(false); }
    }}>
      <p className={mutedText}>仅回读同一原生一轮；保留旧观察并登记修正，不再启动工作，也不自动关闭任务。</p>
      <label className="flex flex-col gap-1.5"><span className="text-label font-semibold text-foreground">复核理由</span>
        <Textarea required readOnly={!!partial || attempted} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <Button type="submit" size="compact" className="w-fit" disabled={busy || attempted || context.blocked || !reason.trim()}>{busy ? "核对中…" : partial ? "继续核对" : "回读原生终态并登记观察"}</Button>
      {message && <div role="status" className="text-small text-text-secondary">{message}{detail && <ErrorDetails failure={{ text: message, detail }} />}</div>}
    </form>
  </details>;
}
