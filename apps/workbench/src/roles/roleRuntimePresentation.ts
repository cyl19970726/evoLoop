import type { RoleRuntimeSkill, RoleRuntimeView, SkillReason, SkillSource } from "@evoloop/contracts/role-skills";
import type { RuntimeProvider } from "@evoloop/contracts/runtime";
import { option, reasonField, type Field } from "../workflow/ActionForm";

export const providerLabel: Record<RuntimeProvider, string> = { codex: "Codex", claude: "Claude" };
const sourceLabel: Record<SkillSource, string> = { evoloop: "业务", project: "项目", personal: "个人", builtin: "内置" };
const reasonLabel: Record<SkillReason, string> = { business: "业务必带", switch: "随来源开关", switch_off: "来源已关", added: "单独加入",
  removed: "单独移除", self_modifying: "会改运行时配置，默认关" };
const deliveryLabel: Record<RoleRuntimeSkill["delivery"], string> = { native: "运行时自行加载", role_context: "经角色上下文加载", none: "不加载" };
const reportedLabel: Record<RoleRuntimeView["skillsReportedBy"], string> = { "codex.list": "Codex 实时列出", "claude.init": "最近一次 Claude Turn 上报",
  files: "按文件推断，运行时尚未确认" };

export interface RoleRuntimePresentation {
  provider: string;
  binding: string;
  reportedBy: string;
  workDirectory: string;
  groups: { source: SkillSource; label: string; loaded: number; skills: { key: string; name: string; selected: boolean; detail: string;
    description: string | null; location: string | null }[] }[];
  loadedCount: number;
}

/** What the card shows, kept apart from rendering so it can be checked without a browser. */
export function presentRoleRuntime(view: RoleRuntimeView): RoleRuntimePresentation {
  const groups = (["evoloop", "project", "personal", "builtin"] as const).map(source => {
    const skills = view.skills.filter(skill => skill.source === source);
    return { source, label: sourceLabel[source], loaded: skills.filter(skill => skill.selected).length,
      skills: skills.map(skill => ({ key: `${skill.source}:${skill.name}`, name: skill.name, selected: skill.selected,
        detail: `${reasonLabel[skill.reason]} · ${deliveryLabel[skill.delivery]}`, description: skill.description, location: skill.location })) };
  }).filter(group => group.skills.length);
  return {
    provider: providerLabel[view.provider],
    binding: view.binding ? `已绑定 · 第 ${view.binding.revision} 次修订；运行时不可更换，模型可在会话配置中修改`
      : `未绑定：首个会话将使用默认的 ${providerLabel[view.provider]} 并就此绑定`,
    reportedBy: reportedLabel[view.skillsReportedBy],
    workDirectory: view.workDirectory ? `${view.workDirectory.cwd}（${view.workDirectory.source === "session" ? "最近会话" : "授权目录"}）` : "尚无会话或授权目录",
    groups,
    loadedCount: view.skills.filter(skill => skill.selected).length,
  };
}

const names = (value: string) => value === "none" ? [] : value.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean);
const onOff = (value: boolean) => value ? "on" : "off";
export function runtimeFields(view: RoleRuntimeView): Field[] {
  const toggle = (name: string, label: string, value: boolean): Field =>
    ({ name, label, kind: "select", value: onOff(value), options: [option("on", "加载"), option("off", "不加载")] });
  return [
    ...(view.binding ? [] : [{ name: "provider", label: "运行时（绑定后不可更换）", kind: "select" as const, value: view.provider,
      options: view.availableProviders.map(provider => option(provider, providerLabel[provider])) }]),
    toggle("project", "项目 skill（工作目录仓库的 .agents/skills、.claude/skills）", view.selection.project),
    toggle("personal", "个人 skill（~/.agents/skills、~/.claude/skills）", view.selection.personal),
    toggle("builtin", "运行时内置 skill", view.selection.builtin),
    { name: "add", label: "单独加入（名称或 来源:名称，逗号分隔）", value: view.selection.add.join(", "), optional: true },
    { name: "remove", label: "单独移除（名称或 来源:名称，逗号分隔）", value: view.selection.remove.join(", "), optional: true },
    reasonField,
  ];
}
export function runtimeCommand(view: RoleRuntimeView, values: Record<string, string>): Record<string, unknown> {
  return { type: "role.runtime.set", roleId: view.roleId, expectedRevision: view.binding?.revision ?? 0,
    provider: view.binding?.provider ?? values.provider ?? view.provider,
    skills: { project: values.project === "on", personal: values.personal === "on", builtin: values.builtin === "on",
      add: names(values.add ?? ""), remove: names(values.remove ?? "") }, reason: values.reason };
}
