// A frozen evaluation: in the middle the fixed definition, each condition's real attempts and the conclusions; in the
// right column the common task, the materials, the Wiki revisions, the source signature, the versions and every ID.
import { useRef, type ReactNode } from "react";
import type { EvaluationAssessment, EvaluationAttempt, EvaluationConclusion, EvaluationRevision } from "@evoloop/contracts";
import { Notice, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { option, type MutationContext } from "../../shared/ActionForm";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { date } from "../../shared/ui/shared";
import { AttemptRecord, RunForm } from "./Attempts";
import { DefinitionForm } from "./DefinitionForm";
import { EvaluationForm } from "./EvaluationForm";
import { useEvaluationEvidence, useFixedTitles, useRoleTitles, type EvaluationRead } from "./evaluationReads";
import { Facts, FixedRefLine, IdentityDetails, PanelSection, card, linkClass, muted, refRows } from "./parts";
import {
  approvalLabels, assessmentName, attemptsForCondition, comparabilityLabels, conclusionComparabilityOptions, conclusionGlance, conditionGlance,
  conditionLabels, currentAssessments, evaluationHref, frozenTaskTitle, labelOf, nextActionHref, nextChoiceLabels, parseFixedRefLines, parseNextActionRef,
  fixedRefLineHint, nextActionLineHint, readStateOf, sandboxLabels, taskStateLabels, unreadSources, type NextActionRef,
} from "./presentation";

const taskHref = (projectId: string, taskId: string, revisionId?: string) =>
  `/p/${projectId}/tasks/${taskId}${revisionId ? `?revision=${encodeURIComponent(revisionId)}` : ""}`;

export function EvaluationDetail({ context, read, selectedRevision, hold }: {
  context: MutationContext; read: EvaluationRead; selectedRevision: boolean; hold?: string | undefined;
}) {
  const { revision, revisions, attempts, assessments, conclusions } = read;
  const { definition } = revision;
  const projectId = context.projectId;
  const root = useRef<HTMLDivElement>(null);
  const evidence = useEvaluationEvidence(projectId, revision.evaluationId, definition.case.taskId, definition.ownerTaskId);
  const titles = useFixedTitles(projectId, revision.evaluationId, revision.id, [definition.protocol, ...definition.case.materials]);
  const roleTitles = useRoleTitles(projectId, (evidence.sessions.data ?? []).map(session => session.roleId));
  const runsState = readStateOf(evidence.runs);
  const taskState = readStateOf(evidence.task);
  const sideFailure = [evidence.task, evidence.runs, evidence.sessions].find(query => query.isError)?.error;
  const sideKept = !!sideFailure && [evidence.task, evidence.runs, evidence.sessions].some(query => query.isError && query.data !== undefined);
  const unread = unreadSources({ task: evidence.task.isError, runs: evidence.runs.isError, agents: evidence.sessions.isError });
  const effective = currentAssessments(assessments);
  const current = revisions.every(item => item.version <= revision.version);
  const latest = revisions.reduce<EvaluationRevision | undefined>((best, item) => !best || item.version > best.version ? item : best, undefined);
  const wikiCondition = definition.conditions.find(condition => condition.kind === "wiki");
  const scrollTo = (anchor: string) => root.current?.querySelector(`[data-anchor="${anchor}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const sideReady = evidence.task.data && evidence.runs.data && evidence.sessions.data;
  return <div ref={root} className="flex min-w-0 flex-col gap-5">
    {selectedRevision && <Notice title={`正在阅读固定定义 v${revision.version}`}>
      尝试、判定与结论只取此修订，不与其他版本合并。<a className={linkClass} href={evaluationHref(projectId, revision.evaluationId)}>回到最新定义 →</a></Notice>}
    {!current && !selectedRevision && latest && <Notice tone="waiting">已有更新的定义 v{latest.version}；本页只读这一版，派发与另存定义要在最新定义里进行。</Notice>}

    <nav aria-label="评价概览" className="grid min-w-0 grid-cols-1 gap-2 compact:grid-cols-3">
      {definition.conditions.map(condition => <Glance key={condition.id} title={labelOf(conditionLabels, condition.kind, "未识别的条件")}
        text={conditionGlance(revision, attempts, assessments, condition.id, evidence.runs.data, runsState)} onClick={() => scrollTo(`condition-${condition.id}`)} />)}
      <Glance title="结论与下一步" text={conclusionGlance(conclusions)} onClick={() => scrollTo("conclusions")} />
    </nav>

    <section aria-label="冻结定义" className={card}>
      <h2 className="text-heading font-semibold text-foreground">冻结定义</h2>
      <Facts rows={[["可比限制", definition.limits], ["公开判定条件", definition.case.criteria], ["共同指令", definition.case.commonInput]]} />
      <p className={cn(muted, "m-0")}>协议、共同材料、Wiki 修订和固定业务签名在右栏；来源页可返回此固定评价定义。现名称只作阅读辅助，已逐项核对同项目固定修订及哈希，不能代表原修订创建时的标题。没有隐藏答案隔离保证；同机工具能否访问其他来源尚未验证。一次案例不得推出因果收益或统计胜者。</p>
    </section>

    {sideFailure && <Notice tone="error" title={`${unread}没有读回`}>
      {errorText(sideFailure)}。既有评价事实仍可读；运行状态不能据此猜测。{sideKept && "下面保留的是上次读回的记录，当前待核对；凡是要靠这些记录判断的地方都写“无法判断”。"}</Notice>}

    {definition.conditions.map(condition => {
      const rows = attemptsForCondition(revision, attempts, condition.id);
      return <section key={condition.id} data-anchor={`condition-${condition.id}`} aria-label={labelOf(conditionLabels, condition.kind, "未识别的条件")} className={cn(card, "scroll-mt-4")}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-heading font-semibold text-foreground">{labelOf(conditionLabels, condition.kind, "未识别的条件")}</h2>
          <span className={muted}>{rows.length} 次尝试</span>
        </div>
        <Facts rows={[["冻结执行配置", `模型 ${condition.model} · ${labelOf(sandboxLabels, condition.environment.sandbox, "未识别的权限")} · ${labelOf(approvalLabels, condition.environment.approvalPolicy, "未识别的审批方式")}`],
          ["工作目录与授权范围", `${condition.environment.cwd}\n${condition.environment.authorizationScope}`],
          ["Wiki", condition.kind === "direct" ? "明确不适用；不从共同任务中删除必需来源。" : `本条件新增 ${condition.wikiRefs?.length ?? 0} 项固定 Wiki，见右栏“Wiki 修订”；知识页可返回本次固定评价定义。`]]} />
        {rows.map(attempt => <AttemptRecord key={attempt.id} context={context} revision={revision} attempt={attempt} hold={hold}
          run={evidence.runs.data?.find(item => item.id === attempt.runId)} runsState={runsState} task={evidence.task.data} taskState={taskState}
          assessments={assessments.filter(item => item.attemptId === attempt.id)} titles={titles.data} />)}
        {!rows.length && <p className="m-0 text-small text-text-secondary">尚无真实尝试；条件定义本身不是运行结果。</p>}
        {!selectedRevision && current && (sideReady && !sideFailure
          ? <RunForm context={context} revision={revision} conditionId={condition.id} task={evidence.task.data!} sessions={evidence.sessions.data!}
            runs={evidence.runs.data!} attempts={attempts} roleTitles={roleTitles.data} hold={hold} />
          : <p className={cn(muted, "m-0 border-t border-border pt-4")}>{sideFailure ? `${unread}没有读回，无法判断能否派发下一次尝试。` : "正在核对共同任务、运行与可用的智能体…"}</p>)}
      </section>;
    })}

    <section data-anchor="conclusions" aria-label="结论与下一步" className={cn(card, "scroll-mt-4")}>
      <h2 className="text-heading font-semibold text-foreground">结论与下一步</h2>
      {!conclusions.length && <p className="m-0 text-small text-text-secondary">尚无结论。缺少两组真实尝试或成本时，只能明确限制或未知。</p>}
      {conclusions.map(item => <ConclusionRecord key={item.id} item={item} all={conclusions} assessments={assessments} attempts={attempts} revision={revision} projectId={projectId} titles={titles.data} />)}
      {!selectedRevision && <ConclusionForm context={context} revision={revision} assessments={effective} attempts={attempts} conclusions={conclusions} hold={hold} />}
      <p className={cn(muted, "m-0")}>结论只留证，不自动采用知识、关闭任务或代表真人实际使用。</p>
    </section>

    {!selectedRevision && current && <details className={cn(card, "gap-0")}>
      <summary className="cursor-pointer text-small font-medium text-foreground">另存一版评价定义</summary>
      <div className="mt-3"><SectionBoundary label="另存定义表单"><DefinitionForm context={context} current={revision} hold={hold} /></SectionBoundary></div>
    </details>}

    <ContextPanelContent>
      <div className="flex flex-col gap-4">
        <PanelSection title="共同任务">
          <a className={cn(linkClass, "break-words text-small")} href={taskHref(projectId, definition.case.taskId, definition.case.sourceTaskRevisionId)}>
            《{frozenTaskTitle(revision)}》 · 来源修订 ↗</a>
          <p className={cn(muted, "m-0")}>{evidence.task.data
            ? `当前${labelOf(taskStateLabels, evidence.task.data.task.state)}${evidence.task.data.task.title !== frozenTaskTitle(revision) ? ` · 现名称《${evidence.task.data.task.title}》` : ""}${evidence.task.isError ? "（上次读回，当前待核对）" : ""}`
            : taskState === "loading" ? "正在读取任务当前状态…" : "任务当前状态无法判断。"}</p>
          <p className={cn(muted, "m-0")}>每次运行形成另一条实际执行修订，不把它和来源修订当同一版本。</p>
          <p className="m-0 text-small text-text-secondary">负责这次评价：{definition.ownerTaskId === definition.case.taskId ? "同一共同任务"
            : <a className={linkClass} href={taskHref(projectId, definition.ownerTaskId)}>{evidence.owner.data ? `《${evidence.owner.data.title}》` : evidence.owner.isError ? "负责任务（名称没有读回）" : "负责任务（正在读取名称）"} ↗</a>}</p>
        </PanelSection>
        <PanelSection title="材料">
          <span className={muted}>协议</span>
          <FixedRefLine value={definition.protocol} projectId={projectId} titles={titles.data} />
          <span className={muted}>两条件共用</span>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{definition.case.materials.map((ref, index) => <li key={`${ref.kind}:${ref.id}:${index}`}>
            <FixedRefLine value={ref} projectId={projectId} titles={titles.data} /></li>)}</ul>
          {titles.isFetching && !titles.data && <span className={muted}>正在核对文档现名称…</span>}
        </PanelSection>
        <PanelSection title="Wiki 修订">
          {wikiCondition?.wikiRefs?.length ? <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{wikiCondition.wikiRefs.map((ref, index) => <li key={`${ref.id}:${index}`}>
            <FixedRefLine value={ref} projectId={projectId} /></li>)}</ul> : <p className="m-0 text-small text-text-secondary">定义里没有登记 Wiki 修订。</p>}
          <p className={cn(muted, "m-0")}>只有“加入固定 Wiki”条件读这些修订；直接材料条件明确不读。</p>
        </PanelSection>
        <PanelSection title="来源">
          <Facts rows={[["冻结时的任务名", frozenTaskTitle(revision)], ["验收", definition.case.sourceSignature.acceptance],
            ["固定依据", `${definition.case.sourceSignature.basis.length} 项`], ["外部来源", `${definition.case.sourceSignature.external.length} 项`]]} />
          <details className="text-small"><summary className="cursor-pointer text-text-secondary">核对共同任务的固定业务签名</summary>
            <pre className="m-0 mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-field p-3 font-mono text-caption text-foreground">{JSON.stringify(definition.case.sourceSignature, null, 2)}</pre></details>
        </PanelSection>
        <PanelSection title="定义版本">
          <p className={cn(muted, "m-0")}>修订追加，不覆盖旧版；每版的尝试与结论各自保留。</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">{[...revisions].sort((a, b) => b.version - a.version).map(item => <li key={item.id}>
            <a aria-current={item.id === revision.id ? "page" : undefined} href={evaluationHref(projectId, item.evaluationId, item.id)}
              className={cn("flex flex-col rounded-md px-2 py-1.5 text-small outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]", item.id === revision.id ? "bg-selected font-medium text-foreground" : "text-text-secondary")}>
              <span>v{item.version}{item.id === latest?.id ? " · 最新" : ""}</span><span className={muted}>{date(item.createdAt)} · {item.actorId}</span>
            </a></li>)}</ul>
        </PanelSection>
        <PanelSection title="完整标识">
          <IdentityDetails label="展开全部标识与哈希" rows={[["评价 ID", revision.evaluationId], ["定义修订 ID", revision.id], ["案例 ID", definition.case.id],
            ...definition.conditions.map(condition => [`${labelOf(conditionLabels, condition.kind, "条件")} 条件 ID`, condition.id] as [string, string]),
            ["共同任务 ID", definition.case.taskId], ["来源任务修订 ID", definition.case.sourceTaskRevisionId], ["负责任务 ID", definition.ownerTaskId],
            ...refRows("协议", [definition.protocol]), ...refRows("共用材料", definition.case.materials), ...refRows("Wiki", wikiCondition?.wikiRefs ?? []),
            ...attempts.flatMap(attempt => [[`尝试 ${attempt.ordinal}（${labelOf(conditionLabels, definition.conditions.find(item => item.id === attempt.conditionId)?.kind ?? "", "未识别的条件")}）`,
              `尝试 ${attempt.id} · 运行 ${attempt.runId} · 智能体 ${attempt.sessionId} · 来源修订 ${attempt.sourceTaskRevisionId} · 实际修订 ${attempt.actualTaskRevisionId}`] as [string, string]])]} />
        </PanelSection>
      </div>
    </ContextPanelContent>
  </div>;
}

function Glance({ title, text, onClick }: { title: string; text: ReactNode; onClick(): void }) {
  return <button type="button" onClick={onClick} className="flex min-w-0 flex-col gap-1 rounded-xl bg-raised px-4 py-3 text-left shadow-sm outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]">
    <strong className="text-small font-semibold text-foreground">{title}</strong><span className="break-words text-caption text-muted-foreground">{text}</span>
  </button>;
}

function ConclusionRecord({ item, all, assessments, attempts, revision, projectId, titles }: {
  item: EvaluationConclusion; all: EvaluationConclusion[]; assessments: EvaluationAssessment[]; attempts: EvaluationAttempt[]; revision: EvaluationRevision; projectId: string; titles: Record<string, string> | undefined;
}) {
  const nextAction = item.nextActionRef as NextActionRef | null;
  const replaced = item.supersedesId ? all.findIndex(row => row.id === item.supersedesId) : -1;
  return <article aria-label={item.supersedesId ? "更正结论" : "结论"} className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
    <h3 className="text-small font-semibold text-foreground">{item.supersedesId ? replaced >= 0 ? `更正第 ${replaced + 1} 条结论` : "更正此前结论（原结论未读到）" : "结论"} · {labelOf(comparabilityLabels, item.comparability)}</h3>
    <p className="m-0 whitespace-pre-wrap break-words text-small text-foreground">{item.finding}</p>
    <Facts rows={[["限制", item.limits], ["为何可比或不可比", item.comparabilityReason],
      ["下一选择", `${labelOf(nextChoiceLabels, item.nextChoice)}${nextAction ? "（已记录固定后续引用，不代表自动执行）" : "（尚无实际后续动作引用）"}`],
      ["纳入判定", item.assessmentIds.map(id => { const assessment = assessments.find(row => row.id === id); return assessment ? assessmentName(assessment, revision, attempts, date) : "一项判定（未读到）"; }).join("\n")]]} />
    {item.affectedRefs.length > 0 && <ul className="m-0 flex list-none flex-col gap-1 p-0">{item.affectedRefs.map((ref, index) => <li key={index}><FixedRefLine value={ref} projectId={projectId} titles={titles} /></li>)}</ul>}
    {nextAction?.kind === "task" && nextActionHref(projectId, nextAction) && <a className={cn(linkClass, "text-small")} href={nextActionHref(projectId, nextAction)!}>后续任务 · 固定修订 ↗</a>}
    {nextAction && nextAction.kind !== "task" && <FixedRefLine value={nextAction} projectId={projectId} titles={titles} />}
    <p className={cn(muted, "m-0")}>{date(item.createdAt)} · {item.actorId}</p>
    <IdentityDetails rows={[["结论 ID", item.id], ...item.supersedesId ? [["更正的结论 ID", item.supersedesId] as [string, string]] : [],
      ...item.assessmentIds.map((id, index) => [`纳入判定 ${index + 1}`, id] as [string, string]),
      ...nextAction?.kind === "task" ? [["后续任务", `${nextAction.taskId} · 修订 ${nextAction.taskRevisionId}`] as [string, string]] : nextAction ? refRows("后续动作", [nextAction]) : [],
      ...refRows("受影响来源", item.affectedRefs)]} />
  </article>;
}

function ConclusionForm({ context, revision, assessments, attempts, conclusions, hold }: {
  context: MutationContext; revision: EvaluationRevision; assessments: EvaluationAssessment[]; attempts: EvaluationAttempt[]; conclusions: EvaluationConclusion[]; hold?: string | undefined;
}) {
  const replaced = new Set(conclusions.map(item => item.supersedesId).filter((id): id is string => !!id));
  return <EvaluationForm context={{ ...context, draftScope: `evaluation-conclusion:${revision.id}`, draftBaseline: revision.id }} review hold={hold}
    title={conclusions.length ? "追加更正结论" : "记录评价结论"} fields={[
      { name: "assessmentIds", label: "纳入逐次判定", kind: "multi", options: assessments.map(item => option(item.id, assessmentName(item, revision, attempts, date))) },
      { name: "supersedesId", label: "更正此前结论（可选）", kind: "select", optional: true, options: conclusions.filter(item => !replaced.has(item.id)).map(item => option(item.id, `${labelOf(comparabilityLabels, item.comparability)} · ${date(item.createdAt)} · ${item.actorId}`)) },
      { name: "finding", label: "实际发现", kind: "textarea" },
      { name: "limits", label: "限制与未测事项", kind: "textarea" },
      { name: "comparability", label: "可比较性", kind: "select", options: conclusionComparabilityOptions.map(item => option(item.value, item.label)) },
      { name: "comparabilityReason", label: "可比性理由", kind: "textarea" },
      { name: "nextChoice", label: "下一选择", kind: "select", options: (Object.keys(nextChoiceLabels) as (keyof typeof nextChoiceLabels)[]).map(value => option(value, nextChoiceLabels[value])) },
      { name: "affectedRefs", label: "受影响固定来源（可选）", kind: "textarea", optional: true, hint: fixedRefLineHint },
      { name: "nextActionRef", label: "实际后续动作固定引用（可选）", kind: "textarea", optional: true, hint: nextActionLineHint },
    ]} build={values => {
      const next = parseNextActionRef(values.nextActionRef ?? "");
      return { type: "evaluation.conclusion.record", evaluationId: revision.evaluationId, revisionId: revision.id,
        conclusionId: crypto.randomUUID(), assessmentIds: JSON.parse(values.assessmentIds || "[]"), supersedesId: values.supersedesId || null,
        finding: values.finding, limits: values.limits, comparability: values.comparability, comparabilityReason: values.comparabilityReason,
        nextChoice: values.nextChoice, affectedRefs: parseFixedRefLines(values.affectedRefs ?? "", ["document", "git", "wiki", "delivery", "evidence"]), nextActionRef: next };
    }} />;
}
