import { useEffect, useRef, useState } from "react";
import type { SessionActivity } from "@evoloop/contracts/session-observation";
import type { RuntimeWorkTrace } from "@evoloop/contracts/runtime";
import { errorText } from "../api";
import { date } from "../ui/shared";
import { activityHeadline, activityPresentation } from "./activityPresentation";
import { groupActivities, type ActivityGroup } from "./activityGroups";
import { sessionClient } from "./client";

export type ActivityFilter = "important" | "all";
type Detail = { state: "loading" } | { state: "error"; message: string } |
  { state: "trace"; pages: RuntimeWorkTrace[]; readAt: string; sourceRevision: string | null;
    pageError?: string; loadingMore?: boolean; refreshing?: boolean; refreshError?: string } |
  { state: "message"; content: string; response: string | null; failure: string | null; status: string;
    readAt: string; sourceRevision: string | null; refreshing?: boolean; refreshError?: string };
const traceCache = new Map<string, Extract<Detail, { state: "trace" }>>();
let cacheEpoch = 0;
export function clearActivityDetails() { cacheEpoch++; traceCache.clear(); }
function cachedDetails(scope: string): Record<string, Detail> {
  return Object.fromEntries([...traceCache].filter(([key]) => key.startsWith(`${scope}\0`)).map(([key, value]) => [key.slice(scope.length + 1), value]));
}

function TraceItem({ entry, index }: { entry: RuntimeWorkTrace["items"][number]; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const firstLine = entry.kind === "message" ? null : entry.text?.split("\n", 1)[0]?.trim();
  return <details className="session-trace-item" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><strong>{index + 1}. {entry.name || entry.kind} · {entry.status || "状态未提供"}</strong>
      <small>{entry.completedAtUtc || entry.startedAtUtc ? date(entry.completedAtUtc || entry.startedAtUtc || undefined) : "时间未提供"}{entry.exitCode !== null && ` · 退出码 ${entry.exitCode}`}{entry.truncated && " · 内容已截断"}</small>
      {firstLine && <span className="session-trace-preview">{firstLine.slice(0, 120)}{firstLine.length > 120 && "…"}</span>}</summary>
    {expanded && <div className="session-trace-body">{entry.text && <><small>输入或正文</small><pre>{entry.text}</pre></>}{entry.output && <><small>输出</small><pre>{entry.output}</pre></>}{entry.error && <><small>错误</small><pre role="alert">{entry.error}</pre></>}{entry.artifactRefs.length > 0 && <p>成果引用：{entry.artifactRefs.join("、")}</p>}{entry.truncated && <small>此项内容已截断；可回到原来源核对。</small>}</div>}
  </details>;
}

function TraceRecords({ pages, shown, onMore }: { pages: RuntimeWorkTrace[]; shown: number; onMore(): void }) {
  const entries = pages.flatMap(page => page.items);
  const isInput = (entry: typeof entries[number]) => entry.kind === "message" && /^(user|input)$/i.test(entry.name?.trim() ?? "");
  const work = entries.filter(entry => !isInput(entry));
  const input = entries.filter(isInput);
  return <>
    <div className="session-trace-list">{work.slice(0, shown).map((entry, index) => <TraceItem key={`${entry.id}:${index}`} entry={entry} index={index} />)}</div>
    {work.length > shown && <button type="button" onClick={onMore}>显示更多工作记录（{shown}/{work.length}）</button>}
    {input.length > 0 && <details className="session-trace-input"><summary>原始输入与消息记录 · {input.length} 项</summary>
      {input.map((entry, index) => <TraceItem key={`${entry.id}:${index}`} entry={entry} index={index} />)}
    </details>}
  </>;
}

export function ActivityFeed({ items, filter, onFilter, open, onOpen, projectId, sessionKey, token, taskHref, taskTitle, currentRunId }: {
  items: SessionActivity[]; filter: ActivityFilter; onFilter(value: ActivityFilter): void;
  open: string[]; onOpen(value: string[]): void; projectId: string; sessionKey: string; token: string;
  taskHref(id: string): string;
  taskTitle(id: string): string | null;
  currentRunId: string | null;
}) {
  const scope = `${token}\0${projectId}\0${sessionKey}`;
  const [details, setDetails] = useState<Record<string, Detail>>(() => cachedDetails(scope));
  const [detailScope, setDetailScope] = useState(scope);
  const [visibleItems, setVisibleItems] = useState<Record<string, number>>({});
  const scopeRef = useRef(scope);
  const generation = useRef(0);
  const requests = useRef(new Map<string, number>());
  scopeRef.current = scope;
  useEffect(() => {
    generation.current++;
    requests.current.clear();
    setDetails(cachedDetails(scope));
    setDetailScope(scope);
    setVisibleItems({});
    return () => { generation.current++; requests.current.clear(); };
  }, [scope]);
  const groups = groupActivities(items.filter(item => filter === "all" || item.importance === "important"));
  const client = sessionClient(token, projectId);
  async function load(group: ActivityGroup, cursor?: string) {
    const source = group.latest.source;
    if (source.kind !== "run" && source.kind !== "message") return;
    const prior = detailScope === scope ? details[group.key] : undefined;
    const requestNumber = (requests.current.get(group.key) ?? 0) + 1;
    requests.current.set(group.key, requestNumber);
    const requestGeneration = generation.current;
    const requestEpoch = cacheEpoch;
    const current = () => scopeRef.current === scope && generation.current === requestGeneration && cacheEpoch === requestEpoch && requests.current.get(group.key) === requestNumber;
    setDetails(old => ({ ...old, [group.key]: cursor && prior?.state === "trace"
      ? { ...prior, pageError: undefined, loadingMore: true }
      : prior?.state === "trace" || prior?.state === "message"
        ? { ...prior, refreshError: undefined, refreshing: true } : { state: "loading" } }));
    try {
      if (source.kind === "run") {
        const page = await client.trace(source.id, cursor);
        if (!current()) return;
        if (page.runId !== source.id) throw new Error("执行记录与所选来源不符");
        if (cursor && page.nextCursor === cursor) throw new Error("执行轨迹游标未前进，请稍后核对来源。");
        const pages = cursor && prior?.state === "trace" ? [...prior.pages, page] : [page];
        const next: Extract<Detail, { state: "trace" }> = { state: "trace", pages, readAt: new Date().toISOString(), sourceRevision: source.revision };
        setDetails(old => ({ ...old, [group.key]: next }));
        traceCache.set(`${scope}\0${group.key}`, next);
        while (traceCache.size > 30) traceCache.delete(traceCache.keys().next().value!);
      } else {
        const value = await client.message(source.id);
        if (!current()) return;
        const target = value.message.target;
        const key = target.kind === "owned" ? `owned:${target.sessionId}` : `external:${target.linkId}`;
        if (value.message.id !== source.id || value.message.projectId !== projectId || key !== sessionKey)
          throw new Error("消息不属于当前会话");
        setDetails(old => ({ ...old, [group.key]: { state: "message", content: value.message.content,
          response: value.processing?.response ?? null, failure: value.processing?.failure ?? null, status: value.message.state,
          readAt: new Date().toISOString(), sourceRevision: source.revision } }));
      }
    } catch (cause) {
      if (!current()) return;
      setDetails(old => ({ ...old, [group.key]: cursor && prior?.state === "trace"
        ? { ...prior, pageError: errorText(cause), loadingMore: false }
        : prior?.state === "trace" || prior?.state === "message"
          ? { ...prior, refreshError: errorText(cause), refreshing: false }
          : { state: "error", message: errorText(cause) } }));
    }
  }
  useEffect(() => {
    for (const group of groups) if (open.includes(group.key) && !(detailScope === scope && details[group.key]) &&
      (group.latest.source.kind === "run" || group.latest.source.kind === "message")) void load(group);
  }, [items, open, projectId, sessionKey, token]);
  return <section className="session-workspace-section session-feed"><div className="session-section-head"><div><h2>活动</h2><p className="muted">同一来源的进展合并展示；关联任务记录不代表由本 Session 执行。</p></div><label>显示 <select aria-label="活动范围" value={filter} onChange={event => onFilter(event.target.value as ActivityFilter)}><option value="important">关键进展</option><option value="all">全部事件</option></select></label></div>
    {groups.length ? <ol className="session-activity-list">{groups.map(group => {
      const item = group.latest;
      const expanded = open.includes(group.key);
      const detail = detailScope === scope ? details[group.key] : undefined;
      const sourceChanged = detail && (detail.state === "trace" || detail.state === "message") &&
        item.source.revision !== detail.sourceRevision;
      const presented = activityPresentation(item, projectId);
      const taskIds = [...new Set(group.items.map(event => event.taskId).filter((id): id is string => !!id))];
      const linkedTaskId = taskIds.length === 1 ? taskIds[0]! : null;
      const runState = group.items.find(event => event.kind === "runtime_run")?.summary.split(" · ").at(-1);
      const runStateLabel = ({ running: "运行中", dispatching: "启动中", requested: "待启动", completed: "已结束", failed: "失败", interrupted: "已中断", unknown: "结果待核对" } as Record<string, string>)[runState ?? ""] ?? "进展待核对";
      const title = item.source.kind === "run" ? `${linkedTaskId && taskTitle(linkedTaskId) || "业务运行"} · ${item.source.id === currentRunId ? runStateLabel : `历史记录：${runStateLabel}`}`
        : activityHeadline(group.items, linkedTaskId ? taskTitle(linkedTaskId) : null);
      return <li key={group.key}><time>{date(item.occurredAt ?? item.recordedAt)}</time><div className="session-activity-card"><button type="button" className="session-activity-toggle" aria-expanded={expanded} onClick={() => {
        onOpen(expanded ? open.filter(key => key !== group.key) : [...open, group.key]);
        if (!expanded && !detail) void load(group);
      }}><strong>{title}</strong><small>{group.items.length > 1 ? `${group.items.length} 条记录 · ` : ""}{item.source.kind === "run" ? "项目运行记录" : presented.sourceLabel}</small></button>
        {expanded && <div className="session-activity-detail">
          {detail?.state === "loading" && <p role="status">正在读取来源详情…</p>}
          {detail?.state === "error" && <p role="alert">详情暂不可用：{detail.message} <button type="button" onClick={() => void load(group)}>重试</button></p>}
          {sourceChanged && <p className="session-trace-stale" role="status">来源记录已更新；下方仍是上次读取的详情，请重读核对。</p>}
          {detail?.state === "message" && <><p>消息状态：{detail.status} · 读于 {date(detail.readAt)} <button type="button" disabled={detail.refreshing} onClick={() => void load(group)}>{detail.refreshing ? "重读中…" : "重读消息"}</button></p>{detail.refreshError && <p role="alert">重读失败，保留上次内容：{detail.refreshError}</p>}<pre>{detail.content}</pre>{detail.response && <><h3>原会话回复</h3><pre>{detail.response}</pre></>}{detail.failure && <p role="alert">处理失败：{detail.failure}</p>}</>}
          {detail?.state === "trace" && <><p>原生执行轨迹 · {detail.pages.at(-1)?.completeness === "partial" ? "只读到部分记录" : "当前已读完整"} · 每字段最多 {detail.pages[0]?.limits.maxFieldChars} 字符 · 读于 {date(detail.readAt)} <button type="button" disabled={detail.refreshing || detail.loadingMore} onClick={() => void load(group)}>{detail.refreshing ? "重读中…" : "重读执行轨迹"}</button></p>
            {detail.refreshError && <p role="alert">重读失败，保留上次内容：{detail.refreshError}</p>}
            <TraceRecords pages={detail.pages} shown={visibleItems[group.key] ?? 10} onMore={() => setVisibleItems(old => ({ ...old, [group.key]: (old[group.key] ?? 10) + 10 }))} />
            {detail.pages.at(-1)?.unsupportedCount ? <p>另有 {detail.pages.at(-1)?.unsupportedCount} 项原生记录不支持展示。</p> : null}
            {detail.pages.at(-1)?.turnMetadata.status === "partial" && <p>Turn 元信息只读到部分范围。</p>}
            {detail.pages.at(-1)?.turnMetadata.status === "not_found" && <p>原生 Turn 元信息暂未找到。</p>}
            {detail.pageError && <p role="alert">后续页暂不可读：{detail.pageError}</p>}
            {detail.pages.at(-1)?.nextCursor && (detail.pages.length < 5
              ? <button type="button" disabled={detail.loadingMore} onClick={() => void load(group, detail.pages.at(-1)!.nextCursor!)}>{detail.loadingMore ? "读取后续页…" : detail.pageError ? "重试后续页" : "继续读取执行轨迹"}</button>
              : <p>已到达本页 5 次读取上限；可在原 Run 来源继续核对。</p>)}
          </>}
          {item.source.kind !== "run" && item.source.kind !== "message" && <p>此来源当前没有可读取的执行正文；可查看原始来源和关联任务。</p>}
          <details><summary>原始事件与来源</summary><ol>{group.items.map(event => <li key={event.id}>{date(event.recordedAt)} · {event.summary} · {event.actorId || "登记者未记录"} · <code>{event.source.kind}:{event.source.id}</code>{event.source.revision && <> · 修订 <code>{event.source.revision}</code></>}</li>)}</ol></details>
        </div>}
      </div><span className="session-activity-links">{linkedTaskId && <a href={taskHref(linkedTaskId)}>查看任务</a>}{presented.discussionHref && <a href={presented.discussionHref}>原讨论</a>}</span></li>;
    })}</ol> : <p className="empty">当前已读范围没有符合筛选条件的活动。</p>}
  </section>;
}
