import { useEffect, useState } from "react";
import { Plus, Search, UserRound } from "lucide-react";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { href } from "../ui/shared";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { useSessionDirectoryGroup, type DirectoryMembership } from "./useSessionDirectoryGroup";
import { sessionStatusLabel } from "./sessionStatusPresentation";
import "./sessions.css";

export const sessionHref = (projectId: string, key: string) => `${href(projectId, "runtime")}?session=${encodeURIComponent(key)}`;

export function SessionNavigation({ token, projectId, selectedId, onNavigate }: { token: string; projectId: string; selectedId?: string; onNavigate(): void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [currentExpanded, setCurrentExpanded] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [retries, setRetries] = useState<Record<DirectoryMembership, number>>({ current: 0, historical: 0, unclassified: 0 });
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  const current = useSessionDirectoryGroup(token, projectId, "current", search, retries.current, true);
  const historyEnabled = listOpen && historyOpen;
  const historical = useSessionDirectoryGroup(token, projectId, "historical", search, retries.historical, historyEnabled);
  const unclassified = useSessionDirectoryGroup(token, projectId, "unclassified", search, retries.unclassified, historyEnabled);
  const totals = current.page?.totals;
  const historicalCount = (totals?.historical ?? 0) + (totals?.unclassified ?? 0);
  const totalSessions = totals ? totals.current + totals.historical + totals.unclassified : 0;
  const visibleCurrent = search || currentExpanded ? current.items : current.items.slice(0, 3);
  function item(session: ObservedSession) {
    const task = session.currentTask;
    const roles = session.roles.map(role => role.title).join(" · ");
    return <a key={session.key} href={sessionHref(projectId, session.key)} className={`session-nav-item ${selectedId === session.key ? "selected" : ""}`} aria-current={selectedId === session.key ? "page" : undefined} onClick={onNavigate}>
      <UserRound size={15} aria-hidden="true" /><span className="session-nav-copy"><strong title={session.title}>{session.title}</strong><small className="session-nav-meta">{roles || task?.title || "职责未确认"} · {session.kind === "owned" ? "受管" : "外部"} · {sessionStatusLabel(session)}</small></span>
    </a>;
  }
  function groupError(membership: DirectoryMembership, message: string) {
    return <p role="alert" className="session-nav-error">会话目录暂不可读取：{message}。<button type="button" onClick={() => setRetries(value => ({ ...value, [membership]: value[membership] + 1 }))}>重试</button></p>;
  }
  return <section className={`session-navigation${currentExpanded ? " expanded" : ""}`} aria-label="Session 列表">
    <div className="session-nav-head"><button type="button" className="session-nav-fold" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}>{listOpen ? "▾" : "▸"} Session {totals && `· ${totals.current + totals.historical + totals.unclassified}`}</button><button type="button" className="quiet" onClick={() => setConnectOpen(true)} aria-label="连接已有或建立受管会话"><Plus size={17} aria-hidden="true" /></button></div>
    {listOpen && <>{currentExpanded && <label className="session-nav-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索 Session 姓名或职责" placeholder="搜索姓名或职责…" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    {current.error && groupError("current", current.error)}
    {current.loading && !current.page && <p className="session-nav-muted">正在读取 Session…</p>}
    <div className="session-nav-group"><span>当前团队 {totals && `· ${totals.current}`}</span>{visibleCurrent.map(item)}{current.page && current.items.length === 0 && <p className="session-nav-muted">没有匹配的当前团队 Session。</p>}
      {!search && current.items.length > 3 && <button className="session-nav-all" type="button" onClick={() => { setCurrentExpanded(value => !value); setQuery(""); }} aria-expanded={currentExpanded}>{currentExpanded ? "收起当前团队" : `查看全部会话 · ${totalSessions}`}</button>}
      {current.hasMore && <button className="session-nav-more" type="button" disabled={current.moreBusy || current.loading} onClick={() => void current.more()}>{current.moreBusy || current.loading ? "加载中…" : "加载更多当前成员"}</button>}</div>
    {(historicalCount > 0 || historyOpen) && <div className="session-nav-group"><button type="button" className="session-nav-history" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>{historyOpen ? "▾" : "▸"} 历史与待归类 {totals && `· ${historicalCount}`}</button>
      {historyOpen && <>
        <span>历史 {totals && `· ${totals.historical}`}</span>
        {historical.error && groupError("historical", historical.error)}
        {historical.loading && !historical.page && <p className="session-nav-muted">正在读取历史 Session…</p>}
        {historical.items.map(item)}
        {historical.page && historical.items.length === 0 && <p className="session-nav-muted">没有匹配的历史 Session。</p>}
        {historical.hasMore && <button className="session-nav-more" type="button" disabled={historical.moreBusy || historical.loading} onClick={() => void historical.more()}>{historical.moreBusy || historical.loading ? "加载中…" : "加载更多历史 Session"}</button>}
        <span>待归类 {totals && `· ${totals.unclassified}`}</span>
        {unclassified.error && groupError("unclassified", unclassified.error)}
        {unclassified.loading && !unclassified.page && <p className="session-nav-muted">正在读取待归类 Session…</p>}
        {unclassified.items.map(item)}
        {unclassified.page && unclassified.items.length === 0 && <p className="session-nav-muted">没有匹配的待归类 Session。</p>}
        {unclassified.hasMore && <button className="session-nav-more" type="button" disabled={unclassified.moreBusy || unclassified.loading} onClick={() => void unclassified.more()}>{unclassified.moreBusy || unclassified.loading ? "加载中…" : "加载更多待归类 Session"}</button>}
      </>}
    </div>}</>}
    <Sheet open={connectOpen} onOpenChange={setConnectOpen}><SheetContent side="left" className="session-connect-sheet"><SheetHeader><SheetTitle>连接或建立 Session</SheetTitle><SheetDescription>同一职责可以有多个承接会话。登记不表示已发送消息或启动执行。</SheetDescription></SheetHeader><div className="session-connect-options"><article><h3>连接已有会话</h3><p>登记原会话引用，核实打开、读取和人工接单能力。</p><a href={`${href(projectId, "runtime")}?view=roles`} onClick={() => { setConnectOpen(false); onNavigate(); }}>查看职责档案并连接</a></article><article><h3>建立受管会话</h3><p>使用项目授权预留，之后核实运行状态。</p><a href={`${href(projectId, "runtime")}?view=execution`} onClick={() => { setConnectOpen(false); onNavigate(); }}>打开受管执行入口</a></article></div></SheetContent></Sheet>
  </section>;
}
