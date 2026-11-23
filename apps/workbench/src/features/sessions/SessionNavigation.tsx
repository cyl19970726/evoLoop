import { useEffect, useRef, useState } from "react";
import { ChevronDown, LayoutDashboard, Plus, Search } from "lucide-react";
import { AgentAvatar, Button, IconButton, Sheet, SheetContent, SheetDescription, SheetTitle, StatusTag, cn } from "@evoloop/ui";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { href } from "../../shared/ui/shared";
import { withReturn, type ReturnFrom } from "../../shared/returnLink";
import { agentDisplayName, agentNameCollisions } from "../../shared/agentNamePresentation";
import { useProviderHolds } from "../../shared/providerHolds";
import { holdCauseLabel } from "../../shared/providerHoldPresentation";
import { useSessionDirectoryGroup, type DirectoryMembership } from "./useSessionDirectoryGroup";
import { agentRowStatus } from "./sessionStatusPresentation";
import { groupSessionsByClass, sessionClassLabel, type SessionClass } from "./sessionDirectoryPresentation";

/** A link to one agent; `from` (the page of this project it is opened from, the reader, optionally that page's name)
 * gives the agent page its way back (shared/returnLink.ts). */
export const sessionHref = (projectId: string, key: string, from?: ReturnFrom | null) =>
  withReturn(`${href(projectId, "sessions")}?${new URLSearchParams({ session: key })}`, from);

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
  // A selected agent that is not among the current team may be inside the 历史与待归类 fold: read it then, and open the fold once for it.
  const probing = !!selectedId && !!current.page && !current.items.some(session => session.key === selectedId);
  const historical = useSessionDirectoryGroup(token, projectId, "historical", search, retries.historical, (historyOpen || probing) && !searchPending, state.pages.historical, rememberPages("historical"));
  const unclassified = useSessionDirectoryGroup(token, projectId, "unclassified", search, retries.unclassified, (historyOpen || probing) && !searchPending, state.pages.unclassified, rememberPages("unclassified"));
  const holds = useProviderHolds(projectId, true);
  const openedFor = useRef<string | null>(null);
  const insideHistory = !!selectedId && [...historical.items, ...unclassified.items].some(session => session.key === selectedId);
  useEffect(() => {
    if (!insideHistory || openedFor.current === selectedId) return;
    openedFor.current = selectedId ?? null;
    onStateRef.current(previous => previous.historyOpen ? previous : { ...previous, historyOpen: true });
  }, [insideHistory, selectedId]);
  const [onlyWaiting, setOnlyWaiting] = useState(false);
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
  const heldReasons = new Map((holds.data?.items ?? []).filter(hold => hold.state === "held").map(hold => [hold.provider, holdCauseLabel(hold)] as const));
  const statusOf = (session: ObservedSession) => agentRowStatus(session, session.runtime ? heldReasons.get(session.runtime.provider) ?? null : null);
  const waitingCount = [...current.items, ...historical.items, ...unclassified.items].filter(session => statusOf(session).waitingOnMe).length;
  const show = (session: ObservedSession) => !onlyWaiting || statusOf(session).waitingOnMe;
  // Row: line 1 the display name (the first four characters of the identifier after it only where two agents share the name),
  // line 2 one sentence of status from the same wording source as the page header. Engineering identifiers live in the right column.
  function item(session: ObservedSession) {
    const name = agentDisplayName(session);
    const short = collisions.get(session.key)?.slice(0, 4);
    const status = statusOf(session);
    const selected = selectedId === session.key;
    return <a key={session.key} href={sessionHref(projectId, session.key)} aria-current={selected ? "page" : undefined} onClick={onNavigate}
      className={cn("selected-mark session-nav-item flex h-[52px] items-center gap-2.5 rounded-lg py-1.5 pl-2 pr-3 text-text-secondary hover:bg-selected focus-visible:shadow-[var(--focus-ring)] outline-none",
        selected && "bg-accent font-semibold text-foreground hover:bg-accent")}>
      <AgentAvatar seed={session.key} roleSeed={session.roles[0]?.id ?? session.title} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="session-nav-name flex min-w-0 items-baseline gap-1.5"><span className="truncate" title={name}>{name}</span>
          {short && <span className="session-nav-short shrink-0 text-caption font-normal text-muted-foreground">{short}</span>}</span>
        <StatusTag tone={status.tone} label={status.text} className="session-nav-signal !py-0 font-normal text-muted-foreground" title={status.text} />
      </span>
    </a>;
  }
  function groupError(membership: DirectoryMembership, message: string) {
    return <p role="alert" className="session-nav-error px-3 py-2 text-small text-destructive">智能体目录暂不可读取：{message}。<Button variant="link" className="ml-1" onClick={() => setRetries(value => ({ ...value, [membership]: value[membership] + 1 }))}>重试</Button></p>;
  }
  const muted = (text: string) => <p className="session-nav-muted px-3 py-1.5 text-small text-muted-foreground">{text}</p>;
  const groupLabel = (text: string) => <span className="block px-3 pb-1.5 pt-4 text-caption text-muted-foreground">{text}</span>;
  const moreButton = (busy: boolean, label: string, onClick: () => void) => <Button variant="ghost" disabled={busy} onClick={onClick}
    className="session-nav-more mx-3 my-1 h-auto rounded-md px-2 py-1 text-small font-normal text-primary hover:bg-accent hover:text-primary disabled:text-muted-foreground disabled:opacity-100">{busy ? "加载中…" : label}</Button>;
  return <section ref={root} className="session-navigation flex flex-col" aria-label="智能体目录" data-ui="">
    <label className="mb-1.5 flex h-9 items-center gap-2 rounded-md bg-field px-3 text-muted-foreground has-[input:focus-visible]:shadow-[var(--focus-ring)]">
      <Search size={14} aria-hidden="true" />
      <input aria-label="搜索智能体名称或职责" placeholder="搜索智能体" value={query} className="w-full bg-transparent text-foreground outline-none" onChange={event => onState(previous => ({ ...previous, query: event.target.value,
        pages: { current: 1, historical: 1, unclassified: 1 },
      }))} />
      <IconButton label="连接或建立智能体" icon={<Plus size={16} />} compact onClick={() => setConnectOpen(true)} />
    </label>
    {/* 统筹安排 is a team page now (Task 0f8c7a15): the directory only points to it. */}
    <a href={href(projectId, "arrangement")} onClick={onNavigate} data-arrangement-entry=""
      className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-text-secondary hover:bg-selected focus-visible:shadow-[var(--focus-ring)] outline-none")}>
      <LayoutDashboard size={18} aria-hidden="true" />统筹安排
      {totals && <span className="ml-auto text-caption text-muted-foreground" title="目录里的智能体总数，含历史与待归类">共 {totals.current + totals.historical + totals.unclassified} 个智能体</span>}
    </a>
    {(waitingCount > 0 || onlyWaiting) && <Button variant="ghost" aria-pressed={onlyWaiting} onClick={() => setOnlyWaiting(value => !value)}
      className="session-nav-waiting mx-3 mb-1 h-auto justify-start rounded-md px-2 py-1 text-small font-normal text-primary hover:bg-accent hover:text-primary">
      {onlyWaiting ? `只看等你处理的（${waitingCount}），点此看全部` : `${waitingCount} 个等你处理`}</Button>}
    {current.error && groupError("current", current.error)}
    {(searchPending || current.loading && !current.page) && muted("正在读取智能体目录…")}
    <div className="session-nav-group session-nav-current">
      {!current.loading && current.page && current.items.length === 0 && muted("没有匹配的当前智能体。")}
      {classOrder.map(groupName => {
        const entries = grouped[groupName].filter(show);
        if (!entries.length) return null;
        return <div className="session-nav-class flex flex-col gap-0.5" key={groupName}>{groupLabel(`${sessionClassLabel[groupName]} · ${entries.length}`)}{entries.map(item)}</div>;
      })}
    </div>
    {current.hasMore && !onlyWaiting && moreButton(current.moreBusy || current.loading, "加载更多当前智能体", () => void current.more())}
    {historicalCount > 0 && <div className="session-nav-group mt-3 flex flex-col gap-0.5 border-t border-border pt-2">
      <Button variant="row" onClick={() => onState(previous => ({ ...previous, historyOpen: !previous.historyOpen }))} aria-expanded={historyOpen}
        className="session-nav-history gap-1.5 px-3 py-1.5 text-small">
        <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", !historyOpen && "-rotate-90")} />历史与待归类{totals && ` · ${historicalCount}`}
      </Button>
      {historyOpen && <>
        {groupLabel(`历史 · ${totals?.historical ?? 0}`)}
        {historical.error && groupError("historical", historical.error)}
        {historical.loading && !historical.page && muted("正在读取历史智能体…")}
        {historical.items.filter(show).map(item)}
        {historical.page && historical.items.length === 0 && muted("没有匹配的历史智能体。")}
        {historical.hasMore && moreButton(historical.moreBusy || historical.loading, "加载更多历史智能体", () => void historical.more())}
        {groupLabel(`待归类 · ${totals?.unclassified ?? 0}`)}
        {unclassified.error && groupError("unclassified", unclassified.error)}
        {unclassified.loading && !unclassified.page && muted("正在读取待归类智能体…")}
        {unclassified.items.filter(show).map(item)}
        {unclassified.page && unclassified.items.length === 0 && muted("没有匹配的待归类智能体。")}
        {unclassified.hasMore && moreButton(unclassified.moreBusy || unclassified.loading, "加载更多待归类智能体", () => void unclassified.more())}
      </>}
    </div>}
    <Sheet open={connectOpen} onOpenChange={setConnectOpen}>
      <SheetContent side="left">
        <SheetTitle>连接或建立智能体</SheetTitle>
        <SheetDescription>同一职责可以有多个承接的智能体。登记不表示已发送消息或开始执行。</SheetDescription>
        <div className="grid gap-3">
          <article className="border-t border-border px-0 py-4"><h3 className="font-medium">连接已有会话</h3><p className="mt-1 text-small text-text-secondary">登记原会话引用，核实打开、读取和人工接单能力。</p>
            <a className="mt-2 inline-block text-small text-primary" href={href(projectId, "roles")} onClick={() => { setConnectOpen(false); onNavigate(); }}>查看职责档案并连接</a></article>
          <article className="border-t border-border px-0 py-4"><h3 className="font-medium">建立受管智能体</h3><p className="mt-1 text-small text-text-secondary">使用项目授权预留，之后核实运行状态。</p>
            <a className="mt-2 inline-block text-small text-primary" href={href(projectId, "runtime")} onClick={() => { setConnectOpen(false); onNavigate(); }}>打开受管执行入口</a></article>
        </div>
      </SheetContent>
    </Sheet>
  </section>;
}
