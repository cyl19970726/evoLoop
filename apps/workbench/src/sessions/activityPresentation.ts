import type { SessionActivity } from "@evoloop/contracts/session-observation";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A related project record is context for this Session, not necessarily its action. */
export function activityPresentation(item: SessionActivity, projectId: string): { sourceLabel: string; discussionHref: string | null } {
  const source = item.source;
  const evidence = source.kind === "discussion" ? "讨论记录"
    : source.kind === "task" ? "关联任务记录"
      : source.evidence === "independent-use" ? "独立使用观察"
        : source.evidence === "session-statement" ? "会话陈述" : "项目记录";
  const sourceLabel = `${evidence} · 登记者 ${item.actorId?.trim() || "未记录"}`;
  const discussionHref = source.kind === "discussion" && uuid.test(source.id)
    ? `#/p/${encodeURIComponent(projectId)}/discussions?discussion=${encodeURIComponent(source.id)}` : null;
  return { sourceLabel, discussionHref };
}
