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
export const runStateName: Record<string, string> = {
  requested: "等待启动", dispatching: "派发中", running: "运行中", unknown: "结果未知",
  completed: "已结束", failed: "失败", interrupted: "已中断",
};
export function executionSummary(item: LeaderWorkTask): string {
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

export interface TaskListView { query: string; filter: string; kind: string; scope: string; selected: string }
export function taskListView(hash: string): TaskListView {
  const query = new URLSearchParams(hash.split("?")[1] ?? "");
  return { query: query.get("q") ?? "", filter: query.get("state") ?? "open",
    kind: query.get("kind") ?? "all", scope: query.get("scope") === "mine" ? "mine" : "all",
    selected: query.get("selected") ?? "" };
}
export function taskListRoute(projectId: string, value: TaskListView): string {
  const query = new URLSearchParams();
  if (value.query) query.set("q", value.query);
  if (value.filter !== "open") query.set("state", value.filter);
  if (value.kind !== "all") query.set("kind", value.kind);
  if (value.scope !== "all") query.set("scope", value.scope);
  if (value.selected) query.set("selected", value.selected);
  return `#/p/${projectId}/work${query.size ? `?${query}` : ""}`;
}
export function matchingProjection(task: Pick<Task, "id" | "version" | "currentRevisionId">, item?: LeaderWorkTask) {
  return item?.taskId === task.id && item.version === task.version && item.currentRevisionId === task.currentRevisionId ? item : undefined;
}
