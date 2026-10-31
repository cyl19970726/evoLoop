import { useEffect, useState } from "react";
import { OrganizationReviewList } from "../documents/OrganizationReviewList";
import { href } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";
import { RuntimePanel } from "../runtime/RuntimePanel";
import { DiscussionPanel } from "../discussions/DiscussionPanel";
import { RolesPanel } from "./RolesPanel";
import "./team-workspace.css";

type TeamTab = "reviews" | "roles" | "execution" | "discussions";

function requestedTab(): TeamTab {
  if (window.location.hash.split("?")[0].endsWith("/reviews")) return "reviews";
  if (window.location.hash.split("?")[0].endsWith("/discussions")) return "discussions";
  const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("view");
  return value === "execution" || value === "discussions" ? value : "roles";
}

export function TeamWorkspace({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [tab, setTab] = useState<TeamTab>(requestedTab);
  useEffect(() => {
    const onHash = () => setTab(requestedTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const changeTab = (value: TeamTab) => {
    setTab(value);
    window.location.hash = value === "reviews" ? href(context.projectId, "reviews")
      : value === "discussions" ? href(context.projectId, "discussions")
        : `${href(context.projectId, "runtime")}?view=${value}`;
  };
  return <div className="content team-workspace">
    <div className="page-title-row"><div><h1>团队分工</h1><p className="lede">管理持续职责、组织复盘、分工讨论和受管执行。具体 Agent 的完整目录统一在 Sessions。</p></div><div className="team-entry-actions"><a className="button-link" href={href(context.projectId, "sessions")}>打开 Sessions</a><a className="button-link" href={href(context.projectId, "collaboration")}>协作回执</a></div></div>
    <nav className="team-tabs" aria-label="团队分工栏目">
      {([["roles", "职责档案"], ["reviews", "组织复盘"], ["discussions", "分工讨论"], ["execution", "受管执行"]] as const).map(([key, label]) =>
        <button key={key} type="button" className={tab === key ? "selected" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => changeTab(key)}>{label}</button>)}
    </nav>
    {tab === "reviews" && <OrganizationReviewList context={context} refresh={refresh} />}
    {tab === "roles" && <RolesPanel context={context} refresh={refresh} />}
    {tab === "execution" && <RuntimePanel context={context} refresh={refresh} />}
    {tab === "discussions" && <DiscussionPanel context={context} refresh={refresh} />}
  </div>;
}
