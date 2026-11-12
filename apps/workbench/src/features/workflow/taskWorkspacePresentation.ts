import type { Task, TaskKind } from "@evoloop/contracts";
import type { LeaderWorkChange, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { leaderPhaseLabel } from "../../shared/leaderWorkLoad";

const timestampFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export function taskTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : timestampFormat.format(parsed);
}

export const taskTypeLabel: Record<TaskKind, string> = {
  implementation: "实施",
  research: "调研",
  validation: "验证",
  defect: "缺陷",
  documentation: "文档",
  operation: "运维与配置",
};

export function taskType(kind: TaskKind | null | undefined): string {
  return kind ? taskTypeLabel[kind] : "未分类";
}

/**
 * The goal line of a Task: the stage goal when the work index has one (an explicit field), otherwise nothing. The body is shown
 * in full right below, so quoting its first paragraph as a "goal" only said the same thing twice (and lost its code styling).
 */
export function taskGoal(item: LeaderWorkTask | null | undefined): string | null {
  return item?.goal?.outcome?.trim() || null;
}

export function currentProgressLabel(item: LeaderWorkTask | null | undefined, fallback: Task["state"]): string {
  if (item) return leaderPhaseLabel[item.phase];
  return ({ todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" } as const)[fallback];
}

/** What kind of record the latest progress came from, in words (the service's own wording per kind). */
const progressKindLabel: Record<LeaderWorkChange["entityKind"], string> = {
  task: "任务内容或状态更新", document: "关联文档事件更新", assignment: "分派或接手更新", delivery: "交付已登记",
  observation: "使用观察已登记", closure: "任务已关闭", run: "运行状态已更新", submission: "作者已提交封存意图",
  impact: "依据影响已更新", queue: "队列状态已更新", plan: "工作计划已更新", dependency: "任务依赖已更新", review: "负责人核对已记录",
};

/**
 * The latest progress event as a reader says it. The service names it in Chinese; a name that is not (an internal
 * event name such as task.revised) is replaced by the wording for its record kind and never shown raw.
 */
export function progressEventName(progress: Pick<NonNullable<LeaderWorkTask["latestProgress"]>, "eventName" | "entityKind">): string {
  const name = progress.eventName?.trim();
  if (name && /[㐀-鿿]/.test(name)) return name;
  return progressKindLabel[progress.entityKind] ?? "业务事件已更新";
}

export type LatestProgressPresentation = {
  name: string;
  time: string;
  fullTime: string;
  source: string;
  unavailable: boolean;
  missing: boolean;
};

export function latestProgressPresentation(item: LeaderWorkTask | null | undefined): LatestProgressPresentation {
  if (!item) return {
    name: "最近进展尚未读回", time: "", fullTime: "", source: "",
    unavailable: true, missing: false,
  };
  if (!item.latestProgress) return {
    name: "未记录", time: "", fullTime: "", source: "没有可归属的真实业务事件",
    unavailable: false, missing: true,
  };
  return {
    name: progressEventName(item.latestProgress),
    time: taskTimestamp(item.latestProgress.changedAt),
    fullTime: item.latestProgress.changedAt,
    source: progressKindLabel[item.latestProgress.entityKind] ?? "业务事件",
    unavailable: false,
    missing: false,
  };
}
