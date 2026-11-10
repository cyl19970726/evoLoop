import { useEffect, useRef, useState } from "react";
import { ChevronDown, LayoutDashboard, Plus, Search } from "lucide-react";
import { AgentAvatar, IconButton, Sheet, SheetContent, SheetDescription, SheetTitle, cn } from "@evoloop/ui";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { href } from "../../shared/ui/shared";
import { agentDisplayName, agentNameCollisions, agentNameHint } from "../../shared/agentNamePresentation";
import { useSessionDirectoryGroup, type DirectoryMembership } from "./useSessionDirectoryGroup";
import { agentStatusLabel } from "./sessionStatusPresentation";
import { groupSessionsByClass, sessionClassLabel, sessionClassReason, type SessionClass } from "./sessionDirectoryPresentation";

/** A link to one agent; `from` (a task of this project, its title and the reader) gives the agent page its way back. */
export const sessionHref = (projectId: string, key: string, from?: { href: string; title: string; actorId: string }) =>
  `${href(projectId, "sessions")}?${new URLSearchParams({ session: key, ...(from ? { return: from.href, actor: from.actorId, returnTitle: from.title.slice(0, 80) } : {}) })}`;

const classOrder: SessionClass[] = ["business", "system", "unclassified"];
const shortTime = (iso: string) => { const at = new Date(iso); return Number.isNaN(at.getTime()) ? iso : at.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); };
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
  // Agents that would show the same name are told apart by their short identifier, first on the second line.
  const collisions = agentNameCollisions([...current.items, ...historical.items, ...unclassified.items]);
  function item(session: ObservedSession) {
    const roles = session.roles.map(role => role.title).join(" · ");
    const name = agentDisplayName(session);
    const taskSignal = session.currentTask ? session.currentTask.title : null;
    // A generated name already says the role; what the service records about the agent says the rest.
    const hint = agentNameHint(session, shortTime);
    const short = collisions.get(session.key);
    const status = agentStatusLabel(session);
    const signal = `${short ? `标识 ${short} · ` : ""}${taskSignal ?? hint ?? (roles || sessionClassReason(session))} · ${status}`;
    const dot = session.busy === true ? "bg-primary" : session.runtimeState === "failed" ? "bg-destructive" : session.busy === false && session.runtimeState === "ready" ? "bg-border" : "bg-warning";
    const selected = selectedId === session.key;
    return <a key={session.key} href={sessionHref(projectId, session.key)} aria-current={selected ? "page" : undefined} onClick={onNavigate}
      className={cn("session-nav-item flex items-center gap-2.5 rounded-lg py-1.5 pl-2 pr-3 text-text-secondary hover:bg-selected focus-visible:shadow-[var(--focus-ring)] outline-none",
        selected && "bg-raised font-medium text-foreground shadow-sm")}>
      <AgentAvatar seed={session.key} roleSeed={session.roles[0]?.id ?? session.title} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" title={name}>{name}</span>
        <span className="session-nav-signal truncate text-caption font-normal text-muted-foreground" title={signal}>{signal}</span>
      </span>
      <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full", dot)} />
    </a>;
  }
  function groupError(membership: DirectoryMembership, message: string) {
    return <p role="alert" className="session-nav-error px-3 py-2 text-small text-destructive">智能体目录暂不可读取：{message}。<button type="button" className="ml-1 text-primary underline-offset-4 hover:underline" onClick={() => setRetries(value => ({ ...value, [membership]: value[membership] + 1 }))}>重试</button></p>;
  }
  const muted = (text: string) => <p className="session-nav-muted px-3 py-1.5 text-small text-muted-foreground">{text}</p>;
  const groupLabel = (text: string) => <span className="block px-3 pb-1.5 pt-4 text-caption text-muted-foreground">{text}</span>;
  const moreButton = (busy: boolean, label: string, onClick: () => void) => <button type="button" disabled={busy} onClick={onClick}
    className="session-nav-more mx-3 my-1 rounded-md px-2 py-1 text-small text-primary hover:bg-accent disabled:text-muted-foreground">{busy ? "加载中…" : label}</button>;
  return <section ref={root} className="session-navigation flex flex-col" aria-label="智能体目录" data-ui="">
    <label className="mb-1.5 flex h-9 items-center gap-2 rounded-full bg-field px-3 text-muted-foreground">
      <Search size={14} aria-hidden="true" />
      <input aria-label="搜索智能体名称或职责" placeholder="搜索智能体" value={query} className="w-full bg-transparent text-foreground outline-none" onChange={event => onState(previous => ({ ...previous, query: event.target.value,
        pages: { current: 1, historical: 1, unclassified: 1 },
      }))} />
      <IconButton label="连接或建立智能体" icon={<Plus size={16} />} compact onClick={() => setConnectOpen(true)} />
    </label>
    <a href={href(projectId, "sessions")} onClick={onNavigate} aria-current={!selectedId ? "page" : undefined}
      className={cn("flex items-center gap-2.5 rounded-lg px-3 py-[9px] text-text-secondary hover:bg-selected focus-visible:shadow-[var(--focus-ring)] outline-none", !selectedId && "bg-raised font-medium text-foreground shadow-sm")}>
      <LayoutDashboard size={18} aria-hidden="true" />统筹安排
      {totals && <span className="ml-auto text-caption text-muted-foreground" title="目录里的智能体总数，含历史与待归类">共 {totals.current + totals.historical + totals.unclassified} 个智能体</span>}
    </a>
    {current.error && groupError("current", current.error)}
    {(searchPending || current.loading && !current.page) && muted("正在读取智能体目录…")}
    <div className="session-nav-group session-nav-current">
      {!current.loading && current.page && current.items.length === 0 && muted("没有匹配的当前智能体。")}
      {classOrder.map(groupName => {
        const entries = grouped[groupName];
        if (!entries.length) return null;
        return <div className="session-nav-class flex flex-col gap-0.5" key={groupName}>{groupLabel(`${sessionClassLabel[groupName]} · 已加载 ${entries.length}`)}{entries.map(item)}</div>;
      })}
    </div>
    {current.hasMore && moreButton(current.moreBusy || current.loading, "加载更多当前智能体", () => void current.more())}
    <div className="session-nav-group mt-3 flex flex-col gap-0.5 border-t border-border pt-2">
      <button type="button" onClick={() => onState(previous => ({ ...previous, historyOpen: !previous.historyOpen }))} aria-expanded={historyOpen}
        className="session-nav-history flex items-center gap-1.5 rounded-md px-3 py-1.5 text-small text-text-secondary hover:bg-selected">
        <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", !historyOpen && "-rotate-90")} />历史与待归类{totals && ` · ${historicalCount}`}
      </button>
      {historyOpen && <>
        {groupLabel(`历史 · ${totals?.historical ?? 0}`)}
        {historical.error && groupError("historical", historical.error)}
        {historical.loading && !historical.page && muted("正在读取历史智能体…")}
        {historical.items.map(item)}
        {historical.page && historical.items.length === 0 && muted("没有匹配的历史智能体。")}
        {historical.hasMore && moreButton(historical.moreBusy || historical.loading, "加载更多历史智能体", () => void historical.more())}
        {groupLabel(`待归类 · ${totals?.unclassified ?? 0}`)}
        {unclassified.error && groupError("unclassified", unclassified.error)}
        {unclassified.loading && !unclassified.page && muted("正在读取待归类智能体…")}
        {unclassified.items.map(item)}
        {unclassified.page && unclassified.items.length === 0 && muted("没有匹配的待归类智能体。")}
        {unclassified.hasMore && moreButton(unclassified.moreBusy || unclassified.loading, "加载更多待归类智能体", () => void unclassified.more())}
      </>}
    </div>
    <Sheet open={connectOpen} onOpenChange={setConnectOpen}>
      <SheetContent side="left">
        <SheetTitle>连接或建立智能体</SheetTitle>
        <SheetDescription>同一职责可以有多个承接的智能体。登记不表示已发送消息或开始执行。</SheetDescription>
        <div className="grid gap-3">
          <article className="rounded-lg bg-muted p-4"><h3 className="font-medium">连接已有会话</h3><p className="mt-1 text-small text-text-secondary">登记原会话引用，核实打开、读取和人工接单能力。</p>
            <a className="mt-2 inline-block text-small text-primary" href={href(projectId, "roles")} onClick={() => { setConnectOpen(false); onNavigate(); }}>查看职责档案并连接</a></article>
          <article className="rounded-lg bg-muted p-4"><h3 className="font-medium">建立受管智能体</h3><p className="mt-1 text-small text-text-secondary">使用项目授权预留，之后核实运行状态。</p>
            <a className="mt-2 inline-block text-small text-primary" href={href(projectId, "runtime")} onClick={() => { setConnectOpen(false); onNavigate(); }}>打开受管执行入口</a></article>
        </div>
      </SheetContent>
    </Sheet>
  </section>;
}
