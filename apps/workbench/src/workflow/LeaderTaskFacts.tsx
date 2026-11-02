import * as React from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { LeaderNotice } from "@evoloop/contracts/leader-notices";
import { api } from "../api";
import { leaderPhaseLabel } from "./leaderWorkLoad";

const date = (value: string) => new Date(value).toLocaleString("zh-CN");
const ShortId = ({ value }: { value: string }) =>
  React.createElement("code", { title: value }, value.slice(0, 8));
const taskHref = (projectId: string, taskId: string) =>
  `#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

const noticeLabel: Record<LeaderNotice["kind"], string> = {
  task_todo: "待编排任务", delivery: "交付已封存", observation: "验收结果",
  task_question: "关键问题", task_blocker: "执行受阻", run_without_submission: "Run 终态缺交付",
  run_submission_blocked: "Run 封存受阻",
};

export function LeaderTaskFacts({ leader, detail, projectId, token, responsibleName }: {
  leader: LeaderWorkTask; detail: TaskDetail; projectId: string; token: string; responsibleName?: string | null;
}) {
  const [notices, setNotices] = React.useState<LeaderNotice[]>([]);
  const [noticeError, setNoticeError] = React.useState("");
  const [noticeCursor, setNoticeCursor] = React.useState<string | null>(null);
  const [noticeLoading, setNoticeLoading] = React.useState(false);
  const [noticeRefresh, setNoticeRefresh] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setNoticeLoading(true);
    api(token).leaderNotices(projectId, detail.task.id).then(page => {
      if (active) { setNotices(page.items); setNoticeCursor(page.nextCursor); setNoticeError(""); }
    }).catch(() => { if (active) setNoticeError("通知记录暂不可读取，请从工作变化流核对。"); })
      .finally(() => { if (active) setNoticeLoading(false); });
    return () => { active = false; };
  }, [token, projectId, detail.task.id, detail.task.version, noticeRefresh]);
  const loadOlder = async () => {
    if (!noticeCursor || noticeLoading) return;
    setNoticeLoading(true);
    try {
      const page = await api(token).leaderNotices(projectId, detail.task.id, noticeCursor);
      setNotices(previous => [...previous, ...page.items]);
      setNoticeCursor(page.nextCursor);
      setNoticeError("");
    } catch { setNoticeError("较早通知读取失败，可重试。"); }
    finally { setNoticeLoading(false); }
  };
  const plan = leader.plan;
  const consumer = detail.proposal?.consumer ?? leader.delivery?.consumer ?? null;
  const source = detail.proposal?.evidence?.trim() || null;
  const responsibility = leader.responsible.kind === "role" && leader.responsible.id === detail.task.owner &&
    responsibleName?.trim() ? responsibleName.trim() : leader.responsible.label;
  return <section className="panel task-focus task-leader-facts">
    <div className="panel-head"><h2>当前工作与安排</h2><span className="pill subtle">{leaderPhaseLabel[leader.phase]}</span></div>
    <p className="task-attention"><strong>下一步：</strong>{leader.nextAction}</p>
    <dl>
      <div><dt>责任</dt><dd>{responsibility}
        {leader.assignment && <> · {leader.assignment.state === "accepted" ? "已承接" : leader.assignment.state === "assigned" ? "待承接" : "已释放"}
          {leader.assignment.recipientActorId && <> · 接收者 {leader.assignment.recipientActorId}</>}
          <br /><small>{leader.assignment.targetKind === "owned" ? "受管 Session" : "外部 HostLink"} <ShortId value={leader.assignment.targetId} /></small></>}
      </dd></div>
      <div><dt>计划</dt><dd>{plan ? <>
        P{plan.priority ?? "未设"} · 计划开始 {plan.plannedStartAt ? date(plan.plannedStartAt) : "未设"} ·
        截止 {plan.dueAt ? date(plan.dueAt) : "未设"}
        <br /><small>计划元数据 v{plan.version ?? 0}{plan.updatedAt ? ` · ${date(plan.updatedAt)}` : ""}</small>
      </> : "尚未设置计划时间、截止或优先级。"}</dd></div>
      <div><dt>时间事实</dt><dd>创建 {date(leader.dates.createdAt)}<br />
        业务变化 {date(leader.dates.businessChangedAt)}<br />
        实际开始 {leader.dates.startedAt ? date(leader.dates.startedAt) : "未发生"}<br />
        完成 {leader.dates.completedAt ? date(leader.dates.completedAt) : "未关闭"}</dd></div>
      <div><dt>来源</dt><dd>{leader.goal ? <>目标：{leader.goal.outcome}<br /></> : "未关联 Goal"}
        {leader.stage ? <>阶段：{leader.stage.deliverable}<br /></> : "未关联 Stage"}
        {source ?? (detail.proposal ? "该任务没有另写创建依据说明。" : "历史任务没有新验收合同。")}</dd></div>
      <div><dt>当前验收与消费者</dt><dd>{detail.proposal?.acceptanceMode === "independent_agent"
        ? "独立 Agent 使用当前交付"
        : detail.proposal?.acceptanceMode === "human_required" ? "受信本人使用当前交付" : "历史合同"}
        {consumer ? ` · ${consumer}` : " · 消费身份待签收"}<br />
        {detail.proposal?.useRequired ? "关闭前要求当前交付的实际使用证据。" : "按既有合同核对使用证据。"}
        {detail.proposal?.stopCondition && <><br />停止条件：{detail.proposal.stopCondition}</>}</dd></div>
      <div><dt>当前执行</dt><dd>{leader.latestRun
        ? <>Run {leader.latestRun.state} · <ShortId value={leader.latestRun.runId} /></>
        : "当前修订没有可见 Run"}
        <br />队列：{leader.queueHold ? `暂不派发（${leader.queueHold}）` : "未登记 hold"}
        {leader.pendingImpactCount > 0 && <><br />依据：{leader.pendingImpactCount} 项待复核</>}</dd></div>
      <div><dt>当前交付</dt><dd>{leader.delivery ? <>
        技术{leader.delivery.technicalResult === "passed" ? "通过" : "失败"} · <ShortId value={leader.delivery.deliveryId} />
        <br />使用：{leader.delivery.observationResult
          ? `${leader.delivery.observationKind === "human" ? "本人" : "Agent"} ${leader.delivery.observationActorId} · ${leader.delivery.observationResult}`
          : "尚无本次使用观察"}
      </> : "当前修订尚无交付。"}</dd></div>
      <div><dt>Leader 决定</dt><dd>{leader.review ? <>
        {leader.review.decision === "acknowledged" ? "已核对" : "暂缓"} · {leader.review.reason}<br />
        <small>{leader.review.actorId} · {date(leader.review.at)} · 变化 {leader.review.reviewedChangeSequence}</small>
      </> : "当前工作位置尚未记录 Leader 决定。"}</dd></div>
    </dl>
    <h3>结果回程</h3><button type="button" disabled={noticeLoading} onClick={() => setNoticeRefresh(value => value + 1)}>重新读取通知</button>
    {noticeError && <p role="status">{noticeError}</p>}
    {notices.length ? <ul className="basis-list task-basis-list">{notices.map(item =>
      <li key={item.id}><strong>{noticeLabel[item.kind]}</strong> · {date(item.occurredAt)}
        <span>{item.messageState === "failed" || item.messageState === "cancelled"
          ? `原通知${item.messageState === "failed" ? "失败" : "已取消"}；须核原消息和 Task，再作新的人工安排` :
          item.blockedReason?.startsWith("MESSAGE_POST_REJECTED") || item.blockedReason === "PINNED_RECIPIENT_CHANGED"
            ? "原消息意图已被拒绝或目标已变；核原操作后人工安排新意图" :
          item.state === "linked" ? item.readAt ? `Leader 已记录收阅 · ${date(item.readAt)}；下一安排另核` :
            item.messageBlockedReason ? `消息待恢复：${item.messageBlockedReason}` :
            item.nativeTurnId ? "原生 Turn 已关联；收阅与下一安排另核" : "已保存给 Leader 的消息，尚未核到原生接收" :
          item.blockedReason ? `待恢复：${item.blockedReason}` :
          item.stale ? "来源属于历史修订，须核当前 Task" : "待通知 Leader"}</span>
        <small>来源 <code className="break-anywhere">{item.sourceRef}</code> · Task 修订 <ShortId value={item.taskRevisionId} />
          {item.stale && <> · 来源属于历史修订</>}
          {item.sourceSessionId && <> · 来源 Session <ShortId value={item.sourceSessionId} /></>}
          {item.sourceActorId && <> · 来源 actor {item.sourceActorId}</>}
          {item.recovery?.parentNoticeId && <> · 新意图继承原拒绝通知 <ShortId value={item.recovery.parentNoticeId} /></>}
          {item.recovery?.replacementNoticeId && <> · 已由 {item.recovery.dispositionActorId} 保存替代通知 <ShortId value={item.recovery.replacementNoticeId} /></>}
          {item.linkedSessionId && <> · <a href={`#/p/${encodeURIComponent(projectId)}/sessions?session=${encodeURIComponent(`owned:${item.linkedSessionId}`)}`}>查看目标 Session ↗</a></>}</small>
        {(item.state === "linked" || item.blockedReason) && <details><summary>核对原通知身份</summary>
          <small>消息 <code className="break-anywhere">{item.messageId}</code><br />
            操作 <code className="break-anywhere">{item.operationId}</code></small></details>}
      </li>)}</ul> : !noticeError && <p className="empty">当前没有结果通知记录。</p>}
    {noticeCursor && <button type="button" disabled={noticeLoading} onClick={() => { void loadOlder(); }}>读取较早通知</button>}
    <h3>前置依赖</h3>
    {leader.dependencies.length ? <ul className="basis-list task-basis-list">{leader.dependencies.map(dependency =>
      <li key={dependency.taskId}><a href={taskHref(projectId, dependency.taskId)}>{dependency.title} ↗</a>
        <span>{dependency.acceptanceSatisfied ? "当前修订已验收/已释放" : "仍在等待真实验收"} · 固定修订 <ShortId value={dependency.currentRevisionId} /></span>
        {dependency.reason && <small>{dependency.reason}</small>}</li>)}</ul>
      : <p className="empty">没有独立 Task 依赖。</p>}
  </section>;
}
