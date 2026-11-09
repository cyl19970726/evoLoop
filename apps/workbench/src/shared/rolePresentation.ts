// A role's lifecycle state in words. The team space and the role cards still keep their own copies of this map
// (features/team/teamPresentation.ts, features/roles/RolesPanel.tsx); they move here when those pages are rewritten.
import type { RoleRecord } from "@evoloop/contracts/roles";

export const roleStateLabel: Record<RoleRecord["state"], string> = {
  candidate: "待判断", trial: "试行中", active: "持续职责", "retirement-pending": "待交接关闭",
  retired: "已撤回", rejected: "未采纳", deferred: "待重看",
};

/** The state's label; a state this page does not know yet is not shown as its code. */
export function roleStateText(state: string): string {
  return roleStateLabel[state as RoleRecord["state"]] ?? "状态待核对";
}

/** Only an established or trial role takes work in the normal way. */
export function roleTakesWork(state: string): boolean {
  return state === "active" || state === "trial";
}
