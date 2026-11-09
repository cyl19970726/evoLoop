// The workbench's single source of fake data. The component sample page uses it now; page screenshots (PR11) and
// page tests reuse it later. Everything is synthetic: names, times and ids are invented and never sent anywhere.
import type { StatusTone } from "@evoloop/ui";

export interface SampleAgent {
  id: string;
  roleId: string;
  name: string;
  role: string;
  state: string;
  tone: StatusTone;
  /** Fixed look for system agents (统筹, 复盘); business agents derive theirs from id and role. */
  system?: "leader" | "review";
}

export interface SampleTask {
  id: string;
  title: string;
  ownerId: string | null;
  state: string;
  tone: StatusTone;
  detail?: string;
  priority: "一" | "二" | "三";
  due: string;
  basis: string;
  updated: string;
}

export interface SampleInboxItem {
  id: string;
  kind: "回答" | "验收" | "批准";
  fromId: string;
  title: string;
  when: string;
}

const role = { dev: "role-dev", arch: "role-arch", verify: "role-verify", req: "role-req", design: "role-design" } as const;

export const sampleAgents: SampleAgent[] = [
  { id: "agent-dev-1", roleId: role.dev, name: "功能开发", role: "功能开发", state: "运行中", tone: "progress" },
  { id: "agent-verify-1", roleId: role.verify, name: "独立验收", role: "独立验收", state: "运行中", tone: "progress" },
  { id: "agent-req-1", roleId: role.req, name: "需求", role: "需求整理", state: "等你回答", tone: "waiting" },
  { id: "agent-design-1", roleId: role.design, name: "体验设计", role: "体验设计", state: "运行中", tone: "progress" },
  { id: "agent-arch-1", roleId: role.arch, name: "架构", role: "架构", state: "空闲", tone: "idle" },
  { id: "agent-dev-2", roleId: role.dev, name: "功能开发 · 二号", role: "功能开发", state: "休眠", tone: "history" },
  { id: "agent-leader", roleId: "role-leader", name: "统筹", role: "统筹", state: "空闲", tone: "idle", system: "leader" },
  { id: "agent-review", roleId: "role-review", name: "复盘", role: "复盘", state: "空闲", tone: "idle", system: "review" },
];

export const sampleTasks: SampleTask[] = [
  { id: "task-1", title: "右栏信息核对", ownerId: "agent-dev-1", state: "受阻", tone: "blocked", detail: "依据待复核", priority: "一", due: "11 月 12 日", basis: "对账规则 第 1 版", updated: "14:51" },
  { id: "task-2", title: "智能体返回入口", ownerId: "agent-dev-1", state: "待返工", tone: "blocked", priority: "一", due: "11 月 11 日", basis: "本轮需求总图", updated: "昨天" },
  { id: "task-3", title: "任务列表与筛选", ownerId: "agent-design-1", state: "进行中", tone: "progress", priority: "二", due: "11 月 13 日", basis: "本轮需求总图", updated: "6 分钟前" },
  { id: "task-4", title: "任务页截图说明", ownerId: "agent-dev-1", state: "待验收", tone: "waiting", priority: "二", due: "11 月 13 日", basis: "对账规则 第 2 版", updated: "11:20" },
  { id: "task-5", title: "交付与使用记录", ownerId: "agent-arch-1", state: "待办", tone: "idle", priority: "三", due: "11 月 14 日", basis: "对账规则 第 2 版", updated: "周日" },
  { id: "task-6", title: "智能体时间线缩进", ownerId: "agent-verify-1", state: "已完成", tone: "done", priority: "二", due: "11 月 8 日", basis: "本轮需求总图", updated: "昨天" },
];

export const sampleInbox: SampleInboxItem[] = [
  { id: "inbox-1", kind: "回答", fromId: "agent-req-1", title: "任务列表默认按什么排序？", when: "10 分钟前" },
  { id: "inbox-2", kind: "验收", fromId: "agent-dev-1", title: "任务页截图说明 · 第 1 版", when: "11:20" },
  { id: "inbox-3", kind: "批准", fromId: "agent-leader", title: "试用新职责：发布检查", when: "周日" },
];

export const samplePerson = { name: "Zuhriddin", role: "项目负责人" };

export function sampleAgent(id: string | null) {
  return sampleAgents.find(agent => agent.id === id) ?? null;
}
