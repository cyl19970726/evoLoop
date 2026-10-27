import { useEffect, useState } from "react";
import type { SessionActivity } from "@evoloop/contracts/session-observation";
import type { RuntimeWorkTrace } from "@evoloop/contracts/runtime";
import { errorText } from "../api";
import { date } from "../ui/shared";
import { activityPresentation } from "./activityPresentation";
import { groupActivities, type ActivityGroup } from "./activityGroups";
import { sessionClient } from "./client";

export type ActivityFilter = "important" | "all";
type Detail = { state: "loading" } | { state: "error"; message: string } |
  { state: "trace"; pages: RuntimeWorkTrace[]; pageError?: string; loadingMore?: boolean } |
  { state: "message"; content: string; response: string | null; failure: string | null; status: string };
const traceCache = new Map<string, Extract<Detail, { state: "trace" }>>();
export function clearActivityDetails() { traceCache.clear(); }
function cachedDetails(scope: string): Record<string, Detail> {
  return Object.fromEntries([...traceCache].filter(([key]) => key.startsWith(`${scope}\0`)).map(([key, value]) => [key.slice(scope.length + 1), value]));
}

export function ActivityFeed({ items, filter, onFilter, open, onOpen, projectId, sessionKey, token, taskHref }: {
  items: SessionActivity[]; filter: ActivityFilter; onFilter(value: ActivityFilter): void;
  open: string[]; onOpen(value: string[]): void; projectId: string; sessionKey: string; token: string;
  taskHref(id: string): string;
}) {
  const scope = `${token}\0${projectId}\0${sessionKey}`;
  const [details, setDetails] = useState<Record<string, Detail>>(() => cachedDetails(scope));
  useEffect(() => setDetails(cachedDetails(scope)), [scope]);
  const groups = groupActivities(items.filter(item => filter === "all" || item.importance === "important"));
  const client = sessionClient(token, projectId);
  async function load(group: ActivityGroup, cursor?: string) {
    const source = group.latest.source;
    if (source.kind !== "run" && source.kind !== "message") return;
    const prior = details[group.key];
    setDetails(old => ({ ...old, [group.key]: cursor && prior?.state === "trace"
      ? { ...prior, pageError: undefined, loadingMore: true } : { state: "loading" } }));
    try {
      if (source.kind === "run") {
        const page = await client.trace(source.id, cursor);
        if (page.runId !== source.id) throw new Error("执行记录与所选来源不符");
        if (cursor && page.nextCursor === cursor) throw new Error("执行轨迹游标未前进，请稍后核对来源。");
        const pages = cursor && prior?.state === "trace" ? [...prior.pages, page] : [page];
        setDetails(old => ({ ...old, [group.key]: { state: "trace", pages } }));
        traceCache.set(`${scope}\0${group.key}`, { state: "trace", pages });
        while (traceCache.size > 30) traceCache.delete(traceCache.keys().next().value!);
      } else {
        const value = await client.message(source.id);
        const target = value.message.target;
        const key = target.kind === "owned" ? `owned:${target.sessionId}` : `external:${target.linkId}`;
        if (value.message.id !== source.id || value.message.projectId !== projectId || key !== sessionKey)
          throw new Error("消息不属于当前会话");
        setDetails(old => ({ ...old, [group.key]: { state: "message", content: value.message.content,
          response: value.processing?.response ?? null, failure: value.processing?.failure ?? null, status: value.message.state } }));
      }
    } catch (cause) { setDetails(old => ({ ...old, [group.key]: cursor && prior?.state === "trace"
      ? { ...prior, pageError: errorText(cause), loadingMore: false } : { state: "error", message: errorText(cause) } })); }
  }
  useEffect(() => {
    for (const group of groups) if (open.includes(group.key) && !details[group.key] &&
      (group.latest.source.kind === "run" || group.latest.source.kind === "message")) void load(group);
  }, [items, open, projectId, sessionKey, token]);
  return <section className="session-workspace-section session-feed"><div className="session-section-head"><div><h2>活动</h2><p className="muted">同一来源的进展合并展示；关联任务记录不代表由本 Session 执行。</p></div><label>显示 <select aria-label="活动范围" value={filter} onChange={event => onFilter(event.target.value as ActivityFilter)}><option value="important">关键进展</option><option value="all">全部事件</option></select></label></div>
    {groups.length ? <ol className="session-activity-list">{groups.map(group => {
      const item = group.latest;
      const expanded = open.includes(group.key);
      const detail = details[group.key];
      const presented = activityPresentation(item, projectId);
      return <li key={group.key}><time>{date(item.occurredAt ?? item.recordedAt)}</time><div className="session-activity-card"><button type="button" className="session-activity-toggle" aria-expanded={expanded} onClick={() => {
        onOpen(expanded ? open.filter(key => key !== group.key) : [...open, group.key]);
        if (!expanded && !detail) void load(group);
      }}><strong>{item.summary}</strong><small>{group.items.length > 1 ? `${group.items.length} 条记录 · ` : ""}{presented.sourceLabel}</small></button>
        {expanded && <div className="session-activity-detail">
          {group.items.length > 1 && <ol>{group.items.map(event => <li key={event.id}><time>{date(event.occurredAt ?? event.recordedAt)}</time><span>{event.summary}</span></li>)}</ol>}
          {detail?.state === "loading" && <p role="status">正在读取来源详情…</p>}
          {detail?.state === "error" && <p role="alert">详情暂不可用：{detail.message} <button type="button" onClick={() => void load(group)}>重试</button></p>}
          {detail?.state === "message" && <><p>消息状态：{detail.status}</p><pre>{detail.content}</pre>{detail.response && <><h3>原会话回复</h3><pre>{detail.response}</pre></>}{detail.failure && <p role="alert">处理失败：{detail.failure}</p>}</>}
          {detail?.state === "trace" && <><p>原生执行轨迹 · {detail.pages.at(-1)?.completeness === "partial" ? "只读到部分记录" : "当前已读完整"} · 每字段最多 {detail.pages[0]?.limits.maxFieldChars} 字符</p>
            {detail.pages.flatMap(page => page.items).map((entry, index) => <article key={`${entry.id}:${index}`} className="session-trace-item"><strong>{entry.name || entry.kind} · {entry.status || "状态未提供"}</strong>{entry.text && <pre>{entry.text}</pre>}{entry.output && <pre>{entry.output}</pre>}{entry.error && <pre role="alert">{entry.error}</pre>}{entry.artifactRefs.length > 0 && <p>成果引用：{entry.artifactRefs.join("、")}</p>}{entry.truncated && <small>此项内容已截断</small>}</article>)}
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
      </div><span className="session-activity-links">{item.taskId && <a href={taskHref(item.taskId)}>查看任务</a>}{presented.discussionHref && <a href={presented.discussionHref}>原讨论</a>}</span></li>;
    })}</ol> : <p className="empty">当前已读范围没有符合筛选条件的活动。</p>}
  </section>;
}
