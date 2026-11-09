// Pure helpers for the team space: which view an address shows, and how the role directory is grouped.
import type { RoleRecord } from "@evoloop/contracts/roles";

export type TeamView = "roles" | "reviews" | "discussions" | "execution";

/** `/roles`, `/reviews` and `/discussions` are their own addresses; `/runtime` is 分工与运行. */
export function teamViewOf(path: string): TeamView {
  const [pathname, query = ""] = path.split("?");
  if (pathname!.endsWith("/reviews")) return "reviews";
  if (pathname!.endsWith("/discussions")) return "discussions";
  if (pathname!.endsWith("/roles")) return "roles";
  // `/runtime` is 分工与运行 in the shell; older links still pick a view with ?view=.
  const view = new URLSearchParams(query).get("view");
  return view === "roles" || view === "discussions" ? view : "execution";
}

/** The section segment of a project address: `/p/{project}/{section}/…`. */
export function sectionOf(path: string): string {
  return path.split("?")[0]!.split("/")[3] ?? "";
}

export const roleStateLabel: Record<RoleRecord["state"], string> = {
  candidate: "待判断", trial: "试行中", active: "持续职责", "retirement-pending": "待交接关闭",
  retired: "已撤回", rejected: "未采纳", deferred: "待重看",
};

const live = new Set<RoleRecord["state"]>(["active", "trial", "retirement-pending"]);
const order: Record<RoleRecord["state"], number> = { active: 0, trial: 1, "retirement-pending": 2, candidate: 3, deferred: 4, rejected: 5, retired: 6 };

export interface RoleGroup { key: "business" | "system" | "other"; label: string; items: RoleRecord[] }

/** Business and system roles that are established or on trial, then everything else (proposals, closed ones). */
export function roleGroups(roles: readonly RoleRecord[]): RoleGroup[] {
  const sorted = [...roles].sort((a, b) => order[a.state] - order[b.state] || a.proposal.title.localeCompare(b.proposal.title, "zh-CN"));
  const groups: RoleGroup[] = [
    { key: "business", label: "业务职责", items: sorted.filter(role => live.has(role.state) && role.proposal.roleClass !== "system") },
    { key: "system", label: "系统职责", items: sorted.filter(role => live.has(role.state) && role.proposal.roleClass === "system") },
    { key: "other", label: "提议与已关闭", items: sorted.filter(role => !live.has(role.state)) },
  ];
  return groups.filter(group => group.items.length > 0);
}
