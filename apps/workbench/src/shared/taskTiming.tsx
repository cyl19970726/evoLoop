// Task stage timing display, shared by the task pages and the Session workspace (which shows the current task's stage).
import React from "react";
import type { LeaderWorkTaskTiming, LeaderWorkTimingStage } from "@evoloop/contracts/work-index";

export const timingStageLabel: Record<LeaderWorkTimingStage, string> = {
  unassigned: "待分派", awaiting_ack: "等待承接确认", awaiting_run: "等待运行",
  run_reserved: "运行已预留", running: "运行中", awaiting_submission: "等待提交",
  awaiting_delivery: "等待交付", awaiting_acceptance: "等待验收",
  awaiting_publication: "具备发布条件，等待维护者", rework: "返工中", blocked: "受阻",
  closed: "已关闭", cancelled: "已取消", unknown: "阶段未知",
};
/** Who the current stage waits on, in the words of shared/workPresentation.ts responsibleKind. */
export const waitingKindLabel: Record<LeaderWorkTaskTiming["current"]["waitingFor"]["kind"], string> = {
  session: "智能体", consumer: "指定验收者", leader: "项目统筹", role: "任务负责职责", publisher: "发布维护者",
  user: "指定的人", task: "前置任务", unknown: "责任未知",
};
const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function timingDate(value: string | null | undefined): string {
  if (!value) return "未知";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "未知" : time.toLocaleString("zh-CN");
}
export function timingDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "未知";
  const minutes = Math.floor(value / 60000);
  if (minutes < 1) return "不足 1 分钟";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const rest = minutes % 60;
  return [days && `${days} 天`, hours && `${hours} 小时`, rest && `${rest} 分钟`].filter(Boolean).join(" ");
}
/** The waiting party by kind; an actor name follows it, a record's raw ID does not (it belongs to 完整标识). */
export function timingWaitingFor(timing: LeaderWorkTaskTiming): string {
  const waiting = timing.current.waitingFor;
  return `${waitingKindLabel[waiting.kind] ?? "责任未知"}${waiting.id && !recordId.test(waiting.id) ? ` · ${waiting.id}` : ""}`;
}
export function TaskTiming({ timing, detailed = false }: { timing?: LeaderWorkTaskTiming | null; detailed?: boolean }) {
  if (!timing) return <p className="task-timing-unavailable">阶段时间尚未读回；请重新读取本任务。</p>;
  const current = timing.current;
  return <section className={`task-timing${detailed ? " task-timing-detailed" : ""}`} aria-label="任务阶段时间">
    <div className="task-timing-current">
      <strong>{timingStageLabel[current.stage] ?? "阶段未知"}</strong>
      <span>本阶段 {timingDate(current.startedAt)} 至 {current.endedAt ? timingDate(current.endedAt) : "不适用（当前阶段）"}</span>
      <span>已历时 {timingDuration(current.elapsedMs)}</span>
      <span>等待 {timingWaitingFor(timing)}</span>
    </div>
    {detailed && <React.Fragment>
      <dl className="task-timing-facts">
        <div><dt>任务创建</dt><dd>{timingDate(timing.createdAt)}</dd></div>
        <div><dt>发布证据</dt><dd>{timing.publication.source === "explicit" && timing.publication.at
          ? `已发布 · ${timingDate(timing.publication.at)}`
          : "未知；具备发布条件不代表已发布"}</dd></div>
        <div><dt>阶段来源</dt><dd>{current.source ? `${current.source.kind} · ${current.source.id}` : "来源未知"}</dd></div>
        <div><dt>最近有效进展</dt><dd>{timing.latestEffectiveProgress
          ? `${timing.latestEffectiveProgress.kind} · ${timingDate(timing.latestEffectiveProgress.at)} · ${timing.latestEffectiveProgress.sourceId}`
          : "未知"}</dd></div>
        <div><dt>当前任务执行活动</dt><dd>{timing.executionActivity
          ? `${timing.executionActivity.kind} · ${timingDate(timing.executionActivity.at)} · ${timing.executionActivity.freshness === "live" ? "新近观察" : timing.executionActivity.freshness === "stale" ? "观察已过期" : "新鲜度未知"}`
          : "未知；没有可归属此 Task 的活动"}</dd></div>
      </dl>
      {timing.rounds.length > 0 && <details className="task-timing-rounds"><summary>查看 {timing.rounds.length} 轮阶段区间</summary>
        <ol>{timing.rounds.map(round => <li key={round.number}><strong>第 {round.number} 轮</strong> · {timingDate(round.startedAt)} 至 {round.endedAt ? timingDate(round.endedAt) : "不适用（进行中）"} · {timingDuration(round.elapsedMs)}
          <ul>{round.intervals.map((interval, index) => <li key={`${round.number}:${index}`}>{timingStageLabel[interval.stage] ?? "阶段未知"} · {timingDate(interval.startedAt)} 至 {interval.endedAt ? timingDate(interval.endedAt) : "不适用（进行中）"} · {interval.source ? `${interval.source.kind} ${interval.source.id}` : "来源未知"}</li>)}</ul>
        </li>)}</ol></details>}
      <small>观察于 {timingDate(timing.observedAt)}；未知时间不计为零。</small>
    </React.Fragment>}
  </section>;
}
