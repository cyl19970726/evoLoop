import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ListFilter, Plus, Search } from "lucide-react";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { href } from "../ui/shared";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { useSessionDirectoryGroup, type DirectoryMembership } from "./useSessionDirectoryGroup";
import { sessionStatusLabel } from "./sessionStatusPresentation";
import { groupSessionsByClass, sessionClassLabel, sessionClassReason, type SessionClass } from "./sessionDirectoryPresentation";
import { SessionIdentityMark } from "./SessionIdentityMark";
import "./sessions.css";

export const sessionHref = (projectId: string, key: string) => `${href(projectId, "sessions")}?session=${encodeURIComponent(key)}`;

const classOrder: SessionClass[] = ["business", "system", "unclassified"];
export interface SessionNavigationState {
  query: string;
  historyOpen: boolean;
  pages: Record<DirectoryMembership, number>;
  scrollTop: number;
}
export const emptySessionNavigationState = (): SessionNavigationState => ({
  query: "", historyOpen: false, pages: { current: 1, historical: 1, unclassified: 1 }, scrollTop: 0,
});

export function SessionNavigation({ token, projectId, selectedId, onNavigate, state, onState }: {
  token: string; projectId: string; selectedId?: string; onNavigate(): void;
  state: SessionNavigationState; onState(update: (state: SessionNavigationState) => SessionNavigationState): void;
}) {
  const { query, historyOpen } = state;
  const root = useRef<HTMLElement>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const scrollRestored = useRef(false);
  const [search, setSearch] = useState(query.trim());
  const searchPending = query.trim() !== search;
  const [connectOpen, setConnectOpen] = useState(false);
  const [retries, setRetries] = useState<Record<DirectoryMembership, number>>({ current: 0, historical: 0, unclassified: 0 });
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  const rememberPages = (membership: DirectoryMembership) => (count: number) => onState(previous =>
    previous.query.trim() !== search ? previous : { ...previous, pages: { ...previous.pages, [membership]: count } });
  const current = useSessionDirectoryGroup(token, projectId, "current", search, retries.current, !searchPending, state.pages.current, rememberPages("current"));
  const historical = useSessionDirectoryGroup(token, projectId, "historical", search, retries.historical, historyOpen && !searchPending, state.pages.historical, rememberPages("historical"));
  const unclassified = useSessionDirectoryGroup(token, projectId, "unclassified", search, retries.unclassified, historyOpen && !searchPending, state.pages.unclassified, rememberPages("unclassified"));
  useEffect(() => {
    const host = root.current?.closest<HTMLElement>(".mobile-navigation") ?? root.current;
    if (!host) return;
    const remember = () => onStateRef.current(previous => previous.scrollTop === host.scrollTop ? previous : { ...previous, scrollTop: host.scrollTop });
    host.addEventListener("scroll", remember, { passive: true });
    return () => host.removeEventListener("scroll", remember);
  }, []);
  useEffect(() => {
    if (!current.page || scrollRestored.current) return;
    const host = root.current?.closest<HTMLElement>(".mobile-navigation") ?? root.current;
    if (!host) return;
    host.scrollTop = state.scrollTop;
    scrollRestored.current = true;
  }, [current.page, state.scrollTop]);
  const totals = current.page?.totals;
  const grouped = groupSessionsByClass(current.items);
  const historicalCount = (totals?.historical ?? 0) + (totals?.unclassified ?? 0);
  function item(session: ObservedSession) {
    const roles = session.roles.map(role => role.title).join(" · ");
    const taskSignal = session.currentTask ? session.currentTask.title : null;
    const stateClass = session.busy === true ? "running" : session.runtimeState === "failed" ? "failed" : session.busy === false && session.runtimeState === "ready" ? "idle" : "unknown";
    return <a key={session.key} href={sessionHref(projectId, session.key)} className={`session-nav-item ${selectedId === session.key ? "selected" : ""}`} aria-current={selectedId === session.key ? "page" : undefined} onClick={onNavigate}>
      <SessionIdentityMark target={session.target} identity={session.identity} name={session.title} size="small" /><span className="session-nav-copy"><strong title={session.title}>{session.title}</strong>{taskSignal && <small className="session-nav-signal">{taskSignal}</small>}{roles && <small className="session-nav-meta">{roles}</small>}{!roles && <small className="session-nav-reason">{sessionClassReason(session)}</small>}<small className="session-nav-state"><span className={`session-nav-status ${stateClass}`} aria-hidden="true" /> {session.kind === "owned" ? "受管" : "外部"} · {sessionStatusLabel(session)}</small></span>
    </a>;
  }
  function groupError(membership: DirectoryMembership, message: string) {
    return <p role="alert" className="session-nav-error">Session 目录暂不可读取：{message}。<button type="button" onClick={() => setRetries(value => ({ ...value, [membership]: value[membership] + 1 }))}>重试</button></p>;
  }
  return <section ref={root} className="session-navigation" aria-label="Session 目录">
    <div className="session-nav-head"><a href={href(projectId, "sessions")} onClick={onNavigate}>Session 目录</a>{totals && <span>{totals.current + totals.historical + totals.unclassified}</span>}<button type="button" className="quiet" onClick={() => setConnectOpen(true)} aria-label="连接已有或建立受管会话"><Plus size={17} aria-hidden="true" /></button></div>
    <label className="session-nav-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索 Session 名称或职责" placeholder="搜索 Session…" value={query} onChange={event => onState(previous => ({ ...previous, query: event.target.value,
      pages: { current: 1, historical: 1, unclassified: 1 },
    }))} /><ListFilter size={15} aria-hidden="true" /></label>
    {current.error && groupError("current", current.error)}
    {(searchPending || current.loading && !current.page) && <p className="session-nav-muted">正在读取 Session 目录…</p>}
    <div className="session-nav-group session-nav-current">
      {!current.loading && current.page && current.items.length === 0 && <p className="session-nav-muted">没有匹配的当前 Session。</p>}
      {classOrder.map(groupName => {
        const entries = grouped[groupName];
        if (!entries.length) return null;
        return <div className="session-nav-class" key={groupName}><span>{sessionClassLabel[groupName]} · 已加载 {entries.length}</span>{entries.map(item)}</div>;
      })}
    </div>
    {current.hasMore && <button className="session-nav-more" type="button" disabled={current.moreBusy || current.loading} onClick={() => void current.more()}>{current.moreBusy ? "加载中…" : "加载更多当前 Session"}</button>}
    <a className="session-nav-directory-link" href={href(projectId, "sessions")} onClick={onNavigate}>查看全部 Session <ArrowRight size={14} aria-hidden="true" /></a>
    <div className="session-nav-group">
      <button type="button" className="session-nav-history" onClick={() => onState(previous => ({ ...previous, historyOpen: !previous.historyOpen }))} aria-expanded={historyOpen}><ChevronDown size={13} aria-hidden="true" className={historyOpen ? "" : "collapsed"} /> 历史与待归类 {totals && `· ${historicalCount}`}</button>
      {historyOpen && <>
        <span>历史 · {totals?.historical ?? 0}</span>
        {historical.error && groupError("historical", historical.error)}
        {historical.loading && !historical.page && <p className="session-nav-muted">正在读取历史 Session…</p>}
        {historical.items.map(item)}
        {historical.page && historical.items.length === 0 && <p className="session-nav-muted">没有匹配的历史 Session。</p>}
        {historical.hasMore && <button className="session-nav-more" type="button" disabled={historical.moreBusy || historical.loading} onClick={() => void historical.more()}>{historical.moreBusy || historical.loading ? "加载中…" : "加载更多历史 Session"}</button>}
        <span>待归类 · {totals?.unclassified ?? 0}</span>
        {unclassified.error && groupError("unclassified", unclassified.error)}
        {unclassified.loading && !unclassified.page && <p className="session-nav-muted">正在读取待归类 Session…</p>}
        {unclassified.items.map(item)}
        {unclassified.page && unclassified.items.length === 0 && <p className="session-nav-muted">没有匹配的待归类 Session。</p>}
        {unclassified.hasMore && <button className="session-nav-more" type="button" disabled={unclassified.moreBusy || unclassified.loading} onClick={() => void unclassified.more()}>{unclassified.moreBusy || unclassified.loading ? "加载中…" : "加载更多待归类 Session"}</button>}
      </>}
    </div>
    <Sheet open={connectOpen} onOpenChange={setConnectOpen}><SheetContent side="left" className="session-connect-sheet"><SheetHeader><SheetTitle>连接或建立 Session</SheetTitle><SheetDescription>同一职责可以有多个承接会话。登记不表示已发送消息或启动执行。</SheetDescription></SheetHeader><div className="session-connect-options"><article><h3>连接已有会话</h3><p>登记原会话引用，核实打开、读取和人工接单能力。</p><a href={`${href(projectId, "runtime")}?view=roles`} onClick={() => { setConnectOpen(false); onNavigate(); }}>查看职责档案并连接</a></article><article><h3>建立受管会话</h3><p>使用项目授权预留，之后核实运行状态。</p><a href={`${href(projectId, "runtime")}?view=execution`} onClick={() => { setConnectOpen(false); onNavigate(); }}>打开受管执行入口</a></article></div></SheetContent></Sheet>
  </section>;
}
