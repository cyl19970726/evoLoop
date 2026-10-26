import { date, ShortId } from "../ui/shared";
import type { RecoveryRead } from "./recoveryPresentation";
import { recoveryActivationLabel, recoveryBudget, recoveryCauseLabel, recoveryNextActionLabel, recoveryPhaseLabel } from "./recoveryPresentation";

function Unavailable({ read }: { read: Exclude<RecoveryRead, { status: "ready" }> }) {
  const label = read.status === "loading" ? "正在读取恢复记录…" : read.status === "unsupported" ? "当前服务暂不支持恢复观察。" : read.status === "forbidden" ? "当前身份无权读取恢复记录。" : "恢复记录暂不可读取。";
  return <p className="session-recovery-unavailable" role={read.status === "loading" ? "status" : "alert"}>{label}{read.status !== "loading" && <span> {read.message}</span>}</p>;
}

export function SessionRecoveryOverview({ read, runtimeState }: { read: RecoveryRead; runtimeState: string | null }) {
  if (read.status !== "ready") return <section className="session-recovery-overview" aria-label="恢复进度"><h2>恢复进度</h2><Unavailable read={read} /></section>;
  const { view } = read;
  const gate = view.gate;
  return <section className="session-recovery-overview" aria-label="恢复进度">
    <div className="session-recovery-heading"><h2>恢复进度</h2><small>读取于 {date(view.observedAtUtc)}</small></div>
    {gate ? <>
      <div className="session-recovery-facts"><div><small>当前阶段</small><strong>{runtimeState === "closed" && gate.phase === "open" ? "恢复门开放；会话已关闭" : recoveryPhaseLabel(gate.phase)}</strong></div><div><small>停止或等待原因</small><strong>{gate.reason || "原因尚未记录"}</strong></div><div><small>下一动作</small><strong>{recoveryNextActionLabel(view.nextAction)}</strong></div></div>
      {runtimeState === "closed" && <p className="session-recovery-note">该受管 Session 已关闭；恢复阶段不能使它直接接续。请先核对会话生命周期与授权。</p>}
      {gate.causeKind && <p className="session-recovery-context">来源：{recoveryCauseLabel(gate.causeKind)}{gate.causeId && <> <ShortId value={gate.causeId} /></>}{gate.causeState && ` · 保存状态 ${gate.causeState}`} · 更新于 {date(gate.updatedAt)}</p>}
      {gate.phase === "retrying" && <p className="session-recovery-note">仅已批准的原任务重试可接续；其他任务与消息仍等待。实际是否运行请核对 Run。</p>}
      {gate.phase === "blocked" && <p className="session-recovery-note">后续任务与普通消息不可启动；需要先核对失败或未知结果，再由负责人决定恢复。</p>}
      {gate.phase === "message_pending" && <p className="session-recovery-note">仅原排队消息可接续；实际处理和回复请核对消息记录。</p>}
      {gate.causeState === "unknown" && <p className="session-recovery-note">原结果未知，先按原操作和记录对账，不能据此重试。</p>}
      {gate.phase === "awaiting_acceptance" && <p className="session-recovery-note">新任务与消息仍等待交付、实际使用和验收放行。</p>}
      {gate.phase === "open" && <p className="session-recovery-note">仍需满足权限、额度、互斥、任务及交付条件。</p>}
      {gate.decisionOperationId && <p className="session-recovery-context">最近采用决定的操作：<ShortId value={gate.decisionOperationId} /></p>}
    </> : <p className="session-recovery-note">没有持久恢复记录；这不代表所有运行已核实健康。{recoveryNextActionLabel(view.nextAction)}。</p>}
    {view.partial && <p className="session-recovery-partial">读取范围不完整；队列最多展示 20 项，其他记录需从任务队列核对。</p>}
    <details className="session-recovery-decisions"><summary>正式恢复决定 · {view.decisions.length}{view.decisions.length === 20 && "（最近 20 条）"}</summary>
      {view.decisions.length ? <ol>{view.decisions.slice(0, 20).map(decision => <li key={decision.id}><strong>{decision.kind === "retry_failed" ? "原失败任务重试" : "恢复接续"}</strong> · {date(decision.createdAt)}<p>{decision.reason}</p><small>登记者 {decision.actorId} · 来源 <ShortId value={decision.causeId} />{decision.evidenceRef && ` · 依据 ${decision.evidenceRef}`}</small></li>)}</ol> : <p>尚无正式恢复决定；阶段变化不能当作已批准。</p>}
    </details>
  </section>;
}

export function SessionRecoveryResources({ read }: { read: RecoveryRead }) {
  if (read.status !== "ready") return <div className="session-recovery-resources"><h3>恢复配置与队列预算</h3><Unavailable read={read} /></div>;
  const { view } = read;
  const profile = view.executionProfile;
  const active = profile && profile.activeRevisionId === profile.revision.revisionId && profile.activationState === "active";
  return <div className="session-recovery-resources">
    <h3>恢复配置与队列预算</h3>
    {profile ? <p>登记模型：<strong>{profile.revision.model ?? "未显式指定"}</strong> · {profile.activationState === "active" && !active ? "当前激活的是其他修订" : recoveryActivationLabel(profile.activationState)}。{active ? "该登记修订已激活。" : profile.activeRevisionId ? "本次目标修订尚未确认激活。" : "没有已核实的原生配置修订。"}<small>配置修订于 {date(profile.revision.createdAt)}；这是登记的启动配置，不是逐次实际运行模型记录。</small></p> : <p>没有可读取的执行配置记录；模型与激活状态未知。</p>}
    {view.queues.length ? <ul className="session-recovery-budgets">{view.queues.slice(0, 20).map(queue => { const budget = recoveryBudget(queue); return <li key={queue.queueId}><span>原队列 <ShortId value={queue.queueId} /></span><strong>累计尝试 {budget.used} / 上限 {budget.max} · 剩余 {budget.remaining}</strong></li>; })}</ul> : <p>当前读取范围没有队列预算记录，不能推定为零消耗。</p>}
    <p className="session-recovery-note">累计尝试包含失败和结果未知的尝试，不会退还；这是原业务队列预算，不含普通消息的独立额度，也不等于实际模型调用次数。</p>
    {view.partial && <p className="session-recovery-partial">队列读取范围不完整；可到任务队列核对其余条目。</p>}
    <small>恢复观察读于 {date(view.observedAtUtc)}；正式记录的时间分别显示在对应条目。</small>
  </div>;
}
