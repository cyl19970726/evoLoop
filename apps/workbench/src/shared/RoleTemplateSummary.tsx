// Parsing the Role template summary (which of the initial Role templates a project has established); the roles page
// renders it.
import { initialRoleTemplates } from "@evoloop/contracts/roles";

type TemplateKey = (typeof initialRoleTemplates)[number]["key"];
type TemplateState = "established" | "not-established" | "unknown";
type SummaryRole = { id: string; title: string };
export type TemplateRow = {
  key: TemplateKey; title: string; roleClass: "system" | "business";
  state: TemplateState; roleIds: string[]; roles: SummaryRole[]; unresolvedIds: string[];
};
export type TemplateSummary = { rows: TemplateRow[]; nextCursor: string | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A link is offered only for a Role whose project, ID and template mapping were checked. */
export function roleTemplateHref(projectId: string, roleId: string): string | null {
  return uuid.test(projectId) && uuid.test(roleId)
    ? `/p/${encodeURIComponent(projectId)}/roles?role=${encodeURIComponent(roleId)}` : null;
}

/** Validate the single server projection; never infer seven established Roles from the catalog. */
export function parseRoleTemplateSummary(value: unknown, projectId: string): TemplateSummary {
  if (!record(value) || !Array.isArray(value.templates) || !Array.isArray(value.roles) ||
      !(value.nextCursor === null || typeof value.nextCursor === "string" && uuid.test(value.nextCursor)))
    throw new Error("基础职责响应不完整");
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of value.templates) {
    if (!record(item) || typeof item.key !== "string" || byKey.has(item.key)) throw new Error("基础职责模板重复或无效");
    byKey.set(item.key, item);
  }
  if (byKey.size !== initialRoleTemplates.length) throw new Error("基础职责模板数量与合同不符");
  const validRoles = new Map<string, Record<string, unknown>>();
  const duplicateRoles = new Set<string>();
  for (const item of value.roles) {
    if (!record(item) || typeof item.id !== "string" || !uuid.test(item.id)) continue;
    if (validRoles.has(item.id)) duplicateRoles.add(item.id);
    validRoles.set(item.id, item);
  }
  const rows = initialRoleTemplates.map(template => {
    const item = byKey.get(template.key);
    if (!item || item.title !== template.title || item.roleClass !== template.roleClass ||
        !["established", "not-established", "unknown"].includes(String(item.state)) ||
        !Array.isArray(item.roleIds) || item.roleIds.some(id => typeof id !== "string" || !uuid.test(id)) ||
        new Set(item.roleIds).size !== item.roleIds.length)
      throw new Error("基础职责模板与合同不符");
    const roleIds = item.roleIds as string[];
    if (item.state === "established" && roleIds.length === 0 || item.state === "not-established" && roleIds.length > 0)
      throw new Error("基础职责状态与关联不符");
    const roles: SummaryRole[] = [], unresolvedIds: string[] = [];
    for (const id of roleIds) {
      const role = validRoles.get(id);
      const proposal = record(role?.proposal) ? role.proposal : null;
      if (!role || duplicateRoles.has(id) || role.projectId !== projectId || role.id !== id ||
          !proposal || typeof proposal.title !== "string" || !proposal.title.trim() ||
          proposal.roleClass !== template.roleClass || proposal.templateKey !== template.key ||
          role.state !== "trial" && role.state !== "active") unresolvedIds.push(id);
      else roles.push({ id, title: proposal.title.trim() });
    }
    // A partial Role listing cannot establish absence, even if the response says otherwise.
    const state: TemplateState = (item.state === "not-established" && value.nextCursor !== null) ||
      (item.state === "established" && roles.length === 0) ? "unknown" : item.state as TemplateState;
    return { key: template.key, title: template.title, roleClass: template.roleClass, state, roleIds, roles, unresolvedIds };
  });
  return { rows, nextCursor: value.nextCursor };
}
