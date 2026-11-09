import { useEffect, useState } from "react";
import type { RoleRuntimeView } from "@evoloop/contracts/role-skills";
import { errorText } from "../api";
import { ActionForm, Notice, type MutationContext } from "../workflow/ActionForm";
import { roleClient } from "./client";
import { presentRoleRuntime, runtimeCommand, runtimeFields } from "./roleRuntimePresentation";
import "./presence.css";

export function RoleRuntimeCard({ context, roleId, refresh }: { context: MutationContext; roleId: string; refresh: number }) {
  const [view, setView] = useState<RoleRuntimeView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    roleClient(context.token, context.projectId).runtime(roleId)
      .then(value => { if (active && value.projectId === context.projectId && value.roleId === roleId) setView(value); })
      .catch(cause => { if (active) { setView(null); setError(errorText(cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, roleId, refresh, tick]);
  const shown = view ? presentRoleRuntime(view) : null;
  return <section className="role-runtime" aria-label="运行时与 skill">
    <div className="panel-head"><h3>运行时与 skill</h3><button type="button" onClick={() => setTick(value => value + 1)} disabled={loading}>{loading ? "读取中…" : "重新读取"}</button></div>
    {saved && !error && (loading ? <Notice>已保存，正在读取新修订…</Notice>
      : view?.binding && <Notice>已保存；回读到第 {view.binding.revision} 次修订。</Notice>)}
    {error && <Notice error>运行时与 skill 暂不可读：{error}</Notice>}
    {view && shown && <>
      <dl>
        <div><dt>运行时</dt><dd><strong>{shown.provider}</strong> · {shown.binding}</dd></div>
        <div><dt>工作目录</dt><dd className="break-anywhere">{shown.workDirectory}</dd></div>
        <div><dt>skill 来源</dt><dd>{shown.reportedBy} · 加载 {shown.loadedCount} 个 · {new Date(view.observedAtUtc).toLocaleString()}</dd></div>
      </dl>
      {!view.providerAvailable && <Notice error>此协调器当前未驱动 {shown.provider}；该角色暂不能新建会话。</Notice>}
      {shown.groups.length === 0 && <p className="empty">没有找到 skill。</p>}
      {shown.groups.map(group => <details key={group.source} className="workflow-detail" open={group.source === "evoloop"}>
        <summary>{group.label} skill <span className="pill subtle">加载 {group.loaded} / {group.skills.length}</span></summary>
        <ul className="role-runtime-skills">{group.skills.map(skill => <li key={skill.key} className={skill.selected ? "" : "muted"}>
          <strong>{skill.name}</strong> <span className={skill.selected ? "pill" : "pill subtle"}>{skill.selected ? "加载" : "不加载"}</span>
          <small> {skill.detail}</small>
          {skill.description && <p>{skill.description}</p>}
          {skill.location && <small className="break-anywhere">{skill.location}</small>}
        </li>)}</ul>
      </details>)}
      {view.missing.length > 0 && <Notice error>单独加入但未找到：{view.missing.join("、")}；该角色运行时不会有它们。</Notice>}
      {(view.plugins.length > 0 || view.mcpServers.length > 0) && <p>插件：{view.plugins.map(item => `${item.name}${item.enabled ? "" : "（停用）"}`).join("、") || "无"}；
        MCP：{view.mcpServers.map(item => item.name).join("、") || "无"}</p>}
      {view.notes.map(note => <Notice key={note}>{note}</Notice>)}
      <details className="workflow-detail"><summary>{view.binding ? "调整 skill" : "绑定运行时并选择 skill"}</summary>
        <p>选择决定运行时把哪些 skill 放进模型上下文，不是安全边界；保存后下一个 Turn 生效。</p>
        <ActionForm key={`${view.binding?.revision ?? 0}`} context={context} review title={view.binding ? "调整角色 skill" : "绑定角色运行时"}
          fields={runtimeFields(view)} build={values => runtimeCommand(view, values)}
          onApplied={() => setSaved(true)} />
      </details>
    </>}
  </section>;
}
