// What a schedule's triggers did, joined from two reads: the occurrences (every instant the scheduler checked) and, for a schedule that
// hands over directly, the dispatch log (what was decided for each: dispatched, fell back, skipped). Only facts the two reads carry;
// a read that failed is "unknown", never a guess (Task 9e45cd20).
import type { Occurrence } from "@evoloop/contracts/scheduling";
import type { ScheduleDispatchLog, ScheduleDispatchPolicy } from "@evoloop/contracts/schedule-dispatch";
import { occurrenceLabel, occurrenceReasonKnown, occurrenceReasonText } from "./presentation";

export const dispatchStateLabel: Record<ScheduleDispatchLog["state"], string> = {
  pending: "待派发（任务已生成，尚未进入队伍）", dispatched: "已直派到队伍", fell_back: "交回 Leader 安排", skipped: "已跳过，没有生成任务",
};
export const dispatchStateTone: Record<ScheduleDispatchLog["state"], "ok" | "wait" | "bad"> = { pending: "wait", dispatched: "ok", fell_back: "wait", skipped: "bad" };

const reasons: Record<string, string> = {
  PREVIOUS_STILL_OPEN: "上一次生成的任务还没关闭，这次不再生成",
  DAILY_BUDGET: "今天的直派次数用完了（每日运行预算）",
  POLICY_PAUSED: "直派策略已暂停，这次交给 Leader",
  POLICY_REVOKED: "直派策略已撤销，这次交给 Leader",
  POLICY_CIRCUIT_OPEN: "直派已熔断（队伍项的运行连续失败），这次交给 Leader",
  CIRCUIT_OPEN: "直派已熔断（队伍项的运行连续失败），改回交 Leader",
  RETURNED_TO_LEADER: "任务模板或职责绑定变了，直派不再有效，这次交给 Leader",
  TEMPLATE_CHANGED: "任务模板变了，直派不再有效",
  ROLE_BINDING_CHANGED: "职责绑定变了，直派不再有效",
  NO_AVAILABLE_SESSION: "名单里没有能接收的会话，交给 Leader",
  BUSINESS_IDENTITY_UNBOUND: "名单里的会话没有绑定业务身份，交给 Leader",
};
/** A dispatch reason code in words; a code the page does not know says so and keeps the original. */
export function dispatchReasonText(code: string): string {
  if (!code) return "";
  if (reasons[code]) return reasons[code];
  if (code.startsWith("APPEND_")) return `加入队伍被拒绝（${code.slice(7)}），交给 Leader`;
  return "原因代码页面未收录，原文见完整标识";
}
export const dispatchReasonKnown = (code: string): boolean => !code || !!reasons[code] || code.startsWith("APPEND_");

export const policyStateLabel: Record<ScheduleDispatchPolicy["state"], string> = {
  active: "生效中", paused: "已暂停", revoked: "已撤销", circuit_open: "已熔断（运行连续失败后退回交 Leader）",
};

export interface TriggerRow {
  plannedAtUtc: string; revisionId: string | null;
  occurrence: Occurrence | null; dispatch: ScheduleDispatchLog | null;
  /** The headline: the dispatch decision when there is one, else what the occurrence says. */
  label: string; tone: "ok" | "wait" | "bad"; reasonText: string; reasonCode: string; reasonKnown: boolean;
  taskId: string | null; taskLabel: string;
}

const occurrenceTone = (item: Occurrence): TriggerRow["tone"] => item.state === "created" ? "ok" : item.state === "queued" ? "wait" : "bad";

/** Triggers newest first: every occurrence and every log row, joined on the planned instant. `dispatches` null = not read. */
export function triggerRows(occurrences: Occurrence[], dispatches: ScheduleDispatchLog[] | null): TriggerRow[] {
  const byTime = new Map<number, { occurrence: Occurrence | null; dispatch: ScheduleDispatchLog | null; at: string }>();
  for (const occurrence of occurrences) byTime.set(Date.parse(occurrence.plannedAtUtc), { occurrence, dispatch: null, at: occurrence.plannedAtUtc });
  for (const dispatch of dispatches ?? []) {
    const key = Date.parse(dispatch.plannedAtUtc), known = byTime.get(key);
    if (known) known.dispatch = dispatch; else byTime.set(key, { occurrence: null, dispatch, at: dispatch.plannedAtUtc });
  }
  return [...byTime.entries()].sort((a, b) => b[0] - a[0]).map(([, { occurrence, dispatch, at }]): TriggerRow => {
    if (dispatch) {
      const own = dispatch.reason || (occurrence ? occurrence.reason : "");
      const isOccurrenceReason = !dispatch.reason && !!occurrence;
      const skippedAnchor = dispatch.state === "skipped";
      return { plannedAtUtc: at, revisionId: occurrence?.revisionId ?? null, occurrence, dispatch, label: dispatchStateLabel[dispatch.state], tone: dispatchStateTone[dispatch.state],
        reasonText: isOccurrenceReason ? occurrenceReasonText(own) : dispatchReasonText(own), reasonCode: own,
        reasonKnown: isOccurrenceReason ? occurrenceReasonKnown(own) : dispatchReasonKnown(own),
        taskId: dispatch.taskId ?? occurrence?.taskId ?? null, taskLabel: skippedAnchor ? "仍未关闭的上一个任务" : "阅读此任务" };
    }
    const item = occurrence!;
    return { plannedAtUtc: at, revisionId: item.revisionId, occurrence: item, dispatch: null, label: occurrenceLabel(item) + (dispatches && item.state === "created" ? " · 没有直派记录" : ""),
      tone: occurrenceTone(item), reasonText: occurrenceReasonText(item.reason), reasonCode: item.reason, reasonKnown: occurrenceReasonKnown(item.reason),
      taskId: item.taskId, taskLabel: "阅读此任务" };
  });
}
