import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";

/** Follow the projection's current/closure-bound result, never an unrelated latest result. */
export function readOutcome(row: LeaderWorkTask, detail: TaskDetail) {
  if (detail.task.id !== row.taskId || detail.task.version !== row.version || detail.task.currentRevisionId !== row.currentRevisionId) return null;
  const delivery = detail.deliveries?.find(item => item.id === row.delivery?.deliveryId);
  if (!delivery || delivery.taskId !== detail.task.id || delivery.projectId !== detail.task.projectId) return null;
  // The service returns registration sequence order; wall-clock timestamps can tie
  // or describe an earlier use recorded later.
  const observation = (detail.observations ?? []).filter(item => item.deliveryId === delivery.id).at(-1);
  return observation ? { taskId: row.taskId, title: row.title, delivery, observation } : null;
}
export type ProjectOutcome = NonNullable<ReturnType<typeof readOutcome>>;
