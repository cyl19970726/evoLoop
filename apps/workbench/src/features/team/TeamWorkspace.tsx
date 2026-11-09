// 团队: the shell's 团队 navigation picks the view (分工与运行、职责、分工讨论、组织复盘). The app passes the section the
// page was opened for, so a page mounted late or kept hidden never takes another address's view. 职责 and 分工与运行
// fill the inner rail and the right column themselves; 分工讨论 is still the older component inside [data-legacy].
import { OrganizationReviewList } from "./OrganizationReviewList";
import type { MutationContext } from "../../shared/ActionForm";
import { DiscussionPanel } from "../discussions";
import { RolesView } from "../roles";
import { ExecutionView } from "../runtime";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { teamViewOf, type TeamSection } from "./teamPresentation";
// Still styles the discussion panel shown under 分工讨论.
import "./team-workspace.css";

const titles = {
  reviews: { label: "组织复盘", detail: "每轮复盘是一份完整文档。报告已保存不等于建议已采纳。" },
  discussions: { label: "分工讨论", detail: "分工提议、接受、转交与取代。具体智能体统一在“智能体”空间。" },
} as const;

export function TeamWorkspace({ context, refresh, section, sessionId }: { context: MutationContext; refresh: number; section: TeamSection; sessionId?: string }) {
  const view = teamViewOf(section);
  if (view === "roles") return <RolesView context={context} refresh={refresh} />;
  if (view === "execution") return <ExecutionView context={context} refresh={refresh} sessionId={sessionId} />;
  const current = titles[view];
  return <div data-ui="" className="team-workspace mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-5 compact:px-8 compact:py-7">
    <header className="min-w-0">
      <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>{current.label}</h1>
      <p className="mt-1 text-small text-text-secondary">{current.detail}</p>
    </header>
    {view === "reviews" ? <OrganizationReviewList context={context} refresh={refresh} />
      : <SectionBoundary label={current.label}><div data-legacy="" className="workbench-layout team-legacy">
        <DiscussionPanel context={context} refresh={refresh} />
      </div></SectionBoundary>}
  </div>;
}
