import type { ObservedSession } from "@evoloop/contracts/session-observation";

export type SessionClass = "business" | "system" | "unclassified";

export const sessionClassLabel: Record<SessionClass, string> = {
  business: "业务智能体",
  system: "系统智能体",
  unclassified: "待归类",
};

/**
 * Classification follows observed formal Role classes only. A cross-class,
 * incomplete, or failed Role read remains unclassified and shows its reason.
 */
export function sessionClass(session: ObservedSession): SessionClass {
  const system = session.roles.filter(role => role.roleClass === "system");
  const business = session.roles.filter(role => role.roleClass === "business");
  const unknown = session.roles.filter(role => role.roleClass !== "system" && role.roleClass !== "business");
  if (system.length === 1 && business.length === 0 && unknown.length === 0) return "system";
  if (system.length === 0 && business.length >= 1 && unknown.length === 0) return "business";
  return "unclassified";
}

export function groupSessionsByClass(items: ObservedSession[]): Record<SessionClass, ObservedSession[]> {
  const groups: Record<SessionClass, ObservedSession[]> = { business: [], system: [], unclassified: [] };
  for (const item of items) groups[sessionClass(item)].push(item);
  return groups;
}

export function sessionClassReason(session: ObservedSession): string {
  if (sessionClass(session) !== "unclassified") return session.membershipReason;
  const system = session.roles.filter(role => role.roleClass === "system").length;
  const business = session.roles.filter(role => role.roleClass === "business").length;
  const unknown = session.roles.length - system - business;
  if (!session.roles.length) return "没有可核对的正式职责；保留原智能体，不按名称猜测分类。";
  if (unknown) return "有职责的类别还没核实；待职责档案确认后再归类。";
  if (system && business) return "同时关联系统职责与业务职责；跨类的智能体待明确主职责。";
  if (system > 1) return "关联多个系统职责；不把复合职责猜成单一的系统智能体。";
  return session.membershipReason;
}
