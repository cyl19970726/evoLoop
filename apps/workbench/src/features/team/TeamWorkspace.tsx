// 团队: the shell's 团队 navigation picks the view (职责、组织复盘、分工讨论、分工与运行); under 职责 the inner rail also
// lists the role directory. The center shows the chosen view. The role cards, discussions and runtime blocks are older components kept inside a
// [data-legacy] region until each is rebuilt.
import { useEffect, useRef, useState } from "react";
import { cn } from "@evoloop/ui";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { OrganizationReviewList } from "./OrganizationReviewList";
import { href } from "../../shared/ui/shared";
import type { MutationContext } from "../../shared/ActionForm";
import { RuntimePanel } from "../runtime";
import { DiscussionPanel } from "../discussions";
import { RolesPanel } from "../roles";
import { currentPath, onNavigate } from "../../shared/navigation";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { useProjectQuery } from "../../shared/query";
import { roleClient } from "../../shared/roleClient";
import { sectionOf, teamViewOf, roleGroups, roleStateLabel, type TeamView } from "./teamPresentation";

// The sections themselves are in the shell's 团队 navigation; this page adds the role directory under it.
const views: Array<{ key: TeamView; label: string; detail: string }> = [
  { key: "roles", label: "职责", detail: "持续职责、试行与承载它的智能体" },
  { key: "reviews", label: "组织复盘", detail: "每轮复盘是一份完整文档" },
  { key: "discussions", label: "分工讨论", detail: "分工提议、接受、转交与取代" },
  { key: "execution", label: "分工与运行", detail: "受管智能体的运行、队列与承接" },
];

const selectedRole = () => new URLSearchParams(currentPath().split("?")[1] ?? "").get("role");

export function TeamWorkspace({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [view, setView] = useState<TeamView>(() => teamViewOf(currentPath()));
  const [role, setRole] = useState<string | null>(selectedRole);
  // Each team address keeps its own mounted page; a page follows changes within its own section only, so a hidden
  // page does not switch to (and read for) the view another section is showing.
  const section = useRef(sectionOf(currentPath()));
  useEffect(() => onNavigate(() => {
    if (sectionOf(currentPath()) !== section.current) return;
    setView(teamViewOf(currentPath())); setRole(selectedRole());
  }), []);
  const roles = useProjectQuery(context.projectId, ["team", "roles", refresh], () => roleClient(context.token, context.projectId).list());
  const groups = roleGroups(roles.data?.items ?? []);
  const current = views.find(item => item.key === view)!;
  const roleLink = (item: RoleRecord) => `${href(context.projectId, "roles")}?role=${encodeURIComponent(item.id)}`;
  return <div data-ui="" className="team-workspace mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-5 compact:px-8 compact:py-7">
    <ContextRailContent>
      {view === "roles" && <nav aria-label="职责目录" className="flex flex-col gap-0.5 pt-1">
        {roles.isLoading && <span className="px-3 py-2 text-caption text-muted-foreground">正在读取职责…</span>}
        {roles.error && <span className="px-3 py-2 text-caption text-destructive">职责暂不可读，见右侧说明。</span>}
        {groups.map(group => <div key={group.key} className="flex flex-col gap-0.5">
          <span className="px-3 pb-1 pt-3 text-caption text-muted-foreground">{group.label} · {group.items.length}</span>
          {group.items.map(item => <a key={item.id} href={roleLink(item)} aria-current={role === item.id ? "page" : undefined}
            className={cn("flex flex-col rounded-lg px-3 py-1.5 outline-none focus-visible:shadow-[var(--focus-ring)]", role === item.id ? "bg-raised shadow-sm" : "hover:bg-selected")}>
            <span className="truncate text-small text-foreground">{item.proposal.title}</span>
            <span className="truncate text-caption text-muted-foreground">{roleStateLabel[item.state]}</span>
          </a>)}
        </div>)}
        {roles.data?.nextCursor && <span className="px-3 py-2 text-caption text-muted-foreground">只列出前 {roles.data.items.length} 项，其余在右侧继续加载。</span>}
      </nav>}
    </ContextRailContent>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>{current.label}</h1>
        <p className="mt-1 text-small text-text-secondary">{current.detail}。具体智能体统一在“智能体”空间。</p>
      </div>
    </header>
    {view === "reviews" ? <OrganizationReviewList context={context} refresh={refresh} />
      : view === "discussions" ? <SectionBoundary label={current.label}><DiscussionPanel context={context} refresh={refresh} /></SectionBoundary>
      : <SectionBoundary label={current.label}><div data-legacy="" className="workbench-layout team-legacy">
        {view === "roles" && <RolesPanel context={context} refresh={refresh} />}
        {view === "execution" && <RuntimePanel context={context} refresh={refresh} />}
      </div></SectionBoundary>}
  </div>;
}
