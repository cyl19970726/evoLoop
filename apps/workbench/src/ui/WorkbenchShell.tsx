import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, BriefcaseBusiness, CalendarDays, ChevronLeft, ChevronRight, FolderOpen, Home, ListTodo, Menu, Settings, TriangleAlert, Users } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "../components/ui/sheet";
import { Button } from "../components/ui/button";
import { href, type Route, type Section } from "./shared";
import { SessionNavigation } from "../sessions/SessionNavigation";

export const sectionNames: Record<Section, string> = { overview: "项目总览", work: "任务", "create-task": "创建任务", inbox: "待判断与复核", task: "任务详情", documents: "文档与知识", document: "文档阅读", knowledge: "知识空间", journey: "目标与阶段", discussions: "团队分工", reviews: "组织复盘", collaboration: "协作回执", runtime: "团队分工", schedules: "日程", roles: "团队分工", repository: "仓库规范", operations: "待核对操作", evaluations: "评价与后果", settings: "项目设置" };
const functions = [
  { section: "overview", title: "项目总览", Icon: Home },
  { section: "work", title: "任务", Icon: ListTodo },
  { section: "documents", title: "文档与知识", Icon: BookOpen },
  { section: "schedules", title: "日程", Icon: CalendarDays },
  { section: "runtime", title: "团队分工", Icon: Users },
] as const;

export function WorkbenchShell({ route, projectTitle, actor, receiptCount, token, logout, children }: { route: Route; projectTitle: string; actor: string; receiptCount: number; token: string; logout(): void; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1180);
  const [open, setOpen] = useState(false);
  const navigationFromMenu = useRef(false);
  const widthRef = useRef(window.innerWidth);
  const manualCollapse = useRef(false);
  useEffect(() => {
    const syncLayout = () => {
      const next = window.innerWidth;
      const crossedBreakpoint = (widthRef.current < 1180) !== (next < 1180);
      if (crossedBreakpoint) manualCollapse.current = false;
      if (!manualCollapse.current) setCollapsed(next < 1180);
      widthRef.current = next;
    };
    window.addEventListener("resize", syncLayout);
    return () => window.removeEventListener("resize", syncLayout);
  }, []);
  const closeAfterNavigation = () => {
    navigationFromMenu.current = open;
    setOpen(false);
    if (window.innerWidth < 1180) {
      manualCollapse.current = false;
      setCollapsed(true);
    }
  };
  const toggleSidebar = () => {
    manualCollapse.current = true;
    setCollapsed(value => !value);
  };
  const changeMenu = (next: boolean) => {
    if (next) navigationFromMenu.current = false;
    setOpen(next);
  };
  const closeFocus = (event: Event) => {
    const navigated = navigationFromMenu.current;
    navigationFromMenu.current = false;
    const content = navigated ? document.getElementById("workspace-main") : null;
    if (content) {
      // Navigation hands focus to content; cancellation keeps Radix's trigger restore.
      event.preventDefault();
      content.focus({ preventScroll: true });
    }
  };
  const projectId = route.projectId!;
  const current = route.section === "task" || route.section === "create-task" || route.section === "journey" || route.section === "inbox" || route.section === "evaluations" ? "work"
    : ["document", "knowledge", "repository"].includes(route.section) ? "documents"
      : ["roles", "discussions", "reviews", "collaboration"].includes(route.section) ? "runtime"
        : route.section === "runtime" && route.session ? "" : route.section;
  const isKnowledge = route.section === "knowledge";
  const now = new Date();
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const workspaceDate = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} 周${weekday}`;
  const link = (section: Section, title: string, Icon: typeof Home) => <a key={section} href={href(projectId, section)} className={current === section ? "selected" : ""} aria-current={current === section ? "page" : undefined} onClick={closeAfterNavigation}><Icon size={18} aria-hidden="true" /><span>{title}</span></a>;
  const sidebar = <>
    <a className="project-switch" href="#/" onClick={closeAfterNavigation}><span className="project-monogram">E</span><span><small>当前项目</small><strong title={projectTitle}>{projectTitle || "读取项目…"}</strong></span><ChevronRight size={15} aria-hidden="true" /></a>
    <nav className="project-functions" aria-label="项目功能">{functions.map(item => link(item.section, item.title, item.Icon))}</nav>
    <SessionNavigation token={token} projectId={projectId} selectedId={route.section === "runtime" && route.session ? route.session.includes(":") ? route.session : `owned:${route.session}` : undefined} onNavigate={closeAfterNavigation} />
    <div className="nav-resources"><a aria-current={route.section === "operations" ? "page" : undefined} href={href(projectId, "operations")} onClick={closeAfterNavigation}><TriangleAlert size={17} />待核对操作{receiptCount > 0 && <span className="nav-count">{receiptCount}</span>}</a><a aria-current={route.section === "repository" ? "page" : undefined} href={href(projectId, "repository")} onClick={closeAfterNavigation}><FolderOpen size={17} />仓库规范</a><a aria-current={route.section === "settings" ? "page" : undefined} href={href(projectId, "settings")} onClick={closeAfterNavigation}><Settings size={17} />项目设置</a></div>
  </>;
  return <div className={`workbench-layout ${collapsed ? "sidebar-collapsed" : ""}`}>
    <a className="skip-link" href="#workspace-main" onClick={e => { e.preventDefault(); document.getElementById("workspace-main")?.focus(); }}>跳到内容</a>
    <nav className="module-rail" aria-label="主导航"><a className="rail-brand" href="#/" aria-label="evoLoop 项目选择">e<span>L</span></a>
      <a className={!isKnowledge && route.section !== "overview" ? "selected" : ""} href={href(projectId, "work")} aria-current={!isKnowledge && route.section !== "overview" ? "page" : undefined}><BriefcaseBusiness size={22} aria-hidden="true" /><span>工作</span></a>
      <a className={isKnowledge ? "selected" : ""} href={href(projectId, "knowledge")} aria-current={isKnowledge ? "page" : undefined}><BookOpen size={22} aria-hidden="true" /><span>知识</span></a>
      <a className={route.section === "overview" ? "selected" : ""} href={href(projectId, "overview")} aria-current={route.section === "overview" ? "page" : undefined}><Home size={22} aria-hidden="true" /><span>总览</span></a>
      <span className="rail-footer">本机<br />试用</span>
    </nav>
    <aside className="project-sidebar" aria-label="项目导航">{sidebar}</aside>
    <div className="workspace-body">{import.meta.env.DEV && <div className="development-preview" role="status">{window.location.port === "5181" ? "开发测试预览 · 模拟数据 · 尚未发布" : "开发预览 · 连接现有数据 · 尚未发布"}</div>}<header className="workspace-header"><div className="workspace-heading">
      <Sheet open={open} onOpenChange={changeMenu}><SheetTrigger asChild><Button variant="ghost" size="icon" className="mobile-menu" aria-label="打开项目导航"><Menu size={19} /></Button></SheetTrigger><SheetContent side="left" className="mobile-navigation" onCloseAutoFocus={closeFocus}><SheetHeader><SheetTitle>项目导航</SheetTitle><SheetDescription>选择功能或 Session，查看当前工作。</SheetDescription></SheetHeader><nav aria-label="移动项目导航"><div className="mobile-modules">{link("work", "工作", BriefcaseBusiness)}{link("knowledge", "知识", BookOpen)}{link("overview", "总览", Home)}</div>{sidebar}</nav></SheetContent></Sheet>
      <button className="sidebar-toggle quiet" onClick={toggleSidebar} aria-label={collapsed ? "展开项目导航" : "收起项目导航"} aria-expanded={!collapsed}>{collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</button><span>工作台 <span className="breadcrumb-divider">/</span> <strong>{route.section === "runtime" && route.session ? "会话" : sectionNames[route.section]}</strong></span></div>
      <div className="workspace-account"><time className="workspace-date"><CalendarDays size={15} aria-hidden="true" />{workspaceDate}</time>{receiptCount > 0 && <a href={href(projectId, "operations")} className="receipt-link" aria-label={`待核对操作 ${receiptCount} 项`}><TriangleAlert size={16} aria-hidden="true" /><span>{receiptCount} 项待核对</span></a>}<Users size={16} aria-hidden="true" /><span className="actor-name" title={actor}>{actor}</span><button className="quiet" onClick={logout}>退出</button></div></header><main id="workspace-main" tabIndex={-1}>{children}</main></div>
  </div>;
}
