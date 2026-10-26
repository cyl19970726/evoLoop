import { useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { ObservedSession, SessionDirectory } from "@evoloop/contracts/session-observation";
import { errorText } from "../api";
import { href } from "../ui/shared";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { sessionClient } from "./client";
import "./sessions.css";

export const sessionHref = (projectId: string, key: string) => `${href(projectId, "runtime")}?session=${encodeURIComponent(key)}`;

export function SessionNavigation({ token, projectId, selectedId, onNavigate }: { token: string; projectId: string; selectedId?: string; onNavigate(): void }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<SessionDirectory | null>(null);
  const [items, setItems] = useState<ObservedSession[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const nextCursor = useRef<string | null>(null);
  const pagesLoaded = useRef(1);
  const reading = useRef(false);
  const loadingMore = useRef(false);
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    const client = sessionClient(token, projectId);
    const controller = new AbortController();
    const myGeneration = ++generation.current;
    reading.current = false; loadingMore.current = false;
    setPage(null); setItems([]); setError(""); setMoreBusy(false); nextCursor.current = null; pagesLoaded.current = 1;
    async function read() {
      if (document.visibilityState === "hidden" || reading.current || loadingMore.current) return;
      reading.current = true; setLoading(true);
      try {
        let result = await client.directory({ search: search || undefined }, controller.signal);
        const merged = new Map(result.items.map(item => [item.key, item]));
        for (let loaded = 1; loaded < pagesLoaded.current && result.nextCursor; loaded++) {
          result = await client.directory({ search: search || undefined, cursor: result.nextCursor }, controller.signal);
          for (const item of result.items) merged.set(item.key, item);
        }
        if (generation.current !== myGeneration) return;
        setPage(result); setItems([...merged.values()]); nextCursor.current = result.nextCursor; setError("");
      } catch (cause) {
        if (!controller.signal.aborted && generation.current === myGeneration) setError(errorText(cause));
      } finally { if (generation.current === myGeneration) { reading.current = false; setLoading(false); } }
    }
    void read();
    const timer = window.setInterval(() => void read(), 10000);
    const visible = () => { if (document.visibilityState === "visible") void read(); };
    document.addEventListener("visibilitychange", visible);
    return () => { generation.current++; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [token, projectId, search, retry]);
  async function more() {
    const cursor = nextCursor.current;
    if (!cursor || moreBusy || reading.current || loadingMore.current) return;
    const myGeneration = generation.current;
    loadingMore.current = true;
    setMoreBusy(true);
    try {
      const result = await sessionClient(token, projectId).directory({ search: search || undefined, cursor });
      if (generation.current !== myGeneration || cursor !== nextCursor.current) return;
      setItems(old => {
        const merged = new Map(old.map(item => [item.key, item]));
        for (const item of result.items) merged.set(item.key, item);
        return [...merged.values()];
      });
      nextCursor.current = result.nextCursor; setPage(result); setError("");
      pagesLoaded.current++;
    } catch (cause) { if (generation.current === myGeneration) setError(errorText(cause)); }
    finally { if (generation.current === myGeneration) { loadingMore.current = false; setMoreBusy(false); } }
  }
  function item(session: ObservedSession) {
    const task = session.currentTask;
    const state = session.busy === true ? "进行中" : session.busy === false ? "空闲" : "状态未知";
    return <a key={session.key} href={sessionHref(projectId, session.key)} className={`session-nav-item ${selectedId === session.key ? "selected" : ""}`} aria-current={selectedId === session.key ? "page" : undefined} onClick={onNavigate}>
      <strong title={session.title}>{session.title}</strong><small>{task ? task.title : session.roles.map(role => role.title).join(" · ") || "职责未确认"}</small><small>{session.kind === "owned" ? "受管" : "外部"} · {state}</small>
    </a>;
  }
  const current = items.filter(item => item.membership === "current");
  const historical = items.filter(item => item.membership !== "current");
  return <section className="session-navigation" aria-label="Session 列表">
    <div className="session-nav-head"><button type="button" className="session-nav-fold" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}>{listOpen ? "▾" : "▸"} Session {page && `· ${page.totals.current + page.totals.historical + page.totals.unclassified}`}</button><button type="button" className="quiet" onClick={() => setConnectOpen(true)} aria-label="连接已有或建立受管会话"><Plus size={17} aria-hidden="true" /></button></div>
    {listOpen && <><label className="session-nav-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索 Session 姓名或职责" placeholder="搜索姓名或职责…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {error && <p role="alert" className="session-nav-error">会话目录暂不可读取：{error}。<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
    {loading && !page && <p className="session-nav-muted">正在读取 Session…</p>}
    <div className="session-nav-group"><span>当前团队 {page && `· ${page.totals.current}`}</span>{current.map(item)}{page && current.length === 0 && <p className="session-nav-muted">没有已归入当前团队的 Session。</p>}</div>
    {(historical.length > 0 || !!page && page.totals.historical + page.totals.unclassified > 0) && <div className="session-nav-group"><button type="button" className="session-nav-history" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>{historyOpen ? "▾" : "▸"} 历史与待归类 {page && `· ${page.totals.historical + page.totals.unclassified}`}</button>{historyOpen && historical.map(item)}</div>}
    {nextCursor.current && <button className="session-nav-more" type="button" disabled={moreBusy} onClick={() => void more()}>{moreBusy ? "加载中…" : "加载更多 Session"}</button>}</>}
    <Sheet open={connectOpen} onOpenChange={setConnectOpen}><SheetContent side="left" className="session-connect-sheet"><SheetHeader><SheetTitle>连接或建立 Session</SheetTitle><SheetDescription>同一职责可以有多个承接会话。登记不表示已发送消息或启动执行。</SheetDescription></SheetHeader><div className="session-connect-options"><article><h3>连接已有会话</h3><p>登记原会话引用，核实打开、读取和人工接单能力。</p><a href={`${href(projectId, "runtime")}?view=roles`} onClick={() => { setConnectOpen(false); onNavigate(); }}>查看职责档案并连接</a></article><article><h3>建立受管会话</h3><p>使用项目授权预留，之后核实运行状态。</p><a href={`${href(projectId, "runtime")}?view=execution`} onClick={() => { setConnectOpen(false); onNavigate(); }}>打开受管执行入口</a></article></div></SheetContent></Sheet>
  </section>;
}
