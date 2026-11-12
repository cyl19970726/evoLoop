import type { RoleRuntimeSkill, RoleRuntimeView, SkillReason, SkillSource } from "@evoloop/contracts/role-skills";
import type { RuntimeProvider } from "@evoloop/contracts/runtime";
import { option, reasonField, type Field } from "../../shared/ActionForm";

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
    /** One sentence in Chinese on what the skill is for; null when its file gives no description. */
    purpose: string | null;
    /** The description as its SKILL.md writes it, when `purpose` does not repeat it (shown under 原文). */
    original: string | null;
    location: string | null }[] }[];
  loadedCount: number;
}

// A skill's description is written in its SKILL.md for agents, often in English. The card says in one Chinese
// sentence what the skill is for: the first sentence of a Chinese description, a known purpose for the project's own
// English-described skills, or that the description is in English. The full description stays under 原文.
const knownPurposes: Record<string, string> = {
  "evoloop-workflow": "用 evoLoop 业务命令行承接已授权的工作：固定依据、更新任务或文档、交付并收集使用反馈",
  "frontend-design": "新建或改造界面时的视觉设计指导：风格方向、字体与不落俗套的取舍",
  "web-design-guidelines": "按通用网页界面规范检查工作台的可访问性与交互",
};
export const englishDescription = "说明为英文，展开查看";
const chinese = /[㐀-鿿]/;

/** The work directory as the card says it: the path, or "已配置" when the reader may not see the machine's path; how many directories a Role's grants name. */
export function workDirectoryText(directory: RoleRuntimeView["workDirectory"]): string {
  if (!directory) return "尚无会话，也没有运行授权";
  const many = directory.source === "grant" && (directory.grantCount ?? 1) > 1 ? `共 ${directory.grantCount} 个授权目录，取第一个` : "";
  if (directory.cwd === null) return `已配置${many ? `（${many}）` : ""}；路径只对有复核权限或本人持有该角色运行授权的人显示`;
  return `${directory.cwd}（${directory.source === "session" ? "最近会话" : `授权目录${many ? `，${many}` : ""}`}）`;
}

export function skillPurpose(name: string, description: string | null): { purpose: string | null; original: string | null } {
  const text = description?.trim() ?? "";
  if (!text) return { purpose: null, original: null };
  if (chinese.test(text)) {
    const first = text.split(/(?<=[。；！？])/u)[0]!.trim().replace(/[。；！？]$/u, "");
    return { purpose: first, original: first === text.replace(/[。；！？]$/u, "") ? null : text };
  }
  return { purpose: knownPurposes[name] ?? englishDescription, original: text };
}

/** What the card shows, kept apart from rendering so it can be checked without a browser. */
export function presentRoleRuntime(view: RoleRuntimeView): RoleRuntimePresentation {
  const groups = (["evoloop", "project", "personal", "builtin"] as const).map(source => {
    const skills = view.skills.filter(skill => skill.source === source);
    return { source, label: sourceLabel[source], loaded: skills.filter(skill => skill.selected).length,
      skills: skills.map(skill => ({ key: `${skill.source}:${skill.name}`, name: skill.name, selected: skill.selected,
        detail: `${reasonLabel[skill.reason]} · ${deliveryLabel[skill.delivery]}`, ...skillPurpose(skill.name, skill.description), location: skill.location })) };
  }).filter(group => group.skills.length);
  return {
    provider: providerLabel[view.provider],
    binding: view.binding ? `已绑定 · 第 ${view.binding.revision} 次修订；运行时不可更换，模型可在会话配置中修改`
      : `未绑定：首个会话将使用默认的 ${providerLabel[view.provider]} 并就此绑定`,
    reportedBy: reportedLabel[view.skillsReportedBy],
    workDirectory: workDirectoryText(view.workDirectory),
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

/** The line shown under the saved form: it survives the form remount that follows a new revision. */
export function savedRuntimeNotice(saved: boolean, loading: boolean, view: RoleRuntimeView | null): string | null {
  if (!saved) return null;
  if (loading) return "已保存，正在读取新修订…";
  return view?.binding ? `已保存；回读到第 ${view.binding.revision} 次修订。` : null;
}
