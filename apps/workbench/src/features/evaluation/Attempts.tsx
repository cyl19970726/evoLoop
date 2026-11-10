// One condition's attempts: each real run with what it was sent, what it delivered, how it was used, what it cost and
// how it was judged; failures and unknown results stay in the record. Below them, the form for the next attempt.
import { useState } from "react";
import type { EvaluationAssessment, EvaluationAttempt, EvaluationRevision, RuntimeRunRecord, RuntimeSessionRecord, TaskDetail } from "@evoloop/contracts";
import { Button, Notice, StatusTag, cn } from "@evoloop/ui";
import { errorText, safeArtifactHref } from "../../shared/api";
import { option, reasonField, type MutationContext } from "../../shared/ActionForm";
import { appPath } from "../../shared/appPath";
import { activeFullExecution } from "../../shared/fullExecution";
import { isRoleOwnerId } from "../../shared/ownerRole";
import { date } from "../../shared/ui/shared";
import { EvaluationForm } from "./EvaluationForm";
import { useNativeOutput, usePacket } from "./evaluationReads";
import { FixedRefLine, IdentityDetails, linkClass, muted, refRows } from "./parts";
import {
  actorKindLabels, assessmentLabels, attemptRunText, attemptsForCondition, correctedPosition, costText, currentAssessments, deliveriesForAttempt,
  fixedRefLineHint, labelOf, observationResultLabels, parseCostLines, parseFixedRefLines, runCostText, runStateLabels, runStateTones, technicalResultLabels, type ReadState,
} from "./presentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

type Deliveries = NonNullable<TaskDetail["deliveries"]>;
type Observations = NonNullable<TaskDetail["observations"]>;
const block = "flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted px-3 py-2.5";
const pre = "m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-field p-3 font-mono text-caption text-foreground";
const taskHref = (projectId: string, taskId: string, revisionId?: string) =>
  `/p/${projectId}/tasks/${taskId}${revisionId ? `?revision=${encodeURIComponent(revisionId)}` : ""}`;

export function AttemptRecord({ context, revision, attempt, run, runsState, task, taskState, assessments, hold, titles }: {
  context: MutationContext; revision: EvaluationRevision; attempt: EvaluationAttempt; run: RuntimeRunRecord | undefined; runsState: ReadState;
  task: TaskDetail | undefined; taskState: ReadState; assessments: EvaluationAssessment[]; hold?: string | undefined; titles?: Record<string, string> | undefined;
}) {
  const projectId = context.projectId;
  const taskId = revision.definition.case.taskId;
  const [packetAsked, setPacketAsked] = useState(false);
  const [nativeAsked, setNativeAsked] = useState(false);
  const packet = usePacket(projectId, revision, attempt.id, packetAsked);
  const native = useNativeOutput(projectId, revision.evaluationId, attempt.runId, nativeAsked);
  const deliveries = deliveriesForAttempt(attempt, taskId, task?.deliveries ?? []);
  const observations = (task?.observations ?? []).filter(item => deliveries.some(delivery => delivery.id === item.deliveryId));
  const readError = (packet.isError && errorText(packet.error)) || (native.isError && errorText(native.error)) || "";
  return <article aria-label={`尝试 ${attempt.ordinal}`} className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
    <header className="flex flex-wrap items-center gap-2">
      <h3 className="text-small font-semibold text-foreground">尝试 {attempt.ordinal}</h3>
      {run ? <StatusTag tone={runStateTones[run.state] ?? "unknown"} label={labelOf(runStateLabels, run.state)} />
        : <span className={muted}>{attemptRunText(undefined, runsState)}</span>}
    </header>
    <p className={cn(muted, "m-0")}>派发于 {date(attempt.createdAt)} · {attempt.actorId}；本次尝试不会覆盖此前失败或未知。</p>
    <p className="m-0 text-small"><a className={linkClass} href={taskHref(projectId, taskId, attempt.actualTaskRevisionId)}>阅读本次实际执行修订 ↗</a>
      <span className={muted}> 由固定来源修订派生，两者不是同一版本。</span></p>
    <IdentityDetails rows={[["尝试 ID", attempt.id], ["运行 ID", attempt.runId], ["智能体 ID", attempt.sessionId],
      ["来源任务修订", attempt.sourceTaskRevisionId], ["实际执行修订", attempt.actualTaskRevisionId]]} />

    {!run ? runsState === "read" ? <Notice tone="error">对应运行尚未读到，不能推断执行或成本。</Notice>
      : runsState === "failed" ? <Notice tone="waiting">运行记录没有读回，不能推断执行或成本。</Notice>
        : <p className={cn(muted, "m-0")}>正在读取这次运行的记录…</p>
      : <div className={block}>
        {run.state === "unknown" && <p className="m-0 text-small text-foreground">结果未知；先沿同一运行与智能体核对，不能视为失败后自动重试。</p>}
        <p className="m-0 text-small text-text-secondary">成本（运行报告）：{runCostText(run)}</p>
        {run.evaluationPacket ? <div className="flex flex-col gap-1.5">
          <p className="m-0 text-small text-foreground">实际发送包已封存 · 构建版本 {run.evaluationPacket.builderVersion}</p>
          <Button size="compact" className="w-fit" disabled={packet.isFetching} onClick={() => packetAsked ? void packet.refetch() : setPacketAsked(true)}>{packet.isFetching ? "读取中…" : "读取固定输入包"}</Button>
          {packet.data && <details className="text-small"><summary className="cursor-pointer text-text-secondary">实际输入内容与来源清单</summary>
            <div className="mt-2 flex flex-col gap-2">
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{packet.data.sources.map((ref, index) => <li key={`${ref.kind}:${ref.id}:${index}`}><FixedRefLine value={ref} projectId={projectId} titles={titles} /></li>)}</ul>
              <pre className={pre}>{packet.data.content}</pre>
              <IdentityDetails label="输入包标识" rows={[["包 SHA-256", packet.data.contentHash], ["清单 SHA-256", packet.data.manifestHash], ...refRows("来源", packet.data.sources)]} />
            </div></details>}
          <IdentityDetails label="封存记录的哈希" rows={[["包 SHA-256", run.evaluationPacket.contentHash], ["清单 SHA-256", run.evaluationPacket.manifestHash]]} />
        </div> : <p className={cn(muted, "m-0")}>尚无已封存输入包；不能把定义材料当作实际发送内容。</p>}
        {run.resultSummary && <p className="m-0 whitespace-pre-wrap break-words text-small text-foreground"><strong className="font-semibold">已存结果摘要：</strong>{run.resultSummary}</p>}
        {run.nativeTurnId && <Button size="compact" className="w-fit" disabled={native.isFetching} onClick={() => nativeAsked ? void native.refetch() : setNativeAsked(true)}>{native.isFetching ? "读取中…" : "读取原始输出"}</Button>}
        {native.data && <details open className="text-small"><summary className="cursor-pointer text-text-secondary">原始输出 · {native.data.finalPhaseConfirmed ? "最终阶段已确认" : "最终阶段未确认"}</summary>
          <div className="mt-2 flex flex-col gap-2">{native.data.messages.map((message, index) => <pre key={index} className={pre}>{message}</pre>)}</div></details>}
      </div>}
    {readError && <Notice tone="error">{readError}<ErrorDetails error={packet.isError ? packet.error : native.error} /></Notice>}

    <section aria-label={`尝试 ${attempt.ordinal} 的交付与使用`} className={block}>
      <h4 className="text-label font-semibold text-foreground">本次实际交付</h4>
      {!task ? <p className={cn(muted, "m-0")}>{taskState === "loading" ? "正在读取交付与使用记录…" : "共同任务没有读回，无法判断这次有没有交付与使用记录。"}</p> : <>
        {taskState === "failed" && <p className={cn(muted, "m-0")}>共同任务重读失败；下面是上次读回的交付与使用记录，当前待核对。</p>}
        {!deliveries.length && <p className="m-0 text-small text-text-secondary">{taskState === "read"
          ? "未读到明确归属这次运行的交付；旧的无归属记录不会自动套入。运行终态也不代表产物合格。"
          : taskState === "loading" ? "正在核对这次有没有交付…" : "无法判断这次有没有交付。"}</p>}
        {deliveries.map(delivery => <DeliveryLine key={delivery.id} projectId={projectId} delivery={delivery} />)}
        <h4 className="mt-1 text-label font-semibold text-foreground">本次交付的使用记录</h4>
        {!observations.length && <p className="m-0 text-small text-text-secondary">{taskState === "read"
          ? "未读到本次交付的使用记录；智能体使用不等于真人后果。"
          : taskState === "loading" ? "正在核对本次交付有没有使用记录…" : "无法判断本次交付有没有使用记录。"}</p>}
        {observations.map(item => <div key={item.id} className="flex min-w-0 flex-col gap-0.5">
          <p className="m-0 break-words text-small text-foreground">{labelOf(actorKindLabels, item.observerKind, "未识别的身份")} {item.observer} · {labelOf(observationResultLabels, item.result)} · {item.evidence}</p>
          <IdentityDetails rows={[["使用记录 ID", item.id], ["交付 ID", item.deliveryId]]} />
        </div>)}
      </>}
    </section>

    <section aria-label={`尝试 ${attempt.ordinal} 的判定与成本`} className="flex min-w-0 flex-col gap-2">
      <h4 className="text-label font-semibold text-foreground">署名判定与成本</h4>
      <p className={cn(muted, "m-0")}>身份和署名只说明谁登记；实际判断是否独立，应由本次理由与证据说明。</p>
      {!assessments.length && <p className="m-0 text-small text-text-secondary">尚无逐次判定；运行终态不代替评价。</p>}
      {assessments.map(item => <AssessmentRecord key={item.id} item={item} all={assessments} projectId={projectId} deliveries={deliveries} observations={observations} taskState={taskState} titles={titles} />)}
      <AssessmentForm context={context} revision={revision} attempt={attempt} assessments={assessments} deliveries={deliveries} observations={observations} taskState={taskState} hasTask={!!task} hold={hold} />
    </section>
  </article>;
}

function DeliveryLine({ projectId, delivery }: { projectId: string; delivery: Deliveries[number] }) {
  const artifact = safeArtifactHref(delivery.artifactRef, projectId);
  const local = artifact ? appPath(artifact) : null;
  return <div className="flex min-w-0 flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
    <p className="m-0 text-small text-foreground">{labelOf(technicalResultLabels, delivery.technicalResult, "技术检查结果未识别")} · 登记于 {date(delivery.createdAt)}</p>
    <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-small">
      {artifact ? <a className={linkClass} href={artifact} target={local ? undefined : "_blank"} rel={local ? undefined : "noopener noreferrer"}>阅读交付引用 ↗</a> : <span className="text-text-secondary">原引用不可安全打开</span>}
      <a className={linkClass} href={taskHref(projectId, delivery.taskId, delivery.taskRevisionId)}>任务里的登记修订 ↗</a>
    </p>
    <p className={cn(muted, "m-0")}>声明来源为这次运行；这项归属不证明产物字节由模型生成。</p>
    <IdentityDetails label="核对原始位置、版本与哈希" rows={[["交付 ID", delivery.id], ["原始位置", delivery.artifactRef], ["固定修订", delivery.artifactRevision],
      ["SHA-256", delivery.contentHash], ["登记修订", delivery.taskRevisionId], ["声明来源运行", delivery.runId ?? "未声明"]]} />
  </div>;
}

function AssessmentRecord({ item, all, projectId, deliveries, observations, taskState, titles }: {
  item: EvaluationAssessment; all: EvaluationAssessment[]; projectId: string; deliveries: Deliveries; observations: Observations; taskState: ReadState; titles?: Record<string, string> | undefined;
}) {
  const position = correctedPosition(item, all);
  const delivery = item.deliveryId ? deliveries.find(row => row.id === item.deliveryId) : undefined;
  const observation = item.observationId ? observations.find(row => row.id === item.observationId) : undefined;
  const pending = taskState === "loading" ? "正在读取" : taskState === "failed" ? "没有读回" : "未读到";
  const bound = (id: string | null, text: string | undefined) => !id ? "未绑定" : text ?? `已绑定（记录${pending}）`;
  return <div className={block}>
    <p className="m-0 text-small font-medium text-foreground">{item.supersedesId ? position ? `更正第 ${position} 条判定` : "更正此前判定（原判定未读到）" : "署名判定"} · {labelOf(actorKindLabels, item.assessorKind, "未识别的身份")} {item.actorId}</p>
    <p className="m-0 break-words text-small text-text-secondary">来源：{labelOf(assessmentLabels.sourceFidelity, item.values.sourceFidelity)} · 知识：{labelOf(assessmentLabels.knowledgeAdoption, item.values.knowledgeAdoption)} · 交付：{labelOf(assessmentLabels.deliveryQuality, item.values.deliveryQuality)} · 真人后果：{labelOf(assessmentLabels.humanEffect, item.values.humanEffect)}</p>
    <p className="m-0 break-words text-small text-text-secondary">绑定交付：{bound(item.deliveryId, delivery && `${labelOf(technicalResultLabels, delivery.technicalResult, "技术检查结果未识别")} · 登记于 ${date(delivery.createdAt)}`)} · 使用记录：{bound(item.observationId, observation && `${labelOf(observationResultLabels, observation.result)} · ${observation.observer}`)}</p>
    {!item.costs.length ? <p className="m-0 text-small text-text-secondary">成本：未记录，不视为零。</p>
      : <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-small text-text-secondary">{item.costs.map((cost, index) => <li key={index}>{costText(cost)}</li>)}</ul>}
    <p className="m-0 whitespace-pre-wrap break-words text-small text-foreground">{item.reason}</p>
    {item.evidence.length > 0 && <ul className="m-0 flex list-none flex-col gap-1 p-0">{item.evidence.map((ref, index) => <li key={index}><FixedRefLine value={ref} projectId={projectId} titles={titles} /></li>)}</ul>}
    <p className={cn(muted, "m-0")}>{date(item.createdAt)}</p>
    <IdentityDetails rows={[["判定 ID", item.id], ...item.supersedesId ? [["更正的判定 ID", item.supersedesId] as [string, string]] : [],
      ...item.deliveryId ? [["交付 ID", item.deliveryId] as [string, string]] : [], ...item.observationId ? [["使用记录 ID", item.observationId] as [string, string]] : [],
      ...refRows("证据", item.evidence)]} />
  </div>;
}

function AssessmentForm({ context, revision, attempt, assessments, deliveries, observations, taskState, hasTask, hold }: {
  context: MutationContext; revision: EvaluationRevision; attempt: EvaluationAttempt; assessments: EvaluationAssessment[];
  deliveries: Deliveries; observations: Observations; taskState: ReadState; hasTask: boolean; hold?: string | undefined;
}) {
  const direct = revision.definition.conditions.find(item => item.id === attempt.conditionId)?.kind === "direct";
  const unread = !hasTask
    ? taskState === "failed" ? "共同任务没有读回，交付与使用记录暂不能选择。" : "交付与使用记录正在读取，暂不能选择。"
    : taskState === "failed" ? "共同任务重读失败；可选项来自上次读回，当前待核对。" : undefined;
  return <EvaluationForm context={{ ...context, draftScope: `evaluation-assessment:${attempt.id}`, draftBaseline: revision.id }} review hold={hold}
    title={assessments.length ? "追加更正判定" : "记录本次判定"} fields={[
      { name: "supersedesId", label: "更正此前判定（可选）", kind: "select", optional: true, options: currentAssessments(assessments).map(item => option(item.id, `${labelOf(actorKindLabels, item.assessorKind, "未识别的身份")} ${item.actorId} · ${date(item.createdAt)}`)) },
      { name: "deliveryId", label: "本次实际交付（可选）", kind: "select", optional: true, hint: unread, options: deliveries.map(item => option(item.id, `${labelOf(technicalResultLabels, item.technicalResult, "技术检查结果未识别")} · 登记于 ${date(item.createdAt)}`)) },
      { name: "observationId", label: "本次交付的使用记录（可选）", kind: "select", optional: true, hint: unread, options: observations.map(item => option(item.id, `${labelOf(actorKindLabels, item.observerKind, "未识别的身份")} ${item.observer} · ${labelOf(observationResultLabels, item.result)}`)) },
      { name: "sourceFidelity", label: "固定来源使用", kind: "select", options: [option("qualified", "符合"), option("failed", "失败"), option("unknown", "未知"), option("needs_review", "待复核")] },
      { name: "knowledgeAdoption", label: "知识采用", kind: "select", value: direct ? "not_applicable" : "", options: direct ? [option("not_applicable", "直接条件：不适用")] : [option("correct", "正确采用"), option("misused", "误用"), option("not_used", "未采用"), option("not_observed", "未观察到"), option("needs_review", "待复核")] },
      { name: "deliveryQuality", label: "交付质量", kind: "select", options: [option("qualified", "合格"), option("failed", "失败"), option("unknown", "未知"), option("needs_review", "待复核")] },
      { name: "humanEffect", label: "真人使用后果", kind: "select", options: [option("observed", "有真实人类证据"), option("unknown", "未知"), option("needs_review", "待复核")] },
      { name: "assessorKind", label: "本次判定者身份", kind: "select", options: [option("agent", "智能体"), option("human", "真人（需本人判断）")] },
      { name: "costs", label: "成本逐项记录（可留空=未记录）", kind: "textarea", optional: true, hint: "每行：阶段 | 单位 | 非负数或未测 | 来源。更正时重新填本次完整成本；不同单位不合计；0 只在确实测得零时填写。" },
      { name: "evidence", label: "固定证据（可选）", kind: "textarea", optional: true, hint: fixedRefLineHint }, reasonField,
    ]} build={values => ({ type: "evaluation.assessment.record", evaluationId: revision.evaluationId, revisionId: revision.id,
      assessmentId: crypto.randomUUID(), attemptId: attempt.id, deliveryId: values.deliveryId || null, observationId: values.observationId || null,
      supersedesId: values.supersedesId || null,
      values: { sourceFidelity: values.sourceFidelity, knowledgeAdoption: direct ? "not_applicable" : values.knowledgeAdoption, deliveryQuality: values.deliveryQuality, humanEffect: values.humanEffect },
      costs: parseCostLines(values.costs ?? ""), evidence: parseFixedRefLines(values.evidence ?? "", ["document", "git", "wiki", "delivery", "evidence"]),
      assessorKind: values.assessorKind, reason: values.reason,
    })} />;
}

export function RunForm({ context, revision, conditionId, task, sessions, runs, attempts, roleTitles, hold }: {
  context: MutationContext; revision: EvaluationRevision; conditionId: string; task: TaskDetail; sessions: RuntimeSessionRecord[];
  runs: RuntimeRunRecord[]; attempts: EvaluationAttempt[]; roleTitles: Record<string, string> | undefined; hold?: string | undefined;
}) {
  const condition = revision.definition.conditions.find(item => item.id === conditionId)!;
  const fullExecution = condition.environment.sandbox === "danger-full-access" && condition.environment.approvalPolicy === "never";
  const fresh = fullExecution ? sessions.filter(session => activeFullExecution(session) && session.roleId === task.task.owner && session.model === condition.model
    && session.cwd === condition.environment.cwd && session.authorizationScope === condition.environment.authorizationScope
    && session.sandbox === condition.environment.sandbox && session.approvalPolicy === condition.environment.approvalPolicy
    && !runs.some(run => run.sessionId === session.id)) : [];
  const active = runs.some(run => run.taskId === task.task.id && ["requested", "dispatching", "running", "unknown"].includes(run.state));
  const nextOrdinal = attemptsForCondition(revision, attempts, conditionId).length + 1;
  // A role is shown by its name whenever it can be read; only an older, non-UUID role key that has no record is shown as written.
  const agentName = (session: RuntimeSessionRecord) => roleTitles?.[session.roleId] ?? (isRoleOwnerId(session.roleId) ? "职责名称待核对" : session.roleId);
  return <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-4">
    <h3 className="text-small font-semibold text-foreground">第 {nextOrdinal} 次尝试 / 重试</h3>
    {active && <Notice tone="waiting">共同任务已有运行中或结果未知的尝试。先核对同一运行，不能重发。</Notice>}
    {!fullExecution && <Notice>此历史定义保留旧执行权限，只供回读；新尝试请先另存完整权限的定义修订。</Notice>}
    {fullExecution && !fresh.length && <p className="m-0 text-small text-text-secondary">没有符合冻结模型、授权与已激活执行配置的全新自有智能体。先在<a className={linkClass} href={`/p/${context.projectId}/runtime?view=execution`}>分工与运行</a>创建并核对激活；用过的智能体不可复用。</p>}
    {!active && fresh.length > 0 && <EvaluationForm key={`${revision.id}:${conditionId}:${task.task.version}`} review hold={hold}
      context={{ ...context, draftScope: `evaluation-run:${revision.id}:${conditionId}`, draftBaseline: `${revision.id}:${task.task.currentRevisionId}` }}
      title={`派发第 ${nextOrdinal} 次真实运行`} fields={[
        { name: "sessionId", label: "全新的自有智能体", kind: "select", options: fresh.map(session => option(session.id, `${agentName(session)} · ${session.model} · 创建于 ${date(session.createdAt)}`)) },
      ]} build={values => ({ type: "runtime.run.reserve", runId: crypto.randomUUID(), taskId: task.task.id,
        sessionId: values.sessionId, expectedVersion: task.task.version, input: revision.definition.case.commonInput,
        evaluation: { evaluationId: revision.evaluationId, revisionId: revision.id, caseId: revision.definition.case.id, conditionId } })} />}
    <p className={cn(muted, "m-0")}>派发前会核对原共同任务签名；每次自动登记尝试和实际执行修订。失败、未知与重试各自保留。</p>
  </div>;
}
