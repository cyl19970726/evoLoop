import { date, ShortId } from "../ui/shared";
import type { RecoveryRead } from "./recoveryPresentation";
import { recoveryActivationLabel, recoveryBudget, recoveryCauseLabel, recoveryNextActionLabel, recoveryPhaseLabel, recoveryReasonSummary, recoverySourceStateLabel } from "./recoveryPresentation";

function FullRecoveryId({ label, value }: { label: string; value: string }) {
  return <details className="session-recovery-full-id"><summary>{label} <ShortId value={value} /> · 查看完整 ID</summary><code>{value}</code></details>;
}

function Unavailable({ read }: { read: Exclude<RecoveryRead, { status: "ready" }> }) {
  const label = read.status === "loading" ? "正在读取恢复记录…" : read.status === "unavailable" ? "恢复信息暂不可读取。" : read.status === "forbidden" ? "当前身份无权读取恢复记录。" : "恢复记录暂不可读取。";
  return <p className="session-recovery-unavailable" role={read.status === "loading" ? "status" : "alert"}>{label}{read.status !== "loading" && <span> {read.message}</span>}</p>;
}

export function SessionRecoveryOverview({ read, runtimeState, queueHref }: { read: RecoveryRead; runtimeState: string | null; queueHref: string }) {
  if (read.status !== "ready") return <section className="session-recovery-overview" aria-label="恢复进度"><h2>恢复进度</h2><Unavailable read={read} /></section>;
  const { view } = read;
  const gate = view.gate;
  return <section className="session-recovery-overview" aria-label="恢复进度">
    <div className="session-recovery-heading"><h2>恢复进度</h2><small>读取于 {date(view.observedAtUtc)}</small></div>
    {gate ? <>
      <div className="session-recovery-facts"><div><small>当前阶段</small><strong>{runtimeState === "closed" && gate.phase === "open" ? "恢复门开放；会话已关闭" : recoveryPhaseLabel(gate.phase)}</strong></div><div><small>{gate.phase === "open" ? "最近停止或恢复的说明" : "停止或等待原因"}</small><strong>{recoveryReasonSummary(gate)}</strong></div><div><small>下一动作</small><strong>{recoveryNextActionLabel(view.nextAction, runtimeState)}</strong></div></div>
      {runtimeState === "closed" && <p className="session-recovery-note">该受管 Session 已关闭；恢复阶段不能使它直接接续。请先核对会话生命周期与授权。</p>}
      {gate.causeKind && <p className="session-recovery-context">{gate.phase === "open" ? "最近来源" : "来源"}：{recoveryCauseLabel(gate.causeKind)}{gate.causeId && <> <ShortId value={gate.causeId} /></>}{gate.causeState && ` · 保存状态：${recoverySourceStateLabel(gate.causeState)}`} · 更新于 {date(gate.updatedAt)}</p>}
      <details className="session-recovery-full-id"><summary>查看原始恢复原因与状态代码</summary><p>{gate.reason || "原始原因未记录"}</p><code>{gate.causeState ?? "原始状态未记录"}</code></details>
      {gate.causeId && <FullRecoveryId label={gate.phase === "open" ? "最近停止或恢复来源" : "失败或等待来源"} value={gate.causeId} />}
      {gate.phase === "retrying" && <p className="session-recovery-note">仅已批准的原任务重试可接续；其他任务与消息仍等待。实际是否运行请核对 Run。</p>}
      {gate.phase === "retrying" && gate.retryRunId && <p className="session-recovery-context">获准重试的 Run：<ShortId value={gate.retryRunId} /></p>}
      {gate.phase === "retrying" && gate.retryRunId && <FullRecoveryId label="获准重试的 Run" value={gate.retryRunId} />}
      {gate.phase === "blocked" && <p className="session-recovery-note">后续任务与普通消息不可启动；需要先核对失败或未知结果，再由负责人决定恢复。</p>}
      {gate.phase === "message_pending" && <p className="session-recovery-note">仅原排队消息可接续；实际处理和回复请核对消息记录。</p>}
      {gate.phase === "message_pending" && gate.resumeMessageId && <p className="session-recovery-context">等待的原消息：<ShortId value={gate.resumeMessageId} /></p>}
      {gate.phase === "message_pending" && gate.resumeMessageId && <FullRecoveryId label="等待的原消息" value={gate.resumeMessageId} />}
      {gate.phase !== "open" && gate.causeState === "unknown" && <p className="session-recovery-note">原结果未知，先按原操作和记录对账，不能据此重试。</p>}
      {gate.phase === "awaiting_acceptance" && <p className="session-recovery-note">新任务与消息仍等待交付、实际使用和验收放行。</p>}
      {gate.phase === "awaiting_acceptance" && gate.claimId && <p className="session-recovery-context">等待验收放行的承接：<ShortId value={gate.claimId} /></p>}
      {gate.phase === "awaiting_acceptance" && gate.claimId && <FullRecoveryId label="等待验收放行的承接" value={gate.claimId} />}
      {gate.phase === "open" && <p className="session-recovery-note">仍需满足权限、额度、互斥、任务及交付条件。</p>}
      {gate.decisionOperationId && <FullRecoveryId label="最近采用决定的操作" value={gate.decisionOperationId} />}
    </> : <><p className="session-recovery-note">没有持久恢复记录；这不代表所有运行已核实健康。{recoveryNextActionLabel(view.nextAction, runtimeState)}。</p>
      {runtimeState === "closed" && view.nextAction !== "normal_work" && <p className="session-recovery-note">该受管 Session 已关闭；没有恢复记录也不能视为可直接接续。</p>}</>}
    {view.partial && <p className="session-recovery-partial">本次恢复观察不完整：列表可能被截取，也可能有原始来源不可用。返回的恢复决定与队列各最多展示 20 条，不能据此确认全部历史或来源状态。<a href={queueHref}>查看现有受管队列与尝试</a>；恢复决定请按上方完整来源或操作 ID 精确核对。</p>}
    <details className="session-recovery-decisions"><summary>正式恢复决定 · 本次返回 {Math.min(view.decisions.length, 20)} 条</summary>
      {view.decisions.length ? <ol>{view.decisions.slice(0, 20).map(decision => <li key={decision.id}><strong>{decision.kind === "retry_failed" ? "原失败任务重试" : "恢复接续"}</strong> · {date(decision.createdAt)}<p>{decision.reason}</p><small>登记者 {decision.actorId} · 来源 <ShortId value={decision.causeId} />{decision.evidenceRef && ` · 依据 ${decision.evidenceRef}`}</small><FullRecoveryId label="决定来源" value={decision.causeId} /></li>)}</ol> : <p>尚无正式恢复决定；阶段变化不能当作已批准。</p>}
    </details>
  </section>;
}

export function SessionRecoveryResources({ read, queueHref }: { read: RecoveryRead; queueHref: string }) {
  if (read.status !== "ready") return <div className="session-recovery-resources"><h3>恢复配置与队列预算</h3><Unavailable read={read} /></div>;
  const { view } = read;
  const profile = view.executionProfile;
  const active = profile && profile.activeRevisionId === profile.revision.revisionId && profile.activationState === "active";
  const activationLabel = profile?.activationState === "active" && !active
    ? profile.activeRevisionId ? "当前激活的是其他修订" : "激活记录待核对"
    : profile ? recoveryActivationLabel(profile.activationState) : "";
  return <div className="session-recovery-resources">
    <h3>恢复配置与队列预算</h3>
    {profile ? <p>登记模型：<strong>{profile.revision.model ?? "未显式指定"}</strong> · {activationLabel}。{active ? "该登记修订已激活。" : profile.activeRevisionId ? "本次目标修订尚未确认激活。" : "没有已核实的原生配置修订。"}<small>配置修订于 {date(profile.revision.createdAt)}；这是登记的启动配置，不是逐次实际运行模型记录。</small></p> : <p>没有可读取的执行配置记录；模型与激活状态未知。</p>}
    {view.queues.length ? <ul className="session-recovery-budgets">{view.queues.slice(0, 20).map(queue => { const budget = recoveryBudget(queue); return <li key={queue.queueId}><span>原队列 <ShortId value={queue.queueId} /></span><strong>累计尝试 {budget.used} / 上限 {budget.max} · 剩余 {budget.remaining}</strong></li>; })}</ul> : <p>当前读取范围没有队列预算记录，不能推定为零消耗。</p>}
    <p className="session-recovery-note">累计尝试包含失败和结果未知的尝试，不会退还；这是原业务队列预算，不含普通消息的独立额度，也不等于实际模型调用次数。</p>
    {view.partial && <p className="session-recovery-partial">本次恢复观察不完整：列表可能被截取，也可能有原始来源不可用；不能据此确认全部历史或来源状态。<a href={queueHref}>查看现有受管队列与尝试</a>；恢复决定请按完整来源或操作 ID 核对。</p>}
    <small>恢复观察读于 {date(view.observedAtUtc)}；正式记录的时间分别显示在对应条目。</small>
  </div>;
}
