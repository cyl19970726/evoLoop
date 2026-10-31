import { useEffect, useRef, useState } from "react";
import { CircleAlert, MessageCircle, Wrench } from "lucide-react";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { errorText } from "../api";
import { ActionForm, type MutationContext } from "../workflow/ActionForm";
import { Alert, date } from "../ui/shared";
import { MarkdownBody } from "../ui/MarkdownBody";
import { sessionClient, type SessionConversationItem } from "./client";
import { sessionMessageEntry } from "./sessionMessageEntry";
import type { NativeProgressView } from "./NativeSessionPanel";

const messageStateLabel: Record<SessionMessageRecord["state"], string> = {
  queued: "待派发",
  processing: "原会话处理中",
  replied: "已回复",
  completed_without_reply: "已完成但无回复",
  failed: "失败",
  unknown: "结果未知",
  cancelled: "已取消",
  manual_pending: "待人工转交",
};

function latestProcessed(items: SessionConversationItem[]): SessionConversationItem | null {
  return items.find(item => item.processing && ["dispatching", "running", "unknown"].includes(item.processing.state))
    ?? items.find(item => item.state === "processing" || item.state === "unknown")
    ?? null;
}

function mergeConversation(previous: SessionConversationItem[], incoming: SessionConversationItem[]): SessionConversationItem[] {
  const old = new Map(previous.map(item => [item.id, item]));
  const merged = new Map(previous.map(item => [item.id, item]));
  for (const item of incoming) {
    const prior = old.get(item.id);
    const preservePrior = !!prior?.processing && (
      item.state === "processing" || item.state === "unknown"
      || prior.processing.state === "completed" || prior.processing.state === "failed"
    );
    merged.set(item.id, item.processing || !preservePrior ? item : { ...item, processing: prior.processing, responseTruncated: item.responseTruncated ?? prior.responseTruncated });
  }
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300);
}

function ToolSummary({ progress, processing }: { progress: NativeProgressView | null; processing: SessionMessageProcessing | null }) {
  const matching = progress?.turn && processing?.nativeTurnId === progress.turn.id ? progress : null;
  const items = matching?.items ?? [];
  if (!matching) return null;
  const unfinished = items.filter(item => item.status === "failed" || item.status === "inProgress");
  return <details className="session-turn-tools" open={unfinished.length > 0}>
    <summary><Wrench size={15} aria-hidden="true" />{items.length ? `${items.length} 项工具活动` : "当前没有可核对的工具活动"}<span>{matching.freshness === "live" ? `观察于 ${date(matching.observedAt)}` : "上次观察"}</span></summary>
    {items.length > 0 && <ol>{items.map(item => <li key={item.id}><strong>{item.name}</strong><span>{item.status === "completed" ? "已结束" : item.status === "failed" ? "失败" : item.status === "declined" ? "已拒绝" : "当时进行中，当前待核对"}</span>{item.summary && <p>{item.summary}</p>}{item.truncated && <small>原生内容已截断。</small>}</li>)}</ol>}
    {!items.length && <p>{matching.freshness === "live" ? "原生来源暂未提供工具活动。" : `上次观察已过期${matching.staleReason ? `：${matching.staleReason}` : ""}。`}</p>}
  </details>;
}

function WorkingObservation({ item, snapshot, progress, projectId }: { item: SessionConversationItem; snapshot: SessionSnapshot; progress: NativeProgressView | null; projectId: string }) {
  const processing = item.processing ?? null;
  const live = progress?.freshness === "live";
  const turnMatches = !!processing?.nativeTurnId && progress?.turn?.id === processing.nativeTurnId;
  const observed = live && turnMatches ? progress : null;
  const latestTools = observed?.items.slice(-3) ?? [];
  const important = snapshot.activity.filter(activity => activity.importance === "important").slice(0, 3);
  const label = processing?.state === "unknown" || item.state === "unknown" ? "处理结果尚未确认" : processing ? "原生处理中" : "处理已保存，等待原生进展";
  return <section className="session-working-observation" aria-label="当前工作观察">
    <div className="session-working-head"><span><MessageCircle size={16} aria-hidden="true" />当前工作</span><strong>{label}</strong></div>
    <p>正在处理你保存的消息。{snapshot.currentWork ? <>当前关联工作：<a href={`#/p/${projectId}/tasks/${snapshot.currentWork.id}`}>{snapshot.currentWork.title}</a></> : null}</p>
    <dl>
      <div><dt>当前消息</dt><dd>{item.content.slice(0, 120)}{item.content.length > 120 ? "…" : ""}</dd></div>
      <div><dt>最近关键进展</dt><dd>{important[0]?.summary ?? "暂无可确认的项目进展"}</dd></div>
      <div><dt>最近工具</dt><dd>{latestTools.at(-1) ? `${latestTools.at(-1)!.name} · ${latestTools.at(-1)!.status}` : "暂无可确认的工具活动"}</dd></div>
      <div><dt>观察来源</dt><dd>{observed ? `${date(observed.observedAt)} · ${observed.freshness === "live" ? "当前原生观察" : "上次记录"}` : "尚无当前原生进度；不会推断思考过程"}</dd></div>
    </dl>
    {latestTools.length > 0 && <details><summary>展开 {observed?.items.length ?? latestTools.length} 项工具活动</summary><ol>{(observed?.items ?? latestTools).map(tool => <li key={tool.id}><strong>{tool.name}</strong><span>{tool.status}</span>{tool.summary && <p>{tool.summary}</p>}</li>)}</ol></details>}
    {important.length > 0 && <details><summary>查看最近项目进展</summary><ul>{important.map(activity => <li key={activity.id}>{activity.summary}<small>{date(activity.occurredAt ?? activity.recordedAt)}</small></li>)}</ul></details>}
  </section>;
}

function ConversationMessage({ item, context, snapshot, progress, onDetail }: {
  item: SessionConversationItem;
  context: MutationContext;
  snapshot: SessionSnapshot;
  progress: NativeProgressView | null;
  onDetail(id: string): void;
}) {
  const mine = item.senderActorId === context.principal.actorId;
  const processing = item.processing ?? null;
  const taskContext = item.context;
  return <div className={`session-chat-message ${mine ? "mine" : "other"}`}>
    <div className="session-chat-byline"><strong>{mine ? "我" : item.senderActorId}</strong><time>{date(item.createdAt)}</time><span>{messageStateLabel[item.state]}</span></div>
    <article className="session-chat-bubble">
      <MarkdownBody source={item.content} identity={`message-${item.id}`} projectId={context.projectId} />
      {item.contentTruncated && <p className="session-chat-truncated">正文较长，当前只显示安全预览。<button type="button" onClick={() => onDetail(item.id)}>读取完整消息</button></p>}
    </article>
    {taskContext && <p className="session-chat-context">关联 Task · <a href={`#/p/${context.projectId}/tasks/${taskContext.taskId}`}>{taskContext.taskId.slice(0, 8)}</a></p>}
    {processing && (processing.response || item.responseTruncated) && <div className="session-chat-reply">
      <div className="session-chat-byline"><strong>{snapshot.session.title}</strong><time>{date(processing.updatedAt)}</time><span>{processing.state === "completed" ? "原 Thread 回复" : processing.state === "failed" ? "处理失败" : "处理记录"}</span></div>
      {processing.response && <MarkdownBody source={processing.response} identity={`message-response-${processing.id}`} projectId={context.projectId} />}
      {item.responseTruncated && <p className="session-chat-truncated">回复较长，当前只显示安全预览。<button type="button" onClick={() => onDetail(item.id)}>读取完整回复</button></p>}
      <ToolSummary progress={progress} processing={processing} />
    </div>}
    {processing?.failure && <p className="session-chat-failure" role="alert"><CircleAlert size={15} aria-hidden="true" />处理失败：{processing.failure}</p>}
    {item.blockedReason && <p className="session-chat-status">{item.blockedReason}</p>}
    <button type="button" className="session-chat-detail-link" aria-label={`核对消息「${item.content.slice(0, 80)}」`} onClick={() => onDetail(item.id)}>核对正文与来源</button>
  </div>;
}

export function SessionConversation({ context, snapshot, onApplied, progress }: {
  context: MutationContext;
  snapshot: SessionSnapshot;
  onApplied(): void;
  progress: NativeProgressView | null;
}) {
  const entry = sessionMessageEntry(snapshot.session.kind, snapshot.session.capabilities);
  const messageScope = `${context.token}\0${context.projectId}\0${snapshot.session.key}`;
  const currentScope = useRef(messageScope);
  currentScope.current = messageScope;
  const [messages, setMessages] = useState<SessionConversationItem[]>([]);
  const [selected, setSelected] = useState<{ message: SessionMessageRecord; processing: SessionMessageProcessing | null } | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const fallbackReads = useRef(new Map<string, SessionConversationItem["state"]>());
  const historyExpanded = useRef(false);
  const conversationScroll = useRef<HTMLDivElement | null>(null);
  const keepAtBottom = useRef(true);
  const ignoreProgrammaticScroll = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const page = await sessionClient(context.token, context.projectId).messages(snapshot.session.key, undefined, controller.signal);
        if (!active) return;
        setMessages(previous => mergeConversation(previous, page.items));
        if (!historyExpanded.current) setNextCursor(current => current ?? page.nextCursor);
        setListError("");
      } catch (cause) { if (active && !controller.signal.aborted) setListError(errorText(cause)); }
      finally { if (active) setLoading(false); }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [context.token, context.projectId, snapshot.session.key, reload]);
  useEffect(() => {
    setMessages([]); setSelected(null); setNextCursor(null); setLoading(true); setListError(""); setDetailError("");
  }, [snapshot.session.key, context.projectId]);
  useEffect(() => {
    const scope = messageScope;
    const candidates = messages.filter(item => !item.processing && ["replied", "completed_without_reply", "failed", "unknown"].includes(item.state)
      && fallbackReads.current.get(item.id) !== item.state).slice(0, 4);
    if (!candidates.length) return;
    let active = true;
    void Promise.all(candidates.map(async item => {
      try {
        const value = await sessionClient(context.token, context.projectId).message(item.id);
        if (!active || currentScope.current !== scope || value.message.id !== item.id) return null;
        return value;
      } catch { return null; }
    })).then(results => {
      if (!active || currentScope.current !== scope) return;
      const byId = new Map(results.filter((value): value is NonNullable<typeof value> => !!value).map(value => [value.message.id, value]));
      if (!byId.size) return;
      for (const value of byId.values()) fallbackReads.current.set(value.message.id, value.message.state);
      setMessages(old => old.map(message => {
        const detail = byId.get(message.id);
        return detail ? { ...message, processing: detail.processing } : message;
      }));
    });
    return () => { active = false; };
  }, [messages, context.token, context.projectId, messageScope]);
  useEffect(() => {
    const id = selected?.message.id;
    if (!id) return;
    const scope = messageScope;
    const controller = new AbortController();
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const value = await sessionClient(context.token, context.projectId).message(id, controller.signal);
        if (controller.signal.aborted || currentScope.current !== scope || value.message.id !== id
          || value.message.projectId !== context.projectId) return;
        setSelected(current => current?.message.id === id ? value : current);
      } catch { /* Preserve the last confirmed detail until an explicit reread reports the failure. */ }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [context.token, context.projectId, messageScope, selected?.message.id]);
  async function loadMore() {
    if (!nextCursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const page = await sessionClient(context.token, context.projectId).messages(snapshot.session.key, nextCursor);
      setMessages(old => mergeConversation(old, page.items));
      historyExpanded.current = true;
      setNextCursor(page.nextCursor); setListError("");
    } catch (cause) { setListError(errorText(cause)); }
    finally { setMoreBusy(false); }
  }
  async function detail(messageId: string) {
    const scope = messageScope;
    try {
      const value = await sessionClient(context.token, context.projectId).message(messageId);
      if (currentScope.current !== scope) return;
      if (value.message.id !== messageId || value.message.projectId !== context.projectId) throw new Error("消息详情与所选项目记录不符");
      const target = value.message.target;
      const targetKey = target.kind === "owned" ? `owned:${target.sessionId}` : `external:${target.linkId}`;
      if (targetKey !== snapshot.session.key) throw new Error("消息详情与所选 Session 不符");
      setSelected(value); setDetailError("");
    } catch (cause) { if (currentScope.current === scope) setDetailError(errorText(cause)); }
  }
  const working = latestProcessed(messages);
  const ordered = [...messages].reverse();
  useEffect(() => {
    const node = conversationScroll.current;
    if (node && keepAtBottom.current) {
      ignoreProgrammaticScroll.current = true;
      node.scrollTop = node.scrollHeight;
      window.requestAnimationFrame(() => { ignoreProgrammaticScroll.current = false; });
    }
  }, [messages, working?.id, working?.state, progress?.observedAt]);
  const canRecordRead = selected?.message.target.kind === "owned" && !selected.message.readReceipt
    && selected.processing?.receiverActorId === context.principal.actorId
    && selected.processing.projectId === context.projectId && selected.processing.messageId === selected.message.id
    && selected.processing.sessionId === selected.message.target.sessionId && !!selected.processing.nativeTurnId?.trim()
    && (selected.processing.state === "running" && selected.message.state === "processing"
      || (selected.processing.state === "completed" || selected.processing.state === "failed")
        && (selected.message.state === "replied" || selected.message.state === "completed_without_reply" || selected.message.state === "failed"));
  return <section className="session-workspace-section session-conversation" aria-label="活动与对话">
    <div className="session-conversation-head"><div><h2>对话</h2><p>{snapshot.session.kind === "owned" ? "普通消息进入真实待处理流程。" : "外部会话只显示已同步的项目记录；原会话实时能力未同步。"}</p></div><details className="session-message-rules"><summary>消息处理规则</summary><p>{entry.introduction}</p>{entry.canSave && entry.sendReason && <p>保存能力：{entry.sendReason}</p>}<p>自动处理：{entry.executionLabel}。{entry.executionReason}{entry.executionObservedAt && <> 状态读于 {date(entry.executionObservedAt)}；配置变化后请重新读取。</>}</p></details></div>
    <p role="status" className="session-execution-state">{snapshot.session.kind === "external" ? "外部会话 · 保存后仍需人工转交；保存、送达与已读分别记录。" : `自动处理：${entry.executionLabel}。${entry.executionReason}`}{entry.executionObservedAt && <> · 状态读于 {date(entry.executionObservedAt)}；配置变化后请点上方“重新读取”。</>}</p>
    {detailError && <Alert kind="error">消息详情暂不可读取：{detailError}。</Alert>}
    {listError && <Alert kind="error">消息列表暂不可读取：{listError}。<button onClick={() => setReload(value => value + 1)}>重试列表</button></Alert>}
    <div ref={conversationScroll} className="session-conversation-scroll" onScroll={event => {
      if (ignoreProgrammaticScroll.current) return;
      const node = event.currentTarget;
      keepAtBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    }}>
      {loading && !messages.length && <p className="session-conversation-empty">正在读取对话…</p>}
      {!loading && !listError && !messages.length && <div className="session-conversation-empty"><MessageCircle size={24} aria-hidden="true" /><strong>还没有已保存的消息</strong><span>在下方写下要沟通的内容。保存、送达、处理与回复分别以真实记录为准。</span></div>}
      {nextCursor && <button type="button" className="session-conversation-older" disabled={moreBusy} onClick={() => void loadMore()}>{moreBusy ? "读取中…" : "加载更早消息"}</button>}
      {ordered.map(item => <ConversationMessage key={item.id} item={item} context={context} snapshot={snapshot} progress={progress} onDetail={id => void detail(id)} />)}
      {working && <WorkingObservation item={working} snapshot={snapshot} progress={progress} projectId={context.projectId} />}
    </div>
    {selected && <section className="session-message-detail">
      <div className="panel-head"><h3>消息详情 · {messageStateLabel[selected.message.state]}</h3><button type="button" onClick={() => setSelected(null)}>关闭</button></div>
      <p className="muted">发送 {date(selected.message.createdAt)} · 更新 {date(selected.message.updatedAt)} · 来源 {selected.message.senderActorId}</p>
      <MarkdownBody source={selected.message.content} identity={`message-detail-${selected.message.id}`} projectId={context.projectId} />
      {selected.processing?.response && <><h4>原会话回复</h4><MarkdownBody source={selected.processing.response} identity={`message-response-${selected.processing.id}`} projectId={context.projectId} /></>}
      {selected.processing?.failure && <Alert kind="error">处理失败：{selected.processing.failure}</Alert>}
      {selected.message.blockedReason && <p>等待原因：{selected.message.blockedReason}</p>}
      {selected.message.readReceipt && <p>已读回执：{selected.message.readReceipt.evidence} · {date(selected.message.readReceipt.at)}</p>}
      {canRecordRead && <ActionForm context={{ ...context, draftScope: `message-read:${selected.message.id}` }} title="记录本人已读原消息" fields={[{ name: "evidence", label: "阅读证据", kind: "textarea" }]} build={v => ({ type: "session.message.receipt", messageId: selected.message.id, stage: "read", evidence: v.evidence })} onApplied={() => { void detail(selected.message.id); setReload(value => value + 1); }} />}
      {(selected.message.state === "queued" || selected.message.state === "manual_pending") && selected.message.senderActorId === context.principal.actorId && <ActionForm context={{ ...context, draftScope: `message-cancel:${selected.message.id}`, draftBaseline: `${selected.message.version}` }} title="取消待处理消息" fields={[{ name: "reason", label: "取消原因", kind: "textarea" }]} build={v => ({ type: "session.message.cancel", messageId: selected.message.id, expectedVersion: selected.message.version, reason: v.reason })} onApplied={() => { void detail(selected.message.id); setReload(value => value + 1); }} />}
      {selected.message.state === "manual_pending" && <p className="muted">外部消息仍待人工转交，不能据此登记原生会话已读。</p>}
      {selected.message.target.kind === "owned" && !selected.message.readReceipt && !canRecordRead && <p className="muted">本人已读仅由配置的实际收件人登记；发送者和会话创建者不能代签。</p>}
    </section>}
    <div className="session-composer-host">
      {!entry.canSave ? <Alert>{entry.sendReason || "当前不可保存消息。"}</Alert> : <>
        {snapshot.currentWork && <p className="session-composer-context">引用当前工作：<a href={`#/p/${context.projectId}/tasks/${snapshot.currentWork.id}`}>{snapshot.currentWork.title}</a></p>}
        <ActionForm embedded submitOnModEnter context={{ ...context, draftScope: `session-message:${snapshot.session.key}` }} title={entry.actionTitle} fields={[{ name: "content", label: "消息内容", kind: "textarea", placeholder: snapshot.session.kind === "external" ? "写给当前外部 Session，保存后人工转交…" : "给当前 Session 发消息…", autoGrow: true }]} build={v => ({ type: "session.message.post", messageId: crypto.randomUUID(), target: snapshot.session.target, content: v.content, ...(snapshot.currentWork ? { context: { taskId: snapshot.currentWork.id, taskRevisionId: snapshot.currentWork.revisionId } } : {}) })} onApplied={() => { if (currentScope.current !== messageScope) return; setReload(value => value + 1); onApplied(); }} />
        <small className="session-composer-hint">{snapshot.session.busy ? "当前处理中，新消息依序排队。" : "Enter 换行，⌘/Ctrl + Enter 保存。"} 送达、已读与回复以消息记录为准。</small>
      </>}
    </div>
  </section>;
}
