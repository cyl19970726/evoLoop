// 结束会话与历史归类 (right column): closing a managed agent. Every blocker in what was read is named; the close is
// offered only when the page read is current, the registered state matches and nothing blocks it. A close already
// requested is read back by its original operation and never sent again.
import { useEffect, useRef, useState } from "react";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { Button, Notice } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { runtimeClient } from "../../shared/runtimeClient";
import { sessionClient } from "../../shared/sessionClient";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { mutedText } from "../../shared/ui/PageParts";
import { date, href } from "../../shared/ui/shared";

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
const note = "text-small text-text-secondary [overflow-wrap:anywhere]";

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
    blockers.push(`仍有关联的未完成任务（${Math.max(tasks.length, snapshot.currentWork ? 1 : 0)} 项）；请先核对交付与责任`);
  const queue = snapshot.queue.filter(item => item.state !== "released");
  if (queue.length) blockers.push(`仍有执行队列的占用或待处理条目（${queue.length} 项，其中 ${queue.filter(item => item.state === "claimed").length} 项已领取）`);
  const runs = read.runs.filter(run => unsettledRun.has(run.state));
  if (runs.length) blockers.push(`仍有在途或结果未知的运行（${runs.length} 项）`);
  const messages = read.messages.filter(message => unsettledMessage.has(message.state));
  if (messages.length) blockers.push(`仍有待处理或结果未知的消息（${messages.length} 条）`);
  if (!read.messagesComplete) blockers.push("消息记录范围未完整读回");
  if (snapshot.nativeInputRequests?.some(item => item.isBlocking && item.state !== "resolved"))
    blockers.push("原生提问仍待处理");
  return blockers;
}

async function readAllMessages(projectId: string, sessionKey: string, signal: AbortSignal) {
  const items: SessionMessageRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await sessionClient("", projectId).messages(sessionKey, cursor, signal);
    items.push(...page.items);
    if (!page.nextCursor) return { items, complete: true };
    if (seen.has(page.nextCursor)) return { items, complete: false };
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
}

export function SessionClosePanel({ context, snapshot, currentRead, onReadAgain }: {
  context: MutationContext; snapshot: SessionSnapshot; currentRead: boolean; onReadAgain(): void;
}) {
  const session = snapshot.session;
  const { projectId } = context;
  const ownedId = session.kind === "owned" && session.target.kind === "owned" ? session.target.sessionId : null;
  const enabled = !!ownedId;
  const sessions = useProjectQuery(projectId, ["runtime", "sessions"], async signal => {
    const items = await sessionClient("", projectId).runtimeSessions(signal);
    if (!Array.isArray(items)) throw new Error("智能体列表响应不完整");
    return items.filter(item => item.projectId === projectId);
  }, { enabled });
  const runs = useProjectQuery(projectId, ["runtime", "runs"], async () => {
    const items = await runtimeClient("", projectId).runs();
    if (!Array.isArray(items)) throw new Error("运行列表响应不完整");
    return items;
  }, { enabled });
  const status = useProjectQuery(projectId, ["runtime", "status"], () => runtimeClient("", projectId).status(), { enabled });
  const messages = useProjectQuery(projectId, ["session-work", session.key, "messages", "all"],
    signal => readAllMessages(projectId, session.key, signal), { enabled });
  const reads = [sessions, runs, status, messages];
  const [submittedVersion, setSubmittedVersion] = useState<number | null>(null);
  const recheck = () => { for (const read of reads) void read.refetch(); };
  // The registered lifecycle moved (closing, closed): check the conditions again.
  const lastState = useRef(session.runtimeState);
  useEffect(() => {
    if (lastState.current === session.runtimeState) return;
    lastState.current = session.runtimeState;
    if (enabled) recheck();
  }, [session.runtimeState]);

  const loading = reads.some(read => read.isFetching);
  const failure = reads.find(read => read.isError)?.error;
  const matching = sessions.data?.filter(item => item.id === ownedId) ?? [];
  // A foreign run or message in this project's answer makes the whole read unusable.
  const mismatch = !!sessions.data && matching.length !== 1 || !!runs.data?.some(item => item.projectId !== projectId)
    || !!messages.data && messages.data.items.some(item => item.projectId !== projectId || item.target.kind !== "owned" || item.target.sessionId !== ownedId);
  const readError = failure ? errorText(failure) : mismatch ? "关闭核对结果与当前智能体不符" : "";
  const read: CloseRead | null = !readError && sessions.data && runs.data && status.data && messages.data ? {
    session: matching[0]!, runs: runs.data.filter(item => item.sessionId === ownedId), messages: messages.data.items,
    messagesComplete: messages.data.complete,
    fault: status.data.faults?.find(item => item.sessionId === ownedId && item.phase === "session_close") ?? null,
    observedAt: new Date(Math.max(sessions.dataUpdatedAt, runs.dataUpdatedAt, status.dataUpdatedAt, messages.dataUpdatedAt)).toISOString(),
  } : null;

  const runtime = read?.session;
  const blockers = read ? closeBlockers(snapshot, read) : [];
  const stateMatches = runtime?.state === session.runtimeState;
  const canClose = currentRead && !loading && !readError && !!runtime && stateMatches && runtime.state === "ready"
    && !!runtime.nativeSessionId && !!runtime.nativeThreadId && !blockers.length && submittedVersion !== runtime.version;
  const fault = read?.fault ?? null;
  return <section className="session-close-panel flex min-w-0 flex-col gap-2.5" aria-label="结束会话与历史归类">
    <h3 className="text-label font-semibold text-foreground">结束会话与历史归类</h3>
    <p className={note}>项目列表的“历史会话”只改变归类。关闭受管智能体还要核实原对话线程已归档；外部聊天请在原聊天应用归档。职责退役在<a className="text-primary hover:underline" href={href(projectId, "roles")}>职责页面</a>单独办理。</p>
    {!ownedId ? <p className={note}>这是外部接入的会话，不能从这里关闭受管智能体。可在展示信息里修改项目归类，并从原聊天入口处理归档。</p> : <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-small font-medium text-foreground">受管智能体</span>
        <Button size="compact" variant="ghost" disabled={loading} onClick={() => { onReadAgain(); recheck(); }}>重新核对关闭条件</Button>
      </div>
      {loading && <p className={mutedText} role="status">{read ? "正在重新核对关闭条件…" : "正在读取关闭条件…"}</p>}
      {readError && <Notice tone="error">关闭条件读取失败：{readError}。{read ? "" : "不能判断能否关闭，"}请重新核对。</Notice>}
      {runtime && <>
        <p className={note}>登记状态：<strong className="font-medium text-foreground">{runtime.state === "ready" ? "就绪" : runtime.state === "closing" ? "关闭请求已登记" : runtime.state === "closed" ? "已核实关闭" : "状态需核对"}</strong> · 登记版本 {runtime.version} · 核对于 {date(read?.observedAt)}</p>
        {runtime.closeOperationId && <p className={note}>已登记关闭请求。{runtime.state === "closing" ? runtime.closeAttemptedAt ? "原生归档已尝试；只读核对原操作与原对话线程，不能重发关闭。" : "等待原关闭请求执行；继续按原操作核对。" : "关闭结果以持久记录为准。"}</p>}
        {fault && runtime.state === "closing" && <Notice tone="error">原生归档未完成，记录于 {date(fault.observedAtUtc)}；诊断代码见下方完整标识，请按原操作只读核对。</Notice>}
        {runtime.state === "closed" && <p className={note} role="status">受管智能体已关闭；此记录不表示外部聊天已归档或职责已退役。</p>}
        {!stateMatches && <p className="text-small text-destructive" role="alert">页面状态与受管登记不一致，请重新读取后再判断。</p>}
        {blockers.length > 0 && <Notice tone="waiting" title="当前不能关闭"><ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">{blockers.map(item => <li key={item}>{item}</li>)}</ul></Notice>}
        {read && blockers.length === 0 && runtime.state === "ready" && <p className={note}>未在本次已读范围发现未完成任务、队列占用、在途运行或待处理消息；提交时服务端会再次检查。</p>}
        {canClose && <ActionForm key={`${ownedId}:${runtime.version}`} context={{ ...context, draftScope: `session-close:${ownedId}`, draftBaseline: `${runtime.version}` }} review
          title="请求关闭受管智能体" fields={[{ name: "reason", label: "关闭理由与核对依据", kind: "textarea" }]}
          build={values => ({ type: "runtime.session.close", sessionId: ownedId, expectedVersion: runtime.version, reason: values.reason })}
          onApplied={() => { setSubmittedVersion(runtime.version); onReadAgain(); recheck(); }} />}
        {submittedVersion === runtime.version && <p className={note} role="status">关闭请求已保存，正在按原操作读取登记结果；尚未确认原对话线程已归档。</p>}
      </>}
      {read && runtime?.state === "ready" && !runtime.nativeThreadId && <p className="text-small text-destructive" role="alert">原对话线程尚未绑定，不能请求关闭。</p>}
      <FullIdentifiers rows={[
        { label: "受管智能体", value: ownedId },
        { label: "原关闭操作", value: runtime?.closeOperationId },
        { label: "原生归档诊断", text: true, value: fault && runtime?.state === "closing"
          ? `${fault.category} · 方法 ${fault.nativeMethod ?? "未确认"} · 错误码 ${fault.nativeCode ?? "未提供"} · 安全类别 ${fault.nativeCategory ?? "未提供"}` : null },
      ]} />
    </>}
  </section>;
}
