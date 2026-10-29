import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { WorkTaskStatus } from "../workflow/workStatusPresentation";

const phaseOrder = ["unknown", "rework", "blocked", "awaiting_delivery", "awaiting_acceptance", "awaiting_assignment", "unassigned", "ready", "running"];
export function selectAttention(rows: LeaderWorkTask[], statuses: Record<string, WorkTaskStatus>): LeaderWorkTask | null {
  return rows.filter(row => !["done", "cancelled"].includes(row.taskState) && statuses[row.taskId]?.cognition === false)
    .sort((a, b) => Number(a.review?.decision === "deferred") - Number(b.review?.decision === "deferred") ||
      (a.plan?.priority ?? 5) - (b.plan?.priority ?? 5) || phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase))[0] ?? null;
}

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
