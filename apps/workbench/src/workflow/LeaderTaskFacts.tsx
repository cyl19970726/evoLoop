import * as React from "react";
import type { Command, TaskDetail, TaskAttentionFollowUp, TaskAttentionItem } from "@evoloop/contracts";
import type { LeaderWorkTask, LeaderWorkTaskTiming, LeaderWorkTimingStage } from "@evoloop/contracts/work-index";
import type { LeaderNotice } from "@evoloop/contracts/leader-notices";
import { api, errorText, isUnconfirmed, request } from "../api";
import { leaderPhaseLabel } from "./leaderWorkLoad";

const date = (value: string) => new Date(value).toLocaleString("zh-CN");
const ShortId = ({ value }: { value: string }) =>
  React.createElement("code", { title: value }, value.slice(0, 8));
const taskHref = (projectId: string, taskId: string) =>
  `#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

export const timingStageLabel: Record<LeaderWorkTimingStage, string> = {
  unassigned: "待分派", awaiting_ack: "等待承接确认", awaiting_run: "等待运行",
  run_reserved: "运行已预留", running: "运行中", awaiting_submission: "等待提交",
  awaiting_delivery: "等待交付", awaiting_acceptance: "等待验收",
  awaiting_publication: "具备发布条件，等待维护者", rework: "返工中", blocked: "受阻",
  closed: "已关闭", cancelled: "已取消", unknown: "阶段未知",
};
const waitingKindLabel: Record<LeaderWorkTaskTiming["current"]["waitingFor"]["kind"], string> = {
  session: "Session", consumer: "消费者", leader: "项目 Leader", role: "任务负责 Role", publisher: "维护者",
  user: "用户", task: "前置任务", unknown: "责任未知",
};
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
export function timingWaitingFor(timing: LeaderWorkTaskTiming): string {
  const waiting = timing.current.waitingFor;
  return `${waitingKindLabel[waiting.kind]}${waiting.id ? ` · ${waiting.id}` : ""}`;
}
function attentionWaitingFor(item: TaskAttentionItem, revisionId: string, timing?: LeaderWorkTaskTiming): string {
  if (item.waitingOn) {
    const kind = waitingKindLabel[item.waitingOn.kind as keyof typeof waitingKindLabel] ?? "责任未知";
    return `${kind}${item.waitingOn.id ? ` · ${item.waitingOn.id}` : ""}`;
  }
  if (item.taskRevisionId === revisionId && timing?.current.stage === item.phase)
    return `${timingWaitingFor(timing)}（当前阶段）`;
  return "未知";
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
    {detailed && <>
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
    </>}
  </section>;
}

type AttentionRead = { followUp: TaskAttentionFollowUp | null; followUpHistory: TaskAttentionFollowUp[];
  items: TaskAttentionItem[]; itemsNextCursor: string | null };
const signalLabel: Record<TaskAttentionItem["signal"], string> = {
  stage_overdue: "阶段逾期", activity_without_progress: "有活动但缺有效进展", observation_gap: "观察缺口",
};
async function readAttention(token: string, projectId: string, taskId: string): Promise<AttentionRead> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/attention`;
  const value = await request<AttentionRead>(token, path, 15000);
  if (!value || !Array.isArray(value.items) || !Array.isArray(value.followUpHistory) ||
    value.items.some(item => item.taskId !== taskId) || value.followUp?.taskId !== undefined && value.followUp.taskId !== taskId ||
    value.items.some(item => !item.id || !item.taskRevisionId))
    throw new Error("关注项响应与所选 Task 不符；请重新读取。");
  return value;
}

export function TaskAttention({ token, projectId, detail, leader, canWrite, blocked,
  onAttempt, onKnown, onChanged }: {
  token: string; projectId: string; detail: TaskDetail; leader: LeaderWorkTask;
  canWrite: boolean; blocked: boolean; onAttempt: (command: Command) => boolean | Promise<boolean>;
  onKnown: (id: string) => void; onChanged: () => void;
}) {
  const taskId = detail.task.id, revisionId = detail.task.currentRevisionId;
  const [read, setRead] = React.useState<{ taskId: string; revisionId: string; value: AttentionRead | null; error: string } | null>(null);
  const [readAgain, setReadAgain] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [waitingKind, setWaitingKind] = React.useState<NonNullable<TaskAttentionFollowUp["waitingOn"]>["kind"]>("unknown");
  const [waitingId, setWaitingId] = React.useState("");
  const [nextCheck, setNextCheck] = React.useState("");
  const [decision, setDecision] = React.useState<TaskAttentionFollowUp["decision"]>("waiting");
  const [actionTaken, setActionTaken] = React.useState("");
  const [evidenceRef, setEvidenceRef] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [handoffEnabled, setHandoffEnabled] = React.useState(false);
  const [handoffRecipient, setHandoffRecipient] = React.useState("");
  const [handoffArtifact, setHandoffArtifact] = React.useState("");
  const [handoffNote, setHandoffNote] = React.useState("");
  const [handoffReadyAt, setHandoffReadyAt] = React.useState("");
  const [publishedAt, setPublishedAt] = React.useState("");
  const [publicationRef, setPublicationRef] = React.useState("");
  const [publicationReason, setPublicationReason] = React.useState("");
  const [unconfirmedOperation, setUnconfirmedOperation] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    setRead(null);
    readAttention(token, projectId, taskId).then(value => {
      if (live) setRead({ taskId, revisionId, value, error: "" });
    }).catch(cause => { if (live) setRead({ taskId, revisionId, value: null, error: errorText(cause) }); });
    return () => { live = false; };
  }, [token, projectId, taskId, revisionId, readAgain]);
  const current = read?.taskId === taskId && read.revisionId === revisionId ? read : null;
  const value = current?.value;
  const followUpCurrent = value?.followUp?.taskRevisionId === revisionId ? value.followUp : null;
  const followUpStale = !!value?.followUp && !followUpCurrent;
  const orderedHistory = [...(value?.followUpHistory ?? [])].sort((a, b) => a.version - b.version);
  const firstPublicationIndex = orderedHistory.findIndex(entry => !!entry.publication);
  const publicationOrigin = firstPublicationIndex >= 0 ? orderedHistory[firstPublicationIndex] : null;
  const publicationProven = !!publicationOrigin && (publicationOrigin.version === 1 ||
    firstPublicationIndex > 0 && !orderedHistory[firstPublicationIndex - 1].publication);
  const publicationCurrent = !!followUpCurrent?.publication && publicationProven && publicationOrigin?.taskRevisionId === revisionId;
  React.useEffect(() => {
    setWaitingKind(followUpCurrent?.waitingOn?.kind ?? "unknown");
    setWaitingId(followUpCurrent?.waitingOn?.id ?? "");
    setNextCheck(followUpCurrent?.nextCheckAt ? followUpCurrent.nextCheckAt.slice(0, 16) : "");
    setDecision(followUpCurrent?.decision ?? "waiting");
    setActionTaken(followUpCurrent?.actionTaken ?? "");
    setEvidenceRef(followUpCurrent?.evidenceRef ?? "");
    const handoff = followUpCurrent?.releaseHandoff;
    setHandoffEnabled(!!handoff || !!value?.followUp?.publication);
    setHandoffRecipient(handoff?.recipient ?? "");
    setHandoffArtifact(handoff?.artifactRef ?? "");
    setHandoffNote(handoff?.note ?? "");
    setHandoffReadyAt(handoff?.readyForPublicationAt?.slice(0, 16) ?? "");
  }, [value?.followUp?.version, taskId, revisionId]);
  const allowed = canWrite && !blocked && !busy && !unconfirmedOperation && !!value && leader.currentRevisionId === revisionId;
  async function submit(command: Command) {
    if (!allowed) return;
    setBusy(true); setMessage("");
    let saved = false;
    try { saved = await onAttempt(command); } catch { /* A missing receipt must stop the write. */ }
    if (!saved) { setMessage(`操作回执未保存，本次未发送。操作 ID：${command.operationId}`); setBusy(false); return; }
    try {
      const result = await api(token).command(command);
      onKnown(command.operationId);
      if (result.status === "rejected") setMessage(`操作被拒绝：${result.message}；请重新读取版本后再决定。`);
      else {
        const checked = await readAttention(token, projectId, taskId);
        if (command.type === "task.attention.followUp.set" || command.type === "task.attention.publication.record") {
          if (!checked.followUp || checked.followUp.version <= command.expectedVersion || checked.followUp.taskRevisionId !== revisionId)
            throw new Error("写入已应用，但当前跟进版本尚未读回；请重新读取。");
        }
        if (command.type === "task.attention.resolve") {
          const path = `/api/projects/${encodeURIComponent(projectId)}/task-attention/items/${encodeURIComponent(command.itemId)}`;
          const resultItem = await request<{item: TaskAttentionItem}>(token, path, 15000);
          if (resultItem.item.id !== command.itemId || resultItem.item.state !== "resolved" || resultItem.item.version <= command.expectedVersion)
            throw new Error("写入已应用，但解决状态尚未读回；请重新读取。");
        }
        setRead({taskId,revisionId,value:checked,error:""});
        setMessage("已回读当前版本与关注状态。" ); onChanged();
      }
      setReadAgain(count => count + 1);
    } catch (cause) {
      if (!isUnconfirmed(cause)) onKnown(command.operationId);
      if (isUnconfirmed(cause)) setUnconfirmedOperation(command.operationId);
      setMessage(isUnconfirmed(cause) ? `结果未知；请先按原操作 ID ${command.operationId} 核对，暂勿重试。` : `操作或回读失败：${errorText(cause)}`);
    } finally { setBusy(false); }
  }
  return <section className="panel task-focus task-attention-panel" aria-label="任务当前关注">
    <div className="panel-head"><h2>当前关注</h2><button type="button" className="quiet" onClick={() => setReadAgain(count => count + 1)}>重新读取</button></div>
    {!current && <p role="status">正在读取此 Task 的关注项…</p>}
    {current?.error && <p role="alert">关注项暂不可读：{current.error}。请重新读取。</p>}
    {value && <>
      <p className="task-attention-state">{value.items.some(item => item.state === "open")
        ? `${value.items.filter(item => item.state === "open").length} 项已关注`
        : "当前已读范围没有待处理关注项"}{value.itemsNextCursor ? "；还有未读续页" : ""}</p>
      {value.items.length > 0 && <ul className="task-attention-items">{value.items.map(item => <li key={item.id}>
        <strong>{signalLabel[item.signal]} · {item.severity === "urgent" ? "紧急" : "观察"} · {item.state === "open" ? "待解决" : "已解决"}</strong>
        <span>首次发现 {timingDate(item.firstDetectedAt)} · 最近核对 {timingDate(item.lastDetectedAt)}</span>
        <span>等待方 {attentionWaitingFor(item, revisionId, leader.timing)}</span>
        {item.taskRevisionId !== revisionId && <span>历史任务修订；不能按当前版本解决</span>}
        <details><summary>查看依据与通知</summary><pre>{JSON.stringify(item.evidence, null, 2)}</pre><small>通知 {item.noticeId ?? "未知"} · 来源观察 {timingDate(item.sourceObservedAt)}</small></details>
        {item.state === "open" && item.taskRevisionId === revisionId && <form onSubmit={event => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          const itemReason = String(data.get("reason") ?? "").trim(); if (!itemReason) return;
          void submit({ type: "task.attention.resolve", projectId, operationId: crypto.randomUUID(),
            itemId: item.id, expectedVersion: item.version, disposition: "resolved", reason: itemReason });
        }}><label>解决依据 <input name="reason" required maxLength={4000} disabled={!allowed} /></label>
          <button type="submit" disabled={!allowed}>记录已解决</button></form>}
      </li>)}</ul>}
      {value.itemsNextCursor && <button type="button" disabled={busy} onClick={async () => {
        try { const path = `/api/projects/${encodeURIComponent(projectId)}/task-attention/items?taskId=${encodeURIComponent(taskId)}&state=open&limit=100&cursor=${encodeURIComponent(value.itemsNextCursor!)}`;
          const next = await request<{items: TaskAttentionItem[]; nextCursor: string | null}>(token, path, 15000);
          if (!Array.isArray(next.items) || next.items.some(item => item.taskId !== taskId || item.state !== "open")) throw new Error("关注项续页与当前 Task 不符");
          setRead({ taskId, revisionId, value: { ...value, items: [...value.items, ...next.items.filter(item => !value.items.some(old => old.id === item.id))], itemsNextCursor: next.nextCursor }, error: "" }); }
        catch (cause) { setMessage(`续页读取失败：${errorText(cause)}`); }
      }}>读取更多关注项</button>}
      <div className="task-attention-followup"><h3>跟进安排</h3>
        {followUpStale && <p className="task-attention-stale">旧跟进属于历史 Task 修订 {value.followUp!.taskRevisionId}。请核对当前任务后，以已有跟进版本 v{value.followUp!.version} 保存新安排。</p>}
        {followUpCurrent && <p>已记录：{followUpCurrent.decision === "checked" ? "已核对" : followUpCurrent.decision === "acted" ? "已采取行动" : "等待中"} · {followUpCurrent.actionTaken}{followUpCurrent.evidenceRef && ` · 依据 ${followUpCurrent.evidenceRef}`}</p>}
        <p>等待 {followUpCurrent?.waitingOn ? `${waitingKindLabel[followUpCurrent.waitingOn.kind]}${followUpCurrent.waitingOn.id ? ` · ${followUpCurrent.waitingOn.id}` : ""}` : "责任未知"}</p>
        <p>下一检查点 {timingDate(followUpCurrent?.nextCheckAt)}</p>
        {followUpCurrent?.releaseHandoff && <p>具备发布条件，等待维护者 · {timingDate(followUpCurrent.releaseHandoff.readyForPublicationAt)} · {followUpCurrent.releaseHandoff.recipient}</p>}
        <p>{publicationCurrent ? `已发布且有固定证据 · ${timingDate(followUpCurrent!.publication!.publishedAt)} · ${followUpCurrent!.publication!.publicationRef}`
          : followUpCurrent?.publication ? "存在发布记录；当前修订的发布来源尚待核对" : "当前修订发布证据未知"}</p>
        <form onSubmit={event => { event.preventDefault(); if (!reason.trim() || !actionTaken.trim() || handoffEnabled && (!handoffRecipient.trim() || !handoffArtifact.trim() || !handoffNote.trim() || !handoffReadyAt)) return;
          void submit({ type: "task.attention.followUp.set", projectId, operationId: crypto.randomUUID(), taskId,
            expectedTaskVersion: detail.task.version, expectedTaskRevisionId: revisionId,
            expectedVersion: value.followUp?.version ?? 0,
            waitingOn: { kind: waitingKind, id: waitingId.trim() || null },
            decision, actionTaken: actionTaken.trim(), evidenceRef: evidenceRef.trim() || null,
            nextCheckAt: nextCheck ? new Date(nextCheck).toISOString() : null,
            releaseHandoff: handoffEnabled ? { recipient: handoffRecipient.trim(), artifactRef: handoffArtifact.trim(), note: handoffNote.trim(), readyForPublicationAt: new Date(handoffReadyAt).toISOString() } : null,
            reason: reason.trim() });
        }}><label>跟进判断 <select value={decision} disabled={!allowed} onChange={event => setDecision(event.target.value as typeof decision)}><option value="waiting">等待中</option><option value="checked">已核对</option><option value="acted">已采取行动</option></select></label>
          <label>已做什么 <textarea value={actionTaken} onChange={event => setActionTaken(event.target.value)} required maxLength={4000} disabled={!allowed} /></label>
          <label>依据引用 <input value={evidenceRef} onChange={event => setEvidenceRef(event.target.value)} maxLength={500} disabled={!allowed} /></label>
          <label>等待谁 <select value={waitingKind} disabled={!allowed} onChange={event => setWaitingKind(event.target.value as typeof waitingKind)}>
            {Object.entries(waitingKindLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>具体对象 <input value={waitingId} onChange={event => setWaitingId(event.target.value)} maxLength={500} disabled={!allowed} /></label>
          <label>下一检查时间 <input type="datetime-local" value={nextCheck} onChange={event => setNextCheck(event.target.value)} disabled={!allowed} /></label>
          <label>跟进理由 <textarea value={reason} onChange={event => setReason(event.target.value)} required maxLength={4000} disabled={!allowed} /></label>
          <label className="task-attention-handoff-toggle"><input type="checkbox" checked={handoffEnabled} disabled={!allowed || !!followUpCurrent?.publication}
            onChange={event => setHandoffEnabled(event.target.checked)} />登记具备发布条件，交给维护者</label>
          {handoffEnabled && <div className="task-attention-handoff-fields">
            <label>维护者或接收方 <input value={handoffRecipient} onChange={event => setHandoffRecipient(event.target.value)} required maxLength={500} disabled={!allowed} /></label>
            <label>待发布固定产物引用 <input value={handoffArtifact} onChange={event => setHandoffArtifact(event.target.value)} required maxLength={500} disabled={!allowed} /></label>
            <label>交接说明 <textarea value={handoffNote} onChange={event => setHandoffNote(event.target.value)} required maxLength={4000} disabled={!allowed} /></label>
            <label>具备发布条件时间 <input type="datetime-local" value={handoffReadyAt} onChange={event => setHandoffReadyAt(event.target.value)} required disabled={!allowed} /></label>
          </div>}
          <button type="submit" disabled={!allowed || !reason.trim() || !actionTaken.trim()}>保存跟进安排</button></form>
        {followUpCurrent?.releaseHandoff && !followUpCurrent.publication && <form className="task-attention-publication" onSubmit={event => {
          event.preventDefault(); if (!publishedAt || !publicationRef.trim() || !publicationReason.trim()) return;
          void submit({ type: "task.attention.publication.record", projectId, operationId: crypto.randomUUID(), taskId,
            expectedTaskVersion: detail.task.version, expectedTaskRevisionId: revisionId,
            expectedVersion: followUpCurrent.version, publishedAt: new Date(publishedAt).toISOString(),
            publicationRef: publicationRef.trim(), reason: publicationReason.trim() });
        }}><h3>记录实际发布</h3><p>仅在维护者已发布且有可核固定证据时登记。</p>
          <label>实际发布时间 <input type="datetime-local" value={publishedAt} onChange={event => setPublishedAt(event.target.value)} required disabled={!allowed} /></label>
          <label>发布证据引用 <input value={publicationRef} onChange={event => setPublicationRef(event.target.value)} required maxLength={500} disabled={!allowed} /></label>
          <label>记录理由 <textarea value={publicationReason} onChange={event => setPublicationReason(event.target.value)} required maxLength={4000} disabled={!allowed} /></label>
          <button type="submit" disabled={!allowed || !publishedAt || !publicationRef.trim() || !publicationReason.trim()}>记录已发布</button></form>}
        {!canWrite && <p>当前身份缺少复核与写入权限；可阅读关注依据。</p>}
        {blocked && <p>任务回读或原操作尚未确认，请先核对原版本。</p>}
      </div>
      {value.followUpHistory.length > 0 && <details><summary>查看 {value.followUpHistory.length} 条跟进历史</summary><ol>{value.followUpHistory.map(item => <li key={item.version}>v{item.version} · {timingDate(item.updatedAt)} · {item.reason}</li>)}</ol></details>}
    </>}
    {message && <p role="status">{message}</p>}
    {unconfirmedOperation && <button type="button" onClick={() => { void api(token).operation(projectId, unconfirmedOperation).then(() => {
      onKnown(unconfirmedOperation); setUnconfirmedOperation(null); setReadAgain(count => count + 1);
    }).catch(cause => setMessage(`原操作仍未能核对：${errorText(cause)}；操作 ID ${unconfirmedOperation}`)); }}>核对原操作</button>}
  </section>;
}

const noticeLabel: Record<LeaderNotice["kind"], string> = {
  task_todo: "待编排任务", delivery: "交付已封存", observation: "验收结果",
  task_question: "关键问题", task_blocker: "执行受阻", run_without_submission: "Run 终态缺交付",
  run_submission_blocked: "Run 封存受阻",
  task_attention: "任务关注待跟进",
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
    <TaskTiming timing={leader.timing} detailed />
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
