import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, Clock3, Search, UserRound } from "lucide-react";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { date, href } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";
import { sessionHref } from "./SessionNavigation";
import { sessionStatusLabel } from "./sessionStatusPresentation";
import { groupSessionsByClass, sessionClassLabel, sessionClassReason, type SessionClass } from "./sessionDirectoryPresentation";
import { useSessionDirectoryGroup } from "./useSessionDirectoryGroup";
import "./sessions.css";

const classOrder: SessionClass[] = ["business", "system", "unclassified"];

function SessionRow({ context, session }: { context: MutationContext; session: ObservedSession }) {
  const unclassified = sessionClassReason(session);
  return <article className="sessions-directory-row">
    <span className="sessions-directory-icon" aria-hidden="true"><UserRound size={18} /></span>
    <div className="sessions-directory-main">
      <div className="sessions-directory-title"><a href={sessionHref(context.projectId, session.key)}>{session.title}</a><span>{session.kind === "owned" ? "受管" : "外部"}</span></div>
      <p>{session.roles.map(role => role.title).join(" · ") || "职责待核对"}<span> · {sessionStatusLabel(session)}</span></p>
      {session.currentTask ? <a className="sessions-directory-task" href={href(context.projectId, "task", session.currentTask.id)}>{session.currentTask.title} <ArrowRight size={13} aria-hidden="true" /></a> : <span className="sessions-directory-empty">当前没有可确认的 Task</span>}
      {session.roles.length === 0 && <small>{unclassified}</small>}
    </div>
    <div className="sessions-directory-meta"><span>{session.lastProgressAt ? <><Clock3 size={13} aria-hidden="true" />{date(session.lastProgressAt)}</> : "进展时间未提供"}</span><a href={sessionHref(context.projectId, session.key)}>打开 <ArrowRight size={13} aria-hidden="true" /></a></div>
  </article>;
}

function SessionGroup({ context, title, items, empty }: { context: MutationContext; title: string; items: ObservedSession[]; empty: string }) {
  return <section className="sessions-directory-group">
    <div className="sessions-directory-group-head"><h2>{title}</h2><span>{items.length}</span></div>
    {items.length ? <div className="sessions-directory-list">{items.map(session => <SessionRow key={session.key} context={context} session={session} />)}</div> : <p className="sessions-directory-empty-state">{empty}</p>}
  </section>;
}

export function SessionsDirectoryPage({ context }: { context: MutationContext; refresh: number }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [readAgain, setReadAgain] = useState(0);
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  const current = useSessionDirectoryGroup(context.token, context.projectId, "current", search, readAgain, true);
  const historical = useSessionDirectoryGroup(context.token, context.projectId, "historical", search, readAgain, historyOpen);
  const unclassified = useSessionDirectoryGroup(context.token, context.projectId, "unclassified", search, readAgain, historyOpen);
  const grouped = groupSessionsByClass(current.items);
  const directory = current.page;
  return <div className="content sessions-directory-page">
    <header className="sessions-directory-header">
      <div><p className="sessions-kicker">Agent 工作目录</p><h1>Sessions</h1><p className="lede">从职责进入具体 Agent，查看真实任务、消息、工具活动和交付依据。</p></div>
      <button type="button" onClick={() => setReadAgain(value => value + 1)} disabled={current.loading}>重新读取</button>
    </header>
    <div className="sessions-directory-toolbar">
      <label><Search size={17} aria-hidden="true" /><input type="search" aria-label="搜索完整 Session 目录" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、职责或用途…" /></label>
      {directory && <p>当前 {directory.totals.current} · 历史 {directory.totals.historical} · 待归类 {directory.totals.unclassified}<span>读于 {date(directory.metadata.generatedAt)}</span></p>}
    </div>
    {directory && directory.attention && <div className="sessions-directory-attention"><span>{directory.attention.pendingMessages} 条待处理消息</span><span>{directory.attention.unansweredQuestions} 个待答问题</span>{directory.attention.pendingAcceptance !== null && <span>{directory.attention.pendingAcceptance} 项待验收</span>}</div>}
    {current.error && <div className="sessions-directory-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><span>当前 Session 目录暂不可读取：{current.error}</span><button type="button" onClick={() => setReadAgain(value => value + 1)}>重试</button></div>}
    {current.loading && !directory && <p className="sessions-directory-loading">正在读取 Session 目录…</p>}
    {(!current.error || current.items.length > 0) && classOrder.map((groupName, index) => <SessionGroup key={groupName} context={context} title={sessionClassLabel[groupName]} items={grouped[groupName]} empty={search ? `没有匹配的${sessionClassLabel[groupName]}。` : index === 2 ? "当前没有需要归类的 Session。" : `当前没有${sessionClassLabel[groupName]}。`} />)}
    {current.hasMore && <button className="sessions-directory-more" type="button" disabled={current.moreBusy} onClick={() => void current.more()}>{current.moreBusy ? "加载中…" : "加载更多当前 Session"}</button>}
    <details className="sessions-directory-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
      <summary>历史与待归类 <span>{directory?.totals.historical ?? 0} 历史 · {directory?.totals.unclassified ?? 0} 待归类</span></summary>
      {historical.error && <div className="sessions-directory-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><span>历史 Session 暂不可读取：{historical.error}</span><button type="button" onClick={() => setReadAgain(value => value + 1)}>重试</button></div>}
      {historical.loading && !historical.page && <p className="sessions-directory-loading">正在读取历史 Session…</p>}
      {historical.page && (!historical.error || historical.items.length > 0) && <SessionGroup context={context} title="历史 Session" items={historical.items} empty={search ? "没有匹配的历史 Session。" : "没有可确认的历史 Session。"} />}
      {!historical.error && historical.hasMore && <button className="sessions-directory-more" type="button" disabled={historical.moreBusy} onClick={() => void historical.more()}>{historical.moreBusy ? "加载中…" : "加载更多历史 Session"}</button>}
      {unclassified.error && <div className="sessions-directory-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><span>待归类 Session 暂不可读取：{unclassified.error}</span><button type="button" onClick={() => setReadAgain(value => value + 1)}>重试</button></div>}
      {unclassified.loading && !unclassified.page && <p className="sessions-directory-loading">正在读取待归类 Session…</p>}
      {unclassified.page && (!unclassified.error || unclassified.items.length > 0) && <SessionGroup context={context} title="待归类" items={unclassified.items} empty={search ? "没有匹配的待归类 Session。" : "没有待归类的 Session。"} />}
      {!unclassified.error && unclassified.hasMore && <button className="sessions-directory-more" type="button" disabled={unclassified.moreBusy} onClick={() => void unclassified.more()}>{unclassified.moreBusy ? "加载中…" : "加载更多待归类 Session"}</button>}
    </details>
  </div>;
}
