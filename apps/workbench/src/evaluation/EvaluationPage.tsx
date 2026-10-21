import { useEffect, useState } from "react";
import type { EvaluationAssessment, EvaluationAttempt, EvaluationConclusion, EvaluationFixedRef, EvaluationRevision, RuntimeRunRecord, RuntimeSessionRecord, TaskDetail } from "@evoloop/contracts";
import { api, errorText, safeArtifactHref } from "../api";
import { date } from "../ui/shared";
import { ActionForm, Notice, option, reasonField, type MutationContext } from "../workflow/ActionForm";
import { runtimeClient, type NativeResult } from "../runtime/client";
import { DefinitionForm } from "./DefinitionForm";
import { assessmentLabels, attemptsForCondition, conclusionComparabilityOptions, costText, currentAssessments, evaluationHref, evaluationListHref, nextActionHref, parseCostLines, parseFixedRefLines, parseNextActionRef, type NextActionRef } from "./presentation";
import "./evaluation.css";

type EvaluationRead = Awaited<ReturnType<ReturnType<typeof api>["evaluation"]>>;
type Packet = Awaited<ReturnType<ReturnType<typeof api>["evaluationPacket"]>>;
const short = (value: string) => value.slice(0, 8);
const stateLabel: Record<string, string> = { requested: "待派发", dispatching: "派发中", running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断", unknown: "结果未知" };
const choiceLabel: Record<string, string> = { read_direct: "先读直接来源", adopt_with_limits: "带限制采用", maintain: "维持当前做法", research: "继续研究", wait: "等待证据", stop: "停止" };

function FixedRef({ value, projectId }: { value: EvaluationFixedRef; projectId: string }) {
  const link = value.kind === "document" && /^[0-9a-f-]{36}$/i.test(value.id) && /^[0-9a-f-]{36}$/i.test(value.revision)
    ? `#/p/${projectId}/documents/${value.id}?revision=${encodeURIComponent(value.revision)}`
    : value.kind === "wiki" && /^[0-9a-f-]{36}$/i.test(value.id) && /^[0-9a-f-]{36}$/i.test(value.revision)
      ? `#/p/${projectId}/knowledge/${value.id}?revision=${encodeURIComponent(value.revision)}` : null;
  return <span className="evaluation-ref">{link ? <a href={link}>{value.kind} {short(value.id)} · 固定版 {short(value.revision)} ↗</a> : <span>{value.kind} {value.id} · 固定版 {value.revision}</span>}<code title={value.contentHash}>SHA-256 {short(value.contentHash)}…</code></span>;
}

export function EvaluationPage({ context, evaluationId, selectedRevision, refresh, taskId, knowledgePageId }: { context: MutationContext; evaluationId?: string; selectedRevision?: string; refresh: number; taskId?: string; knowledgePageId?: string }) {
  const [list, setList] = useState<EvaluationRevision[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [read, setRead] = useState<EvaluationRead | null>(null);
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let active = true;
    setError(""); setRead(null); setList([]); setCursor(null);
    if (evaluationId) api(context.token).evaluation(context.projectId, evaluationId, selectedRevision)
      .then(value => { if (active) setRead(value); }).catch(cause => { if (active) setError(errorText(cause)); });
    else api(context.token).evaluations(context.projectId, undefined, taskId, knowledgePageId)
      .then(value => { if (active) { setList(value.items); setCursor(value.nextCursor); } }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, evaluationId, selectedRevision, taskId, knowledgePageId, refresh, epoch]);
  async function more() {
    if (!cursor) return;
    try { const result = await api(context.token).evaluations(context.projectId, cursor, taskId, knowledgePageId); setList(previous => [...previous, ...result.items]); setCursor(result.nextCursor); }
    catch (cause) { setError(errorText(cause)); }
  }
  return <div className="content evaluation-page">
    <div className="evaluation-heading"><div><a className="back" href={evaluationHref(context.projectId)}>评价</a><h1>{evaluationId ? "固定评价与实际尝试" : "评价"}</h1><p className="muted">同一共同任务、同一指令与环境下，逐次看真实运行、交付、成本和判断。失败与未知也保留。</p></div><button type="button" onClick={() => setEpoch(value => value + 1)}>回读当前记录</button></div>
    {error && <Notice error>{error}</Notice>}
    {!evaluationId ? <>
      <section className="panel"><h2>已建立的评价</h2>{!list.length && !error && <p className="empty">尚无评价定义。先准备进行中的共同任务与固定协议、材料和 Wiki 修订。</p>}
        <div className="evaluation-list">{list.map(item => <a key={`${item.evaluationId}:${item.id}`} href={evaluationListHref(context.projectId, item)}><strong>{item.definition.question}</strong><span>匹配定义 v{item.version} · 共同任务 {short(item.definition.case.taskId)} · {date(item.createdAt)}</span></a>)}</div>
        {cursor && <button type="button" onClick={() => void more()}>继续读取</button>}
      </section>
      <DefinitionForm context={context} ownerTaskId={taskId} onApplied={id => { window.location.hash = evaluationHref(context.projectId, id); }} />
    </> : read ? <EvaluationDetail key={`${read.revision.evaluationId}:${read.revision.id}`} context={context} read={read} selectedRevision={!!selectedRevision} onChanged={() => setEpoch(value => value + 1)} />
      : !error && <p>正在读取冻结定义与逐次记录…</p>}
  </div>;
}

function EvaluationDetail({ context, read, selectedRevision, onChanged }: { context: MutationContext; read: EvaluationRead; selectedRevision: boolean; onChanged: () => void }) {
  const { revision, revisions, attempts, assessments, conclusions } = read;
  const { definition } = revision;
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [runs, setRuns] = useState<RuntimeRunRecord[]>([]);
  const [sessions, setSessions] = useState<RuntimeSessionRecord[]>([]);
  const [sideError, setSideError] = useState("");
  const [sideEpoch, setSideEpoch] = useState(0);
  useEffect(() => {
    let active = true;
    setTask(null); setRuns([]); setSessions([]); setSideError("");
    Promise.all([api(context.token).task(context.projectId, definition.case.taskId),
      runtimeClient(context.token, context.projectId).runs(), runtimeClient(context.token, context.projectId).sessions()])
      .then(([taskValue, runRows, sessionRows]) => { if (active) { setTask(taskValue); setRuns(runRows); setSessions(sessionRows); } })
      .catch(cause => { if (active) setSideError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, definition.case.taskId, revision.id, sideEpoch]);
  const effective = currentAssessments(assessments);
  const current = revisions.every(item => item.version <= revision.version);
  return <>
    {selectedRevision && <Notice>正在阅读固定定义 v{revision.version}；尝试、判定与结论只取此修订，不与其他版本合并。<a href={evaluationHref(context.projectId, revision.evaluationId)}>回到最新定义 →</a></Notice>}
    <section className="panel evaluation-definition"><div className="panel-head"><h2>{definition.question}</h2><span>定义 v{revision.version} · {short(revision.id)}</span></div>
      <p><strong>比较边界：</strong>{definition.limits}</p><p><strong>公开判定条件：</strong>{definition.case.criteria}</p><p><strong>共同指令：</strong>{definition.case.commonInput}</p>
      <p>共同任务 <a href={`#/p/${context.projectId}/tasks/${definition.case.taskId}?revision=${encodeURIComponent(definition.case.sourceTaskRevisionId)}`}>{short(definition.case.taskId)} · 来源修订 {short(definition.case.sourceTaskRevisionId)} ↗</a>；运行将形成另一条实际修订，不把二者当同一 ID。</p>
      <div className="evaluation-fixed"><strong>协议</strong><FixedRef value={definition.protocol} projectId={context.projectId} /><strong>共用材料</strong>{definition.case.materials.map((ref, index) => <FixedRef key={`${ref.kind}:${ref.id}:${index}`} value={ref} projectId={context.projectId} />)}</div>
      <details><summary>核对共同任务的固定业务签名</summary><pre>{JSON.stringify(definition.case.sourceSignature, null, 2)}</pre></details>
      <p className="muted">没有隐藏答案隔离保证；同机工具能否访问其他来源尚未验证。一次 case 不得推出因果收益或统计胜者。</p>
    </section>
    <section className="panel"><div className="panel-head"><h2>定义版本</h2><span>修订追加，旧版不覆盖</span></div><div className="evaluation-revisions">{revisions.map(item => <a key={item.id} aria-current={item.id === revision.id ? "page" : undefined} href={evaluationHref(context.projectId, item.evaluationId, item.id)}>v{item.version} · {date(item.createdAt)} · {item.actorId}</a>)}</div></section>
    {sideError && <Notice error>任务或运行旁证读取失败：{sideError}。既有评价事实仍可读；运行状态不能据此猜测。</Notice>}
    <section className="evaluation-conditions">{definition.conditions.map(condition => <section className="panel evaluation-condition" key={condition.id}>
      <div className="panel-head"><h2>{condition.kind === "direct" ? "直接材料" : "加入固定 Wiki"}</h2><span>{attemptsForCondition(revision, attempts, condition.id).length} 次尝试</span></div>
      <p>模型 {condition.model} · {condition.environment.sandbox} · {condition.environment.approvalPolicy}</p><p className="evaluation-env">{condition.environment.cwd} · {condition.environment.authorizationScope}</p>
      {condition.kind === "direct" ? <p>Wiki：明确不适用；不从共同任务中删除必需来源。</p> : <div className="evaluation-fixed"><strong>本条件新增的 Wiki 固定来源</strong>{condition.wikiRefs?.map((ref, index) => <FixedRef key={`${ref.id}:${index}`} value={ref} projectId={context.projectId} />)}</div>}
      {attemptsForCondition(revision, attempts, condition.id).map(attempt => <AttemptCard key={attempt.id} context={context} revision={revision} attempt={attempt} run={runs.find(item => item.id === attempt.runId)} task={task} assessments={assessments.filter(item => item.attemptId === attempt.id)} onChanged={onChanged} />)}
      {!attemptsForCondition(revision, attempts, condition.id).length && <p className="empty">尚无真实尝试；条件定义本身不是运行结果。</p>}
      {!selectedRevision && current && task && <RunForm context={context} revision={revision} conditionId={condition.id} task={task} sessions={sessions} runs={runs} attempts={attempts} />}
    </section>)}</section>
    <section className="panel evaluation-conclusions"><h2>评价判定与下一步</h2>
      {!conclusions.length && <p className="empty">尚无结论。缺少两组真实尝试或成本时，只能明确限制或未知。</p>}
      {conclusions.map(item => <ConclusionRecord key={item.id} item={item} assessments={assessments} projectId={context.projectId} />)}
      {!selectedRevision && <ConclusionForm context={context} revision={revision} assessments={effective} conclusions={conclusions} />}
      <p className="muted">结论只留证，不自动采用知识、关闭任务或代表真人实际使用。</p>
    </section>
    {!selectedRevision && current && <DefinitionForm context={context} current={revision} onApplied={() => onChanged()} />}
    <button type="button" onClick={() => { setSideEpoch(value => value + 1); onChanged(); }}>重新读取来源与尝试</button>
  </>;
}

function RunForm({ context, revision, conditionId, task, sessions, runs, attempts }: { context: MutationContext; revision: EvaluationRevision; conditionId: string; task: TaskDetail; sessions: RuntimeSessionRecord[]; runs: RuntimeRunRecord[]; attempts: EvaluationAttempt[] }) {
  const condition = revision.definition.conditions.find(item => item.id === conditionId)!;
  const fresh = sessions.filter(session => session.state === "ready" && session.roleId === task.task.owner && session.model === condition.model
    && session.cwd === condition.environment.cwd && session.authorizationScope === condition.environment.authorizationScope
    && session.sandbox === condition.environment.sandbox && session.approvalPolicy === condition.environment.approvalPolicy
    && !runs.some(run => run.sessionId === session.id));
  const active = runs.some(run => run.taskId === task.task.id && ["requested", "dispatching", "running", "unknown"].includes(run.state));
  const nextOrdinal = attemptsForCondition(revision, attempts, conditionId).length + 1;
  return <div className="evaluation-run-form"><h3>第 {nextOrdinal} 次尝试 / 重试</h3>
    {active && <Notice>共同任务已有运行中或未知的尝试。先核对同一 Run，不能重发。</Notice>}
    {!fresh.length && <p className="muted">没有符合冻结模型、授权与环境的新自有会话。先在<a href={`#/p/${context.projectId}/runtime`}>分工与会话</a>创建；旧会话不可复用。</p>}
    {!active && fresh.length > 0 && <ActionForm key={`${revision.id}:${conditionId}:${task.task.version}`} context={{ ...context, draftScope: `evaluation-run:${revision.id}:${conditionId}`, draftBaseline: `${revision.id}:${task.task.currentRevisionId}` }} review title={`派发第 ${nextOrdinal} 次真实运行`} fields={[
      { name: "sessionId", label: "全新自有会话", kind: "select", options: fresh.map(session => option(session.id, `${session.roleId} · ${short(session.id)} · ${session.model}`)) },
    ]} build={values => ({ type: "runtime.run.reserve", runId: crypto.randomUUID(), taskId: task.task.id,
      sessionId: values.sessionId, expectedVersion: task.task.version, input: revision.definition.case.commonInput,
      evaluation: { evaluationId: revision.evaluationId, revisionId: revision.id, caseId: revision.definition.case.id, conditionId } })} />}
    <p className="muted">派发前会核对原共同任务签名；每次自动登记尝试和实际执行修订。失败、未知与重试各自保留。</p>
  </div>;
}

function AttemptCard({ context, revision, attempt, run, task, assessments, onChanged }: { context: MutationContext; revision: EvaluationRevision; attempt: EvaluationAttempt; run?: RuntimeRunRecord; task: TaskDetail | null; assessments: EvaluationAssessment[]; onChanged: () => void }) {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [native, setNative] = useState<NativeResult | null>(null);
  const [readError, setReadError] = useState("");
  const deliveries = (task?.deliveries ?? []).filter(item => item.taskRevisionId === attempt.actualTaskRevisionId);
  const observations = (task?.observations ?? []).filter(item => deliveries.some(delivery => delivery.id === item.deliveryId));
  return <article className="evaluation-attempt"><h3>尝试 {attempt.ordinal} · {stateLabel[run?.state ?? ""] ?? "运行记录尚未读到"}</h3>
    <p>来源 Task 修订 <code>{short(attempt.sourceTaskRevisionId)}</code> → 实际执行修订 <code>{short(attempt.actualTaskRevisionId)}</code> · Run <code>{short(attempt.runId)}</code></p>
    <p className="muted">自有会话 {short(attempt.sessionId)} · {date(attempt.createdAt)}；本次尝试不会覆盖此前失败或未知。</p>
    {!run && <Notice error>对应 Run 尚未读到，不能推断执行或成本。</Notice>}
    {run && <><p>{run.state === "unknown" ? "结果未知；先沿同一 Run/会话核对，不能视为失败后自动重试。" : `运行状态：${stateLabel[run.state] ?? run.state}`}</p>
      {run.evaluationPacket ? <div className="evaluation-packet"><strong>实际发送包</strong><p>SHA-256 <code>{run.evaluationPacket.contentHash}</code><br />清单 hash <code>{run.evaluationPacket.manifestHash}</code><br />构建版本 {run.evaluationPacket.builderVersion}</p>
        <button type="button" onClick={async () => { try { setPacket(await api(context.token).evaluationPacket(context.projectId, revision.evaluationId, revision.id, attempt.id)); setReadError(""); } catch (cause) { setReadError(errorText(cause)); } }}>读取固定输入包</button>
        {packet && <details><summary>实际输入内容与来源清单</summary><p>包 SHA-256 <code>{packet.contentHash}</code> · 清单 <code>{packet.manifestHash}</code></p><div className="evaluation-fixed">{packet.sources.map((ref, index) => <FixedRef key={`${ref.kind}:${ref.id}:${index}`} value={ref} projectId={context.projectId} />)}</div><pre>{packet.content}</pre></details>}
      </div> : <p className="muted">尚无已封存输入包；不能把定义材料当作实际发送内容。</p>}
      {run.resultSummary && <p><strong>已存结果摘要：</strong>{run.resultSummary}</p>}
      {run.nativeTurnId && <button type="button" onClick={async () => { try { setNative(await runtimeClient(context.token, context.projectId).result(run.id)); setReadError(""); } catch (cause) { setReadError(errorText(cause)); } }}>读取原生输出</button>}
      {native && <details open><summary>原生输出 · {native.finalPhaseConfirmed ? "最终阶段已确认" : "最终阶段未确认"}</summary>{native.messages.map((message, index) => <pre key={index}>{message}</pre>)}</details>}
    </>}
    {readError && <Notice error>{readError}</Notice>}
    <div className="evaluation-evidence"><strong>本次实际交付</strong>{!deliveries.length && <p>未读到绑定此执行修订的交付。</p>}{deliveries.map(delivery => { const artifact = safeArtifactHref(delivery.artifactRef, context.projectId); return <div key={delivery.id}>
        <p>交付 <a href={`#/p/${context.projectId}/tasks/${delivery.taskId}`}>{short(delivery.id)} ↗</a> · 技术{delivery.technicalResult === "passed" ? "通过" : "失败"} · 固定修订 {short(delivery.artifactRevision)}</p>
        {artifact ? <a href={artifact} target={artifact.startsWith("#") ? undefined : "_blank"} rel={artifact.startsWith("#") ? undefined : "noopener noreferrer"}>阅读交付引用 ↗</a> : <span>原引用不可安全打开</span>}
        <details><summary>核对原始位置、版本与哈希</summary><p className="evaluation-raw">{delivery.artifactRef}</p><p>固定修订 <code>{delivery.artifactRevision}</code><br />SHA-256 <code>{delivery.contentHash}</code></p></details>
      </div>; })}
      <strong>本次实际使用观察</strong>{!observations.length && <p>未读到本次交付的使用观察；Agent 使用不等于真人后果。</p>}{observations.map(item => <p key={item.id}>{item.observerKind === "human" ? "真人" : "Agent"} {item.observer} · {item.result} · {item.evidence} <code>{short(item.id)}</code></p>)}
    </div>
    <h4>署名判定与成本</h4><p className="muted">身份和署名只说明谁登记；实际判断是否独立，应由本次理由与证据说明。</p>{!assessments.length && <p className="empty">尚无逐次判定；运行终态不代替评价。</p>}
    {assessments.map(item => <AssessmentRecord key={item.id} item={item} projectId={context.projectId} />)}
    <AssessmentForm context={context} revision={revision} attempt={attempt} assessments={assessments} deliveries={deliveries} observations={observations} onChanged={onChanged} />
  </article>;
}

function AssessmentRecord({ item, projectId }: { item: EvaluationAssessment; projectId: string }) {
  return <div className="evaluation-assessment"><strong>{item.supersedesId ? `更正 ${short(item.supersedesId)}` : "署名判定"} · {item.assessorKind === "human" ? "真人" : "Agent"} {item.actorId}</strong>
    <p>来源：{assessmentLabels.sourceFidelity[item.values.sourceFidelity]} · 知识：{assessmentLabels.knowledgeAdoption[item.values.knowledgeAdoption]} · 交付：{assessmentLabels.deliveryQuality[item.values.deliveryQuality]} · 真人后果：{assessmentLabels.humanEffect[item.values.humanEffect]}</p>
    <p>交付 {item.deliveryId ? short(item.deliveryId) : "未绑定"} · 使用观察 {item.observationId ? short(item.observationId) : "未绑定"}</p>
    {!item.costs.length ? <p>成本：未记录，不视为零。</p> : <ul>{item.costs.map((cost, index) => <li key={index}>{costText(cost)}</li>)}</ul>}
    <p>{item.reason}</p>{item.evidence.length > 0 && <div className="evaluation-fixed">{item.evidence.map((ref, index) => <FixedRef key={index} value={ref} projectId={projectId} />)}</div>}
    <small>{date(item.createdAt)} · 判定 {short(item.id)}</small></div>;
}

function AssessmentForm({ context, revision, attempt, assessments, deliveries, observations, onChanged }: { context: MutationContext; revision: EvaluationRevision; attempt: EvaluationAttempt; assessments: EvaluationAssessment[]; deliveries: NonNullable<TaskDetail["deliveries"]>; observations: NonNullable<TaskDetail["observations"]>; onChanged: () => void }) {
  const direct = revision.definition.conditions.find(item => item.id === attempt.conditionId)?.kind === "direct";
  return <ActionForm context={{ ...context, draftScope: `evaluation-assessment:${attempt.id}`, draftBaseline: revision.id }} review title={assessments.length ? "追加更正判定" : "记录本次判定"} fields={[
    { name: "supersedesId", label: "更正此前判定（可选）", kind: "select", optional: true, options: currentAssessments(assessments).map(item => option(item.id, `${short(item.id)} · ${item.actorId} · ${date(item.createdAt)}`)) },
    { name: "deliveryId", label: "本次实际交付（可选）", kind: "select", optional: true, options: deliveries.map(item => option(item.id, `${short(item.id)} · 技术${item.technicalResult === "passed" ? "通过" : "失败"}`)) },
    { name: "observationId", label: "本次交付的使用观察（可选）", kind: "select", optional: true, options: observations.map(item => option(item.id, `${short(item.id)} · ${item.observerKind} · ${item.result}`)) },
    { name: "sourceFidelity", label: "固定来源使用", kind: "select", options: [option("qualified", "符合"), option("failed", "失败"), option("unknown", "未知"), option("needs_review", "待复核")] },
    { name: "knowledgeAdoption", label: "知识采用", kind: "select", value: direct ? "not_applicable" : "", options: direct ? [option("not_applicable", "直接条件：不适用")] : [option("correct", "正确采用"), option("misused", "误用"), option("not_used", "未采用"), option("not_observed", "未观察到"), option("needs_review", "待复核")] },
    { name: "deliveryQuality", label: "交付质量", kind: "select", options: [option("qualified", "合格"), option("failed", "失败"), option("unknown", "未知"), option("needs_review", "待复核")] },
    { name: "humanEffect", label: "真人使用后果", kind: "select", options: [option("observed", "有真实人类证据"), option("unknown", "未知"), option("needs_review", "待复核")] },
    { name: "assessorKind", label: "本次判定者身份", kind: "select", options: [option("agent", "Agent"), option("human", "真人（需本人判断）")] },
    { name: "costs", label: "成本逐项记录（可留空=未记录）", kind: "textarea", optional: true, hint: "每行：阶段 | 单位 | 非负数或未测 | 来源。更正时重新填本次完整成本；不同单位不合计；0 只在确实测得零时填写。" },
    { name: "evidence", label: "固定证据（可选）", kind: "textarea", optional: true, hint: "每行：kind | ID | revision | SHA-256" }, reasonField,
  ]} build={values => ({ type: "evaluation.assessment.record", evaluationId: revision.evaluationId, revisionId: revision.id,
    assessmentId: crypto.randomUUID(), attemptId: attempt.id, deliveryId: values.deliveryId || null, observationId: values.observationId || null,
    supersedesId: values.supersedesId || null,
    values: { sourceFidelity: values.sourceFidelity, knowledgeAdoption: direct ? "not_applicable" : values.knowledgeAdoption, deliveryQuality: values.deliveryQuality, humanEffect: values.humanEffect },
    costs: parseCostLines(values.costs), evidence: parseFixedRefLines(values.evidence, ["document", "git", "wiki", "delivery", "evidence"]),
    assessorKind: values.assessorKind, reason: values.reason,
  })} onApplied={() => onChanged()} />;
}

function ConclusionRecord({ item, assessments, projectId }: { item: EvaluationConclusion; assessments: EvaluationAssessment[]; projectId: string }) {
  const nextAction = item.nextActionRef as NextActionRef | null;
  return <article className="evaluation-conclusion"><h3>{item.supersedesId ? `更正结论 ${short(item.supersedesId)}` : "结论"} · {item.comparability === "comparable" ? "历史记录声称可比较" : item.comparability === "with_limits" ? "有限比较" : "未知"}</h3>
    <p>{item.finding}</p><p><strong>限制：</strong>{item.limits}</p><p><strong>为何可比/不可比：</strong>{item.comparabilityReason}</p>
    <p><strong>下一选择：</strong>{choiceLabel[item.nextChoice]}{nextAction ? "（已记录固定后续引用，不代表自动执行）" : "（尚无实际后续动作引用）"}</p>
    <p>纳入判定：{item.assessmentIds.map(id => { const assessment = assessments.find(row => row.id === id); return assessment ? `${short(id)} · 尝试 ${short(assessment.attemptId)}` : `${short(id)}（未读到）`; }).join("；")}</p>
    {item.affectedRefs.length > 0 && <div className="evaluation-fixed">{item.affectedRefs.map((ref, index) => <FixedRef key={index} value={ref} projectId={projectId} />)}</div>}
    {nextAction?.kind === "task" && <a href={nextActionHref(projectId, nextAction)!}>后续 Task {short(nextAction.taskId)} · 固定修订 {short(nextAction.taskRevisionId)} ↗</a>}
    {nextAction && nextAction.kind !== "task" && <FixedRef value={nextAction} projectId={projectId} />}
    <small>{date(item.createdAt)} · {item.actorId} · {short(item.id)}</small></article>;
}

function ConclusionForm({ context, revision, assessments, conclusions }: { context: MutationContext; revision: EvaluationRevision; assessments: EvaluationAssessment[]; conclusions: EvaluationConclusion[] }) {
  const replaced = new Set(conclusions.map(item => item.supersedesId).filter((id): id is string => !!id));
  return <ActionForm context={{ ...context, draftScope: `evaluation-conclusion:${revision.id}`, draftBaseline: revision.id }} review title={conclusions.length ? "追加更正结论" : "记录评价结论"} fields={[
    { name: "assessmentIds", label: "纳入逐次判定", kind: "multi", options: assessments.map(item => option(item.id, `${short(item.id)} · ${short(item.attemptId)} · ${item.assessorKind}`)) },
    { name: "supersedesId", label: "更正此前结论（可选）", kind: "select", optional: true, options: conclusions.filter(item => !replaced.has(item.id)).map(item => option(item.id, `${short(item.id)} · ${date(item.createdAt)}`)) },
    { name: "finding", label: "实际发现", kind: "textarea" },
    { name: "limits", label: "限制与未测事项", kind: "textarea" },
    { name: "comparability", label: "可比较性", kind: "select", options: conclusionComparabilityOptions.map(item => option(item.value, item.label)) },
    { name: "comparabilityReason", label: "可比性理由", kind: "textarea" },
    { name: "nextChoice", label: "下一选择", kind: "select", options: [option("read_direct", "先读直接来源"), option("adopt_with_limits", "带限制采用"), option("maintain", "维持"), option("research", "继续研究"), option("wait", "等待"), option("stop", "停止")] },
    { name: "affectedRefs", label: "受影响固定来源（可选）", kind: "textarea", optional: true, hint: "每行：kind | ID | revision | SHA-256" },
    { name: "nextActionRef", label: "实际后续动作固定引用（可选）", kind: "textarea", optional: true, hint: "Task：task | Task ID | Task 固定修订 ID（无需哈希）；其他：kind | ID | revision | SHA-256。留空不表示动作已发生。" },
  ]} build={values => {
    const next = parseNextActionRef(values.nextActionRef);
    return { type: "evaluation.conclusion.record", evaluationId: revision.evaluationId, revisionId: revision.id,
      conclusionId: crypto.randomUUID(), assessmentIds: JSON.parse(values.assessmentIds || "[]"), supersedesId: values.supersedesId || null,
      finding: values.finding, limits: values.limits, comparability: values.comparability, comparabilityReason: values.comparabilityReason,
      nextChoice: values.nextChoice, affectedRefs: parseFixedRefLines(values.affectedRefs, ["document", "git", "wiki", "delivery", "evidence"]), nextActionRef: next };
  }} />;
}
