// 派发方式 and 最近触发 of one schedule (Task 9e45cd20): read-only. The facts come from GET .../dispatch (policy, null when none is registered),
// GET .../dispatches (one decision per trigger of a direct schedule) and, for the skip escalation, the Leader notices of the Task the skips named.
import type { ReactNode } from "react";
import { Notice as UiNotice, cn } from "@evoloop/ui";
import type { ScheduleDispatchLog, ScheduleDispatchPolicy } from "@evoloop/contracts/schedule-dispatch";
import { api, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { date } from "../../shared/ui/shared";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { schedulingClient } from "./client";
import { dispatchReasonKnown, policyStateLabel, type TriggerRow } from "./dispatch";
import { scheduleTime } from "./presentation";

const muted = "text-caption text-muted-foreground";
const MAX_PAGES = 5;

export interface ScheduleDispatchRead {
  policy: ScheduleDispatchPolicy | null; logs: ScheduleDispatchLog[]; truncated: boolean;
  /** Notices of kind schedule_skips_escalated read for this schedule; null = the read failed. */
  skipNotices: Array<{ id: string; occurredAt: string; taskId: string }> | null;
}

/** The dispatch facts of one schedule; `readAt` re-keys the read when the history is read again. */
export function useScheduleDispatch(token: string, projectId: string, scheduleId: string, version: number, readAt: string | null) {
  return useProjectQuery<ScheduleDispatchRead>(projectId, ["schedule", scheduleId, "dispatch", version, readAt], async () => {
    const client = schedulingClient(token, projectId);
    const policy = await client.dispatchPolicy(scheduleId);
    const logs: ScheduleDispatchLog[] = []; let cursor: string | undefined, truncated = false;
    for (let n = 0; n < MAX_PAGES; n++) {
      const page = await client.dispatches(scheduleId, cursor);
      if (page.items.some(item => item.scheduleId !== scheduleId)) throw new Error("派发记录与当前日程不符");
      logs.push(...page.items);
      if (!page.nextCursor) { cursor = undefined; break; }
      cursor = page.nextCursor; if (n === MAX_PAGES - 1) truncated = true;
    }
    // The skip escalation is a Leader notice on the Task the skips named, not a field of the log: read it for the latest few of those Tasks.
    let skipNotices: ScheduleDispatchRead["skipNotices"] = [];
    const anchors = [...new Set(logs.filter(item => item.state === "skipped" && item.taskId).map(item => item.taskId!))].slice(-3);
    try {
      for (const taskId of anchors) {
        const page = await api(token).leaderNotices(projectId, taskId);
        for (const notice of page.items) if (notice.kind === "schedule_skips_escalated" && notice.sourceRef.startsWith(`schedule:${scheduleId}:skips@`))
          skipNotices.push({ id: notice.id, occurredAt: notice.occurredAt, taskId });
      }
    } catch { skipNotices = null; }
    return { policy, logs, truncated, skipNotices };
  }, { retry: false });
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-0.5"><dt className={muted}>{label}</dt><dd className="m-0 break-words text-small text-foreground">{children}</dd></div>;
}

/** How this schedule hands its Task over, in the page's words. Nothing here is inferred: no read says 未知. */
export function DispatchFacts({ read }: { read: { data?: ScheduleDispatchRead; isPending: boolean; isError: boolean; error: unknown } }) {
  const card = "flex flex-col gap-3 rounded-xl bg-raised p-4 border border-border compact:p-5";
  const data = read.data;
  if (!data) return <section aria-label="派发方式" className={card} data-dispatch-facts="">
    <h3 className="text-label font-semibold text-foreground">派发方式</h3>
    <p className="text-small text-text-secondary" role="status">{read.isPending ? "正在读取派发方式…" : `派发方式本次没有读到（${errorText(read.error)}）：当前方式未知，不推断为交 Leader。`}</p>
  </section>;
  const { policy, logs, skipNotices } = data;
  const direct = policy?.mode === "direct";
  const waitEscalated = logs.filter(item => item.escalatedAt);
  return <section aria-label="派发方式" className={card} data-dispatch-facts="">
    <h3 className="text-label font-semibold text-foreground">派发方式</h3>
    <p className={muted}>每次到点生成的 Task 交给谁：默认交 Leader 安排；设了直派的日程把 Task 直接放进指定会话的队伍。到点只分发，不立即开始。</p>
    <dl className="m-0 flex flex-col gap-2">
      <Fact label="派发方式">{direct ? "直派到队伍" : policy ? `交 Leader 安排${policy.revertReason ? `（直派已退回：${dispatchReasonKnown(policy.revertReason) ? policy.revertReason : "原因见完整标识"}）` : ""}` : "交 Leader 安排（没有登记直派策略，按默认）"}</Fact>
      {policy && <Fact label="策略状态">{policyStateLabel[policy.state]}</Fact>}
      {policy && <Fact label="连续跳过">{policy.consecutiveSkips} 次{policy.consecutiveFailures ? ` · 直派的运行连续失败 ${policy.consecutiveFailures} 次` : ""}</Fact>}
      {policy && <Fact label="等待上限与每日预算">队伍里等 {policy.waitLimitMinutes} 分钟未开始就告知 Leader · {policy.dailyRunBudget === null ? "每日直派次数不设上限" : `每日最多直派 ${policy.dailyRunBudget} 次`}</Fact>}
      {policy && <Fact label="已升级给 Leader">
        {skipNotices === null ? "未知：升级通知这次没有读到"
          : skipNotices.length ? `连续跳过已升级：读到 ${skipNotices.length} 条通知，最近一条 ${date(skipNotices.at(-1)!.occurredAt)}`
          : policy.consecutiveSkips >= 2 ? "当前连续跳过已达 2 次，但没有读到升级通知（可能还没发出，也可能不在已读范围内）" : "没有读到连续跳过的升级通知"}
        {waitEscalated.length > 0 && <span className="block text-text-secondary">另有 {waitEscalated.length} 次直派的任务在队伍里等过上限，已告知 Leader（最近一次 {date(waitEscalated.at(-1)!.escalatedAt!)}）。</span>}
      </Fact>}
    </dl>
    {data.truncated && <p className={muted}>派发记录较多，只读到最早的 {MAX_PAGES * 100} 条；更新的记录没有列出。</p>}
    {policy && <FullIdentifiers rows={[{ label: "策略修订", value: policy.setRevisionId }, { label: "批准时的职责修订", value: policy.roleRevisionId },
      { label: "策略设置人", value: policy.actorId }, { label: "退回原因原文", value: policy.revertReason, text: true }]} />}
  </section>;
}

const toneClass = { ok: "font-medium text-foreground", wait: "font-medium text-warning", bad: "text-text-secondary" } as const;

/** The triggers, newest first: planned time, what happened, why, and the Task it made (or the open one it skipped for). */
export function TriggerList({ rows, zoneOf, taskHref, dispatchProblem }: {
  rows: TriggerRow[]; zoneOf(revisionId: string | null): string; taskHref(taskId: string): string; dispatchProblem: string | null;
}) {
  return <>
    {dispatchProblem && <UiNotice tone="waiting">派发记录本次没有读到（{dispatchProblem}）：下面只列日程自己的发生记录；谁接了任务、是否直派、是否交回 Leader 未知。</UiNotice>}
    <ol className="flex flex-col" data-trigger-list="">{rows.map(row => <li key={row.plannedAtUtc} data-trigger-state={row.dispatch?.state ?? row.occurrence?.state}
      className="flex flex-col gap-0.5 border-t border-border py-2.5 first:border-t-0">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small font-medium text-foreground">
        <span>{scheduleTime(row.plannedAtUtc, zoneOf(row.revisionId))}</span>
        <span className={cn("text-caption", toneClass[row.tone])} data-trigger-label="">{row.label}</span>
      </span>
      {row.reasonText && <span className="text-small text-text-secondary">{row.reasonText}</span>}
      {row.dispatch?.state === "dispatched" && <span className={muted}>{row.dispatch.dispatchedAt ? `${date(row.dispatch.dispatchedAt)} 放进队伍` : "已放进队伍"}{row.dispatch.escalatedAt ? ` · 等待超过上限，已告知 Leader（${date(row.dispatch.escalatedAt)}）` : ""}。放进队伍不等于已开始或已完成。</span>}
      {row.taskId && <a href={taskHref(row.taskId)} className="w-fit text-caption text-foreground underline">{row.taskLabel}</a>}
      <FullIdentifiers rows={[{ label: "操作", value: row.occurrence?.operationId ?? null }, { label: "任务", value: row.taskId }, { label: "日程修订", value: row.revisionId },
        { label: "队伍会话", value: row.dispatch?.sessionId ?? null }, { label: "队伍项", value: row.dispatch?.entryId ?? null },
        { label: "原因原文", value: row.reasonCode, text: true }]} />
    </li>)}</ol>
  </>;
}
