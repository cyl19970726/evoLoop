import { useEffect, useState } from "react";
import { ListFilter, Plus, Search, UserRound } from "lucide-react";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { href } from "../ui/shared";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { useSessionDirectoryGroup, type DirectoryMembership } from "./useSessionDirectoryGroup";
import { sessionStatusLabel } from "./sessionStatusPresentation";
import { groupSessionsByClass, sessionClassLabel, sessionClassReason, type SessionClass } from "./sessionDirectoryPresentation";
import "./sessions.css";

export const sessionHref = (projectId: string, key: string) => `${href(projectId, "sessions")}?session=${encodeURIComponent(key)}`;

const classOrder: SessionClass[] = ["business", "system", "unclassified"];

export function SessionNavigation({ token, projectId, selectedId, onNavigate }: { token: string; projectId: string; selectedId?: string; onNavigate(): void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [retries, setRetries] = useState<Record<DirectoryMembership, number>>({ current: 0, historical: 0, unclassified: 0 });
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  const current = useSessionDirectoryGroup(token, projectId, "current", search, retries.current, true);
  const historical = useSessionDirectoryGroup(token, projectId, "historical", search, retries.historical, historyOpen);
  const unclassified = useSessionDirectoryGroup(token, projectId, "unclassified", search, retries.unclassified, historyOpen);
  const totals = current.page?.totals;
  const grouped = groupSessionsByClass(current.items);
  const historicalCount = (totals?.historical ?? 0) + (totals?.unclassified ?? 0);
  function item(session: ObservedSession) {
    const roles = session.roles.map(role => role.title).join(" · ");
    return <a key={session.key} href={sessionHref(projectId, session.key)} className={`session-nav-item ${selectedId === session.key ? "selected" : ""}`} aria-current={selectedId === session.key ? "page" : undefined} onClick={onNavigate}>
      <UserRound size={15} aria-hidden="true" /><span className="session-nav-copy"><strong title={session.title}>{session.title}</strong>{roles && <small className="session-nav-meta">{roles}</small>}{!roles && <small className="session-nav-reason">{sessionClassReason(session)}</small>}<small className="session-nav-state">{session.kind === "owned" ? "受管" : "外部"} · {sessionStatusLabel(session)}</small></span>
    </a>;
  }
  function groupError(membership: DirectoryMembership, message: string) {
    return <p role="alert" className="session-nav-error">Session 目录暂不可读取：{message}。<button type="button" onClick={() => setRetries(value => ({ ...value, [membership]: value[membership] + 1 }))}>重试</button></p>;
  }
  return <section className="session-navigation" aria-label="Session 目录">
    <div className="session-nav-head"><strong>Session 目录</strong>{totals && <span>{totals.current + totals.historical + totals.unclassified}</span>}<button type="button" className="quiet" onClick={() => setConnectOpen(true)} aria-label="连接已有或建立受管会话"><Plus size={17} aria-hidden="true" /></button></div>
    <label className="session-nav-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索 Session 名称或职责" placeholder="搜索 Session…" value={query} onChange={event => setQuery(event.target.value)} /><ListFilter size={15} aria-hidden="true" /></label>
    {current.error && groupError("current", current.error)}
    {current.loading && !current.page && <p className="session-nav-muted">正在读取 Session 目录…</p>}
    <div className="session-nav-group session-nav-current">
      {!current.loading && current.page && current.items.length === 0 && <p className="session-nav-muted">没有匹配的当前 Session。</p>}
      {classOrder.map(groupName => {
        const entries = grouped[groupName];
        if (!entries.length) return null;
        const limit = groupName === "unclassified" ? 1 : 2;
        const selected = selectedId ? entries.find(entry => entry.key === selectedId) : undefined;
        const visible = search ? entries : selected
          ? [selected, ...entries.filter(entry => entry.key !== selected.key).slice(0, limit - 1)]
          : entries.slice(0, limit);
        return <div className="session-nav-class" key={groupName}><span>{sessionClassLabel[groupName]} · {entries.length}</span>{visible.map(item)}</div>;
      })}
    </div>
    <div className="session-nav-group">
      <button type="button" className="session-nav-history" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>{historyOpen ? "▾" : "▸"} 历史与待归类 {totals && `· ${historicalCount}`}</button>
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
    <a className="session-nav-directory-link" href={href(projectId, "sessions")} onClick={onNavigate}>打开完整目录 <span>→</span></a>
    <Sheet open={connectOpen} onOpenChange={setConnectOpen}><SheetContent side="left" className="session-connect-sheet"><SheetHeader><SheetTitle>连接或建立 Session</SheetTitle><SheetDescription>同一职责可以有多个承接会话。登记不表示已发送消息或启动执行。</SheetDescription></SheetHeader><div className="session-connect-options"><article><h3>连接已有会话</h3><p>登记原会话引用，核实打开、读取和人工接单能力。</p><a href={`${href(projectId, "runtime")}?view=roles`} onClick={() => { setConnectOpen(false); onNavigate(); }}>查看职责档案并连接</a></article><article><h3>建立受管会话</h3><p>使用项目授权预留，之后核实运行状态。</p><a href={`${href(projectId, "runtime")}?view=execution`} onClick={() => { setConnectOpen(false); onNavigate(); }}>打开受管执行入口</a></article></div></SheetContent></Sheet>
  </section>;
}
