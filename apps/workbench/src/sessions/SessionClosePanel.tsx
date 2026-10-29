import { useEffect, useState } from "react";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { errorText } from "../api";
import { ActionForm, type MutationContext } from "../workflow/ActionForm";
import { date, href } from "../ui/shared";
import { runtimeClient } from "../runtime/client";
import { sessionClient } from "./client";

type CloseRead = {
  session: RuntimeSessionRecord;
  runs: RuntimeRunRecord[];
  messages: SessionMessageRecord[];
  messagesComplete: boolean;
  fault: { category: string; nativeMethod?: string; nativeCode?: number; nativeCategory?: string; observedAtUtc: string } | null;
  observedAt: string;
};

const unsettledRun = new Set(["requested", "dispatching", "running", "unknown"]);
const unsettledMessage = new Set(["queued", "processing", "unknown", "manual_pending"]);

export function closeBlockers(snapshot: SessionSnapshot, read: CloseRead): string[] {
  const { session } = snapshot;
  const blockers: string[] = [];
  const sourceLimited = snapshot.metadata.limitations.some(item =>
    item.startsWith("分派首屏") || item.startsWith("队列首屏")
    || (item.startsWith("响应大小限制：已省略部分") && /分派|队列/.test(item)));
  if (sourceLimited) blockers.push("分派或队列来源未完整读回，不能确认全部关联工作");
  if (session.busy !== false) blockers.push("会话仍忙碌或忙碌状态未确认");
  const tasks = snapshot.assignments.filter(item => item.assignment.state !== "released"
    && item.task.state !== "done" && item.task.state !== "cancelled");
  if (tasks.length || snapshot.currentWork && !tasks.some(item => item.task.id === snapshot.currentWork?.id))
    blockers.push(`仍有关联的未完 Task（${Math.max(tasks.length, snapshot.currentWork ? 1 : 0)} 项）；请先核对交付与责任`);
  const queue = snapshot.queue.filter(item => item.state !== "released");
  if (queue.length) blockers.push(`仍有队列占用或待处理条目（${queue.length} 项，含 ${queue.filter(item => item.state === "claimed").length} 项 claim）`);
  const runs = read.runs.filter(run => unsettledRun.has(run.state));
  if (runs.length) blockers.push(`仍有在途或结果未知的 Run（${runs.length} 项）`);
  const messages = read.messages.filter(message => unsettledMessage.has(message.state));
  if (messages.length) blockers.push(`仍有待处理或结果未知的消息（${messages.length} 条）`);
  if (!read.messagesComplete) blockers.push("消息记录范围未完整读回");
  if (snapshot.nativeInputRequests?.some(item => item.isBlocking && item.state !== "resolved"))
    blockers.push("原生提问仍待处理");
  return blockers;
}

export function SessionClosePanel({ context, snapshot, currentRead, onReadAgain }: {
  context: MutationContext; snapshot: SessionSnapshot; currentRead: boolean; onReadAgain(): void;
}) {
  const session = snapshot.session;
  const ownedId = session.kind === "owned" && session.target.kind === "owned" ? session.target.sessionId : null;
  const [read, setRead] = useState<CloseRead | null>(null);
  const [readError, setReadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [submittedVersion, setSubmittedVersion] = useState<number | null>(null);
  useEffect(() => {
    if (!ownedId) return;
    let live = true;
    const controller = new AbortController();
    setRead(null); setReadError(""); setLoading(true);
    const runtime = runtimeClient(context.token, context.projectId);
    const work = sessionClient(context.token, context.projectId);
    async function readMessages() {
      const items: SessionMessageRecord[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        const page = await work.messages(session.key, cursor, controller.signal);
        items.push(...page.items);
        if (!page.nextCursor) return { items, complete: true };
        if (seen.has(page.nextCursor)) return { items, complete: false };
        seen.add(page.nextCursor); cursor = page.nextCursor;
      }
    }
    void Promise.all([runtime.sessions(), runtime.runs(), readMessages(), runtime.status()]).then(([sessions, runs, messages, status]) => {
      if (!live) return;
      const matching = sessions.filter(item => item.projectId === context.projectId && item.id === ownedId);
      if (matching.length !== 1 || runs.some(item => item.projectId !== context.projectId)
        || messages.items.some(item => item.projectId !== context.projectId || item.target.kind !== "owned" || item.target.sessionId !== ownedId))
        throw new Error("关闭核对结果与当前 Session 不符");
      setRead({ session: matching[0], runs: runs.filter(item => item.sessionId === ownedId), messages: messages.items,
        messagesComplete: messages.complete,
        fault: status.faults?.find(item => item.sessionId === ownedId && item.phase === "session_close") ?? null,
        observedAt: new Date().toISOString() });
      setReadError("");
    }).catch(cause => { if (live) { setRead(null); setReadError(errorText(cause)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, [context.token, context.projectId, session.key, ownedId, session.runtimeState, reload]);

  const runtime = read?.session;
  const blockers = read ? closeBlockers(snapshot, read) : [];
  const stateMatches = runtime?.state === session.runtimeState;
  const canClose = currentRead && !loading && !readError && !!runtime && stateMatches && runtime.state === "ready"
    && !!runtime.nativeSessionId && !!runtime.nativeThreadId && !blockers.length && submittedVersion !== runtime.version;
  return <section className="session-close-panel" aria-label="结束会话与历史归类">
    <h2>结束会话与历史归类</h2>
    <p>项目列表的“历史会话”只改变归类。关闭受管 Session 还要核实原生线程归档；外部聊天请在原聊天应用归档。Role 退休在<a href={href(context.projectId, "roles")}>职责页面</a>单独办理。</p>
    {!ownedId ? <p>这是外部接入会话，不能从此处请求关闭受管 Session。可在下方“会话信息”修改项目归类，并从原聊天入口处理归档。</p> : <>
      <div className="session-close-read"><strong>受管 Session</strong><code>{ownedId}</code><button type="button" onClick={() => { onReadAgain(); setReload(value => value + 1); }}>重新核对关闭条件</button></div>
      {loading && <p role="status">正在读取关闭条件…</p>}
      {readError && <p role="alert">关闭条件读取失败：{readError}。请重新核对。</p>}
      {runtime && <>
        <p>登记状态：<strong>{runtime.state === "ready" ? "就绪" : runtime.state === "closing" ? "关闭请求已登记" : runtime.state === "closed" ? "已核实关闭" : "状态需核对"}</strong> · 登记版本 {runtime.version} · 核对于 {date(read?.observedAt)}</p>
        {runtime.closeOperationId && <p>原关闭操作 <code>{runtime.closeOperationId}</code>。{runtime.state === "closing" ? runtime.closeAttemptedAt ? "原生归档已尝试；只读核对原操作与原线程，不能重发关闭。" : "等待原关闭意图执行；继续按原操作核对。" : "关闭结果以持久记录为准。"}</p>}
        {read?.fault && runtime.state === "closing" && <p role="alert">原生归档诊断：{read.fault.category} · 方法 {read.fault.nativeMethod ?? "未确认"} · 错误码 {read.fault.nativeCode ?? "未提供"} · 安全类别 {read.fault.nativeCategory ?? "未提供"}。记录于 {date(read.fault.observedAtUtc)}；请按上方原操作只读核对。</p>}
        {runtime.state === "closed" && <p role="status">受管 Session 已关闭；此记录不表示外部聊天已归档或 Role 已退休。</p>}
        {!stateMatches && <p role="alert">工作区状态与受管登记不一致，请重新读取后再判断。</p>}
        {blockers.length > 0 && <div className="session-close-blockers" role="status"><strong>当前不能关闭</strong><ul>{blockers.map(item => <li key={item}>{item}</li>)}</ul></div>}
        {read && blockers.length === 0 && runtime.state === "ready" && <p>未在本次已读范围发现未完 Task、队列占用、在途 Run 或待处理消息；提交时服务端会再次检查。</p>}
        {canClose && <ActionForm key={`${ownedId}:${runtime.version}`} context={{ ...context, draftScope: `session-close:${ownedId}`, draftBaseline: `${runtime.version}` }} review
          title="请求关闭受管 Session" fields={[{ name: "reason", label: "关闭理由与核对依据", kind: "textarea" }]}
          build={values => ({ type: "runtime.session.close", sessionId: ownedId, expectedVersion: runtime.version, reason: values.reason })}
          onApplied={() => { setSubmittedVersion(runtime.version); onReadAgain(); setReload(value => value + 1); }} />}
        {submittedVersion === runtime.version && <p role="status">关闭请求已保存，正在按原操作读取登记结果；尚未确认原生线程归档。</p>}
      </>}
      {read && runtime?.state === "ready" && !runtime.nativeThreadId && <p role="alert">原生线程尚未绑定，不能请求关闭。</p>}
    </>}
  </section>;
}
