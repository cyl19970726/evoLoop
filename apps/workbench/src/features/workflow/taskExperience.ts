import type { Task, TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";

export function assignmentSessionKey(item: Pick<LeaderWorkTask, "assignment">): string | null {
  const assignment = item.assignment;
  return assignment && assignment.state !== "released"
    ? `${assignment.targetKind}:${assignment.targetId}` : null;
}

/** Responsibility is not assignment: a Role or an old/released assignment is never "mine". */
export function isMyCurrentWork(item: LeaderWorkTask, actorId: string): boolean {
  return !["done", "cancelled"].includes(item.taskState) && !!assignmentSessionKey(item) &&
    item.assignment!.recipientActorId === actorId;
}
export function isClosedTask(state: Task["state"]): boolean {
  return state === "done" || state === "cancelled";
}

/** Retained assignments on a closed Task are evidence of past responsibility. */
export function assignmentStatusLabel(item: Pick<LeaderWorkTask, "taskState" | "assignment">): string {
  const state = item.assignment?.state;
  if (isClosedTask(item.taskState)) {
    return state === "accepted" ? "历史承接 · 当时已接受" : state === "assigned"
      ? "历史分派 · 当时待接受" : state === "released" ? "历史分派已释放" : "暂无历史分派记录";
  }
  return state === "accepted" ? "已接受" : state === "assigned"
    ? "已分派，仍待接受（分派回执）" : "暂无有效分派";
}

/** Gate data during render, before the effect for a newly selected Task can run. */
export function matchingTaskDetail(detail: TaskDetail | null, projectId: string, taskId: string): TaskDetail | null {
  return detail?.task.projectId === projectId && detail.task.id === taskId ? detail : null;
}

export const runStateName: Record<string, string> = {
  requested: "等待启动", dispatching: "派发中", running: "运行中", unknown: "结果未知",
  completed: "已结束", failed: "失败", interrupted: "已中断",
};
export function executionSummary(item: LeaderWorkTask): string {
  if (isClosedTask(item.taskState)) {
    const closed = item.taskState === "done" ? "已完成" : "已取消";
    return item.latestRun ? `任务${closed} · 历史 Run：${runStateName[item.latestRun.state] ?? "状态未知"}`
      : `任务${closed} · 尚无可见历史 Run`;
  }
  if (item.latestRun) return `Run · ${runStateName[item.latestRun.state] ?? "状态未知"}`;
  if (item.assignment?.targetKind === "external" && item.assignment.state !== "released") return "外部运行状态未知";
  if (item.assignment?.state === "accepted") return "已接手，尚无当前 Run";
  if (item.assignment?.state === "assigned") return "待接受，尚无当前 Run";
  return "尚无当前 Run";
}
export function currentDelivery(detail: TaskDetail) {
  const closure = detail.task.state === "done" ? (detail.closures ?? [])
    .filter(item => item.taskRevisionId === detail.task.currentRevisionId).at(-1) : undefined;
  if (closure?.deliveryId) return detail.deliveries?.find(item => item.id === closure.deliveryId);
  return (detail.deliveries ?? []).filter(item => item.taskRevisionId === detail.task.currentRevisionId).at(-1);
}

/** The task list's view: filters, sort and (in the table view) the selected row. Kept in the address bar. */
export type TaskSort = "default" | "priority" | "due" | "progress" | "created" | "phase";
export const taskSorts: readonly TaskSort[] = ["default", "priority", "due", "progress", "created", "phase"];
export interface TaskListView { query: string; filter: string; kind: string; scope: string; selected: string; sort: TaskSort }
export const defaultTaskListView: TaskListView = { query: "", filter: "open", kind: "all", scope: "all", selected: "", sort: "default" };
export function taskListView(hash: string): TaskListView {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  const sort = query.get("sort");
  return { query: query.get("q") ?? "", filter: query.get("state") ?? "open",
    kind: query.get("kind") ?? "all", scope: query.get("scope") === "mine" ? "mine" : "all",
    selected: query.get("selected") ?? "", sort: taskSorts.includes(sort as TaskSort) ? sort as TaskSort : "default" };
}
/** Only values that differ from the defaults are written, so a plain list keeps a plain address. */
export function taskListParams(value: TaskListView): URLSearchParams {
  const query = new URLSearchParams();
  if (value.query) query.set("q", value.query);
  if (value.filter !== "open") query.set("state", value.filter);
  if (value.kind !== "all") query.set("kind", value.kind);
  if (value.scope !== "all") query.set("scope", value.scope);
  if (value.sort !== "default") query.set("sort", value.sort);
  if (value.selected) query.set("selected", value.selected);
  return query;
}
/** The table view (`/work`) with this view. */
export function taskListRoute(projectId: string, value: TaskListView): string {
  const query = taskListParams(value);
  return `/p/${projectId}/work${query.size ? `?${query}` : ""}`;
}
/** A task opened from the list carries the list's filters and sort (never the table's selected row). */
export function taskRoute(projectId: string, taskId: string, value: TaskListView): string {
  const query = taskListParams({ ...value, selected: "" });
  return `/p/${projectId}/tasks/${taskId}${query.size ? `?${query}` : ""}`;
}
export function matchingProjection(task: Pick<Task, "id" | "version" | "currentRevisionId">, item?: LeaderWorkTask) {
  return item?.taskId === task.id && item.version === task.version && item.currentRevisionId === task.currentRevisionId ? item : undefined;
}
