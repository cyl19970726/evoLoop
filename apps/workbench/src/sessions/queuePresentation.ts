import type { QueueEntryState } from "@evoloop/contracts/queues";

const queueStateLabels: Record<QueueEntryState, string> = {
  queued: "待处理",
  held: "已暂停",
  claimed: "已领取（占用中）",
  released: "已放行",
};

export function queuePosition(position: number): number { return position + 1; }
export function queueStateLabel(state: string): string {
  return Object.hasOwn(queueStateLabels, state) ? queueStateLabels[state as QueueEntryState] : `状态待核对（${state}）`;
}
