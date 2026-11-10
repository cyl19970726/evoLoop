// 等我使用的交付: every open task of the work index (GET /work-management/index, readable by every project member), read
// page by page as leaderWorkLoad.ts does, judged by inboxModel.ts. Loaded on demand by inboxReads.ts, so the work-index
// helpers stay out of the first screen.
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { api } from "../../shared/api";
import { appendLeaderWorkPage } from "../../shared/leaderWorkLoad";
import { deliveredAt, judgeMyDelivery, myLatestObservation, type DeliveryForMe } from "./inboxModel";

/** 1000 open tasks (20 pages of 50). Past that the list says it was not read to the end and the count is not claimed. */
const maxIndexPages = 20;

export interface DeliveriesForMe {
  items: DeliveryForMe[];
  /** Every open task was read: no page left, no repeated cursor, not marked partial. */
  complete: boolean;
  /** Open tasks read from the work index. */
  tasksRead: number;
}

async function readOpenTasks(projectId: string, signal?: AbortSignal): Promise<{ items: LeaderWorkTask[]; complete: boolean }> {
  const read = async (cursor?: string) => {
    const page = await api().leaderWork(projectId, "tasks", cursor, false, signal) as LeaderWorkPage<LeaderWorkTask>;
    if (!Array.isArray(page?.items)) throw new Error("工作索引响应不完整");
    return page;
  };
  // A write between two pages changes the snapshot; read again from the first page once.
  for (let attempt = 0; ; attempt++) {
    try {
      let page = await read();
      const cursors = new Set<string>();
      for (let pages = 1; page.nextCursor && !cursors.has(page.nextCursor) && pages < maxIndexPages; pages++) {
        signal?.throwIfAborted();
        cursors.add(page.nextCursor);
        page = appendLeaderWorkPage(page, await read(page.nextCursor));
      }
      return { items: page.items.filter(item => item.kind === "task"), complete: !page.nextCursor && page.partial !== true };
    } catch (cause) {
      if (attempt > 0 || !(cause instanceof Error) || !cause.message.includes("快照已变化")) throw cause;
    }
  }
}

/**
 * Open tasks whose current, passed delivery declares me as its consumer and that I have not recorded as 已使用 or
 * 使用失败 (that one goes back to rework). When someone else observed the delivery last, my own latest observation is
 * read from the task.
 */
export async function readDeliveriesForMe(projectId: string, actorId: string, signal?: AbortSignal): Promise<DeliveriesForMe> {
  const { items: tasks, complete } = await readOpenTasks(projectId, signal);
  const rows = await Promise.all(tasks.map(async (task): Promise<DeliveryForMe | null> => {
    const judgement = judgeMyDelivery(task, actorId);
    if (judgement.kind === "none" || judgement.kind === "used" || judgement.kind === "failed") return null;
    const delivery = task.delivery!;
    const row: DeliveryForMe = { taskId: task.taskId, title: task.title, deliveryId: delivery.deliveryId, taskRevisionId: delivery.taskRevisionId,
      deliveredAt: deliveredAt(task), useRequired: delivery.useRequired, last: null, othersObserved: false };
    if (judgement.kind === "waiting") return { ...row, last: judgement.last ? { result: judgement.last, at: null } : null };
    const detail: TaskDetail = await api().task(projectId, task.taskId);
    if (detail?.task?.projectId !== projectId || detail.task.id !== task.taskId || !Array.isArray(detail.observations))
      throw new Error("任务的使用观察响应与所选任务不符");
    const mine = myLatestObservation(detail.observations, delivery.deliveryId, actorId);
    if (mine?.result === "used" || mine?.result === "failed") return null;
    return { ...row, othersObserved: true, last: mine ? { result: "notUsed", at: mine.createdAt } : null,
      deliveredAt: row.deliveredAt ?? detail.deliveries?.find(item => item.id === delivery.deliveryId)?.createdAt ?? null };
  }));
  return { items: rows.filter((row): row is DeliveryForMe => row !== null), complete, tasksRead: tasks.length };
}
