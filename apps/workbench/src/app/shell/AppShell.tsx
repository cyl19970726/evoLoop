// The workbench frame (docs/frontend/layout.md): outer rail for spaces, inner rail for project, sections and the
// object list, and one raised work panel with the center column and the right column. The frame is built from
// @evoloop/ui inside [data-ui]. Pages that are not rebuilt yet render in the center under `.workbench-layout`,
// the class their old styles are written against (the old frame's own rules are deleted); the window scrolls the
// center, as those pages expect.
import * as React from "react";
import { BriefcaseBusiness, ChevronsUpDown, Inbox, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Settings, Users, FolderGit2, Plug, TriangleAlert, X } from "lucide-react";
import {
  CountDot, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
  IconButton, Logo, PersonAvatar, Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, cn,
} from "@evoloop/ui";
import { href, type Route, type Section } from "../../shared/routes";
import { currentPath, navigate } from "../../shared/navigation";
import { SessionNavigation, emptySessionNavigationState, type SessionNavigationState } from "../../features/sessions/SessionNavigation";
import { ContextPanelColumn, ContextPanelProvider } from "../../shared/ui/ContextPanel";
import {
  inboxNavigation, leafOf, projectInitial, rememberSpace, sectionLabels, spaceHref, spaceLabels, spaceOf, workNavigation, workSectionOf,
  type NavItem, type Space,
} from "./spaces";

export interface AppShellProps {
  route: Route; projectId: string; projectTitle: string; actor: string; permissions: readonly string[];
  receiptCount: number; inboxCount: number; token: string; logout(): void; children: React.ReactNode;
}

const permissionText = (permissions: readonly string[]) =>
  permissions.includes("review") ? "可读写与复核" : permissions.includes("write") ? "可读写" : "只读";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(() => window.matchMedia(query).matches);
  React.useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function AppShell(props: AppShellProps) {
  const { route, projectId, actor } = props;
  const space = spaceOf(route);
  const compact = !useMediaQuery("(min-width: 760px)");
  const store = typeof window === "undefined" ? null : window.sessionStorage;
  React.useEffect(() => { rememberSpace(store, actor, projectId, route, currentPath()); });
  const title = route.section === "sessions" || space === "agents" ? spaceLabels.agents : sectionLabels[route.section];
  React.useEffect(() => { document.title = `${title} · ${props.projectTitle || "evoLoop"}`; }, [title, props.projectTitle]);
  const [sessionStates, setSessionStates] = React.useState<Record<string, SessionNavigationState>>({});
  const scope = `${actor}:${projectId}`;
  const sessionState = sessionStates[scope] ?? emptySessionNavigationState();
  const updateSessionState = (update: (state: SessionNavigationState) => SessionNavigationState) =>
    setSessionStates(previous => ({ ...previous, [scope]: update(previous[scope] ?? emptySessionNavigationState()) }));
  const [drawer, setDrawer] = React.useState(false);
  const navigatedFromDrawer = React.useRef(false);
  // The inner rail follows the width (shown from 1100px) until the reader toggles it; that choice is kept.
  const roomy = useMediaQuery("(min-width: 1100px)");
  const [railChoice, setRailChoice] = React.useState<"shown" | "hidden" | null>(() => {
    try { const saved = localStorage.getItem("evoloop:rail"); return saved === "shown" || saved === "hidden" ? saved : null; } catch { return null; }
  });
  const railHidden = railChoice ? railChoice === "hidden" : !roomy;
  const toggleRail = () => {
    const next = railHidden ? "shown" : "hidden";
    setRailChoice(next);
    try { localStorage.setItem("evoloop:rail", next); } catch { /* memory only */ }
  };
  const afterNavigate = () => { if (drawer) navigatedFromDrawer.current = true; setDrawer(false); };
  // Leaving the drawer by a link hands focus to the content; closing it otherwise returns focus to the menu button.
  const drawerCloseFocus = (event: Event) => {
    if (!navigatedFromDrawer.current) return;
    navigatedFromDrawer.current = false;
    event.preventDefault();
    document.getElementById("workspace-main")?.focus({ preventScroll: true });
  };
  const spaceLink = (target: Space) => spaceHref(store, actor, projectId, target);
  const railProps = { ...props, space, sessionState, onSessionState: updateSessionState, onNavigate: afterNavigate };

  return <ContextPanelProvider space={space}>
    <div className="min-h-dvh bg-sunken text-foreground">
      <div data-ui=""><a href="#workspace-main" onClick={event => { event.preventDefault(); document.getElementById("workspace-main")?.focus(); }}
        className="sr-only z-50 rounded-md bg-raised px-3 py-2 shadow-md focus:not-sr-only focus:fixed focus:left-3 focus:top-3">跳到内容</a></div>
      {import.meta.env.DEV && <div data-ui="" role="status" className="fixed bottom-3 right-3 z-40 rounded-full bg-warning-soft px-3 py-1 text-caption text-warning compact:bottom-3 max-compact:bottom-20">
        {window.location.port === "5181" ? "开发测试预览 · 模拟数据 · 尚未发布" : "开发预览 · 连接现有数据 · 尚未发布"}</div>}
      {/* One tree for every width, switched by CSS at 760px: crossing it restyles the frame in the same frame as the
          viewport change and never remounts the pages (their state and drafts stay). */}
      <header data-ui="" data-shell="mobile-header" className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-sunken/95 px-2 backdrop-blur compact:hidden">
        <IconButton label="打开项目导航" icon={<Menu size={19} />} onClick={() => setDrawer(true)} />
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="max-w-[40%] truncate text-small text-muted-foreground">{props.projectTitle}</span>
      </header>
      <Sheet open={drawer && compact} onOpenChange={setDrawer}>
        {/* `mobile-navigation` marks the drawer as the scroll container the Session list keeps its position in. */}
        <SheetContent side="left" className="mobile-navigation w-[300px] max-w-[85vw] gap-0 bg-sunken p-0" onCloseAutoFocus={drawerCloseFocus}>
          <SheetTitle className="sr-only">项目导航</SheetTitle><SheetDescription className="sr-only">项目、分区与对象列表</SheetDescription>
          <div className="flex justify-end px-2 pt-2"><SheetClose asChild><IconButton label="关闭导航" icon={<X size={18} />} /></SheetClose></div>
          <ContextRail {...railProps} inDrawer />
        </SheetContent>
      </Sheet>
      <div data-shell="frame" data-rail={compact ? "drawer" : railHidden ? "hidden" : "shown"}
        className={cn("block compact:grid compact:min-h-dvh", railHidden ? "compact:grid-cols-[68px_minmax(0,1fr)]" : "compact:grid-cols-[68px_264px_minmax(0,1fr)]")}>
        <nav data-ui="" data-shell="rail" aria-label="空间" className="sticky top-0 hidden h-dvh flex-col items-center gap-2 py-4 compact:flex">
          <a href="/" aria-label="evoLoop 项目列表" className="mb-4 rounded-lg focus-visible:shadow-[var(--focus-ring)]"><Logo size={36} /></a>
          <RailLink href={spaceLink("work")} label="工作" selected={space === "work"} icon={<BriefcaseBusiness size={20} />} />
          <RailLink href={spaceLink("agents")} label="智能体" selected={space === "agents"} icon={<Users size={20} />} />
          <div className="mt-auto flex flex-col items-center gap-2">
            <RailLink href={spaceLink("inbox")} label="待我处理" selected={space === "inbox"} icon={<Inbox size={20} />} count={props.inboxCount + props.receiptCount} />
            <IconButton label={railHidden ? "展开项目导航" : "收起项目导航"} aria-expanded={!railHidden} icon={railHidden ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />} onClick={toggleRail} />
          </div>
        </nav>
        {!railHidden && <div className="sticky top-0 hidden h-dvh compact:block"><ContextRail {...railProps} /></div>}
        <div className="flex min-w-0 bg-background compact:m-2 compact:ml-0 compact:min-h-[calc(100dvh-16px)] compact:rounded-xl compact:shadow-lg">
          <main id="workspace-main" tabIndex={-1} className="workbench-layout min-w-0 flex-1 outline-none max-compact:pb-20">{props.children}</main>
          <ContextPanelColumn />
        </div>
      </div>
      <nav data-ui="" data-shell="tabs" aria-label="空间" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-raised pb-[env(safe-area-inset-bottom)] compact:hidden">
        <TabLink href={spaceLink("work")} label="工作" selected={space === "work"} icon={<BriefcaseBusiness size={20} />} />
        <TabLink href={spaceLink("agents")} label="智能体" selected={space === "agents"} icon={<Users size={20} />} />
        <TabLink href={spaceLink("inbox")} label="待我处理" selected={space === "inbox"} icon={<Inbox size={20} />} count={props.inboxCount + props.receiptCount} />
        <AccountMenu {...props} trigger={<button type="button" aria-label="我的：账号与设置" className="flex flex-col items-center gap-0.5 py-2 text-caption text-muted-foreground"><PersonAvatar name={actor} size={22} />我的</button>} />
      </nav>
    </div>
  </ContextPanelProvider>;
}

function RailLink({ href: target, label, selected, icon, count = 0 }: { href: string; label: string; selected: boolean; icon: React.ReactNode; count?: number }) {
  return <a href={target} aria-current={selected ? "page" : undefined}
    className={cn("relative flex w-[52px] flex-col items-center gap-1 rounded-lg pb-[7px] pt-[9px] text-[11px] text-muted-foreground hover:bg-selected hover:text-foreground focus-visible:shadow-[var(--focus-ring)] outline-none",
      selected && "bg-selected font-medium text-foreground")}>
    {icon}{label}
    {count > 0 && <CountDot count={count} className="absolute right-[7px] top-[3px]" />}
  </a>;
}

function TabLink({ href: target, label, selected, icon, count = 0 }: { href: string; label: string; selected: boolean; icon: React.ReactNode; count?: number }) {
  return <a href={target} aria-current={selected ? "page" : undefined}
    className={cn("relative flex flex-col items-center gap-0.5 py-2 text-caption text-muted-foreground", selected && "font-medium text-foreground")}>
    {icon}{label}
    {count > 0 && <CountDot count={count} className="absolute right-[22%] top-1" />}
  </a>;
}

function ContextRail(props: AppShellProps & { space: Space; sessionState: SessionNavigationState;
  onSessionState(update: (state: SessionNavigationState) => SessionNavigationState): void; onNavigate(): void; inDrawer?: boolean }) {
  const { route, projectId, space, inDrawer = false } = props;
  const selectedSession = route.session ? route.session.includes(":") ? route.session : `owned:${route.session}` : undefined;
  // On the wide frame the object list scrolls inside the rail; in the drawer the whole drawer scrolls.
  return <aside aria-label="项目导航" className={cn("flex flex-col gap-0.5 pb-3 pl-1 pr-3 pt-3.5", inDrawer ? "min-h-full pl-3" : "h-full")}>
    <div data-ui="">
      <a href="/" onClick={props.onNavigate} className="mb-3 flex items-center gap-2.5 rounded-lg bg-raised px-3 py-2.5 shadow-sm hover:shadow-md focus-visible:shadow-[var(--focus-ring)] outline-none">
        <span aria-hidden="true" className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] bg-accent font-semibold text-accent-foreground">{projectInitial(props.projectTitle)}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold" title={props.projectTitle}>{props.projectTitle || "正在读取项目…"}</span>
          <span className="text-caption text-muted-foreground">本机 · 所在机器待接入</span>
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      </a>
    </div>
    {space === "agents"
      ? <div data-legacy="" className={cn("min-h-0 flex-1", !inDrawer && "overflow-y-auto")}>
        <SessionNavigation key={`${props.actor}:${projectId}`} token={props.token} projectId={projectId} selectedId={selectedSession}
          onNavigate={props.onNavigate} state={props.sessionState} onState={props.onSessionState} />
      </div>
      : <nav data-ui="" aria-label={space === "inbox" ? "待我处理" : "工作分区"} className={cn("min-h-0 flex-1", !inDrawer && "overflow-y-auto")}>
        <SectionList items={space === "inbox" ? inboxNavigation : workNavigation} route={route} projectId={projectId} onNavigate={props.onNavigate} />
      </nav>}
    <div data-ui="" className="mt-2 flex items-center gap-2.5 border-t border-border px-2 pt-2.5">
      <PersonAvatar name={props.actor} size={30} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium" title={props.actor}>{props.actor}</span>
        <span className="text-caption text-muted-foreground">{permissionText(props.permissions)}</span>
      </span>
      <AccountMenu {...props} trigger={<IconButton label="设置与账号" icon={<Settings size={18} />} />} />
    </div>
  </aside>;
}

function SectionList({ items, route, projectId, onNavigate }: { items: readonly NavItem[]; route: Route; projectId: string; onNavigate(): void }) {
  const owner = workSectionOf(route.section) ?? route.section;
  const leaf = leafOf(route.section);
  return <ul className="flex flex-col gap-0.5">
    {items.map(item => {
      const current = item.section === owner;
      return <li key={item.section}>
        <a href={href(projectId, item.section)} onClick={onNavigate} aria-current={current && (!item.children || leaf === item.section) ? "page" : undefined}
          className={cn("flex items-center rounded-md px-3 py-[9px] text-text-secondary hover:bg-selected hover:text-foreground focus-visible:shadow-[var(--focus-ring)] outline-none",
            current && "bg-selected font-medium text-foreground")}>{item.label}</a>
        {current && item.children && <ul className="mb-1 ml-3 mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
          {item.children.map(child => <li key={child.section}>
            <a href={href(projectId, child.section)} onClick={onNavigate} aria-current={leaf === child.section ? "page" : undefined}
              className={cn("block rounded-md px-2.5 py-1.5 text-small text-muted-foreground hover:bg-selected hover:text-foreground focus-visible:shadow-[var(--focus-ring)] outline-none",
                leaf === child.section && "bg-raised font-medium text-foreground shadow-sm")}>{child.label}</a>
          </li>)}
        </ul>}
      </li>;
    })}
  </ul>;
}

function AccountMenu({ projectId, actor, permissions, receiptCount, logout, trigger }: AppShellProps & { trigger: React.ReactElement }) {
  const go = (section: Section) => navigate(href(projectId, section));
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
    <DropdownMenuContent align="end" side="top" className="w-56">
      <DropdownMenuLabel><span className="block truncate text-foreground">{actor}</span><span className="text-caption">{permissionText(permissions)}</span></DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => go("settings")}><Settings size={16} aria-hidden="true" />项目设置</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => go("operations")}><TriangleAlert size={16} aria-hidden="true" />结果未知的操作{receiptCount > 0 && <span className="ml-auto text-caption text-warning">{receiptCount}</span>}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => go("repository")}><FolderGit2 size={16} aria-hidden="true" />仓库规范</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => go("connectors")}><Plug size={16} aria-hidden="true" />微信连接</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => navigate("/")}><ChevronsUpDown size={16} aria-hidden="true" />切换项目</DropdownMenuItem>
      <DropdownMenuItem onSelect={logout}><LogOut size={16} aria-hidden="true" />退出</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
