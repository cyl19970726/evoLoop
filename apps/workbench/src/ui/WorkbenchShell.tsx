import { useState, type ReactNode } from "react";
import { BookOpen, BriefcaseBusiness, ChevronLeft, ChevronRight, CircleHelp, FileText, FolderOpen, Home, ListTodo, Menu, MessageSquare, CalendarDays, Users, Terminal, TriangleAlert, GitBranch, Target } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "../components/ui/sheet";
import { Button } from "../components/ui/button";
import { href, type Route, type Section } from "./shared";

export const sectionNames: Record<Section, string> = { overview: "总览", work: "任务", inbox: "待判断与复核", task: "任务详情", documents: "过程文档", document: "文档阅读", knowledge: "知识空间", journey: "目标与阶段", discussions: "负责人讨论", collaboration: "协作回执", runtime: "分工与会话", schedules: "日程", roles: "职责提案", repository: "仓库规范", operations: "待核对操作", evaluations: "评价与后果" };
const groups = [
  { title: "推进工作", links: [["inbox", CircleHelp], ["work", ListTodo], ["documents", FileText], ["journey", Target], ["evaluations", Target]] },
  { title: "协作辅助", links: [["discussions", MessageSquare], ["runtime", Terminal], ["schedules", CalendarDays], ["roles", Users], ["collaboration", GitBranch]] },
] as const;

export function WorkbenchShell({ route, projectTitle, actor, receiptCount, logout, children }: { route: Route; projectTitle: string; actor: string; receiptCount: number; logout(): void; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const projectId = route.projectId!;
  const current = route.section === "task" ? "work" : route.section === "document" ? "documents" : route.section;
  const isKnowledge = current === "knowledge";
  function link(section: Section, label: string, Icon: typeof Home) {
    return <a key={section} href={href(projectId, section)} className={current === section ? "selected" : ""} aria-current={current === section ? "page" : undefined} onClick={() => setOpen(false)}><Icon size={17} aria-hidden="true" /><span>{label}</span>{section === "operations" && receiptCount > 0 && <span className="nav-count">{receiptCount}</span>}</a>;
  }
  const navigation = <>
    <a className="project-switch" href="#/" onClick={() => setOpen(false)}><span className="project-monogram">E</span><span><small>当前项目</small><strong title={projectTitle}>{projectTitle || "读取项目…"}</strong></span><ChevronRight size={15} aria-hidden="true" /></a>
    {isKnowledge ? <div className="nav-group"><p>阅读与来源</p>{link("knowledge", "知识空间", BookOpen)}{link("documents", "过程文档", FileText)}{link("discussions", "负责人讨论", MessageSquare)}</div> : groups.map(group => <div className="nav-group" key={group.title}><p>{group.title}</p>{group.links.map(([section, Icon]) => link(section, sectionNames[section], Icon))}</div>)}
    <div className="nav-resources">{link("operations", "待核对操作", TriangleAlert)}{link("repository", "仓库规范", FolderOpen)}</div>
  </>;
  return <div className={`workbench-layout ${collapsed ? "sidebar-collapsed" : ""}`}>
    <a className="skip-link" href="#workspace-main" onClick={e => { e.preventDefault(); document.getElementById("workspace-main")?.focus(); }}>跳到内容</a>
    <nav className="module-rail" aria-label="主导航"><a className="rail-brand" href="#/" aria-label="evoLoop 项目选择">e<span>L</span></a>
      <a className={!isKnowledge && current !== "overview" ? "selected" : ""} href={href(projectId, "work")} aria-current={!isKnowledge && current !== "overview" ? "page" : undefined}><BriefcaseBusiness size={22} aria-hidden="true" /><span>工作</span></a>
      <a className={isKnowledge ? "selected" : ""} href={href(projectId, "knowledge")} aria-current={isKnowledge ? "page" : undefined}><BookOpen size={22} aria-hidden="true" /><span>知识</span></a>
      <a className={current === "overview" ? "selected" : ""} href={href(projectId, "overview")} aria-current={current === "overview" ? "page" : undefined}><Home size={22} aria-hidden="true" /><span>总览</span></a>
      <span className="rail-footer">本机<br />试用</span>
    </nav>
    <aside className="project-sidebar" aria-label="项目导航">{navigation}</aside>
    <div className="workspace-body">
      <header className="workspace-header"><div className="workspace-heading">
        <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild><Button variant="ghost" size="icon" className="mobile-menu" aria-label="打开项目导航"><Menu size={19} /></Button></SheetTrigger><SheetContent side="left" className="mobile-navigation"><SheetHeader><SheetTitle>项目导航</SheetTitle><SheetDescription>选择当前项目的工作、知识和协作入口。</SheetDescription></SheetHeader><nav aria-label="移动项目导航"><div className="mobile-modules">{link("work", "工作", BriefcaseBusiness)}{link("knowledge", "知识", BookOpen)}{link("overview", "总览", Home)}</div>{navigation}</nav></SheetContent></Sheet>
        <button className="sidebar-toggle quiet" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "展开项目导航" : "收起项目导航"} aria-expanded={!collapsed}>{collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}</button><span>工作台 <span className="breadcrumb-divider">/</span> <strong>{sectionNames[route.section]}</strong></span>
      </div><div className="workspace-account"><a href={href(projectId, "operations")} className="receipt-link" aria-label={`待核对操作 ${receiptCount} 项`}><TriangleAlert size={16} aria-hidden="true" /><span>{receiptCount ? `${receiptCount} 项待核对` : "操作回执"}</span></a><span className="actor-name" title={actor}>{actor}</span><button className="quiet" onClick={logout}>退出</button></div></header>
      <main id="workspace-main" tabIndex={-1}>{children}</main>
    </div>
  </div>;
}
