// The center of the agent page: one continuous flow of what was said and done, in the order the records give.
// A person's message is a bubble on the right, the agent's reply is plain prose, tool calls fold into one muted line
// (failures and the running step stay in sight), a finished turn closes with one line of what it produced, and a live
// status line ends the flow while a turn runs. The composer stays at the bottom. Reading position, history paging
// and the long poll come from useSessionTimeline and are kept as they were.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, FileText, Info, LoaderCircle, MessageCircle, Users } from "lucide-react";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import type { WorkspaceEntry, WorkspaceTool } from "@evoloop/contracts/session-timeline";
import type { SessionIdentity } from "@evoloop/contracts/session-identity";
import type { SessionTarget } from "@evoloop/contracts/session-work";
import {
  AgentAvatar, AgentMessage, Button, CollapsibleRow, Dialog, DialogContent, DialogDescription, DialogTitle, LiveStatusLine, MessageBubble, Notice,
  TodoList, ToolSummary, TurnSummary, cn,
} from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { date } from "../../shared/ui/shared";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { readingProse } from "../../shared/ui/readingProse";
import { sessionClient } from "../../shared/sessionClient";
import { agentDisplayName } from "../../shared/agentNamePresentation";
import { useProjectQuery } from "../../shared/query";
import { sessionMessageEntry } from "./sessionMessageEntry";
import { useSessionTimeline } from "./useSessionTimeline";
import { workspaceReadingGroups, workspaceReadingOrder } from "./workspaceTimelineModel";
import {
  elapsedText, entryStateLabel, isFailedEntry, liveStatusText, pinnedToolIds, planExplanation, planSteps, recordLabel, toolDetailReason, toolGroupStatus, toolGroupSummary,
  toolLabel, toolStepState, toolStepText, turnSummaries,
} from "./conversationPresentation";
import { SessionIdentityMark } from "./SessionIdentityMark";
import { SessionComposer } from "./SessionComposer";
import { SourceLimitations } from "./SourceLimitations";
import type { NativeProgressView } from "./NativeSessionPanel";

const messageStates: Record<SessionMessageRecord["state"], string> = { queued: "待派发", processing: "原会话处理中", replied: "已回复", completed_without_reply: "已完成但无回复", failed: "失败", unknown: "结果未知", cancelled: "已取消", manual_pending: "待人工转交" };
const originKinds: Record<string, string> = { run: "任务运行", message: "普通消息", native: "原生来源" };
type ReadingPosition = { top: number; height: number; id: string | null; offset: number; viewportTop: number | null; follow: boolean };
const readingPositions = new Map<string, ReadingPosition>();
const expandedTools = new Map<string, Set<string>>();
let viewCacheGeneration = 0;
export function clearSessionTimelineViews() { viewCacheGeneration++; readingPositions.clear(); expandedTools.clear(); }
function readingPosition(node: HTMLElement, follow: boolean): ReadingPosition {
  const top = node.getBoundingClientRect().top;
  const entry = [...node.querySelectorAll<HTMLElement>("[data-workspace-entry]")].find(item => item.getBoundingClientRect().bottom > top);
  return { top: node.scrollTop, height: node.scrollHeight, id: entry?.dataset.workspaceEntry ?? null,
    offset: entry ? entry.getBoundingClientRect().top - top : 0,
    viewportTop: entry?.getBoundingClientRect().top ?? null, follow };
}
function restorePosition(node: HTMLElement, prior: ReadingPosition) {
  const entry = [...node.querySelectorAll<HTMLElement>("[data-workspace-entry]")].find(item => item.dataset.workspaceEntry === prior.id);
  node.scrollTop = prior.follow ? node.scrollHeight : entry ? node.scrollTop + entry.getBoundingClientRect().top -
    (prior.viewportTop ?? node.getBoundingClientRect().top + prior.offset) : prior.top;
}
/** Agent replies read as prose: the shared reading type (body size, reading line height), as AgentMessage draws them. */
const replyProse = cn(readingProse, "[&_:is(h2,h3)]:mt-5 [&_:is(h2,h3)]:text-body [&_:is(h4,h5,h6)]:mt-4");
/** Small text actions under an entry (详情、消息详情、查看来源): Button variant="link" at caption size. */
const linkButton = "text-caption";

/** Ticks once a second while `active`, for the live status line's elapsed time. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function ToolGroup({ entries, scope, context, sessionKey, mayReadOriginal }: { entries: WorkspaceTool[]; scope: string; context: MutationContext; sessionKey: string; mayReadOriginal: boolean }) {
  const [open, setOpen] = useState(() => entries.some(entry => expandedTools.get(scope)?.has(entry.id)));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pinned = pinnedToolIds(entries, selectedId);
  const toggle = (next: boolean) => {
    const saved = expandedTools.get(scope) ?? new Set<string>();
    for (const entry of entries) if (next) saved.add(entry.id); else saved.delete(entry.id);
    expandedTools.delete(scope); expandedTools.set(scope, saved);
    while (expandedTools.size > 2) expandedTools.delete(expandedTools.keys().next().value!);
    setOpen(next);
  };
  return <ToolSummary
    className="workspace-tools"
    triggerClassName="workspace-tools-toggle"
    open={open}
    onOpenChange={toggle}
    summary={toolGroupSummary(entries)}
    status={<span className={entries.some(isFailedEntry) ? "text-destructive" : undefined}>{toolGroupStatus(entries)}</span>}
    steps={entries.map(entry => {
      const label = toolLabel(entry.name);
      const selected = selectedId === entry.id;
      return {
        id: entry.id, text: toolStepText(entry), meta: toolStepState(entry), failed: isFailedEntry(entry),
        running: entry.state === "running" && entry.freshness === "live", pinned: pinned.has(entry.id),
        rowProps: { className: cn("workspace-tool", entry.state), "data-workspace-entry": entry.id, "data-turn-id": entry.turnId ?? undefined },
        action: <Button variant="link" className={cn(linkButton, "shrink-0")} aria-label={`${selected ? "收起" : "查看"}工具详情：${label}`} aria-expanded={selected}
          onClick={() => setSelectedId(value => value === entry.id ? null : entry.id)}>{selected ? "收起" : "详情"}</Button>,
        detail: selected ? <div className="workspace-tool-inline flex flex-col gap-2 rounded-md bg-raised p-3 text-small text-foreground" role="region" aria-label={`${label}详情`}>
          <EntryInspector key={entry.id} entry={entry} context={context} sessionKey={sessionKey} mayReadOriginal={mayReadOriginal} />
        </div> : undefined,
      };
    })} />;
}

function TimelineEntry({ item, context, title, taskTitle, sessionKey, target, identity, taskHref, onDetail, onMessage, onExpanded }: {
  item: WorkspaceEntry; context: MutationContext; title: string; sessionKey: string; target: SessionTarget; identity: SessionIdentity | null;
  taskTitle: string | null;
  taskHref(taskId: string): string;
  onDetail(entry: WorkspaceEntry): void; onMessage(id: string): void; onExpanded?(entry: WorkspaceEntry): void;
}) {
  const [fullText, setFullText] = useState<{ body: string; truncated: boolean } | null>(null);
  const [bodyError, setBodyError] = useState("");
  const [bodyBusy, setBodyBusy] = useState(false);
  const bodyScope = `${context.projectId}\0${item.id}`;
  const currentBodyScope = useRef(bodyScope); currentBodyScope.current = bodyScope;
  useEffect(() => () => { currentBodyScope.current = ""; }, [bodyScope]);
  const expandBody = async () => {
    if (item.kind !== "message") return;
    if (!item.turnId || !item.nativeItemId) { if (item.origin?.kind === "message") onMessage(item.origin.id); else onDetail(item); return; }
    setBodyBusy(true); setBodyError("");
    try {
      const value = await sessionClient("", context.projectId).timelineItem(sessionKey, item.turnId, item.nativeItemId);
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
  const label = mine ? "我" : assistant ? title : item.author.label || "发送者未确认";
  const messageId = item.origin?.kind === "message" ? item.origin.id : null;
  const heading = item.kind === "message" ? null : item.kind === "tool" ? toolLabel(item.name) : recordLabel(item.label);
  const expandedBody = item.kind === "message" && fullText && item.state !== "running" && fullText.body.startsWith(item.body) ? fullText : null;
  const body = expandedBody?.body ?? (item.kind === "tool" ? toolStepText(item) : item.body);
  const runHref = item.origin?.kind === "run" && item.origin.taskId ? `${taskHref(item.origin.taskId)}${taskHref(item.origin.taskId).includes("?") ? "&" : "?"}run=${encodeURIComponent(item.origin.id)}` : null;
  if (dispatched && item.origin?.taskId) return <article className="workspace-system-strip flex flex-wrap items-center gap-x-2 gap-y-1 self-center rounded-full bg-muted px-3 py-1.5 text-caption text-text-secondary" data-workspace-entry={item.id} data-turn-id={item.turnId ?? undefined}>
    <FileText size={14} aria-hidden="true" /><strong className="font-medium text-foreground">系统派发 · 本轮任务</strong><span>来自任务运行 · {taskTitle || "任务标题待核对"}</span>
    <a className="text-primary hover:underline" href={runHref!}>查看任务与指令</a>
  </article>;
  const failedInput = item.kind === "message" && item.role === "input" && ["failed", "unknown", "interrupted", "declined"].includes(item.state);
  const stateTag = item.kind === "message" && item.role === "input" && ["pending", "running", "failed", "unknown", "interrupted", "declined"].includes(item.state)
    ? <span className={cn("workspace-input-state rounded-full px-2 py-px text-caption", failedInput ? "bg-danger-soft text-destructive" : "bg-field text-text-secondary")}>{item.state === "pending" ? "排队中" : entryStateLabel[item.state]}</span> : null;
  const actions = <>
    {(expandedBody?.truncated ?? item.truncated) && <Button variant="link" className={linkButton} disabled={bodyBusy} onClick={() => void expandBody()}>{bodyBusy ? "读取完整内容中…" : `读取完整${assistant ? "回复" : "内容"}`}</Button>}
    {messageId && <Button variant="link" className={linkButton} onClick={() => onMessage(messageId)}>消息详情</Button>}
    {runHref && <a className="text-caption text-primary hover:underline" href={runHref}>查看来源任务</a>}
    {!messageId && item.nativeItemId && !mine && <Button variant="link" className={linkButton} onClick={() => onDetail(item)}>查看来源</Button>}
  </>;
  const time = item.occurredAt ? <time dateTime={item.occurredAt}>{date(item.occurredAt)}</time> : null;
  // A plan the native source wrote as numbered steps folds into one line; the running turn's plan is also pinned above the composer.
  const steps = item.kind === "plan" ? planSteps(item.body) : null;
  if (item.kind === "plan" && steps) {
    const done = steps.filter(step => step.status === "done").length;
    const explanation = planExplanation(item.body);
    return <article aria-label="执行计划" className="min-w-0 pl-[38px]" data-workspace-entry={item.id} data-turn-id={item.turnId ?? undefined}>
      <CollapsibleRow summary={<span>执行计划 · 已完成 {done} / {steps.length} 步{item.freshness === "stale" ? " · 上次观察" : ""}</span>}>
        <div className="flex flex-col gap-2">{explanation && <p className="text-small text-text-secondary">{explanation}</p>}<TodoList items={steps} /></div>
      </CollapsibleRow>
    </article>;
  }
  const stale = item.freshness === "stale" && <span className="workspace-stale">上次观察</span>;
  if (mine) return <article aria-label="我发出的消息" className="flex flex-col items-end gap-1 self-end" data-workspace-entry={item.id} data-turn-id={item.turnId ?? undefined}>
    <MessageBubble footer={<span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">{stateTag}{time}{stale}{actions}</span>}>{body || "（没有可公开的正文）"}</MessageBubble>
    {bodyError && <p role="alert" className="text-caption text-destructive">{bodyError}</p>}
  </article>;
  return <article aria-label={label} className={cn("flex min-w-0 gap-3", item.kind !== "message" && "text-small")} data-workspace-entry={item.id} data-turn-id={item.turnId ?? undefined}>
    {assistant ? <AgentAvatar seed={sessionKey} roleSeed={title} size={26} className="mt-0.5" />
      : <span className="mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">{item.author.kind === "actor" ? <Users size={14} /> : <Info size={14} />}</span>}
    <div className="min-w-0 flex-1">
      <header className="mb-1 flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground">{provenSession && <SessionIdentityMark target={target} identity={identity} name={title} size="small" />}<strong className="font-medium text-text-secondary">{label}</strong>{time}{stale}{stateTag}</header>
      {heading && <h3 className="mb-1 text-label font-medium text-text-secondary">{heading}</h3>}
      {body ? <AgentMessage className={cn(replyProse, item.kind !== "message" && "text-small text-text-secondary")}><MarkdownBody source={body} identity={`workspace-${item.id}`} projectId={context.projectId} topHeading={3} /></AgentMessage>
        : <p className="text-small text-muted-foreground">{assistant && item.state === "running" ? "正在回复…" : "来源没有提供可公开的正文。"}</p>}
      {bodyError && <p role="alert" className="mt-1 text-caption text-destructive">{bodyError}</p>}
      <footer className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-caption">{actions}</footer>
    </div>
  </article>;
}

/** A tool's or message's source: what the summary shows, the original input and output where the reader may see them. */
function EntryInspector({ entry, context, sessionKey, mayReadOriginal }: { entry: WorkspaceEntry; context: MutationContext; sessionKey: string; mayReadOriginal: boolean }) {
  const [value, setValue] = useState(entry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scope = `${context.projectId}\0${sessionKey}\0${entry.id}`;
  const current = useRef(scope); current.current = scope;
  const read = async () => {
    if (!entry.turnId || !entry.nativeItemId) return;
    setBusy(true); setError("");
    try {
      const result = await sessionClient("", context.projectId).timelineItem(sessionKey, entry.turnId, entry.nativeItemId);
      if (current.current !== scope) return;
      if (result.turnId !== entry.turnId || result.nativeItemId !== entry.nativeItemId) throw new Error("详情与所选活动不符");
      setValue(result);
    } catch (cause) { if (current.current === scope) setError(errorText(cause)); }
    finally { if (current.current === scope) setBusy(false); }
  };
  useEffect(() => { if (entry.kind === "message" && entry.truncated) void read(); return () => { current.current = ""; }; }, [scope]);
  const block = "max-h-[42vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-caption [overflow-wrap:anywhere]";
  return <>
    <p className="text-caption text-muted-foreground">{value.author.label}{value.occurredAt ? ` · ${date(value.occurredAt)}` : " · 来源未提供时间"}</p>
    {value.kind === "tool" ? <>
      <p className="font-medium">{toolLabel(value.name)}</p>
      <p className="text-text-secondary">{toolStepText(value)}</p>
      <p className="text-caption text-muted-foreground">{toolStepState(value)}{value.exitCode !== null ? ` · 退出码 ${value.exitCode}` : ""}</p>
      {value.detail && mayReadOriginal ? <>
        {value.detail.input !== null && <details open><summary className="cursor-pointer text-caption text-text-secondary">输入</summary><pre className={block}>{value.detail.input}</pre></details>}
        {value.detail.output !== null && <details open><summary className="cursor-pointer text-caption text-text-secondary">输出</summary><pre className={block}>{value.detail.output}</pre></details>}
        {value.detail.error && <Notice tone="error">{value.detail.error}</Notice>}
        {value.detail.resources.length > 0 && <ul className="flex flex-col gap-0.5 font-mono text-caption">{value.detail.resources.map(resource => <li key={resource}>{resource}</li>)}</ul>}
      </> : value.detailAvailable && mayReadOriginal ? <Button size="compact" className="self-start" disabled={busy} onClick={() => void read()}>{busy ? "读取中…" : "读取原始输入与输出"}</Button>
        : <p className="text-caption text-muted-foreground">{mayReadOriginal ? toolDetailReason(value.detailReason) : "当前身份可阅读活动摘要；原始输入与输出未获授权。"}</p>}
    </> : <div className={replyProse}><MarkdownBody source={value.body} identity={`workspace-detail-${value.id}`} projectId={context.projectId} topHeading={4} /></div>}
    {busy && <p role="status" className="text-caption text-muted-foreground">正在读取完整内容…</p>}
    {error && <Notice tone="error" action={<Button size="compact" disabled={busy} onClick={() => void read()}>重试详情</Button>}>{error}</Notice>}
    {value.truncated && !busy && <p className="text-caption text-muted-foreground">来源内容仍有截断，当前显示不能代表完整原件。</p>}
    <FullIdentifiers summary="来源标识与读取范围" rows={[
      { label: "轮次 ID", value: value.turnId || "未提供" }, { label: "条目 ID", value: value.nativeItemId || "未提供" },
      { label: "来源", value: value.origin ? originKinds[value.origin.kind] ?? "来源类型未识别" : "未关联业务来源", text: true },
      { label: "读取于", value: date(value.observedAt), text: true },
    ]} />
  </>;
}

/** One saved message: its state, the reply, and the read receipt or withdrawal the sender may record. */
function MessageInspector({ id, context, snapshot, onApplied }: { id: string; context: MutationContext; snapshot: SessionSnapshot; onApplied(): void }) {
  // Each opening reads the message again: an answer from an earlier opening never decides what may be recorded now.
  const [openedAt] = useState(() => Date.now());
  const read = useProjectQuery(context.projectId, ["session-messages", id, "detail", openedAt], async signal => {
    const result = await sessionClient("", context.projectId).message(id, signal);
    const target = result.message.target;
    if (result.message.id !== id || result.message.projectId !== context.projectId || `${target.kind}:${target.kind === "owned" ? target.sessionId : target.linkId}` !== snapshot.session.key)
      throw new Error("消息详情与所选智能体不符");
    return result;
  }, { refetchInterval: 5000 });
  const value = read.data;
  if (!value) return read.isError ? <Notice tone="error" action={<Button size="compact" onClick={() => void read.refetch()}>重试</Button>}>{errorText(read.error)}</Notice>
    : <p role="status" className="text-small text-muted-foreground">正在读取消息…</p>;
  const { message, processing } = value as { message: SessionMessageRecord; processing: SessionMessageProcessing | null };
  const canRead = message.target.kind === "owned" && !message.readReceipt && processing?.receiverActorId === context.principal.actorId
    && processing.projectId === context.projectId && processing.messageId === message.id && processing.sessionId === message.target.sessionId && !!processing.nativeTurnId?.trim()
    && (processing.state === "running" && message.state === "processing" || ["completed", "failed"].includes(processing.state) && ["replied", "completed_without_reply", "failed"].includes(message.state));
  const applied = () => { void read.refetch(); onApplied(); };
  return <div className="flex min-w-0 flex-col gap-3 text-small">
    {read.isError && <Notice tone="error">重新读取失败：{errorText(read.error)}；下面是上次读回，当前待核对。</Notice>}
    <h3 className="text-label font-semibold">消息详情 · {messageStates[message.state]}</h3>
    <p className="text-caption text-muted-foreground">发送于 {date(message.createdAt)}{message.senderActorId === context.principal.actorId ? " · 由我发送" : ""}</p>
    <div className={replyProse}><MarkdownBody source={message.content} identity={`message-detail-${message.id}`} projectId={context.projectId} topHeading={4} /></div>
    {processing?.response && <><h3 className="text-label font-semibold">回复</h3><div className={replyProse}><MarkdownBody source={processing.response} identity={`message-response-${processing.id}`} projectId={context.projectId} topHeading={4} /></div></>}
    {processing?.failure && <Notice tone="error">处理失败：{processing.failure}</Notice>}
    {message.blockedReason && <p className="text-text-secondary">等待原因：{message.blockedReason}</p>}
    {message.readReceipt && <p className="text-text-secondary">已读回执：{message.readReceipt.evidence} · {date(message.readReceipt.at)}</p>}
    {canRead && <ActionForm context={{ ...context, draftScope: `message-read:${message.id}` }} title="记录本人已读原消息" fields={[{ name: "evidence", label: "阅读证据", kind: "textarea" }]} build={v => ({ type: "session.message.receipt", messageId: message.id, stage: "read", evidence: v.evidence })} onApplied={applied} />}
    {(["queued", "manual_pending"].includes(message.state)) && message.senderActorId === context.principal.actorId && <ActionForm context={{ ...context, draftScope: `message-cancel:${message.id}`, draftBaseline: String(message.version) }} title="取消待处理消息" fields={[{ name: "reason", label: "取消原因", kind: "textarea" }]} build={v => ({ type: "session.message.cancel", messageId: message.id, expectedVersion: message.version, reason: v.reason })} onApplied={applied} />}
    {message.state === "manual_pending" && <p className="text-caption text-muted-foreground">外部消息仍待人工转交；保存不代表已送达或已读。</p>}
    <FullIdentifiers rows={[{ label: "消息 ID", value: message.id }, { label: "发送者", value: message.senderActorId }, { label: "处理记录 ID", value: processing?.id }, { label: "原轮次 ID", value: processing?.nativeTurnId }]} />
  </div>;
}

export function SessionTimeline({ context, snapshot, onApplied, taskHref, refresh = 0, reauthorizeVersion = 0, progress = null, waitingTurnIds, composerFacts = [], children }: {
  context: MutationContext; snapshot: SessionSnapshot; onApplied(): void; taskHref(taskId: string): string; refresh?: number; reauthorizeVersion?: number;
  progress?: NativeProgressView | null; waitingTurnIds?: ReadonlySet<string>; composerFacts?: string[]; children?: ReactNode;
}) {
  const timeline = useSessionTimeline(context.token, context.projectId, context.principal.actorId, snapshot.session.key, refresh, reauthorizeVersion);
  const capability = sessionMessageEntry(snapshot.session.kind, snapshot.session.capabilities);
  const items = useMemo(() => workspaceReadingOrder(timeline.entries, timeline.pending), [timeline.entries, timeline.pending]);
  const groups = useMemo(() => workspaceReadingGroups(items), [items]);
  const summaries = useMemo(() => turnSummaries(items, timeline.turns, snapshot.results, waitingTurnIds), [items, timeline.turns, snapshot.results, waitingTurnIds]);
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
    let previousWidth = node.clientWidth, previousHeight = node.clientHeight;
    let hidden = node.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      if (node.clientHeight === 0) { hidden = true; return; }
      const position = readingPositions.get(scope);
      if ((hidden || (previousWidth !== node.clientWidth || previousHeight !== node.clientHeight) && !follow.current) && position) restorePosition(node, position);
      previousWidth = node.clientWidth; previousHeight = node.clientHeight; hidden = false;
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
  const currentTool = live && activeTurn ? [...items].reverse().find((entry): entry is WorkspaceTool => entry.kind === "tool" && entry.turnId === activeTurn.id && entry.state === "running") ?? null : null;
  const replying = live && !!activeTurn && items.some(entry => entry.turnId === activeTurn.id && entry.kind === "message" && entry.role === "assistant" && entry.state === "running");
  const now = useNow(live && !!activeTurn);
  const source = activeTurn?.origin;
  const limitations = [...new Set([...(timeline.page?.limitations ?? []), ...(timeline.live?.limitations ?? [])])];
  const mayReadOriginal = timeline.page?.capabilities.originalToolDetail ?? false;
  const summaryFor = (id: string) => {
    const line = summaries.get(id);
    return line ? <TurnSummary key={`summary:${id}`} produced={line.produced} delivered={line.delivered} next={line.next} /> : null;
  };
  const readingScope = <details className="workspace-reading-scope text-caption text-muted-foreground">
    <summary className="w-fit cursor-pointer hover:text-foreground">消息怎样处理与读取范围</summary>
    <div className="mt-1.5 flex flex-col gap-1">
      <p>{capability.introduction}</p>
      <p>自动处理：{capability.executionLabel}。{capability.executionReason}</p>
      {capability.budgetLabel && <p>{capability.budgetLabel}。账户额度与此累计次数分开。</p>}
      {capability.executionObservedAt && <p>执行状态读于 {date(capability.executionObservedAt)}；配置变化后请点上方“重新读取”。</p>}
      <p>{timeline.page?.capabilities.history ? "历史按来源分页读取。" : "这个智能体的原有历史暂不可读取。"}{live ? "实时活动来自现有连接。" : "当前没有可确认的实时连接。"}</p>
      {timeline.page && <p>读取于 {date(timeline.page.observedAt)}{timeline.page.partial && " · 来源仅展示已读范围"}</p>}
      <SourceLimitations items={limitations} />
    </div>
  </details>;
  return <section className="session-conversation unified-session-timeline flex min-h-0 flex-1 flex-col gap-2 overflow-hidden" aria-label="活动与对话">
    {snapshot.session.kind === "external" && <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><Info size={13} aria-hidden="true" />外部智能体 · 这里只显示已同步的内容，消息保存后需人工转交。</p>}
    {timeline.error && <Notice tone="error" action={<Button size="compact" onClick={timeline.reread}>重新读取活动</Button>}>活动暂不可读取：{timeline.error}
      {timeline.errorOriginal && <details className="mt-1 text-caption text-muted-foreground"><summary className="w-fit cursor-pointer">原文</summary><p lang="en" className="mt-1 font-mono [overflow-wrap:anywhere]">{timeline.errorOriginal}</p></details>}</Notice>}
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scroll} className="session-conversation-scroll workspace-timeline-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1 py-3 outline-none [&>:first-child]:mt-auto" role="log" tabIndex={0} aria-label="消息与工具时间线" aria-live="off" aria-busy={!timeline.loaded} onScroll={event => {
      const node = event.currentTarget;
      if (!node.clientHeight || timeline.denied || cacheGeneration.current !== viewCacheGeneration) return;
      const near = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
      follow.current = near; setNearBottom(near);
      readingPositions.delete(scope); readingPositions.set(scope, readingPosition(node, near));
      while (readingPositions.size > 2) readingPositions.delete(readingPositions.keys().next().value!);
    }}>
      {(timeline.nextCursor || timeline.messagesCursor) && <Button variant="ghost" size="compact" className="h-auto self-center px-3 py-1 text-caption font-normal text-primary hover:bg-accent hover:text-primary disabled:text-muted-foreground disabled:opacity-100" disabled={timeline.moreBusy || timeline.reconciling} onClick={() => void more()}>{timeline.reconciling ? "正在校准历史…" : timeline.moreBusy ? "正在读取更早内容…" : "加载更早的消息与活动"}</Button>}
      {!timeline.loaded && <p className="flex items-center gap-2 text-small text-muted-foreground" role="status"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />正在读取对话…</p>}
      {timeline.loaded && !timeline.error && !groups.length && !children && !activeTurn && <div className="session-conversation-empty flex flex-col items-center gap-1.5 py-10 text-center text-small text-muted-foreground"><MessageCircle size={25} aria-hidden="true" /><strong className="text-body font-medium text-foreground">{timeline.page?.partial ? "当前来源尚未提供可读的活动" : "从这里开始沟通"}</strong><span>{timeline.page?.partial ? "这不代表原来没有历史记录，可在读取范围中查看原因。" : "发送消息后，这个智能体的回复与工具活动会连续显示在这里。"}</span></div>}
      {groups.map(group => group.kind === "tools"
        ? [<ToolGroup key={`tools:${group.id}`} entries={group.entries} scope={scope} context={context} sessionKey={snapshot.session.key} mayReadOriginal={mayReadOriginal} />, summaryFor(group.entries.at(-1)!.id)]
        : [<TimelineEntry key={group.entry.id} item={group.entry} context={context} title={agentDisplayName(snapshot.session)} taskTitle={snapshot.currentWork && group.entry.origin?.taskId === snapshot.currentWork.id ? snapshot.currentWork.title : null} sessionKey={snapshot.session.key} target={snapshot.session.target} identity={snapshot.session.identity} taskHref={taskHref} onExpanded={timeline.replaceEntry} onDetail={entry => inspect({ entry })} onMessage={messageId => inspect({ messageId })} />, summaryFor(group.entry.id)])}
      {activeTurn && (live
        ? <LiveStatusLine className="workspace-turn-state" avatar={<AgentAvatar seed={snapshot.session.key} roleSeed={snapshot.session.title} size={20} />}
          text={liveStatusText(currentTool, replying)} elapsed={elapsedText(activeTurn.startedAt, now) ?? undefined}>
          {source?.taskId && <a className="text-primary hover:underline" href={taskHref(source.taskId)}>{snapshot.currentWork?.id === source.taskId ? `任务「${snapshot.currentWork.title}」` : "查看关联任务"}</a>}
        </LiveStatusLine>
        : <p className="workspace-turn-state stale text-label text-muted-foreground" role="status">上次读回时这一轮在进行，当前连接状态待核对。</p>)}
      {!timeline.denied && children}
    </div>
    {!nearBottom && items.length > 0 && <Button size="compact" className="absolute bottom-3 left-1/2 z-10 h-auto -translate-x-1/2 gap-1.5 bg-raised px-3 py-1.5 text-caption font-normal shadow-md hover:bg-selected" onClick={() => { if (scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); follow.current = true; setNearBottom(true); }}><ArrowDown size={15} aria-hidden="true" />回到最新内容</Button>}
    </div>
    <SessionComposer context={context} snapshot={snapshot} entries={items} activeTurn={activeTurn} live={live} progress={progress} facts={composerFacts} readingScope={readingScope} onApplied={applied} />
    <Dialog open={inspector !== null && !timeline.denied} onOpenChange={open => { if (!open) setInspector(null); }}>
      <DialogContent className="workspace-inspector max-h-[85dvh] w-[min(640px,calc(100vw-32px))] overflow-y-auto" aria-describedby="workspace-inspector-description" onCloseAutoFocus={event => { const trigger = inspectorTrigger.current; if (trigger?.isConnected && trigger.getClientRects().length) { event.preventDefault(); trigger.focus({ preventScroll: true }); } inspectorTrigger.current = null; }}>
        <DialogTitle>活动详情</DialogTitle>
        <DialogDescription id="workspace-inspector-description">核对所选内容、消息状态与来源。</DialogDescription>
        {inspector && !timeline.denied && ("entry" in inspector ? <EntryInspector key={inspector.entry.id} entry={inspector.entry} context={context} sessionKey={snapshot.session.key} mayReadOriginal={mayReadOriginal} /> : <MessageInspector key={inspector.messageId} id={inspector.messageId} context={context} snapshot={snapshot} onApplied={applied} />)}
      </DialogContent>
    </Dialog>
  </section>;
}
