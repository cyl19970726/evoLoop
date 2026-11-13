// The task list in the inner rail and the table view: which tasks match the filters and in what order.
// Pure, so the rail, the table and the tests agree. The task list API only pages; every sort here works on the
// pages already loaded, and the list says so.
import type { Task } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { phaseOrder, phaseStatus, taskStateStatus } from "../../shared/taskStatus";
import { cognitionSummary, type WorkTaskStatus } from "../../shared/workStatusPresentation";
import { isMyCurrentWork, matchingProjection, type TaskListView, type TaskSort } from "./taskExperience";
import { taskTimestamp, taskTypeLabel } from "./taskWorkspacePresentation";

export const sortLabels: Record<TaskSort, string> = {
  default: "默认顺序", priority: "优先级", due: "截止时间", progress: "最近进展", created: "创建时间", phase: "对账阶段",
};
export const stateFilterLabels: Record<string, string> = {
  open: "未完成", all: "全部状态", todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消",
};
export const kindFilterLabels: Record<string, string> = { all: "全部类型", ...taskTypeLabel };

/** Search text of a task: its title, owner and id, plus the readable title of a judgement record. */
function searchText(task: Task, status: WorkTaskStatus | undefined): string {
  return `${task.title} ${task.owner} ${task.id} ${status?.cognition ? cognitionSummary(status).title : ""}`.toLowerCase();
}

/** Filters except the 我的承接 scope, which needs the assignment projections. */
export function matchesFilters(task: Task, view: Pick<TaskListView, "query" | "filter" | "kind">, status?: WorkTaskStatus): boolean {
  const state = view.filter === "all" || (view.filter === "open" ? task.state === "todo" || task.state === "in_progress" : task.state === view.filter);
  return state && (view.kind === "all" || task.kind === view.kind) && searchText(task, status).includes(view.query.toLowerCase());
}

/** 我的承接 is only the exact recipient of a current assignment; a Role or a released assignment is not. */
export function isMine(task: Task, projection: LeaderWorkTask | undefined, actorId: string): boolean {
  const current = matchingProjection(task, projection);
  return !!current && isMyCurrentWork(current, actorId);
}

const stateOrder: Record<Task["state"], number> = { in_progress: 0, todo: 1, done: 2, cancelled: 3 };
const time = (value: string | null | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
};

/** The value a sort orders by; null when the projection does not give it (those tasks go last, in list order). */
export function sortValue(task: Task, sort: TaskSort, projection: LeaderWorkTask | undefined): number | null {
  const item = matchingProjection(task, projection);
  switch (sort) {
    case "default": return stateOrder[task.state];
    case "priority": return item?.plan?.priority ?? null;
    case "due": return time(item?.plan?.dueAt);
    case "progress": { const value = time(item?.latestProgress?.changedAt); return value === null ? null : -value; }
    case "created": { const value = time(item?.timing?.createdAt ?? item?.dates.createdAt); return value === null ? null : -value; }
    case "phase": {
      if (task.state === "done" || task.state === "cancelled") return phaseOrder.length + stateOrder[task.state];
      const index = item ? phaseOrder.indexOf(item.phase) : -1;
      return index < 0 ? null : index;
    }
  }
}

/** Stable sort: equal values and missing values keep the order the server listed them in. */
export function sortTasks(tasks: readonly Task[], sort: TaskSort, projections: Record<string, LeaderWorkTask>): Task[] {
  return tasks.map((task, index) => ({ task, index, value: sortValue(task, sort, projections[task.id]) }))
    .sort((a, b) => a.value === null ? b.value === null ? a.index - b.index : 1 : b.value === null ? -1 : a.value - b.value || a.index - b.index)
    .map(entry => entry.task);
}

/** The short line under a row's title: the task state, and what the chosen sort orders by. */
export function rowMeta(task: Task, sort: TaskSort, projection: LeaderWorkTask | undefined): string {
  const item = matchingProjection(task, projection);
  const state = taskStateStatus[task.state].label;
  const open = task.state === "todo" || task.state === "in_progress";
  const key = (() => {
    switch (sort) {
      case "default": return "";
      case "priority": return !item ? "优先级未读回" : item.plan?.priority ? `P${item.plan.priority}` : "优先级未设";
      case "due": return !item ? "截止未读回" : item.plan?.dueAt ? `截止 ${taskTimestamp(item.plan.dueAt)}` : "截止未设";
      case "progress": return item?.latestProgress ? `进展 ${taskTimestamp(item.latestProgress.changedAt)}` : item ? "进展未记录" : "进展未读回";
      case "created": { const created = item?.timing?.createdAt ?? item?.dates.createdAt; return created ? `创建 ${taskTimestamp(created)}` : "创建时间未读回"; }
      case "phase": return !open ? "" : item ? `阶段 ${phaseStatus[item.phase].label}` : "阶段未读回";
    }
  })();
  return [state, key].filter(Boolean).join(" · ");
}

/** Whether a sort orders by projection facts (all of them except the default). */
export function sortUsesProjection(sort: TaskSort): boolean {
  return sort !== "default";
}
