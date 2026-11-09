// 新建任务 (docs/frontend/pages/tasks.md 新建任务): what the work is, how it counts as done, who is responsible and which
// stage it belongs to, with an optional agreed time and daily repeat. The same view opens from the task page
// (`/tasks/new`) and from 目标与阶段 (`/journey?action=propose`). One `task.create` is sent through useCommand; the
// checklist, the chosen stage and the identifiers sit in the right column.
import React from "react";
import type { Document, Stage } from "@evoloop/contracts";
import { ArrowLeft } from "lucide-react";
import { Button, Field, Input, Notice, Select, Textarea, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { currentPath, navigate, onNavigate } from "../../shared/navigation";
import { useProjectQuery } from "../../shared/query";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { href } from "../../shared/ui/shared";
import { journeyKey, readOwnerRoles, readPublishedDocuments, useGoals, useStages } from "./journeyRead";
import { draftFieldLabels, draftTouched, emptyTaskDraft, maxLinkedDocuments, taskCreateCommand, taskDraftProblems, taskKinds, zonedInstant, type DraftProblems, type TaskDraft } from "./taskCreate";
import { formatScheduled } from "./taskTimingPresentation";
import { baselineChangedText, useCommand } from "./useCommand";

const muted = "text-caption text-muted-foreground";
const section = "flex flex-col gap-4 rounded-xl bg-raised p-4 shadow-sm compact:p-5";

/** `?stage=` of the current address, when it is this page's. */
function stageFromAddress(pathname: string): string {
  const [path, query = ""] = currentPath().split("?");
  return path === pathname ? new URLSearchParams(query).get("stage") ?? "" : "";
}

/** The task list the person came from (its filters are kept), else the plain list. */
export function taskListHref(projectId: string): string {
  try {
    const saved = sessionStorage.getItem(`evoloop:list:${projectId}`);
    if (saved?.startsWith(`/p/${projectId}/`)) return saved;
  } catch { /* optional return state */ }
  return href(projectId, "work");
}

export function CreateTaskPage({ context, active }: { context: MutationContext; active: boolean }) {
  return <CreateTaskView context={context} active={active} pathname={href(context.projectId, "create-task")}
    back={{ href: taskListHref(context.projectId), label: "返回任务列表" }} />;
}

export function CreateTaskView({ context, active, pathname, back, embedded = false }: {
  context: MutationContext; active: boolean; pathname: string; back: { href: string; label: string };
  /** Inside another page's center (目标与阶段), which keeps its own padding and rail. */
  embedded?: boolean;
}) {
  const { projectId, principal } = context;
  const canWrite = principal.permissions.includes("write");
  const canReview = principal.permissions.includes("review");
  const panel = useContextPanel();
  const fresh = React.useMemo(() => emptyTaskDraft(), []);
  const [draft, setDraft] = React.useState<TaskDraft>(() => ({ ...fresh, stageId: stageFromAddress(pathname) }));
  const [taskId, setTaskId] = React.useState(() => crypto.randomUUID());
  const [showProblems, setShowProblems] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const touched = draftTouched(draft, fresh);
  // A link here with another stage (目标与阶段 → 新建任务) chooses that stage while nothing has been typed yet.
  React.useEffect(() => onNavigate(() => {
    if (currentPath().split("?")[0] !== pathname) return;
    const stageId = stageFromAddress(pathname);
    setDraft(current => draftTouched(current, fresh) || !stageId || current.stageId === stageId ? current : { ...current, stageId });
  }), [pathname, fresh]);
  const stagesRead = useStages(projectId);
  const goalsRead = useGoals(projectId);
  const rolesRead = useProjectQuery(projectId, ["roles", "task-owner-choices"], () => readOwnerRoles(projectId), { enabled: canWrite && active });
  const documentsRead = useProjectQuery(projectId, [journeyKey, "published-documents"], () => readPublishedDocuments(projectId), { enabled: canWrite && active });
  const stages = (stagesRead.data ?? []).filter(stage => stage.state === "active");
  const chosenStage = stagesRead.data?.find(stage => stage.id === draft.stageId);
  const chosenGoal = chosenStage ? goalsRead.data?.items.find(goal => goal.id === chosenStage.goalId) : undefined;
  const problems = taskDraftProblems(draft, { canReview });
  if (draft.stageId && stagesRead.data && !chosenStage) problems.stageId = "所选阶段不在已读的阶段中；请重新选择。";
  else if (chosenStage && chosenStage.state !== "active") problems.stageId = "所选阶段已不在推进中，不能再建所属任务。";
  const shown: DraftProblems = showProblems ? problems : {};
  const edit = (patch: Partial<TaskDraft>) => setDraft(current => ({ ...current, ...patch }));
  const roles = rolesRead.data ?? [];
  const ownersReady = rolesRead.isSuccess && roles.length > 0;
  const schedulePreview = (() => {
    if (!draft.executeAt.trim()) return "";
    try { return `约定在 ${formatScheduled(zonedInstant(draft.executeAt, draft.timezone), draft.timezone)}${draft.repeat === "daily" ? "，之后每天同一时刻各生成一项独立的任务" : ""}。`; }
    catch { return ""; }
  })();
  const applied = () => {
    const created = taskId;
    setDraft({ ...fresh, stageId: draft.stageId }); setTaskId(crypto.randomUUID()); setShowProblems(false);
    navigate(href(projectId, "task", created));
  };
  const field = (key: keyof TaskDraft) => ({ error: shown[key] });
  const form = <form aria-label="新建任务" data-dirty={touched ? "true" : undefined} noValidate className="flex flex-col gap-4"
    onSubmit={event => event.preventDefault()}>
    <section aria-label="要做什么" className={section}>
      <h2 className="text-label font-semibold text-foreground">要做什么</h2>
      <Field label="任务名称" {...field("title")}>{control => <Input {...control} value={draft.title} onChange={event => edit({ title: event.target.value })} autoComplete="off" />}</Field>
      <Field label="为什么要做" hint="写明背景、范围和需要读的材料，可以用 Markdown。" {...field("why")}>
        {control => <Textarea {...control} rows={5} value={draft.why} onChange={event => edit({ why: event.target.value })} />}</Field>
      <Field label="期望结果" hint="做完后应得到什么；保存时接在正文末尾。" {...field("outcome")}>
        {control => <Textarea {...control} rows={3} value={draft.outcome} onChange={event => edit({ outcome: event.target.value })} />}</Field>
    </section>
    <section aria-label="怎样算完成" className={section}>
      <h2 className="text-label font-semibold text-foreground">怎样算完成</h2>
      <Field label="怎样独立验收" hint="写明验收的人要看哪些证据。" {...field("acceptance")}>
        {control => <Textarea {...control} rows={3} value={draft.acceptance} onChange={event => edit({ acceptance: event.target.value })} />}</Field>
      {draft.closeRule === "use" && <Field label="验收方式">{control => <Select {...control} className="w-full" value={draft.acceptanceMode}
        onChange={event => edit({ acceptanceMode: event.target.value as TaskDraft["acceptanceMode"] })}>
        <option value="independent_agent">独立的智能体验收（默认）</option><option value="human_required">必须由本人验收</option>
      </Select>}</Field>}
      {draft.closeRule === "use" && <Field label={draft.stageId || draft.acceptanceMode === "human_required" ? "实际使用成果的身份" : "实际使用成果的身份（可选）"} {...field("consumer")}
        hint={draft.acceptanceMode === "human_required" ? "填写验收人的受信身份；关闭时要有这个身份对本次交付的使用记录。" : "填写会实际使用成果的受信身份；不填时可以稍后由统筹确定独立验收。"}>
        {control => <Input {...control} value={draft.consumer} onChange={event => edit({ consumer: event.target.value })} autoComplete="off" />}</Field>}
    </section>
    <section aria-label="责任与归属" className={section}>
      <h2 className="text-label font-semibold text-foreground">责任与归属</h2>
      <Field label="负责职责" {...field("owner")} hint={rolesRead.isPending ? "正在读取可用的职责…" : undefined}>
        {control => <Select {...control} className="w-full" value={draft.owner} disabled={!ownersReady} onChange={event => edit({ owner: event.target.value })}>
          <option value="">{rolesRead.isPending ? "正在读取…" : "请选择"}</option>
          {roles.map(role => <option key={role.id} value={role.id}>{role.proposal.title} · {role.state === "trial" ? "试行" : "使用中"}</option>)}
        </Select>}</Field>
      {rolesRead.error && <Notice tone="error" action={<Button size="compact" onClick={() => void rolesRead.refetch()}>重新读取</Button>}>
        职责没有完整读回：{errorText(rolesRead.error)}。请先重新读取，避免把任务交给错误的职责。</Notice>}
      {rolesRead.isSuccess && !roles.length && <p className="text-small text-text-secondary">项目里还没有在用或试行的职责，暂时不能新建任务。请先在团队里建立职责。</p>}
      <div className="grid grid-cols-1 gap-4 compact:grid-cols-2">
        <Field label="所属阶段（可选）" {...field("stageId")} hint={stagesRead.isPending ? "正在读取推进中的阶段…" : stagesRead.error ? "阶段暂不可读取，只能建不属于阶段的任务。" : undefined}>
          {control => <Select {...control} className="w-full" value={draft.stageId} onChange={event => edit({ stageId: event.target.value })}>
            <option value="">不属于阶段</option>
            {stages.map(stage => <option key={stage.id} value={stage.id}>{stage.deliverable}</option>)}
            {draft.stageId && !stages.some(stage => stage.id === draft.stageId) && <option value={draft.stageId}>{chosenStage ? `${chosenStage.deliverable}（不在推进中）` : "所选阶段（未读到）"}</option>}
          </Select>}</Field>
        <Field label={draft.closeRule === "decision" ? "任务类型" : "任务类型（可选）"} {...field("kind")}>{control => <Select {...control} className="w-full" value={draft.kind}
          onChange={event => edit({ kind: event.target.value as TaskDraft["kind"] })}>
          <option value="">未指定</option>{Object.entries(taskKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>}</Field>
      </div>
      {draft.stageId && <>
        <Field label="来源或反馈证据" hint="属于阶段的任务要写明为什么现在做。" {...field("evidence")}>
          {control => <Textarea {...control} rows={3} value={draft.evidence} onChange={event => edit({ evidence: event.target.value })} />}</Field>
        <Field label="停止条件" hint="在什么情况下停止或改做别的。" {...field("stopCondition")}>
          {control => <Textarea {...control} rows={2} value={draft.stopCondition} onChange={event => edit({ stopCondition: event.target.value })} />}</Field>
      </>}
    </section>
    <section aria-label="约定执行时间" className={section}>
      <div className="flex flex-col gap-1"><h2 className="text-label font-semibold text-foreground">执行时间（可选）</h2>
        <p className={muted}>约定时间只记录在任务上；到时谁来执行，仍要在任务里安排承接。</p></div>
      <div className="grid grid-cols-1 gap-4 compact:grid-cols-3">
        <Field label="执行时间" {...field("executeAt")}>{control => <Input {...control} type="datetime-local" step={60} value={draft.executeAt} onChange={event => edit({ executeAt: event.target.value })} />}</Field>
        <Field label="时区" hint="IANA 时区，例如 Asia/Taipei。" {...field("timezone")}>{control => <Input {...control} value={draft.timezone} onChange={event => edit({ timezone: event.target.value })} autoComplete="off" />}</Field>
        <Field label="是否重复" {...field("repeat")}>{control => <Select {...control} className="w-full" value={draft.repeat} onChange={event => edit({ repeat: event.target.value as TaskDraft["repeat"] })}>
          <option value="none">仅本次</option>{canReview && <option value="daily">每天重复</option>}
        </Select>}</Field>
      </div>
      {schedulePreview && <p className="text-small text-text-secondary" data-schedule-preview="">{schedulePreview}</p>}
      <p className={muted}>{canReview
        ? "每日重复要求维护者已为本项目、你的身份和负责职责授予任务时间授权（授权范围见右栏的完整标识）。还没有授权时，可以先建仅本次的任务，授权后在任务里改成每日重复。"
        : "当前身份可以约定一次执行时间；每日重复需由有审阅权限的身份设置。"}</p>
    </section>
    {/* A problem inside 更多设置 opens it, so the field named in the summary is on screen. */}
    <details className={cn(section, "group")} open={moreOpen || !!shown.documentIds} onToggle={event => setMoreOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-label font-semibold text-foreground">更多设置</summary>
      <div className="mt-4 flex flex-col gap-4">
        <DocumentChoices read={documentsRead} chosen={draft.documentIds} error={shown.documentIds} onChange={documentIds => edit({ documentIds })} />
        {!draft.stageId && <>
          <Field label="来源或反馈证据（可选）">{control => <Textarea {...control} rows={2} value={draft.evidence} onChange={event => edit({ evidence: event.target.value })} />}</Field>
          <Field label="停止条件（可选）">{control => <Textarea {...control} rows={2} value={draft.stopCondition} onChange={event => edit({ stopCondition: event.target.value })} />}</Field>
        </>}
        <Field label="关闭条件" hint={draft.closeRule === "decision" ? "只适用于认知职责的调研任务：必须属于推进中的阶段，验收身份就是负责职责本身，且需要审阅权限；否则保存会被拒绝。" : undefined}>
          {control => <Select {...control} className="w-full" value={draft.closeRule} onChange={event => edit({ closeRule: event.target.value as TaskDraft["closeRule"] })}>
            <option value="use">需要本次交付的实际使用（默认）</option><option value="decision">只作判断记录，不要求使用</option>
          </Select>}</Field>
      </div>
    </details>
    <SubmitBar key={`${taskId}:${draft.stageId}`} context={context} stage={chosenStage} taskId={taskId} draft={draft} problems={problems}
      ready={ownersReady} onInvalid={() => setShowProblems(true)} onApplied={applied} onClear={touched ? () => { setDraft({ ...fresh, stageId: draft.stageId }); setShowProblems(false); } : undefined} />
  </form>;
  return <div data-ui="" className={cn("flex w-full flex-col gap-5", !embedded && "mx-auto max-w-[880px] px-4 py-5 compact:px-8 compact:py-7")}>
    <header className="flex flex-col gap-2">
      <a href={back.href} className="inline-flex items-center gap-1 self-start text-label font-medium text-primary hover:underline"><ArrowLeft size={15} aria-hidden="true" />{back.label}</a>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 tabIndex={-1} className="text-title font-semibold text-foreground outline-none">新建任务</h1>
        {panel && <Button size="compact" className="desktop:hidden" onClick={() => panel.setOpen(true)}>检查与归属</Button>}
      </div>
      <p className="text-small text-text-secondary">先写清要做什么、怎样算完成、由哪个职责负责。保存只建立任务记录；承接的智能体、计划和依赖在任务里安排。</p>
    </header>
    {canWrite ? form : <Notice tone="waiting" title="当前身份没有写入权限，不能新建任务。" action={<Button asChild size="compact"><a href={back.href}>{back.label}</a></Button>}>
      可以请有写入权限的人或负责的智能体登记这项工作。</Notice>}
    <ContextPanelContent><div data-ui="" role="region" aria-label="新建任务的检查与归属" className="flex flex-col gap-4">
      <PanelBlock title="交办前检查">
        <ol className="flex flex-col gap-2.5">{[["目标具体", "说明要解决的问题和可交付的结果。"], ["结果可核对", "写明独立验收要看的证据。"], ["责任真实", "选项目里实际负责分流或执行的职责。"]]
          .map(([title, text], index) => <li key={title} className="flex gap-2.5">
            <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-field text-caption text-text-secondary">{index + 1}</span>
            <span className="flex flex-col"><span className="text-label font-medium text-foreground">{title}</span><span className={muted}>{text}</span></span>
          </li>)}</ol>
      </PanelBlock>
      <PanelBlock title="所属阶段">
        {chosenStage ? <div className="flex flex-col gap-1.5">
          <p className="text-label font-medium text-foreground">{chosenStage.deliverable}</p>
          <p className={muted}>学习问题：{chosenStage.learningQuestion}</p>
          <p className={muted}>目标：{chosenGoal?.outcome ?? (goalsRead.isPending ? "正在读取…" : "目标未读到")}</p>
          <p className={muted}>属于阶段的任务要写明实际使用成果的身份、来源证据和停止条件。</p>
        </div> : <p className={muted}>{draft.stageId ? "所选阶段未读到。" : "不属于任何阶段。需要时在“所属阶段”里选一个推进中的阶段。"}</p>}
      </PanelBlock>
      <PanelBlock title="保存之后">
        <p className={muted}>任务以“待办”建立，主正文随任务自动生成。之后在任务里设置计划时间、截止、优先级和前置依赖，再确认承接的智能体。</p>
      </PanelBlock>
      <FullIdentifiers rows={[{ label: "新任务", value: taskId }, { label: "每日重复的授权范围", value: `task-timing:${taskId}` },
        { label: "所属阶段", value: draft.stageId || null }, { label: "负责职责", value: draft.owner || null }]} />
    </div></ContextPanelContent>
  </div>;
}

function PanelBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h2 className="text-label font-semibold text-foreground">{title}</h2>{children}
  </section>;
}

function DocumentChoices({ read, chosen, error, onChange }: {
  read: { data?: { items: Document[]; complete: boolean } | undefined; isPending: boolean; isSuccess: boolean; error: unknown };
  chosen: string[]; error?: string | undefined; onChange(ids: string[]): void;
}) {
  const documents = read.data?.items ?? [];
  return <fieldset className="flex flex-col gap-1.5">
    <legend className="text-label font-semibold text-foreground">关联已发布的文档（可选）</legend>
    {read.isPending && <p className={muted}>正在读取已发布的文档…</p>}
    {!!read.error && <p className={muted}>已发布的文档暂不可读取：{errorText(read.error)}。可以先不关联，保存后在任务里补充。</p>}
    {read.isSuccess && !documents.length && <p className={muted}>{read.data?.complete ? "项目里还没有已发布的文档。" : "已读范围内没有已发布的文档。"}</p>}
    {documents.length > 0 && read.data && !read.data.complete && <p className={muted} data-documents-partial="">文档只读了一部分，下面没有列出的已发布文档可以保存后在任务里补充。</p>}
    {documents.length > 0 && <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md bg-muted p-2">{documents.map(document => <li key={document.id}>
      <label className="flex items-start gap-2 text-small text-foreground">
        <input type="checkbox" className="mt-1 accent-[var(--brand)]" checked={chosen.includes(document.id)}
          onChange={event => onChange(event.target.checked ? [...chosen, document.id] : chosen.filter(id => id !== document.id))} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{document.title}</span>
      </label>
    </li>)}</ul>}
    <p className={cn(muted, error && "text-destructive")}>{error ?? `已选 ${chosen.length} 份，最多 ${maxLinkedDocuments} 份。`}</p>
  </fieldset>;
}

/** The send step. Keyed by the draft's task and stage: the stage version seen when it was chosen is the baseline. */
function SubmitBar({ context, stage, taskId, draft, problems, ready, onInvalid, onApplied, onClear }: {
  context: MutationContext; stage: Stage | undefined; taskId: string; draft: TaskDraft; problems: DraftProblems; ready: boolean;
  onInvalid(): void; onApplied(): void; onClear: (() => void) | undefined;
}) {
  const command = useCommand(context, stage ? `${stage.version}:${stage.state}` : undefined, { onStale: context.onChanged });
  const count = Object.keys(problems).length;
  const [tried, setTried] = React.useState(false);
  async function send() {
    setTried(true);
    if (count) { onInvalid(); return; }
    if (await command.submit(() => taskCreateCommand(draft, taskId))) onApplied();
  }
  return <div className="flex flex-col gap-3">
    {tried && count > 0 && <Notice tone="waiting">还有 {count} 处需要补充：{(Object.keys(problems) as (keyof TaskDraft)[]).map(key => draftFieldLabels[key]).join("、")}。说明写在各项下面。</Notice>}
    {context.blocked && <p className={muted}>本项目仍有结果未确认的操作，请先核对回执，再保存。</p>}
    {command.baselineChanged && <Notice tone="waiting" title="所属阶段已被更新" action={<Button size="compact" onClick={command.rebase}>已查看，继续</Button>}>
      {baselineChangedText}右栏“所属阶段”已是最新读回。</Notice>}
    {command.outcome && !command.baselineChanged && <Notice tone={command.outcome.failed ? "error" : "info"}>{command.outcome.message}</Notice>}
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" onClick={() => void send()} disabled={!ready || context.blocked || command.busy || command.baselineChanged}>{command.busy ? "保存中…" : "保存任务"}</Button>
      {onClear && <Button variant="ghost" onClick={onClear}>清空草稿</Button>}
    </div>
  </div>;
}
