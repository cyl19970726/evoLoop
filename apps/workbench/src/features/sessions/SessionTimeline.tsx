// The center of the agent page: one continuous flow of what was said and done, in the order the records give.
// A person's message is a bubble on the right, the agent's reply is plain prose, tool calls fold into one muted line
// (failures and the running step stay in sight), a finished turn closes with one line of what it produced, and a live
// status line ends the flow while a turn runs. The composer stays at the bottom. Reading position, history paging
// and the long poll come from useSessionTimeline and are kept as they were.
import { senderClassLabel } from "./senderClassPresentation";
import { nativeFailureLine } from "./nativeFailurePresentation";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, FileText, Info, LoaderCircle, MessageCircle, Users } from "lucide-react";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import type { WorkspaceEntry, WorkspaceReasoning, WorkspaceTool, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
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
import { useSessionTimeline } from "./useSessionTimeline";
import { ActorIdentifiers } from "../../shared/ui/ActorIdentifiers";
import { settleEndedTools, workspaceReadingGroups } from "./workspaceTimelineModel";
import { buildRounds, lastReplyId, roundEntries, timelineRows, type Round } from "./timelineRounds";
import { useMessageFacts } from "./useMessageFacts";
import { CoordinationGroup, CoordinationLine } from "./CoordinationLine";
import { RoundTimes } from "./RoundTimes";
import { reworkHref, runSourceLabel, sentAndStarted, type SentStarted } from "./roundPresentation";
import { replyingPhrase } from "./sessionStatusPresentation";
import { api } from "../../shared/api";
import {
  elapsedText, entryStateLabel, isFailedEntry, toolStepKind, liveStatusText, pinnedToolIds, planExplanation, planSteps, recordLabel, toolDetailReason, toolGroupStatus, toolGroupSummary,
  entryAuthorText, reasoningSourceLabel, toolLabel, toolStepState, toolStepText, turnLabel, turnReasoningTokensText, turnSummaries,
} from "./conversationPresentation";
import { SessionIdentityMark } from "./SessionIdentityMark";
import { SessionComposer } from "./SessionComposer";
import { grantBlockText, grantBlockedNotice } from "./queuedMessagePresentation";
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
/**
 * Opening an agent shows its last reply from its beginning, with the line that says where the round came from just above it
 * (the round's source when that is near, else a little context). Without any reply the view stays at the end, as before.
 */
function landOnLastReply(node: HTMLElement) {
  const reply = node.querySelector<HTMLElement>("[data-last-reply]");
  if (!reply) { node.scrollTop = node.scrollHeight; return; }
  const box = node.getBoundingClientRect();
  let source: Element | null = reply.previousElementSibling;
  while (source && !source.hasAttribute("data-round-source")) source = source.previousElementSibling;
  const replyTop = reply.getBoundingClientRect().top - box.top;
  const sourceTop = source ? source.getBoundingClientRect().top - box.top : null;
  const wanted = sourceTop !== null && replyTop - sourceTop < node.clientHeight * .6 ? sourceTop - 12 : replyTop - 48;
  node.scrollTop += wanted;
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

/**
 * One Turn's reasoning, folded by default. Entries keep native order and are numbered within the Turn. Unreadable
 * reasoning says so with its reason; nothing is filled in from the answer.
 */
function ReasoningGroup({ entries, turn, context }: { entries: WorkspaceReasoning[]; turn: WorkspaceTurn | undefined; context: MutationContext }) {
  const readable = entries.filter(entry => entry.readable).length;
  const running = entries.some(entry => entry.state === "running" && entry.freshness === "live");
  return <article aria-label="思考过程" className="workspace-reasoning min-w-0 pl-[38px] text-small" data-workspace-entry={entries[0]!.id} data-turn-id={entries[0]!.turnId ?? undefined}>
    <CollapsibleRow summary={<span>思考过程 · {turnLabel(entries[0]!.turnId, turn?.startedAt)} · {entries.length} 条{readable < entries.length ? `（${entries.length - readable} 条不可显示）` : ""} · {turnReasoningTokensText(turn?.usage)}{running ? " · 进行中" : ""}</span>}>
      <ol className="flex flex-col gap-3">
        {entries.map((entry, index) => <li key={entry.id} className="flex flex-col gap-1" data-workspace-entry={entry.id} data-reasoning-item={entry.nativeItemId ?? undefined}>
          <p className="text-caption text-muted-foreground">条目 {index + 1} / {entries.length} · {entry.readable ? reasoningSourceLabel[entry.source] : entry.state === "running" ? "进行中" : "不可显示"}{entry.truncated ? " · 已截断" : ""}</p>
          {entry.readable
            ? <div className={cn(replyProse, "text-small text-text-secondary")}><MarkdownBody source={entry.body} identity={`workspace-reasoning-${entry.id}`} projectId={context.projectId} topHeading={4} /></div>
            : entry.state === "running" ? <p className="text-caption text-muted-foreground">思考尚未结束。</p>
              : <p className="text-caption text-muted-foreground">不可显示：{entry.unavailableReason ?? "原生记录没有可读的推理内容。"}</p>}
        </li>)}
      </ol>
    </CollapsibleRow>
  </article>;
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
        id: entry.id, text: toolStepText(entry), meta: toolStepState(entry), failed: isFailedEntry(entry), state: toolStepKind(entry),
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

/** The agent's answer to a saved message, from the message list, for a round whose Turn the timeline has not shown. */
function ReplyRecord({ id, reply, title, sessionKey, roleSeed, lastReply, projectId, onFull }: { id: string; reply: { body: string; truncated: boolean; at: string | null }; title: string; sessionKey: string; roleSeed: string; lastReply: boolean; projectId: string; onFull(): void }) {
  return <article aria-label={title} className="flex min-w-0 gap-3" data-workspace-entry={id} data-reply-record="" {...(lastReply ? { "data-last-reply": "" } : {})}>
    <AgentAvatar seed={sessionKey} roleSeed={roleSeed} size={26} className="mt-0.5" />
    <div className="min-w-0 flex-1">
      <header className="mb-1 flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground"><strong className="font-medium text-text-secondary">{title}</strong>{reply.at && <time dateTime={reply.at}>{date(reply.at)}</time>}</header>
      <AgentMessage className={replyProse}><MarkdownBody source={reply.body} identity={`workspace-${id}`} projectId={projectId} topHeading={3} /></AgentMessage>
      {reply.truncated && <footer className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-caption"><Button variant="link" className={linkButton} onClick={onFull}>读取完整回复</Button></footer>}
    </div>
  </article>;
}

function RunStrip({ id, turnId, label, at, href, reworkHref = null }: { id: string; turnId: string | null; label: string; at: string | null; href: string | null; reworkHref?: string | null }) {
  return <article className="workspace-system-strip flex flex-wrap items-center gap-x-2 gap-y-1 self-center rounded-md bg-muted px-3 py-1.5 text-caption text-text-secondary" data-workspace-entry={id} data-round-source="" data-turn-id={turnId ?? undefined}>
    <FileText size={14} aria-hidden="true" /><strong className="font-medium text-foreground">{label}</strong>
    {at && <time dateTime={at}>{date(at)}</time>}
    {href && <a className="text-primary hover:underline" href={href}>查看任务与指令</a>}
    {reworkHref && <a className="text-primary hover:underline" href={reworkHref} data-rework-link="">查看退回意见</a>}
  </article>;
}

function TimelineEntry({ item, context, title, sessionKey, target, identity, taskHref, times, replyAt, lastReply, onDetail, onMessage, onExpanded }: {
  item: WorkspaceEntry; context: MutationContext; title: string; sessionKey: string; target: SessionTarget; identity: SessionIdentity | null;
  /** An input's send time and processing start; a reply's time is `replyAt`. */
  times: SentStarted | null; replyAt: { at: string; fromTurnStart: boolean } | null; lastReply: boolean;
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
  const label = mine ? "我" : assistant ? title : entryAuthorText(item.author, title, context.principal.actorId);
  const messageId = item.origin?.kind === "message" ? item.origin.id : null;
  const heading = item.kind === "message" ? null : item.kind === "tool" ? toolLabel(item.name) : item.kind === "reasoning" ? "思考过程" : recordLabel(item.label);
  const expandedBody = item.kind === "message" && fullText && item.state !== "running" && fullText.body.startsWith(item.body) ? fullText : null;
  const uncheckedInput = item.kind === "notice" && item.nativeKind === "userMessage" && item.label === "未核对的原生输入";
  const body = expandedBody?.body ?? (uncheckedInput ? "这条输入的来源还在核对，展开可核对；这不表示来源不明。" : item.kind === "tool" ? toolStepText(item) : item.body);
  const runHref = item.origin?.kind === "run" && item.origin.taskId ? `${taskHref(item.origin.taskId)}${taskHref(item.origin.taskId).includes("?") ? "&" : "?"}run=${encodeURIComponent(item.origin.id)}` : null;
  const failedInput = item.kind === "message" && item.role === "input" && ["failed", "unknown", "interrupted"].includes(item.state);
  const stateTag = item.kind === "message" && item.role === "input" && ["pending", "running", "failed", "unknown", "interrupted", "declined"].includes(item.state)
    ? <span className={cn("workspace-input-state text-caption", failedInput ? "font-medium text-destructive" : "text-text-secondary")}>{item.state === "pending" ? (item.kind === "message" && grantBlockText(item.blockedReason) !== null ? "受阻：缺少消息授权" : "排队中") : item.state === "running" && mine ? replyingPhrase("me") : item.state === "declined" ? "已撤回" : entryStateLabel[item.state]}</span> : null;
  const actions = <>
    {(expandedBody?.truncated ?? item.truncated) && <Button variant="link" className={linkButton} disabled={bodyBusy} onClick={() => void expandBody()}>{bodyBusy ? "读取完整内容中…" : `读取完整${assistant ? "回复" : "内容"}`}</Button>}
    {messageId && <Button variant="link" className={linkButton} onClick={() => onMessage(messageId)}>消息详情</Button>}
    {runHref && <a className="text-caption text-primary hover:underline" href={runHref}>查看来源任务</a>}
    {!messageId && item.nativeItemId && !mine && <Button variant="link" className={linkButton} onClick={() => onDetail(item)}>查看来源</Button>}
  </>;
  const input = item.kind === "message" && item.role === "input";
  const time = input ? (times ? <RoundTimes times={times} /> : item.occurredAt ? <time dateTime={item.occurredAt}>{date(item.occurredAt)}</time> : null)
    : replyAt ? <time dateTime={replyAt.at}>{replyAt.fromTurnStart ? "本轮开始 " : ""}{date(replyAt.at)}</time>
      : item.occurredAt ? <time dateTime={item.occurredAt}>{date(item.occurredAt)}</time> : null;
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
  if (mine) return <article aria-label="我发出的消息" className="flex flex-col items-end gap-1 self-end" data-workspace-entry={item.id} data-round-source="" data-turn-id={item.turnId ?? undefined}>
    <MessageBubble footer={<span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1"><span>你的消息</span>{stateTag}{time}{stale}{actions}</span>}>{body || "（没有可公开的正文）"}</MessageBubble>
    {bodyError && <p role="alert" className="text-caption text-destructive">{bodyError}</p>}
  </article>;
  return <article aria-label={label} className={cn("flex min-w-0 gap-3", item.kind !== "message" && "text-small")} data-workspace-entry={item.id} data-turn-id={item.turnId ?? undefined} {...(input ? { "data-round-source": "" } : {})} {...(lastReply ? { "data-last-reply": "" } : {})}>
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
function EntryInspector({ entry, context, sessionKey, mayReadOriginal, agentName = "这个智能体" }: { entry: WorkspaceEntry; context: MutationContext; sessionKey: string; mayReadOriginal: boolean; agentName?: string }) {
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
  // A "not checked" input: opening its source asks the service to check this one Item with its own budget; what comes back replaces the notice.
  const unchecked = entry.kind === "notice" && entry.nativeKind === "userMessage" && entry.label === "未核对的原生输入";
  useEffect(() => { if (entry.kind === "message" && entry.truncated || unchecked) void read(); return () => { current.current = ""; }; }, [scope]);
  const block = "max-h-[42vh] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-caption [overflow-wrap:anywhere]";
  return <>
    <p className="text-caption text-muted-foreground">{entryAuthorText(value.author, agentName, context.principal.actorId)}{value.occurredAt ? ` · ${date(value.occurredAt)}` : " · 来源未提供时间"}</p>
    <ActorIdentifiers actors={[["发送者", value.author.kind === "actor" ? value.author.id ?? value.author.label : null]]} />
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
    <p className="text-caption text-muted-foreground">发送于 {date(message.createdAt)}{message.senderActorId === context.principal.actorId ? " · 由我发送" : ""}{senderClassLabel(message.senderClass) ? ` · 发送者：${senderClassLabel(message.senderClass)}` : ""}</p>
    <div className={replyProse}><MarkdownBody source={message.content} identity={`message-detail-${message.id}`} projectId={context.projectId} topHeading={4} /></div>
    {processing?.response && <><h3 className="text-label font-semibold">回复</h3><div className={replyProse}><MarkdownBody source={processing.response} identity={`message-response-${processing.id}`} projectId={context.projectId} topHeading={4} /></div></>}
    {processing?.failure && <Notice tone="error">{nativeFailureLine(processing.failureCategory)}处理失败：{processing.failure}</Notice>}
    {message.blockedReason && <p className="text-text-secondary">等待原因：{grantBlockText(message.blockedReason) ?? message.blockedReason}</p>}
    {message.readReceipt && <p className="text-text-secondary">已读回执：{message.readReceipt.evidence} · {date(message.readReceipt.at)}</p>}
    {canRead && <ActionForm context={{ ...context, draftScope: `message-read:${message.id}` }} requiredPermissions={["session"]} title="记录本人已读原消息" fields={[{ name: "evidence", label: "阅读证据", kind: "textarea" }]} build={v => ({ type: "session.message.receipt", messageId: message.id, stage: "read", evidence: v.evidence })} onApplied={applied} />}
    {(["queued", "manual_pending"].includes(message.state)) && message.senderActorId === context.principal.actorId && <ActionForm context={{ ...context, draftScope: `message-cancel:${message.id}`, draftBaseline: String(message.version) }} requiredPermissions={["session"]} title="取消待处理消息" fields={[{ name: "reason", label: "取消原因", kind: "textarea" }]} build={v => ({ type: "session.message.cancel", messageId: message.id, expectedVersion: message.version, reason: v.reason })} onApplied={applied} />}
    {message.state === "manual_pending" && <p className="text-caption text-muted-foreground">外部消息仍待人工转交；保存不代表已送达或已读。</p>}
    <FullIdentifiers rows={[{ label: "消息 ID", value: message.id }, { label: "发送者", value: message.senderActorId }, { label: "发送者类别", value: senderClassLabel(message.senderClass) ?? undefined }, { label: "处理记录 ID", value: processing?.id }, { label: "原轮次 ID", value: processing?.nativeTurnId }]} />
  </div>;
}

export function SessionTimeline({ context, snapshot, onApplied, taskHref, titleOf: knownTitleOf, refresh = 0, reauthorizeVersion = 0, progress = null, waitingTurnIds, composerFacts = [], holdReason = null, children }: {
  context: MutationContext; snapshot: SessionSnapshot; onApplied(): void; taskHref(taskId: string): string; titleOf?(taskId: string): string | null; refresh?: number; reauthorizeVersion?: number;
  progress?: NativeProgressView | null; waitingTurnIds?: ReadonlySet<string>; composerFacts?: string[]; holdReason?: string | null; children?: ReactNode;
}) {
  const timeline = useSessionTimeline(context.token, context.projectId, context.principal.actorId, snapshot.session.key, refresh, reauthorizeVersion);
  const settledEntries = useMemo(() => settleEndedTools(timeline.entries, timeline.turns), [timeline.entries, timeline.turns]);
  // Message ids the page shows, so the message list is read far enough to tell who sent each and what was answered.
  const wantedMessages = useMemo(() => [...new Set([...settledEntries, ...timeline.pending].flatMap(entry => entry.origin?.kind === "message" ? [entry.origin.id] : []))], [settledEntries, timeline.pending]);
  const activeId = timeline.live?.activeTurnId ?? "";
  // The reply reached the timeline on the 1.5 s update channel; the receipt and the header read the snapshot. Read it now instead of at its next tick, so the three settle together.
  const seenActive = useRef(activeId);
  const settleRead = useRef(onApplied); settleRead.current = onApplied;
  useEffect(() => {
    const was = seenActive.current; seenActive.current = activeId;
    if (was && !activeId) settleRead.current?.();
  }, [activeId]);
  const facts = useMessageFacts(context.projectId, snapshot.session.key, wantedMessages, timeline.loaded && !timeline.denied, `${settledEntries.length}:${timeline.pending.length}:${timeline.turns.length}:${activeId}`);
  const rounds = useMemo(() => buildRounds(settledEntries, timeline.pending, timeline.turns, { messages: facts.messages, me: context.principal.actorId }),
    [settledEntries, timeline.pending, timeline.turns, facts.messages, context.principal.actorId]);
  const items = useMemo(() => roundEntries(rounds), [rounds]);
  const rows = useMemo(() => timelineRows(rounds), [rounds]);
  const lastReply = useMemo(() => lastReplyId(rounds), [rounds]);
  // Titles of the Tasks the rounds are for: what the page already knows, then one read for the rest (the newest few).
  const unknownTasks = useMemo(() => [...new Set(rounds.flatMap(round => round.taskId && !knownTitleOf?.(round.taskId) && round.taskId !== snapshot.currentWork?.id ? [round.taskId] : []))].slice(-12).sort(), [rounds, knownTitleOf, snapshot.currentWork?.id]);
  const taskFacts = useProjectQuery(context.projectId, ["round-task-titles", ...unknownTasks], async () => {
    const settled = await Promise.allSettled(unknownTasks.map(id => api().leaderTask(context.projectId, id)));
    const titles: Record<string, string> = {};
    settled.forEach((result, index) => { if (result.status === "fulfilled" && result.value.taskId === unknownTasks[index]) titles[unknownTasks[index]!] = result.value.title; });
    return titles;
  }, { enabled: unknownTasks.length > 0 && !timeline.denied, retry: false, keepPrevious: true });
  const titleOf = (taskId: string): string | null => snapshot.currentWork?.id === taskId ? snapshot.currentWork.title : knownTitleOf?.(taskId) ?? taskFacts.data?.[taskId] ?? null;
  const taskLink = (taskId: string, runId: string) => `${taskHref(taskId)}${taskHref(taskId).includes("?") ? "&" : "?"}run=${encodeURIComponent(runId)}`;
  const grantNotice = useMemo(() => grantBlockedNotice(items), [items]);
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
  /** Opening an agent lands on its last reply once; a saved reading position (coming back from a Task) wins. */
  const landing = useRef(false);
  useLayoutEffect(() => {
    historyFill.current = { scope, count: 0, busy: false };
    cacheGeneration.current = viewCacheGeneration;
    const saved = readingPositions.get(scope) ?? null;
    landing.current = saved === null;
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
    } else if (landing.current && timeline.loaded && facts.settled && !timeline.moreBusy) {
      // Wait for the message list too: it adds the replies and folds the Leader's lines, which moves everything.
      if (timeline.error || timeline.denied) landing.current = false;
      else if (items.length) {
        landing.current = false; anchor.current = null;
        landOnLastReply(node);
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 90; setNearBottom(follow.current);
        if (!follow.current) readingPositions.set(scope, readingPosition(node, false));
      }
    } else if (anchor.current && !timeline.moreBusy) {
      restorePosition(node, anchor.current);
      anchor.current = null;
    } else if (!anchor.current && follow.current) node.scrollTop = node.scrollHeight;
  }, [items, timeline.moreBusy, timeline.turns, timeline.loaded, facts.settled]);
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
  // Waiting: a message of mine that is saved but not yet being answered, with how long it has waited (the live turn has its own line).
  const waitingSince = !activeTurn ? items.filter((entry): entry is Extract<WorkspaceEntry, { kind: "message" }> => entry.kind === "message" && entry.role === "input" && entry.state === "pending"
    && entry.author.kind === "actor" && entry.author.id === context.principal.actorId && !!entry.occurredAt).map(entry => entry.occurredAt!).sort()[0] ?? null : null;
  const now = useNow(live && !!activeTurn || !!waitingSince);
  const source = activeTurn?.origin;
  const limitations = [...new Set([...(timeline.page?.limitations ?? []), ...(timeline.live?.limitations ?? [])])];
  const mayReadOriginal = timeline.page?.capabilities.originalToolDetail ?? false;
  const summaryFor = (id: string) => {
    const line = summaries.get(id);
    return line ? <TurnSummary key={`summary:${id}`} produced={line.produced} delivered={line.delivered} next={line.next} /> : null;
  };
  const turnOf = (turnId: string | null) => turnId === null ? undefined : timeline.turns.find(turn => turn.id === turnId);
  /** A reply's time: when the source gave one, else when the Turn finished (its last reply) or began, said as such. */
  const replyTime = (round: Round, entry: WorkspaceEntry): { at: string; fromTurnStart: boolean } | null => {
    if (entry.occurredAt) return { at: entry.occurredAt, fromTurnStart: false };
    const turn = turnOf(round.turnId);
    const last = [...round.body].reverse().find(item => item.kind === "message" && item.role === "assistant");
    if (last?.id === entry.id && turn?.completedAt) return { at: turn.completedAt, fromTurnStart: false };
    return turn?.startedAt ? { at: turn.startedAt, fromTurnStart: true } : null;
  };
  const entryView = (round: Round, entry: WorkspaceEntry, key = entry.id) => {
    const input = entry.kind === "message" && entry.role === "input";
    return <TimelineEntry key={key} item={entry} context={context} title={agentDisplayName(snapshot.session)} sessionKey={snapshot.session.key} target={snapshot.session.target} identity={snapshot.session.identity}
      taskHref={taskHref} times={input ? sentAndStarted(round) : null} replyAt={input ? null : replyTime(round, entry)} lastReply={entry.id === lastReply}
      onExpanded={timeline.replaceEntry} onDetail={detail => inspect({ entry: detail })} onMessage={messageId => inspect({ messageId })} />;
  };
  const bodyViews = (round: Round) => workspaceReadingGroups(round.body).map(group => group.kind === "reasoning"
    ? [<ReasoningGroup key={`reasoning:${group.id}`} entries={group.entries} turn={timeline.turns.find(turn => turn.id === group.turnId)} context={context} />, summaryFor(group.entries.at(-1)!.id)]
    : group.kind === "tools"
      ? [<ToolGroup key={`tools:${group.id}`} entries={group.entries} scope={scope} context={context} sessionKey={snapshot.session.key} mayReadOriginal={mayReadOriginal} />, summaryFor(group.entries.at(-1)!.id)]
      : [entryView(round, group.entry), summaryFor(group.entry.id)]);
  const renderRound = (round: Round) => {
    const { source, input } = round;
    const head = source.kind === "run" && (input?.origin?.taskId ?? source.taskId) !== null
      ? <RunStrip key={`source:${round.key}`} id={input?.id ?? round.key} turnId={round.turnId} label={runSourceLabel(source.label, titleOf(source.taskId ?? input!.origin!.taskId!))}
        at={round.startedAt ?? round.at} href={taskLink(source.taskId ?? input!.origin!.taskId!, source.runId)}
        reworkHref={source.dispatch?.source === "rework" ? reworkHref(taskHref(source.taskId ?? input!.origin!.taskId!), source.dispatch) : null} />
      : source.kind === "message" && source.from === "leader" && input
        ? <CoordinationLine key={`source:${round.key}`} round={round} projectId={context.projectId} titleOf={titleOf} taskHref={taskHref} onMessage={messageId => inspect({ messageId })} />
        : input ? entryView(round, input, `source:${round.key}`) : null;
    const reply = round.replyRecord;
    return <Fragment key={round.key}>{head}{input && summaryFor(input.id)}{bodyViews(round)}
      {reply && <ReplyRecord key={`reply:${round.key}`} id={`reply:${round.key}`} reply={reply} title={agentDisplayName(snapshot.session)} sessionKey={snapshot.session.key}
        roleSeed={snapshot.session.title} lastReply={`reply:${round.key}` === lastReply} projectId={context.projectId} onFull={() => round.messageId && inspect({ messageId: round.messageId })} />}</Fragment>;
  };
  // The limits of this read are said where they matter: only when there is one. (The standing “消息怎样处理与读取范围” block is gone.)
  const readingLimits = limitations.length > 0 || timeline.page?.partial ? <details className="workspace-reading-limits text-caption text-muted-foreground">
    <summary className="w-fit cursor-pointer hover:text-foreground">这次读取有限制{timeline.page?.partial ? "，只显示了已读到的部分" : ""}</summary>
    <div className="mt-1.5 flex flex-col gap-1"><SourceLimitations items={limitations} /></div>
  </details> : null;
  const routing = { held: holdReason, replying: source?.kind === "message",
    taskTitle: source?.kind === "run" && source.taskId && snapshot.currentWork?.id === source.taskId ? snapshot.currentWork.title : null };
  return <section className="session-conversation unified-session-timeline flex min-h-0 flex-1 flex-col gap-2 overflow-hidden" aria-label="活动与对话">
    {snapshot.session.kind === "external" && <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><Info size={13} aria-hidden="true" />外部智能体 · 这里只显示已同步的内容，消息保存后需人工转交。</p>}
    {timeline.error && <Notice tone="error" action={<Button size="compact" onClick={timeline.reread}>重新读取活动</Button>}>活动暂不可读取：{timeline.error}
      {timeline.errorOriginal && <details className="mt-1 text-caption text-muted-foreground"><summary className="w-fit cursor-pointer">原文</summary><p lang="en" className="mt-1 font-mono [overflow-wrap:anywhere]">{timeline.errorOriginal}</p></details>}</Notice>}
    {grantNotice && <Notice tone="waiting"><span role="status" data-grant-blocked-notice="">有 {grantNotice.count} 条来自 {grantNotice.senders.join("、")} 的消息因缺少消息授权而受阻：补上授权前不会送达，它们没有占用队列，后面的消息照常处理。{grantNotice.reason}</span></Notice>}
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scroll} className="session-conversation-scroll workspace-timeline-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1 py-3 outline-none focus-visible:shadow-[var(--focus-ring)] [&>:first-child]:mt-auto" role="log" tabIndex={0} aria-label="消息与工具时间线" aria-live="off" aria-busy={!timeline.loaded} onScroll={event => {
      const node = event.currentTarget;
      if (!node.clientHeight || timeline.denied || cacheGeneration.current !== viewCacheGeneration) return;
      const near = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
      follow.current = near; setNearBottom(near);
      readingPositions.delete(scope); readingPositions.set(scope, readingPosition(node, near));
      while (readingPositions.size > 2) readingPositions.delete(readingPositions.keys().next().value!);
    }}>
      {(timeline.nextCursor || timeline.messagesCursor) && <Button variant="ghost" size="compact" className="h-auto self-center px-3 py-1 text-caption font-normal text-primary hover:bg-accent hover:text-primary disabled:text-muted-foreground disabled:opacity-100" disabled={timeline.moreBusy || timeline.reconciling} onClick={() => void more()}>{timeline.reconciling ? "正在校准历史…" : timeline.moreBusy ? "正在读取更早内容…" : "加载更早的消息与活动"}</Button>}
      {!timeline.loaded && <p className="flex items-center gap-2 text-small text-muted-foreground" role="status"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />正在读取对话…</p>}
      {timeline.loaded && !timeline.error && !rows.length && !children && !activeTurn && <div className="session-conversation-empty flex flex-col items-center gap-1.5 py-10 text-center text-small text-muted-foreground"><MessageCircle size={25} aria-hidden="true" /><strong className="text-body font-medium text-foreground">{timeline.page?.partial ? "当前来源尚未提供可读的活动" : "从这里开始沟通"}</strong><span>{timeline.page?.partial ? "这不代表原来没有历史记录，可在读取范围中查看原因。" : "发送消息后，这个智能体的回复与工具活动会连续显示在这里。"}</span></div>}
      {rows.map(row => row.kind === "coordination-group"
        ? <CoordinationGroup key={row.id} rounds={row.rounds} projectId={context.projectId} titleOf={titleOf} taskHref={taskHref} onMessage={messageId => inspect({ messageId })} />
        : renderRound(row.round))}
      {activeTurn && (live
        ? <LiveStatusLine className="workspace-turn-state" avatar={<AgentAvatar seed={snapshot.session.key} roleSeed={snapshot.session.title} size={20} />}
          text={liveStatusText(currentTool, replying)} elapsed={elapsedText(activeTurn.startedAt, now) ?? undefined}>
          {source?.taskId && <a className="text-primary hover:underline" href={taskHref(source.taskId)}>{snapshot.currentWork?.id === source.taskId ? `任务「${snapshot.currentWork.title}」` : "查看关联任务"}</a>}
        </LiveStatusLine>
        : <p className="workspace-turn-state stale text-label text-muted-foreground" role="status">上次读回时这一轮在进行，当前连接状态待核对。</p>)}
      {waitingSince && !timeline.denied && <LiveStatusLine className="workspace-turn-state" avatar={<AgentAvatar seed={snapshot.session.key} roleSeed={snapshot.session.title} size={20} />}
        text="等它开始处理你的消息" elapsed={elapsedText(waitingSince, now) ?? undefined} />}
      {!timeline.denied && children}
    </div>
    </div>
    {!nearBottom && items.length > 0 && <Button size="compact" className="h-auto shrink-0 gap-1.5 self-center bg-raised px-3 py-1 text-caption font-normal hover:bg-selected" onClick={() => { if (scroll.current) scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); follow.current = true; setNearBottom(true); }}><ArrowDown size={15} aria-hidden="true" />回到最新内容</Button>}
    {readingLimits}
    <SessionComposer context={context} snapshot={snapshot} entries={items} activeTurn={activeTurn} live={live} progress={progress} facts={composerFacts} routing={routing} onApplied={applied} />
    <Dialog open={inspector !== null && !timeline.denied} onOpenChange={open => { if (!open) setInspector(null); }}>
      <DialogContent className="workspace-inspector max-h-[85dvh] w-[min(640px,calc(100vw-32px))] overflow-y-auto" aria-describedby="workspace-inspector-description" onCloseAutoFocus={event => { const trigger = inspectorTrigger.current; if (trigger?.isConnected && trigger.getClientRects().length) { event.preventDefault(); trigger.focus({ preventScroll: true }); } inspectorTrigger.current = null; }}>
        <DialogTitle>活动详情</DialogTitle>
        <DialogDescription id="workspace-inspector-description">核对所选内容、消息状态与来源。</DialogDescription>
        {inspector && !timeline.denied && ("entry" in inspector ? <EntryInspector key={inspector.entry.id} entry={inspector.entry} context={context} sessionKey={snapshot.session.key} mayReadOriginal={mayReadOriginal} agentName={agentDisplayName(snapshot.session)} /> : <MessageInspector key={inspector.messageId} id={inspector.messageId} context={context} snapshot={snapshot} onApplied={applied} />)}
      </DialogContent>
    </Dialog>
  </section>;
}
