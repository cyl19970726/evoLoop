import type { Task, TaskKind } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { leaderPhaseLabel } from "./leaderWorkLoad";

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
};

export function taskType(kind: TaskKind | null | undefined): string {
  return kind ? taskTypeLabel[kind] : "未分类";
}

/** Use the stage goal when available, otherwise the first real line of the Task body. */
export function taskGoal(item: LeaderWorkTask | null | undefined, task: Pick<Task, "content">): string {
  const goal = item?.goal?.outcome?.trim();
  if (goal) return goal;
  const line = task.content.split("\n").map(value => value.trim()).find(value => value && !/^#{1,6}\s/.test(value));
  if (!line) return "目标见任务正文";
  const plain = line.replace(/^[-*>]\s+/, "").replace(/[*_`]/g, "");
  const firstSentence = plain.match(/^.*?[。！？!?](?:\s|$)/)?.[0]?.trim() ?? plain;
  const summary = firstSentence.length >= 24 ? firstSentence : plain;
  return summary.length > 220 ? `${summary.slice(0, 220)}…` : summary;
}

export function currentProgressLabel(item: LeaderWorkTask | null | undefined, fallback: Task["state"]): string {
  if (item) return leaderPhaseLabel[item.phase];
  return ({ todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" } as const)[fallback];
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
    name: item.latestProgress.eventName,
    time: taskTimestamp(item.latestProgress.changedAt),
    fullTime: item.latestProgress.changedAt,
    source: `事件 ${item.latestProgress.entityKind}`,
    unavailable: false,
    missing: false,
  };
}
