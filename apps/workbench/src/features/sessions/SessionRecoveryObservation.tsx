// Recovery of one owned agent, in the right column: where recovery stands, why, and what comes next; the formal
// decisions and the execution queue budget. Original reasons, state codes and identifiers sit in the source layer.
import { FactList, mutedText } from "../../shared/ui/PageParts";
import { FullIdentifiers, type IdentifierRow } from "../../shared/ui/FullIdentifiers";
import { date } from "../../shared/ui/shared";
import type { RecoveryRead } from "./recoveryPresentation";
import { permissionLabel, recoveryActivationLabel, recoveryBudget, recoveryCauseLabel, recoveryNextActionLabel, recoveryPhaseLabel, recoveryReasonSummary, recoverySourceStateLabel } from "./recoveryPresentation";

const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const heading = "text-label font-semibold text-foreground";
const note = "text-caption text-text-secondary [overflow-wrap:anywhere]";
const partialNote = "rounded-md bg-warning-soft px-3 py-2 text-caption text-foreground [overflow-wrap:anywhere]";

function Unavailable({ read }: { read: Exclude<RecoveryRead, { status: "ready" }> }) {
  const label = read.status === "loading" ? "正在读取恢复记录…" : read.status === "unavailable" ? "恢复信息暂不可读取。" : read.status === "forbidden" ? "当前身份无权读取恢复记录。" : "恢复记录暂不可读取。";
  return <p className={read.status === "loading" ? mutedText : "text-caption text-text-secondary"} role={read.status === "loading" ? "status" : "alert"}>{label}{read.status !== "loading" && <span> {read.message}</span>}</p>;
}

export function SessionRecoveryOverview({ read, runtimeState, queueHref }: { read: RecoveryRead; runtimeState: string | null; queueHref: string }) {
  if (read.status !== "ready") return <section className="session-recovery-overview flex min-w-0 flex-col gap-2" aria-label="恢复进度"><h3 className={heading}>恢复进度</h3><Unavailable read={read} /></section>;
  const { view } = read;
  const gate = view.gate;
  const sources: IdentifierRow[] = gate ? [
    { label: "原始原因", value: gate.reason || "原始原因未记录", text: true },
    { label: "状态代码", value: gate.causeState ?? "原始状态未记录", text: true },
    { label: gate.phase === "open" ? "最近停止或恢复来源" : "失败或等待来源", value: gate.causeId },
    { label: gate.phase === "reworking" ? "获准返工的运行" : "获准重试的运行", value: gate.phase === "retrying" || gate.phase === "reworking" ? gate.retryRunId : null },
    { label: "等待的原消息", value: gate.phase === "message_pending" ? gate.resumeMessageId : null },
    { label: "等待验收放行的承接", value: gate.phase === "awaiting_acceptance" ? gate.claimId : null },
    { label: "最近采用决定的操作", value: gate.decisionOperationId },
  ] : [];
  return <section className="session-recovery-overview flex min-w-0 flex-col gap-2.5" aria-label="恢复进度">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className={heading}>恢复进度</h3><small className={mutedText}>读取于 {date(view.observedAtUtc)}</small></div>
    {gate ? <>
      <FactList rows={[
        ["当前阶段", runtimeState === "closed" && gate.phase === "open" ? "恢复门未限制；会话已关闭" : recoveryPhaseLabel(gate.phase)],
        [gate.phase === "open" ? "最近停止或恢复的说明" : "停止或等待原因", recoveryReasonSummary(gate)],
        ["下一步", recoveryNextActionLabel(view.nextAction, runtimeState)],
      ]} />
      {runtimeState === "closed" && <p className={note}>这个受管智能体已关闭；恢复阶段不能使它直接接续。请先核对会话生命周期与授权。</p>}
      {gate.causeKind && <p className={mutedText}>{gate.phase === "open" ? "最近来源" : "来源"}：{recoveryCauseLabel(gate.causeKind)}{gate.causeState && ` · 保存状态：${recoverySourceStateLabel(gate.causeState)}`} · 更新于 {date(gate.updatedAt)}</p>}
      {gate.phase === "retrying" && <p className={note}>仅已批准的原任务重试可接续；其他任务与消息仍等待。实际是否运行请核对运行记录。</p>}
      {gate.phase === "reworking" && <p className={note}>仅本次获准的原任务返工可启动；其他任务和普通消息继续等待。</p>}
      {gate.phase === "blocked" && <p className={note}>后续任务与普通消息不可启动；需要先核对失败或未知结果，再由负责人决定恢复。</p>}
      {gate.phase === "message_pending" && <p className={note}>仅原排队消息可接续；实际处理和回复请核对消息记录。</p>}
      {gate.phase !== "open" && gate.causeState === "unknown" && <p className={note}>原结果未知，先按原操作和记录对账，不能据此重试。</p>}
      {gate.phase === "awaiting_acceptance" && <p className={note}>新任务与消息仍等待交付、实际使用和验收放行。</p>}
      {gate.phase === "open" && <p className={note}>原消息占用、这一轮的原生状态和当前写入控制须另行核对；还需满足权限、额度、互斥、任务及交付条件。下一轮是否启动以实际记录为准。</p>}
      <FullIdentifiers summary="查看原始恢复原因与状态代码" rows={sources} />
    </> : <><p className={note}>没有持久恢复记录；这不代表所有运行已核实健康。{recoveryNextActionLabel(view.nextAction, runtimeState)}。</p>
      {runtimeState === "closed" && view.nextAction !== "normal_work" && <p className={note}>这个受管智能体已关闭；没有恢复记录也不能视为可直接接续。</p>}</>}
    {view.partial && <p className={partialNote}>本次恢复观察不完整：列表可能被截取，也可能有原始来源不可用。返回的恢复决定与队列各最多展示 20 条，不能据此确认全部历史或来源状态。<a className="text-primary hover:underline" href={queueHref}>查看现有受管队列与尝试</a>；恢复决定请按完整标识精确核对。</p>}
    <details className="min-w-0 text-label text-text-secondary [&>summary]:w-fit [&>summary]:cursor-pointer hover:[&>summary]:text-foreground"><summary>正式恢复决定 · 本次返回 {Math.min(view.decisions.length, 20)} 条</summary>
      {view.decisions.length ? <ol className="mt-2 flex flex-col gap-2.5">{view.decisions.slice(0, 20).map(decision => <li key={decision.id} className="flex min-w-0 flex-col gap-0.5">
        <span><strong className="font-medium text-foreground">{decision.kind === "retry_failed" ? "原失败任务重试" : "恢复接续"}</strong> · {date(decision.createdAt)}</span>
        <p className="[overflow-wrap:anywhere]">{decision.reason}</p>
        <small className={mutedText}>登记者 {recordId.test(decision.actorId) ? "见完整标识" : decision.actorId}{decision.evidenceRef && ` · 依据 ${decision.evidenceRef}`}</small>
        <FullIdentifiers summary="决定来源" rows={[{ label: "决定来源", value: decision.causeId }, { label: "登记者", value: recordId.test(decision.actorId) ? decision.actorId : null }]} />
      </li>)}</ol> : <p className="mt-1.5">尚无正式恢复决定；阶段变化不能当作已批准。</p>}
    </details>
  </section>;
}

export function SessionRecoveryResources({ read, queueHref }: { read: RecoveryRead; queueHref: string }) {
  if (read.status !== "ready") return <div className="flex min-w-0 flex-col gap-2"><h3 className={heading}>恢复配置与队列预算</h3><Unavailable read={read} /></div>;
  const { view } = read;
  const profile = view.executionProfile;
  const active = profile && profile.activeRevisionId === profile.revision.revisionId && profile.activationState === "active";
  const activationLabel = profile?.activationState === "active" && !active
    ? profile.activeRevisionId ? "当前激活的是其他修订" : "激活记录待核对"
    : profile ? recoveryActivationLabel(profile.activationState) : "";
  const queues = view.queues.slice(0, 20);
  return <div className="flex min-w-0 flex-col gap-2">
    <h3 className={heading}>恢复配置与队列预算</h3>
    {profile ? <p className="text-small text-text-secondary [overflow-wrap:anywhere]">目标配置 v{profile.revision.version}：模型 <strong className="font-medium text-foreground">{profile.revision.model ?? "未显式指定"}</strong> · {permissionLabel(profile.revision.sandbox, profile.revision.approvalPolicy)} · {activationLabel}。{active ? "该登记修订已激活。" : profile.activeRevisionId ? "本次目标修订尚未确认激活；之前的激活修订仍单独保留。" : "没有已核实的原生配置修订。"}
      <small className={`${mutedText} mt-1 block`}>配置修订于 {date(profile.revision.createdAt)}；这是登记的启动配置，不是逐次实际运行模型或联网结果的记录。</small></p>
      : <p className="text-small text-text-secondary">没有可读取的执行配置记录；模型与激活状态未知。</p>}
    {queues.length ? <ul className="flex flex-col">{queues.map((queue, index) => { const budget = recoveryBudget(queue); return <li key={queue.queueId} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 border-t border-border py-1.5 text-caption first:border-t-0">
      <span className="text-text-secondary">执行队列 {index + 1}</span><strong className="font-medium text-foreground">累计尝试 {budget.used} / 上限 {budget.max} · 剩余 {budget.remaining}</strong></li>; })}</ul>
      : <p className="text-small text-text-secondary">当前读取范围没有队列预算记录，不能推定为零消耗。</p>}
    <p className={note}>累计尝试包含失败和结果未知的尝试，不会退还；这是原业务队列预算，不含普通消息的独立额度，也不等于实际模型调用次数。</p>
    {view.partial && <p className={partialNote}>本次恢复观察不完整：列表可能被截取，也可能有原始来源不可用；不能据此确认全部历史或来源状态。<a className="text-primary hover:underline" href={queueHref}>查看现有受管队列与尝试</a>；恢复决定请按完整标识核对。</p>}
    <small className={mutedText}>恢复观察读于 {date(view.observedAtUtc)}；正式记录的时间分别显示在对应条目。</small>
    <FullIdentifiers rows={[
      { label: "目标配置修订", value: profile?.revision.revisionId }, { label: "已激活修订", value: profile?.activeRevisionId },
      ...queues.map((queue, index) => ({ label: `执行队列 ${index + 1}`, value: queue.queueId })),
    ]} />
  </div>;
}
