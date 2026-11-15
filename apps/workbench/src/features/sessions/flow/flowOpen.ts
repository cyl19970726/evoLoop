// Where an event's real object can be read in the workbench, and what to say when it cannot be reached (DEC-045 F1, rework of observation a150a6e6).
// A link is given only where the workbench has a page for the object; where it has none, the detail says so in words instead of a generic link that
// lands somewhere else. Pure: routes in, labels and sentences out.
import type { SchedEvent } from "@evoloop/contracts/work-board";
import { href } from "../../../shared/routes";
import { sessionHref } from "../SessionNavigation";
import { styleOf } from "./flowModel";

export interface OpenTarget { label: string; href: string }
export interface OpenInfo {
  targets: OpenTarget[];
  /** What the links do not say, in a sentence each (shown under the links). */
  notes: string[];
  /** The pull request an event is about. The scheduling event stream does not carry one, and the detail says so for the events where one would be expected. */
  pr: string | null;
}

export const PR_UNAVAILABLE = "读不到：调度事件流不含 PR";
export const DELIVERY_LOCATION = "交付记录在该任务的“交付与使用”页签";
export const MESSAGE_LOCATION = "这条消息在该 Session 对话中查看，没有单条消息页面";

const isDelivery = (event: SchedEvent) => event.subject.kind === "delivery" || event.kind === "task.delivered";
const isMessage = (event: SchedEvent) => event.subject.kind === "message" || event.kind.startsWith("message.");
/** Events where a pull request would be expected: a delivery and everything that accepts, reviews or closes one. */
const expectsPr = (event: SchedEvent) => isDelivery(event) || styleOf(event.kind).group === "accept" || event.kind === "task.done";

/** The 交付与使用 tab of a Task, at one Delivery (the tab scrolls to and marks the delivery whose id is in `delivery`). */
export const deliveryHref = (projectId: string, taskId: string, deliveryId?: string): string =>
  `${href(projectId, "task", taskId)}?${new URLSearchParams({ tab: "delivery", ...(deliveryId ? { delivery: deliveryId } : {}) })}`;

export function openInfoOf(projectId: string, event: SchedEvent): OpenInfo {
  const targets: OpenTarget[] = [], notes: string[] = [];
  const session = event.sessionId ? sessionHref(projectId, `owned:${event.sessionId}`) : null;
  if (isDelivery(event)) {
    if (event.taskId) {
      targets.push({ label: "打开交付", href: deliveryHref(projectId, event.taskId, event.subject.kind === "delivery" ? event.subject.id : undefined) });
      notes.push(`${DELIVERY_LOCATION}，打开后定位到这次交付。`);
    } else notes.push(`${DELIVERY_LOCATION}；这条事件没有带任务，无法直达。`);
  } else if (event.taskId) targets.push({ label: "打开任务", href: href(projectId, "task", event.taskId) });
  if (isMessage(event)) {
    if (session) targets.push({ label: "打开该 Session 的对话", href: session });
    notes.push(session ? `${MESSAGE_LOCATION}。` : `${MESSAGE_LOCATION}；这条事件没有带 Session，读不到是哪个对话。`);
  } else if (session) targets.push({ label: "打开 Session", href: session });
  return { targets, notes, pr: expectsPr(event) ? PR_UNAVAILABLE : null };
}
