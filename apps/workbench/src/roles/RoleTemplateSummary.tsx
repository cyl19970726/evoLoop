import { useEffect, useState } from "react";
import { initialRoleTemplates } from "@evoloop/contracts/roles";
import { errorText, request } from "../api";

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
const shortId = (id: string) => id.slice(0, 8);
const category = (value: "system" | "business") => value === "system" ? "系统职责" : "业务职责";

/** A link is offered only for a Role whose project, ID and template mapping were checked. */
export function roleTemplateHref(projectId: string, roleId: string): string | null {
  return uuid.test(projectId) && uuid.test(roleId)
    ? `#/p/${encodeURIComponent(projectId)}/roles?role=${encodeURIComponent(roleId)}` : null;
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

export function RoleTemplateSummary({ token, projectId, refresh }: { token: string; projectId: string; refresh: number }) {
  const [manualRefresh, setManualRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<{ token: string; projectId: string; value: TemplateSummary; observedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ token: string; projectId: string; message: string } | null>(null);
  const current = snapshot?.token === token && snapshot.projectId === projectId ? snapshot : null;
  const currentError = error?.token === token && error.projectId === projectId ? error.message : "";
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    request<unknown>(token, `/api/projects/${encodeURIComponent(projectId)}/role-templates`, 15000, { signal: controller.signal })
      .then(value => parseRoleTemplateSummary(value, projectId))
      .then(value => { if (active) setSnapshot({ token, projectId, value, observedAt: new Date().toLocaleString() }); })
      .catch(cause => { if (active) setError({ token, projectId, message: errorText(cause) }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [token, projectId, refresh, manualRefresh]);

  return <section className="panel role-template-summary" aria-label="基础职责状态">
    <div className="section-title"><h2>基础职责</h2><button type="button" onClick={() => setManualRefresh(value => value + 1)} disabled={loading}>回读当前状态</button></div>
    <p>初始组合只作参考；试行中的正式职责才算已建立。承载和执行权限需另核。</p>
    {(loading || !current && !currentError) && <p role="status">正在读取基础职责…{current ? "下列仍是上次观察。" : ""}</p>}
    {currentError && <p role="alert">基础职责读取失败：{currentError}{current ? "；保留上次观察，不能视为当前状态。" : "；尚无可信状态。"}</p>}
    {current && <>
      <p className="muted">{currentError || loading ? "上次观察于" : "观察于"} {current.observedAt}；{current.value.nextCursor ? "Role 列表尚有未读页，缺项显示未知。" : "已读本次模板投影。"}</p>
      <ul className="role-template-list">
        {current.value.rows.map(row => <li key={row.key}>
          <strong>{row.title}</strong> <span>· {category(row.roleClass)} · {row.state === "established" ? "已建立" : row.state === "not-established" ? "未建立" : "未知"}</span>
          {row.roles.map(role => <span key={role.id}> · <a href={roleTemplateHref(projectId, role.id)!}>{role.title}（{shortId(role.id)}）</a></span>)}
          {row.unresolvedIds.map(id => <span key={id}> · <code>{id}</code>（关联职责不可核）</span>)}
        </li>)}
      </ul>
    </>}
  </section>;
}
