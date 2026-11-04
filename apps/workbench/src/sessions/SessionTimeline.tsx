import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Bot, Check, ChevronDown, CircleAlert, Clock3, FileCode2, FileText, FolderOpen, Info, LoaderCircle, MessageCircle, Search, TerminalSquare, UserRound, Users, Wrench, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import type { WorkspaceEntry, WorkspaceState, WorkspaceTool } from "@evoloop/contracts/session-timeline";
import { errorText } from "../api";
import { ActionForm, type MutationContext } from "../workflow/ActionForm";
import { Alert, date } from "../ui/shared";
import { MarkdownBody } from "../ui/MarkdownBody";
import { sessionClient } from "./client";
import { sessionMessageEntry } from "./sessionMessageEntry";
import { useSessionTimeline } from "./useSessionTimeline";
import { workspaceReadingGroups, workspaceReadingOrder } from "./workspaceTimelineModel";
import { SessionIdentityMark } from "./SessionIdentityMark";
import type { SessionIdentity } from "@evoloop/contracts/session-identity";
import type { SessionTarget } from "@evoloop/contracts/session-work";

const states: Record<WorkspaceState, string> = { pending: "待处理", running: "进行中", completed: "已完成", failed: "失败", interrupted: "已中断", declined: "已拒绝", unknown: "状态未确认" };
const messageStates: Record<SessionMessageRecord["state"], string> = { queued: "待派发", processing: "原会话处理中", replied: "已回复", completed_without_reply: "已完成但无回复", failed: "失败", unknown: "结果未知", cancelled: "已取消", manual_pending: "待人工转交" };
type ReadingPosition = { top: number; height: number; id: string | null; offset: number; follow: boolean };
const readingPositions = new Map<string, ReadingPosition>();
const expandedTools = new Map<string, Set<string>>();
let viewCacheGeneration = 0;
export function clearSessionTimelineViews() { viewCacheGeneration++; readingPositions.clear(); expandedTools.clear(); }
function readingPosition(node: HTMLElement, follow: boolean): ReadingPosition {
  const top = node.getBoundingClientRect().top;
  const entry = [...node.querySelectorAll<HTMLElement>("[data-workspace-entry]")].find(item => item.getBoundingClientRect().bottom > top);
  return { top: node.scrollTop, height: node.scrollHeight, id: entry?.dataset.workspaceEntry ?? null,
    offset: entry ? entry.getBoundingClientRect().top - top : 0, follow };
}
function restorePosition(node: HTMLElement, prior: ReadingPosition) {
  const entry = [...node.querySelectorAll<HTMLElement>("[data-workspace-entry]")].find(item => item.dataset.workspaceEntry === prior.id);
  node.scrollTop = prior.follow ? node.scrollHeight : entry ? node.scrollTop + entry.getBoundingClientRect().top - node.getBoundingClientRect().top - prior.offset : prior.top;
}
function ToolIcon({ entry }: { entry: WorkspaceTool }) {
  const kind = entry.nativeKind;
  if (entry.name === "Read file") return <FileText size={17} aria-hidden="true" />;
  if (entry.name === "List files") return <FolderOpen size={17} aria-hidden="true" />;
  if (entry.name === "Search") return <Search size={17} aria-hidden="true" />;
  if (kind === "fileChange") return <FileCode2 size={17} aria-hidden="true" />;
  if (kind === "webSearch") return <Search size={17} aria-hidden="true" />;
  if (kind === "commandExecution") return <TerminalSquare size={17} aria-hidden="true" />;
  return <Wrench size={17} aria-hidden="true" />;
}
const toolLabel = (name: string) => ({ Command: "执行命令", "Read file": "读取文件", "List files": "列出文件", Search: "搜索", "Web search": "网页搜索", "File change": "修改文件", "Agent collaboration": "Agent 协作", "Tool result": "工具结果" } as Record<string, string>)[name] ?? name;
function StateIcon({ state }: { state: WorkspaceState }) {
  return state === "running" ? <LoaderCircle size={13} className="workspace-spinning" aria-hidden="true" />
    : state === "failed" || state === "interrupted" || state === "declined" ? <CircleAlert size={13} aria-hidden="true" />
      : state === "completed" ? <Check size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />;
}

function ToolGroup({ entries, scope, onDetail }: { entries: WorkspaceTool[]; scope: string; onDetail(entry: WorkspaceEntry): void }) {
  const [open, setOpen] = useState(() => entries.some(entry => expandedTools.get(scope)?.has(entry.id)));
  const listId = useId();
  const failures = entries.filter(entry => ["failed", "interrupted", "declined"].includes(entry.state)).length;
  const running = entries.some(entry => entry.state === "running" && entry.freshness === "live");
  return <div className={`workspace-tools ${failures ? "has-failure" : ""}`}>
    <button type="button" className="workspace-tools-toggle" aria-expanded={open} aria-controls={listId} onClick={() => {
      const next = !open, saved = expandedTools.get(scope) ?? new Set<string>();
      for (const entry of entries) if (next) saved.add(entry.id); else saved.delete(entry.id);
      expandedTools.delete(scope); expandedTools.set(scope, saved);
      while (expandedTools.size > 2) expandedTools.delete(expandedTools.keys().next().value!);
      setOpen(next);
    }}><ChevronDown size={14} aria-hidden="true" /><Wrench size={15} aria-hidden="true" /><strong>工具与活动 · {entries.length} 项</strong>
      <span className="workspace-tools-status">{running && <><LoaderCircle size={13} className="workspace-spinning" aria-hidden="true" />进行中</>}{failures > 0 && <><CircleAlert size={13} aria-hidden="true" />{failures} 项失败或中断</>}</span>
    </button>
    <div id={listId} className={`workspace-tool-list ${open ? "expanded" : "preview"}`}>
      {(open ? entries : entries.slice(0, 4)).map(entry => <div className={`workspace-tool ${entry.state}`} key={entry.id} data-workspace-entry={entry.id} data-turn-id={entry.turnId ?? undefined}>
        <ToolIcon entry={entry} /><div><strong>{toolLabel(entry.name)}</strong>{entry.summary && entry.summary !== entry.name && <span>{entry.summary}</span>}
          <small><StateIcon state={entry.state === "running" && entry.freshness !== "live" ? "unknown" : entry.state} />{entry.freshness !== "live" && entry.state === "running" ? "上次进行中，当前待核对" : states[entry.state]}{entry.durationMs !== null && ` · ${Math.round(entry.durationMs) / 1000}s`}</small></div>
        {open && <button type="button" className="workspace-entry-detail" onClick={() => onDetail(entry)} aria-label={`查看工具详情：${entry.name}`}>详情</button>}
      </div>)}
    </div>
    {!open && entries.length > 4 && <span className="workspace-tool-more">另有 {entries.length - 4} 项，展开查看</span>}
  </div>;
}

function TimelineEntry({ item, context, title, sessionKey, target, identity, taskHref, onDetail, onMessage, onExpanded }: {
  item: WorkspaceEntry; context: MutationContext; title: string; sessionKey: string; target: SessionTarget; identity: SessionIdentity | null;
  taskHref(taskId: string): string;
  onDetail(entry: WorkspaceEntry): void; onMessage(id: string): void; onExpanded?(entry: WorkspaceEntry): void;
}) {
  const [fullText, setFullText] = useState<{ body: string; truncated: boolean } | null>(null);
  const [bodyError, setBodyError] = useState("");
  const [bodyBusy, setBodyBusy] = useState(false);
  const bodyScope = `${context.token}\0${context.projectId}\0${item.id}`;
  const currentBodyScope = useRef(bodyScope); currentBodyScope.current = bodyScope;
  useEffect(() => () => { currentBodyScope.current = ""; }, [bodyScope]);
  const expandBody = async () => {
    if (item.kind !== "message") return;
    if (!item.turnId || !item.nativeItemId) { if (item.origin?.kind === "message") onMessage(item.origin.id); else onDetail(item); return; }
    setBodyBusy(true); setBodyError("");
    try {
      const value = await sessionClient(context.token, context.projectId).timelineItem(sessionKey, item.turnId, item.nativeItemId);
      if (currentBodyScope.current !== bodyScope) return;
      if (value.kind !== "message" || value.id !== item.id || value.turnId !== item.turnId || value.nativeItemId !== item.nativeItemId) throw new Error("正文与所选消息不符");
      setFullText({ body: value.body, truncated: value.truncated });
      onExpanded?.(value);
    } catch (cause) { if (currentBodyScope.current === bodyScope) setBodyError(errorText(cause)); }
    finally { if (currentBodyScope.current === bodyScope) setBodyBusy(false); }
  };
  const dispatched = item.kind === "message" && item.role === "input" && item.origin?.kind === "run";
  const mine = !dispatched && item.kind === "message" && item.role === "input" && item.author.kind === "actor" && item.author.id === context.principal.actorId;
  const assistant = item.kind === "message" && item.role === "assistant";
  const provenSession = assistant && target.kind === "owned" && item.author.kind === "session" && item.author.id === target.sessionId;
  const label = dispatched ? `项目派发 · ${item.author.label || "发起者未确认"}` : mine ? "我" : item.author.label || (assistant ? `${title} Agent` : "发送者未确认");
  const messageId = item.origin?.kind === "message" ? item.origin.id : null;
  const summary = item.kind === "message" ? null : item.kind === "tool" ? item.name : item.label;
  const expandedBody = item.kind === "message" && fullText && item.state !== "running" && fullText.body.startsWith(item.body) ? fullText : null;
  const body = expandedBody?.body ?? (item.kind === "tool" ? item.summary : item.body);
  return <article aria-label={dispatched ? "项目派发的任务输入" : mine ? "我发出的消息" : label} className={`workspace-message ${mine ? "from-me" : assistant ? "from-agent" : "from-other"} ${item.kind !== "message" ? "workspace-record" : ""}`} data-workspace-entry={item.id} data-turn-id={item.turnId ?? undefined}>
    <span className="workspace-avatar" aria-hidden="true">{dispatched ? <FileText size={18} /> : mine ? <UserRound size={18} /> : assistant ? <Bot size={19} /> : item.author.kind === "actor" ? <Users size={18} /> : <Info size={18} />}</span>
    <div className="workspace-message-content"><header>{provenSession && <SessionIdentityMark target={target} identity={identity} name={title} size="small" />}<strong>{label}</strong>{item.occurredAt && <time dateTime={item.occurredAt}>{date(item.occurredAt)}</time>}
      {item.freshness === "stale" && <span className="workspace-stale">上次观察</span>}
      {item.kind === "message" && item.role === "input" && ["pending", "running", "failed", "unknown", "interrupted", "declined"].includes(item.state) && <span className={`workspace-input-state ${item.state}`}>{states[item.state]}</span>}
    </header><div className={`workspace-message-body ${item.kind === "message" ? item.phase : ""}`}>
      {summary && <h3>{summary}</h3>}
      {body ? <MarkdownBody source={body} identity={`workspace-${item.id}`} projectId={context.projectId} /> : <p className="muted">{assistant && item.state === "running" ? "正在回复…" : "原生来源未提供可公开的正文。"}</p>}
      {(expandedBody?.truncated ?? item.truncated) && <button className="workspace-entry-detail" type="button" disabled={bodyBusy} onClick={() => void expandBody()}>{bodyBusy ? "读取完整内容中…" : `读取完整${assistant ? "回复" : "内容"}`}</button>}
      {bodyError && <p role="alert" className="workspace-input-state failed">{bodyError}</p>}
      <footer>{messageId && <button type="button" className="workspace-entry-detail" onClick={() => onMessage(messageId)}>消息详情</button>}
        {item.origin?.kind === "run" && item.origin.taskId && <a href={`${taskHref(item.origin.taskId)}${taskHref(item.origin.taskId).includes("?") ? "&" : "?"}run=${encodeURIComponent(item.origin.id)}`}>查看来源任务</a>}
        {!messageId && item.nativeItemId && !mine && <button type="button" className="workspace-entry-detail" onClick={() => onDetail(item)}>查看来源</button>}
      </footer>
    </div></div>
  </article>;
}

function EntryInspector({ entry, context, sessionKey, mayReadOriginal }: { entry: WorkspaceEntry; context: MutationContext; sessionKey: string; mayReadOriginal: boolean }) {
  const [value, setValue] = useState(entry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scope = `${context.token}\0${context.projectId}\0${sessionKey}\0${entry.id}`;
  const current = useRef(scope); current.current = scope;
  const read = async () => {
    if (!entry.turnId || !entry.nativeItemId) return;
    setBusy(true); setError("");
    try {
      const result = await sessionClient(context.token, context.projectId).timelineItem(sessionKey, entry.turnId, entry.nativeItemId);
      if (current.current !== scope) return;
      if (result.turnId !== entry.turnId || result.nativeItemId !== entry.nativeItemId) throw new Error("详情与所选活动不符");
      setValue(result);
    } catch (cause) { if (current.current === scope) setError(errorText(cause)); }
    finally { if (current.current === scope) setBusy(false); }
  };
  useEffect(() => { if (entry.kind === "message" && entry.truncated) void read(); return () => { current.current = ""; }; }, [scope]);
  return <><p className="workspace-source-note">{value.author.label}{value.occurredAt ? ` · ${date(value.occurredAt)}` : " · 原生时间未提供"}</p>
    {value.kind === "tool" ? <><h3>{toolLabel(value.name)}</h3><p>{value.summary || "原生来源未提供摘要。"}</p><p className={`workspace-tool-state ${value.state}`}><StateIcon state={value.state === "running" && value.freshness !== "live" ? "unknown" : value.state} />{value.state === "running" && value.freshness !== "live" ? "上次进行中，当前待核对" : states[value.state]}{value.exitCode !== null ? ` · 退出码 ${value.exitCode}` : ""}</p>
      {value.detail && mayReadOriginal ? <>{value.detail.input !== null && <details open><summary>输入</summary><pre>{value.detail.input}</pre></details>}{value.detail.output !== null && <details open><summary>输出</summary><pre>{value.detail.output}</pre></details>}{value.detail.error && <Alert kind="error">{value.detail.error}</Alert>}{value.detail.resources.length > 0 && <ul>{value.detail.resources.map(resource => <li key={resource}><code>{resource}</code></li>)}</ul>}</>
        : value.detailAvailable && mayReadOriginal ? <button type="button" disabled={busy} onClick={() => void read()}>{busy ? "读取中…" : "读取原始输入与输出"}</button> : <p className="muted">{mayReadOriginal ? value.detailReason || "来源没有提供原始工具详情。" : "当前身份可阅读活动摘要；原始输入与输出未获授权。"}</p>}
    </> : <MarkdownBody source={value.body} identity={`workspace-detail-${value.id}`} projectId={context.projectId} />}
    {busy && <p role="status">正在读取完整内容…</p>}{error && <Alert kind="error">{error}<button type="button" disabled={busy} onClick={() => void read()}>重试详情</button></Alert>}
    {value.truncated && !busy && <p className="muted">来源内容仍有截断，当前显示不能代表完整原件。</p>}
    <details className="workspace-source-identifiers"><summary>来源标识与读取范围</summary><dl><div><dt>Turn</dt><dd>{value.turnId || "未提供"}</dd></div><div><dt>Item</dt><dd>{value.nativeItemId || "未提供"}</dd></div><div><dt>来源类型</dt><dd>{value.origin?.kind || "未关联业务来源"}</dd></div><div><dt>读取于</dt><dd>{date(value.observedAt)}</dd></div></dl></details>
  </>;
}

function MessageInspector({ id, context, snapshot, onApplied }: { id: string; context: MutationContext; snapshot: SessionSnapshot; onApplied(): void }) {
  const [value, setValue] = useState<{ message: SessionMessageRecord; processing: SessionMessageProcessing | null } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      try {
        const result = await sessionClient(context.token, context.projectId).message(id, controller.signal);
        if (controller.signal.aborted) return;
        const target = result.message.target;
        if (result.message.id !== id || result.message.projectId !== context.projectId || `${target.kind}:${target.kind === "owned" ? target.sessionId : target.linkId}` !== snapshot.session.key) throw new Error("消息详情与所选 Session 不符");
        setValue(result); setError("");
      } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    };
    void read();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void read(); }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [id, context.token, context.projectId, snapshot.session.key, reload]);
  if (!value) return error ? <Alert kind="error">{error}<button type="button" onClick={() => setReload(value => value + 1)}>重试</button></Alert> : <p>正在读取消息…</p>;
  const { message, processing } = value;
  const canRead = message.target.kind === "owned" && !message.readReceipt && processing?.receiverActorId === context.principal.actorId
    && processing.projectId === context.projectId && processing.messageId === message.id && processing.sessionId === message.target.sessionId && !!processing.nativeTurnId?.trim()
    && (processing.state === "running" && message.state === "processing" || ["completed", "failed"].includes(processing.state) && ["replied", "completed_without_reply", "failed"].includes(message.state));
  const applied = () => { setReload(value => value + 1); onApplied(); };
  return <>{error && <Alert kind="error">{error}</Alert>}<h3>消息详情 · {messageStates[message.state]}</h3><p className="workspace-source-note">发送者 {message.senderActorId} · {date(message.createdAt)}</p><MarkdownBody source={message.content} identity={`message-detail-${message.id}`} projectId={context.projectId} />
    {processing?.response && <><h3>原会话回复</h3><MarkdownBody source={processing.response} identity={`message-response-${processing.id}`} projectId={context.projectId} /></>}
    {processing?.failure && <Alert kind="error">处理失败：{processing.failure}</Alert>}{message.blockedReason && <p>等待原因：{message.blockedReason}</p>}
    {message.readReceipt && <p>已读回执：{message.readReceipt.evidence} · {date(message.readReceipt.at)}</p>}
    {canRead && <ActionForm context={{ ...context, draftScope: `message-read:${message.id}` }} title="记录本人已读原消息" fields={[{ name: "evidence", label: "阅读证据", kind: "textarea" }]} build={v => ({ type: "session.message.receipt", messageId: message.id, stage: "read", evidence: v.evidence })} onApplied={applied} />}
    {(["queued", "manual_pending"].includes(message.state)) && message.senderActorId === context.principal.actorId && <ActionForm context={{ ...context, draftScope: `message-cancel:${message.id}`, draftBaseline: String(message.version) }} title="取消待处理消息" fields={[{ name: "reason", label: "取消原因", kind: "textarea" }]} build={v => ({ type: "session.message.cancel", messageId: message.id, expectedVersion: message.version, reason: v.reason })} onApplied={applied} />}
    {message.state === "manual_pending" && <p className="muted">外部消息仍待人工转交；保存不代表已送达或已读。</p>}
  </>;
}

export function SessionTimeline({ context, snapshot, onApplied, taskHref, refresh = 0, reauthorizeVersion = 0, children }: { context: MutationContext; snapshot: SessionSnapshot; onApplied(): void; taskHref(taskId: string): string; refresh?: number; reauthorizeVersion?: number; children?: ReactNode }) {
  const timeline = useSessionTimeline(context.token, context.projectId, context.principal.actorId, snapshot.session.key, refresh, reauthorizeVersion);
  const capability = sessionMessageEntry(snapshot.session.kind, snapshot.session.capabilities);
  const items = useMemo(() => workspaceReadingOrder(timeline.entries, timeline.pending), [timeline.entries, timeline.pending]);
  const groups = useMemo(() => workspaceReadingGroups(items), [items]);
  const [inspector, setInspector] = useState<{ entry: WorkspaceEntry } | { messageId: string } | null>(null);
  const inspectorTrigger = useRef<HTMLElement | null>(null);
  const inspect = (selection: NonNullable<typeof inspector>) => {
    inspectorTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInspector(selection);
  };
  const [nearBottom, setNearBottom] = useState(true);
  const scroll = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const anchor = useRef<ReadingPosition | null>(null);
  const restore = useRef<ReadingPosition | null>(null);
  const cacheGeneration = useRef(viewCacheGeneration);
  const scope = `${context.token}\0${context.projectId}\0${context.principal.actorId}\0${snapshot.session.key}`;
  const historyFill = useRef({ scope, count: 0, busy: false });
  useLayoutEffect(() => {
    historyFill.current = { scope, count: 0, busy: false };
    cacheGeneration.current = viewCacheGeneration;
    const saved = readingPositions.get(scope) ?? null;
    restore.current = saved; follow.current = saved?.follow ?? true;
    inspectorTrigger.current = null; setInspector(null); setNearBottom(saved?.follow ?? true);
  }, [scope]);
  useEffect(() => { if (timeline.denied) { readingPositions.delete(scope); expandedTools.delete(scope); inspectorTrigger.current = null; setInspector(null); } }, [scope, timeline.denied]);
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    let previousWidth = node.clientWidth;
    let hidden = node.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      if (node.clientHeight === 0) { hidden = true; return; }
      const position = readingPositions.get(scope);
      if ((hidden || previousWidth !== node.clientWidth && !follow.current) && position) restorePosition(node, position);
      previousWidth = node.clientWidth; hidden = false;
      // Reflow changes scrollHeight; retain the reader's prior follow intention.
      if (follow.current && !anchor.current) { node.scrollTop = node.scrollHeight; setNearBottom(true); }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scope]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    if (restore.current && timeline.loaded && !timeline.moreBusy && items.length) {
      restorePosition(node, restore.current); restore.current = null;
    } else if (anchor.current && !timeline.moreBusy) {
      restorePosition(node, anchor.current);
      anchor.current = null;
    } else if (!anchor.current && follow.current) node.scrollTop = node.scrollHeight;
  }, [items, timeline.moreBusy, timeline.turns, timeline.loaded]);
  const more = async (keepLatest = false) => {
    const node = scroll.current;
    if (node) {
      follow.current = keepLatest;
      anchor.current = readingPosition(node, keepLatest);
    }
    await timeline.loadMore();
  };
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const fill = () => {
      const budget = historyFill.current;
      if (budget.scope !== scope || budget.busy || budget.count >= 3 || !follow.current ||
        !timeline.loaded || timeline.denied || timeline.error || timeline.moreBusy || timeline.reconciling ||
        !(timeline.nextCursor || timeline.messagesCursor) || node.clientHeight < 1 ||
        node.scrollHeight > node.clientHeight + 2) return;
      const first = node.firstElementChild?.getBoundingClientRect(), last = node.lastElementChild?.getBoundingClientRect();
      if (first && last && node.clientHeight - (last.bottom - first.top) < Math.max(120, node.clientHeight * .2)) return;
      budget.count++; budget.busy = true;
      void more(true).finally(() => { budget.busy = false; });
    };
    const observer = new ResizeObserver(fill);
    observer.observe(node); fill();
    return () => observer.disconnect();
  }, [scope, items, timeline.loaded, timeline.denied, timeline.error, timeline.moreBusy,
    timeline.reconciling, timeline.nextCursor, timeline.messagesCursor]);
  const applied = () => { timeline.refresh(); onApplied(); };
  const activeTurn = timeline.live?.activeTurnId
    ? timeline.turns.find(turn => turn.id === timeline.live!.activeTurnId && turn.state === "running") : undefined;
  const live = timeline.live?.freshness === "live";
  const limitations = [...new Set([...(timeline.page?.limitations ?? []), ...(timeline.live?.limitations ?? [])])];
  return <section className="session-workspace-section session-conversation unified-session-timeline" aria-label="活动与对话">
    {snapshot.session.kind === "external" && <p className="workspace-range-note"><Info size={13} aria-hidden="true" />外部会话 · 这里只显示已同步内容，消息保存后需人工转交。</p>}
    {timeline.error && <Alert kind="error">活动暂不可读取：{timeline.error}<button type="button" onClick={timeline.reread}>重新读取活动</button></Alert>}
    <div ref={scroll} className="session-conversation-scroll workspace-timeline-scroll" role="log" tabIndex={0} aria-label="Session 消息与工具时间线" aria-live="off" aria-busy={!timeline.loaded} onScroll={event => {
      const node = event.currentTarget;
      if (!node.clientHeight || timeline.denied || cacheGeneration.current !== viewCacheGeneration) return;
      const near = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
      follow.current = near; setNearBottom(near);
      readingPositions.delete(scope); readingPositions.set(scope, readingPosition(node, near));
      while (readingPositions.size > 2) readingPositions.delete(readingPositions.keys().next().value!);
    }}>
      {(timeline.nextCursor || timeline.messagesCursor) && <button className="session-conversation-older" type="button" disabled={timeline.moreBusy || timeline.reconciling} onClick={() => void more()}>{timeline.reconciling ? "正在校准历史…" : timeline.moreBusy ? "正在读取更早内容…" : "加载更早的消息与活动"}</button>}
      {!timeline.loaded && <p className="workspace-reading-status" role="status"><LoaderCircle size={16} className="workspace-spinning" aria-hidden="true" />正在读取会话…</p>}
      {timeline.loaded && !timeline.error && !groups.length && !children && !activeTurn && <div className="session-conversation-empty"><MessageCircle size={25} aria-hidden="true" /><strong>{timeline.page?.partial ? "当前来源尚未提供可读的活动" : "从这里开始沟通"}</strong><span>{timeline.page?.partial ? "这不代表原会话没有历史记录，可在读取范围中查看原因。" : "发送消息后，这个 Agent 的回复与工具活动会连续显示在这里。"}</span></div>}
      {groups.map(group => group.kind === "tools" ? <ToolGroup key={`tools:${group.id}`} entries={group.entries} scope={scope} onDetail={entry => inspect({ entry })} /> : <TimelineEntry key={group.entry.id} item={group.entry} context={context} title={snapshot.session.title} sessionKey={snapshot.session.key} target={snapshot.session.target} identity={snapshot.session.identity} taskHref={taskHref} onExpanded={timeline.replaceEntry} onDetail={entry => inspect({ entry })} onMessage={messageId => inspect({ messageId })} />)}
      {activeTurn && <div className={`workspace-turn-state ${live ? "" : "stale"}`} role="status"><span className="workspace-avatar"><Bot size={19} aria-hidden="true" /></span><div><strong>{live ? <><LoaderCircle size={15} className="workspace-spinning" aria-hidden="true" />处理中</> : "上次观察为进行中"}</strong><span>{live ? "活动将随原会话更新。" : "当前连接状态待核对。"}</span></div></div>}
      {!timeline.denied && children}
    </div>
    {!nearBottom && items.length > 0 && <button className="workspace-jump-latest" type="button" onClick={() => { if (scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); follow.current = true; setNearBottom(true); }}><ArrowDown size={15} aria-hidden="true" />回到最新内容</button>}
    <div className="session-composer-host">
      {!capability.canSave ? <Alert>{capability.sendReason || "当前不能保存消息。"}</Alert> : <ActionForm embedded submitOnModEnter context={{ ...context, draftScope: `session-message:${snapshot.session.key}` }} title={capability.actionTitle} fields={[{ name: "content", label: "消息内容", kind: "textarea", placeholder: snapshot.session.kind === "external" ? "写给当前外部 Session，保存后人工转交…" : "给当前 Session 发消息…", autoGrow: true }]} build={v => ({ type: "session.message.post", messageId: crypto.randomUUID(), target: snapshot.session.target, content: v.content, ...(snapshot.currentWork ? { context: { taskId: snapshot.currentWork.id, taskRevisionId: snapshot.currentWork.revisionId } } : {}) })} onApplied={applied} />}
      <div className="workspace-composer-meta"><small>{snapshot.session.busy ? "当前处理中，新消息依序排队。" : "Enter 换行，⌘/Ctrl + Enter 保存。"}</small><details className="workspace-reading-scope"><summary>读取范围</summary><div><p>{capability.introduction}</p><p>自动处理：{capability.executionLabel}。{capability.executionReason}</p>{capability.executionObservedAt && <p>执行状态读于 {date(capability.executionObservedAt)}；配置变化后请点上方“重新读取”。</p>}<p>{timeline.page?.capabilities.history ? "历史按原生来源分页读取。" : "当前原生历史不可读取。"}{timeline.live?.freshness === "live" ? "实时活动来自现有连接。" : "当前没有可确认的实时连接。"}</p>{timeline.page && <p>读取于 {date(timeline.page.observedAt)}{timeline.page.partial && " · 来源仅展示已读范围"}</p>}{limitations.length > 0 && <ul>{limitations.map(reason => <li key={reason}>{reason}</li>)}</ul>}</div></details></div>
    </div>
    <Dialog.Root open={inspector !== null && !timeline.denied} onOpenChange={open => { if (!open) setInspector(null); }}><Dialog.Portal><Dialog.Overlay className="workspace-inspector-overlay" /><Dialog.Content className="workspace-inspector" aria-describedby="workspace-inspector-description" onCloseAutoFocus={event => { const trigger = inspectorTrigger.current; if (trigger?.isConnected && trigger.getClientRects().length) { event.preventDefault(); trigger.focus({ preventScroll: true }); } inspectorTrigger.current = null; }}><header><div><Dialog.Title>活动详情</Dialog.Title><Dialog.Description id="workspace-inspector-description">核对所选内容、消息状态与来源。</Dialog.Description></div><Dialog.Close aria-label="关闭活动详情"><X size={18} /></Dialog.Close></header>{inspector && !timeline.denied && ("entry" in inspector ? <EntryInspector key={inspector.entry.id} entry={inspector.entry} context={context} sessionKey={snapshot.session.key} mayReadOriginal={timeline.page?.capabilities.originalToolDetail ?? false} /> : <MessageInspector key={inspector.messageId} id={inspector.messageId} context={context} snapshot={snapshot} onApplied={applied} />)}</Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
