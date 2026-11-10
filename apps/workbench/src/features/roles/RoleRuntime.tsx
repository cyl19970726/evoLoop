// 运行时与 skill (right column): the runtime the Role is bound to, where the skill list came from and what loads.
// Saving rereads the Role's runtime in place; the selected Role and this section stay as they are (#225).
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { RoleRuntimeView } from "@evoloop/contracts/role-skills";
import { Badge, Button, Notice, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { roleClient } from "../../shared/roleClient";
import { FactList, PanelSection, mutedText } from "../../shared/ui/PageParts";
import { presentRoleRuntime, runtimeCommand, runtimeFields, savedRuntimeNotice } from "./roleRuntimePresentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";

export function RoleRuntime({ context, roleId }: { context: MutationContext; roleId: string }) {
  const read = useProjectQuery(context.projectId, ["roles", roleId, "runtime"], async () => {
    const value = await roleClient("", context.projectId).runtime(roleId);
    if (value.projectId !== context.projectId || value.roleId !== roleId) throw new Error("运行时响应与当前职责不符");
    return value;
  });
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const view: RoleRuntimeView | undefined = read.data;
  const error = read.error ? errorText(read.error) : "";
  const notice = savedRuntimeNotice(saved, read.isFetching, view ?? null);
  const shown = view ? presentRoleRuntime(view) : null;
  return <PanelSection title="运行时与 skill" action={<Button size="compact" variant="ghost" disabled={read.isFetching} onClick={() => void read.refetch()}>
    <RefreshCw aria-hidden="true" className={read.isFetching ? "animate-spin" : undefined} />{read.isFetching ? "读取中…" : "重新读取"}</Button>}>
    {read.isPending && <p className={mutedText} role="status">正在读取运行时与 skill…</p>}
    {!error && notice && <p role="status" className="text-small text-text-secondary">{notice}</p>}
    {error && <Notice tone="error" title="运行时与 skill 暂不可读">{error}{view ? "；下面是上次读回，当前待核对。" : ""}<ErrorDetails error={read.error} /></Notice>}
    {view && shown && <>
      <FactList rows={[
        ["运行时", `${shown.provider} · ${shown.binding}`],
        ["工作目录", shown.workDirectory],
        ["skill 来源", `${shown.reportedBy} · 加载 ${shown.loadedCount} 个 · ${new Date(view.observedAtUtc).toLocaleString("zh-CN", { hour12: false })}`],
      ]} />
      {!view.providerAvailable && <Notice tone="error">此协调器当前未驱动 {shown.provider}；这项职责暂不能新建智能体。</Notice>}
      {shown.groups.length === 0 && <p className="text-small text-text-secondary">没有找到 skill。</p>}
      {shown.groups.map(group => <details key={group.source} open={group.source === "evoloop"} className="min-w-0">
        <summary className="flex cursor-pointer items-center gap-2 text-small font-medium text-foreground">{group.label} skill <Badge>加载 {group.loaded} / {group.skills.length}</Badge></summary>
        <ul className="mt-1 flex flex-col">{group.skills.map(skill => <li key={skill.key} className="flex min-w-0 flex-col gap-0.5 border-t border-border py-2 first:border-t-0">
          <span className={cn("flex flex-wrap items-center gap-2 text-small", skill.selected ? "text-foreground" : "text-muted-foreground")}>
            <strong className="font-medium">{skill.name}</strong>{skill.selected ? <Badge>加载</Badge> : <span className={mutedText}>不加载</span>}</span>
          <span className={mutedText}>{skill.detail}</span>
          {skill.purpose && <span className="text-caption text-text-secondary">{skill.purpose}</span>}
          <FullIdentifiers summary="原文与位置" rows={[{ label: "说明原文", value: skill.original, text: true }, { label: "文件位置", value: skill.location }]} />
        </li>)}</ul>
      </details>)}
      {view.missing.length > 0 && <Notice tone="error">单独加入但未找到：{view.missing.join("、")}；这项职责的运行时不会有它们。</Notice>}
      {(view.plugins.length > 0 || view.mcpServers.length > 0) && <p className="text-small text-text-secondary">插件：{view.plugins.map(item => `${item.name}${item.enabled ? "" : "（停用）"}`).join("、") || "无"}；
        MCP：{view.mcpServers.map(item => item.name).join("、") || "无"}</p>}
      {view.notes.map(note => <Notice key={note}>{note}</Notice>)}
      <Button size="compact" className="w-fit" aria-expanded={editing} onClick={() => setEditing(value => !value)}>
        {view.binding ? "调整 skill" : "绑定运行时并选择 skill"}</Button>
      {editing && <div role="region" aria-label={view.binding ? "调整 skill" : "绑定运行时并选择 skill"} className="flex flex-col gap-2">
        <p className={mutedText}>选择决定运行时把哪些 skill 放进模型上下文，不是安全边界；保存后下一轮生效。</p>
        <ActionForm key={`${view.binding?.revision ?? 0}`} context={{ ...context, draftScope: `role-runtime:${roleId}`, draftBaseline: `${view.binding?.revision ?? 0}` }}
          review embedded title={view.binding ? "调整职责 skill" : "绑定职责运行时"}
          fields={runtimeFields(view)} build={values => runtimeCommand(view, values)} onApplied={() => setSaved(true)} />
      </div>}
    </>}
  </PanelSection>;
}
