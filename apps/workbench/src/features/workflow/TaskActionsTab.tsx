// 任务操作 (tasks.md 正文与右栏: 修改、取消、重开等写入放在“任务操作”层). Only what the signed-in identity can do in the
// task's current state is shown; what needs another permission is counted in one line, never listed as forms.
// Each form records the versions it opened on (useCommand); the commands are pinned in task-commands.test.ts.
import React from "react";
import type { DocumentDetail, RuntimeRunRecord, TaskDetail } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import {
  leaderWorkDependenciesCommandSchema, leaderWorkPlanCommandSchema, leaderWorkReviewCommandSchema,
  type LeaderWorkDependenciesCommand, type LeaderWorkPlanCommand, type LeaderWorkReviewCommand, type LeaderWorkTask,
} from "@evoloop/contracts/work-index";
import { Button, Checkbox, Field, Input, Notice, Select, Textarea } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { acceptanceMemberKind } from "../../shared/memberPresentation";
import { MemberChoice } from "../../shared/ui/MemberChoice";
import { useProjectPages, useProjectQuery } from "../../shared/query";
import { roleClient } from "../../shared/roleClient";
import { runtimeClient } from "../../shared/runtimeClient";
import { date, href } from "../../shared/ui/shared";
import { CommandForm, CommandFrame, overLimitText, useCommand } from "../../shared/command";
import { attributableRuns } from "./deliveryRun";
import { runStateName } from "./taskExperience";
import {
  acceptanceResponsibilityCommand, closableDelivery, deliveryRecordCommand, dependenciesCommand, leaderSeen, localInput,
  observationRecordCommand, olderBasisSources, planCommand, reviewCommand, taskCancelCommand, taskCloseCommand, taskReopenCommand,
  taskStartCommand, taskUpdateCommand, withoutOperationType,
} from "./taskCommands";
import { ActionRow, Fine, TabSection, reasonField } from "./TaskForms";
import { TaskScheduleSection } from "./TaskScheduleSection";
import type { ReadState } from "./taskFactsPresentation";

type Permission = "write" | "review";
interface Action { key: string; title: string; description?: React.ReactNode; needs: Permission[]; element: React.ReactNode }

const kindOptions = [{ value: "implementation", label: "实施" }, { value: "research", label: "调研" }, { value: "validation", label: "验证" }];

/** Every Role of the project, read in pages; a partial list is never offered as complete. */
async function readRoles(projectId: string): Promise<RoleRecord[]> {
  const result: RoleRecord[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const next = await roleClient("", projectId).list(cursor);
    if (next.items.some(role => role.projectId !== projectId)) throw new Error("职责响应与当前项目不符");
    result.push(...next.items);
    if (!next.nextCursor) return [...new Map(result.map(role => [role.id, role])).values()];
    if (seen.has(next.nextCursor)) throw new Error("职责列表分页游标重复");
    seen.add(next.nextCursor); cursor = next.nextCursor;
  }
  throw new Error("职责超过自动读取上限，无法完整选择；请先缩小项目范围");
}

/** The roles a task may be handed to. Until the directory is read, only the current owner is offered. */
export function ownerOptions(owner: string, read: { data?: RoleRecord[] | undefined; error?: unknown; isPending?: boolean }) {
  if (!read.data || read.error) return [{ value: owner, label: "当前负责者（职责目录待核对）" }];
  const roles = read.data.filter(role => role.state === "active" || role.state === "trial")
    .map(role => ({ value: role.id, label: `${role.proposal.title} · ${role.state === "trial" ? "试行" : "使用中"}` }));
  return roles.some(role => role.value === owner) ? roles : [{ value: owner, label: "当前负责者（未核为使用中的职责）" }, ...roles];
}

export function TaskActionsTab({ context, detail, leader, leaderState, documents, documentsPending, documentsFailed = false, onRereadDocuments, onRereadLeader, open }: {
  context: MutationContext; detail: TaskDetail; leader: LeaderWorkTask | null; leaderState: ReadState;
  documents: Record<string, DocumentDetail | undefined>; documentsPending: boolean; documentsFailed?: boolean; onRereadDocuments?(): void; onRereadLeader(): void;
  /** The action opened when the tab first shows (its key). */
  open?: string | undefined;
}) {
  const projectId = context.projectId;
  const task = detail.task;
  const permissions = context.principal.permissions;
  const may = (needs: Permission[]) => needs.every(permission => permissions.includes(permission));
  const roles = useProjectQuery(projectId, ["roles", "choices"], () => readRoles(projectId));
  const owners = ownerOptions(task.owner, roles);
  const deliveries = detail.deliveries ?? [];
  const latest = deliveries.at(-1);
  const acceptanceMode = detail.proposal?.acceptanceMode ?? null;
  const closable = closableDelivery(detail);
  const older = olderBasisSources(detail, documents);
  const taskSeen = { taskVersion: task.version, revisionId: task.currentRevisionId };
  // While the current work is read again after a write, the forms stay open on the last answer (their baselines
  // still guard the submit); a failed read hides them.
  const lastLeader = React.useRef<LeaderWorkTask | null>(null);
  if (leaderState === "ready") lastLeader.current = leader;
  const shownLeader = leaderState === "ready" ? leader : leaderState === "failed" ? null : lastLeader.current;

  const content: Action[] = [];
  if (task.state === "todo" || task.state === "in_progress") content.push({ key: "update", title: "更新任务内容", needs: ["write"],
    description: task.state === "in_progress" ? "执行范围已经固定；要改正文、验收、负责职责或类型，先“返回待办”，更新后再开始。" : "改名称、类型、正文、验收条件和负责职责。",
    element: <CommandForm context={context} submitLabel="保存任务内容" baseline={{ ...taskSeen, links: detail.links.map(link => link.documentId).join(",") }}
      notes={roles.error ? <Notice tone="error" action={<Button size="compact" onClick={() => void roles.refetch()}>重新读取职责</Button>}>
        职责目录暂不可完整读取：{errorText(roles.error)}。仍可保留现负责者修改内容；更换负责职责要先读全职责目录。</Notice>
        : roles.isPending ? <Fine>正在读取职责目录；读完前只能保留现负责者。</Fine> : null}
      fields={[
        { name: "title", label: "任务名称", initial: task.title, maxLength: 240 },
        { name: "kind", label: "类型", kind: "select", optional: true, initial: task.kind ?? "", options: kindOptions },
        { name: "content", label: "任务内容", kind: "textarea", rows: 8, initial: task.content, maxLength: 65536 },
        { name: "acceptance", label: "独立验收条件", kind: "textarea", rows: 4, initial: task.acceptance, maxLength: 4000 },
        { name: "owner", label: "负责职责", kind: "select", initial: task.owner, options: owners },
        reasonField(),
      ]}
      build={(values, seen) => {
        if (!owners.some(item => item.value === values.owner)) throw new Error("所选职责不在已核对的范围内。");
        return taskUpdateCommand(detail, seen, { title: values.title ?? "", kind: values.kind ?? "", content: values.content ?? "",
          acceptance: values.acceptance ?? "", owner: values.owner ?? "", reason: values.reason ?? "" });
      }} /> });
  if (task.state === "todo") content.push({ key: "acceptance", title: "修订验收责任", needs: ["review"], description: "谁来使用交付并签收：独立的智能体，或指定的人本人。",
    element: <CommandForm context={context} submitLabel="保存验收责任" baseline={{ taskVersion: task.version }} fields={[
      { name: "acceptanceMode", label: "验收方式", kind: "select", initial: acceptanceMode ?? "legacy", options: [
        ...(acceptanceMode ? [] : [{ value: "legacy", label: "保留旧任务的历史约定" }]),
        { value: "independent_agent", label: "独立的智能体验收" }, { value: "human_required", label: "必须本人验收" }] },
      { name: "consumer", label: "指定验收身份", optional: true, kind: "custom", initial: detail.proposal?.consumer ?? "", maxLength: 4000,
        hint: "必须本人验收时选验收的人本人；独立智能体验收可以不预先指定。只列出能写入的成员（记录使用要写入）。",
        render: ({ control, value, values, onChange }) => <MemberChoice projectId={projectId} control={control} value={value} onChange={onChange}
          need="write" kind={acceptanceMemberKind(values.acceptanceMode)} optional /> },
      reasonField()]}
      build={(values, seen) => acceptanceResponsibilityCommand(detail, seen, { acceptanceMode: values.acceptanceMode ?? "legacy",
        consumer: values.consumer ?? "", reason: values.reason ?? "" })} /> });

  const progress: Action[] = [];
  if (task.state === "todo") progress.push({ key: "start", title: "开始任务并固定依据", needs: ["review"],
    description: "开始时把正文和依据的当前修订固定下来；文档以后改版要复核。",
    element: documentsPending ? <Fine>正在核对依据文档是否已有新版…</Fine>
      // Without the documents' current state nobody can tell whether a fixed revision is outdated: start waits for it.
      : documentsFailed ? <Notice tone="waiting" action={onRereadDocuments && <Button size="compact" onClick={onRereadDocuments}>重新读取</Button>}>
        依据文档的现状暂不可读，无法判断哪份已有新版；读回后再开始。</Notice>
      : <CommandForm context={context} submitLabel="开始任务" baseline={{ taskVersion: task.version, older: older.map(item => `${item.documentId}@${item.observedAdoptedRevisionId}`).join(",") }}
        notes={<Fine>主正文的固定修订会自动加入依据。已有且仍适用的保留决定会沿用；新的逐项理由和依据一起封存，上游再改版仍要复核。</Fine>}
        fields={[reasonField(),
          ...older.map(source => ({ name: `retain_${source.documentId}`, label: `要保留《${source.title}》的旧版，写明理由`, kind: "textarea" as const, optional: true, maxLength: 4000,
            hint: "这份文档已发布新版。先在“依据与影响”读两版；留空不等于同意使用旧版。" }))]}
        build={(values, seen) => taskStartCommand(detail, seen, older, { reason: values.reason ?? "",
          retain: Object.fromEntries(older.map(source => [source.documentId, values[`retain_${source.documentId}`] ?? ""])) })} /> });
  if (task.state === "in_progress") {
    progress.push({ key: "delivery", title: latest ? "提交新的交付" : "登记本次交付", needs: ["write"],
      description: latest ? "旧交付的记录保留；新交付要重新检查和使用。" : "成果的位置、固定修订、内容摘要和技术检查结果。",
      element: <DeliveryRecordForm context={context} detail={detail} /> });
    const humanOnly = acceptanceMode === "human_required" && context.principal.identityKind !== "human";
    if (latest && !humanOnly) progress.push({ key: "observation", title: "记录本次交付的使用观察", needs: ["write"],
      description: "谁实际用了最新的交付、结果怎样。登记不自动证明长期效果。",
      element: <CommandForm context={context} submitLabel="记录使用观察" baseline={{ deliveryId: latest.id, acceptanceMode: acceptanceMode ?? "legacy" }} fields={[
        { name: "observer", label: "实际使用者", initial: context.principal.actorId, maxLength: 4000 },
        { name: "observerKind", label: "使用者类型", kind: "select", initial: acceptanceMode === "human_required" ? "human" : "agent",
          options: acceptanceMode === "independent_agent" ? [{ value: "agent", label: "智能体使用" }]
            : acceptanceMode === "human_required" ? [{ value: "human", label: "指定的人本人使用" }]
              : [{ value: "agent", label: "智能体使用" }, { value: "human", label: "人使用（需要实际证据）" }] },
        { name: "result", label: "使用结果", kind: "select", options: [{ value: "used", label: "实际使用并有结果" }, { value: "failed", label: "尝试使用但失败" }, { value: "notUsed", label: "尚未使用" }] },
        { name: "evidence", label: "使用过程、结果与反馈证据", kind: "textarea", maxLength: 4000 }, reasonField()]}
        build={(values, seen) => observationRecordCommand(detail, seen, { observer: values.observer ?? "", observerKind: values.observerKind ?? "",
          result: values.result ?? "", evidence: values.evidence ?? "", reason: values.reason ?? "" })} /> });
    if (latest && closable) progress.push({ key: "close", title: "核对验收并关闭任务", needs: ["review"], description: "逐项写明验收已满足的证据与限制。",
      element: <CommandForm context={context} submitLabel="关闭任务" baseline={{ taskVersion: task.version, deliveryId: latest.id }} fields={[
        { name: "acceptanceEvidence", label: "逐项验收已满足的证据与限制", kind: "textarea", rows: 4, maxLength: 4000 }, reasonField()]}
        build={(values, seen) => taskCloseCommand(detail, seen, { acceptanceEvidence: values.acceptanceEvidence ?? "", reason: values.reason ?? "" })} /> });
  }

  const ending: Action[] = [];
  if (task.state === "todo" || task.state === "in_progress") ending.push({ key: "cancel", title: "取消任务", needs: ["review"], description: "取消这一份任务；重复任务的以后生成另在“执行时间与重复”里停止。",
    element: <CommandForm context={context} submitLabel="取消任务" danger baseline={{ taskVersion: task.version }} fields={[reasonField()]}
      build={(values, seen) => taskCancelCommand(detail, seen, { reason: values.reason ?? "" })} /> });
  if (task.state === "in_progress" || task.state === "done" || task.state === "cancelled") ending.push({ key: "reopen",
    title: task.state === "in_progress" ? "返回待办以重新定界" : "重新打开任务", needs: ["review"],
    description: task.state === "in_progress" ? "回到待办后可以改正文、验收和负责职责，再重新开始。" : "重新打开的任务不沿用旧交付的通过或使用记录。",
    element: <CommandForm context={context} submitLabel={task.state === "in_progress" ? "返回待办" : "重新打开"} baseline={{ taskVersion: task.version }} fields={[reasonField()]}
      build={(values, seen) => taskReopenCommand(detail, seen, { reason: values.reason ?? "" })} /> });

  const groups = [{ title: "内容与验收责任", actions: content }, { title: "推进与交付", actions: progress }, { title: "取消与重开", actions: ending }];
  const hidden = groups.flatMap(group => group.actions).filter(action => !may(action.needs));
  const canArrange = may(["write", "review"]);
  const hiddenCount = hidden.length + (!canArrange && leaderState === "ready" && leader ? 3 : 0);
  const visible = (actions: Action[]) => actions.filter(action => may(action.needs));
  return <div className="flex flex-col gap-8" data-task-actions="">
    <Fine>提交时按打开表单时看到的版本核对；结果未知时保留原操作 ID，先核对，不重复发送。</Fine>
    {groups.slice(0, 2).map(group => visible(group.actions).length > 0 && <TabSection key={group.title} title={group.title}>
      <div className="flex flex-col">{visible(group.actions).map(action => <ActionRow key={action.key} title={action.title} description={action.description} defaultOpen={action.key === open}>{action.element}</ActionRow>)}</div>
      {group.title === "推进与交付" && task.state === "in_progress" && latest && !closable && may(["review"]) && <Fine>当前修订还需要技术检查通过的交付{detail.proposal?.useRequired ? "，以及约定的使用者对这次交付的实际使用记录" : ""}，满足后才能关闭。</Fine>}
      {group.title === "推进与交付" && task.state === "in_progress" && latest && acceptanceMode === "human_required" && context.principal.identityKind !== "human" && <Fine>这项任务等指定的人本人登录后记录使用结果。</Fine>}
    </TabSection>)}
    {canArrange && <TabSection title="统筹安排">
      {(leaderState === "loading" || leaderState === "checking") && <Fine>{shownLeader ? "正在重新核对当前工作安排…" : "正在读取当前工作安排…"}</Fine>}
      {leaderState === "failed" && <Notice tone="waiting" action={<Button size="compact" onClick={onRereadLeader}>重新读取</Button>}>当前工作安排暂不可读取。计划、依赖和统筹决定要按读到的版本提交，读回前暂不能修改。</Notice>}
      {leaderState === "ready" && !leader && <p className="text-label text-text-secondary">这项任务没有登记当前工作安排，不能设置计划、依赖或统筹决定。</p>}
      {shownLeader && <LeaderActions context={context} detail={detail} leader={shownLeader} open={open} />}
    </TabSection>}
    <TaskScheduleSection context={context} detail={detail} />
    {visible(ending).length > 0 && <TabSection title="取消与重开">
      <div className="flex flex-col">{visible(ending).map(action => <ActionRow key={action.key} title={action.title} description={action.description} defaultOpen={action.key === open}>{action.element}</ActionRow>)}</div>
    </TabSection>}
    {hiddenCount > 0 && <Fine>另有 {hiddenCount} 项操作需要{permissions.includes("write") ? "审阅" : "写入或审阅"}权限，当前身份不能执行。</Fine>}
    {!visible(content).length && !visible(progress).length && !visible(ending).length && !canArrange && !may(["write"]) && <p className="text-label text-text-secondary">当前身份在这个状态下没有可做的操作。</p>}
  </div>;
}

/** 登记交付: the source run is chosen from this task's finished runs, read when the form opens. */
function DeliveryRecordForm({ context, detail }: { context: MutationContext; detail: TaskDetail }) {
  const projectId = context.projectId;
  const task = detail.task;
  const runsRead = useProjectQuery(projectId, ["runtime", "runs", task.id], async () => {
    const value = await runtimeClient("", projectId).runs(task.id);
    if (!Array.isArray(value)) throw new Error("运行列表响应格式不符");
    return value;
  });
  const runs: RuntimeRunRecord[] = attributableRuns(projectId, task.id, runsRead.data ?? []);
  return <CommandForm context={context} submitLabel="登记交付" baseline={{ taskVersion: task.version }}
        notes={runsRead.error ? <Notice tone="waiting">暂时无法读取来源运行：{errorText(runsRead.error)}。可以登记没有运行归属的交付，不能猜测归属。</Notice> : null}
        fields={[
          { name: "runId", label: "来源运行", kind: "select", optional: true, options: runs.map(run => ({ value: run.id,
            label: `${runStateName[run.state] ?? "状态未识别"} · 开始于 ${date(run.createdAt)}${run.taskRevisionId === task.currentRevisionId ? "" : " · 旧修订"}` })),
            hint: "只列这项任务已结束的运行；不选就明确没有运行归属。运行结束不代表成果合格。" },
          { name: "artifactRef", label: "成果位置", hint: "可追溯的文档、文件或合并请求地址。", maxLength: 4000 },
          { name: "artifactRevision", label: "成果的固定修订", maxLength: 4000 },
          { name: "contentHash", label: "内容 SHA-256", hint: "64 位十六进制摘要。" },
          { name: "technicalResult", label: "技术检查结果", kind: "select", options: [{ value: "passed", label: "检查通过" }, { value: "failed", label: "检查失败，不能关闭" }] },
          { name: "technicalEvidence", label: "实际检查与结果证据", kind: "textarea", maxLength: 4000 },
          reasonField()]}
        build={(values, seen) => deliveryRecordCommand(detail, seen, { runId: values.runId ?? "", artifactRef: values.artifactRef ?? "",
          artifactRevision: values.artifactRevision ?? "", contentHash: values.contentHash ?? "", technicalResult: values.technicalResult ?? "",
          technicalEvidence: values.technicalEvidence ?? "", reason: values.reason ?? "" })} />;
}

function LeaderActions({ context, detail, leader, open }: { context: MutationContext; detail: TaskDetail; leader: LeaderWorkTask; open?: string | undefined }) {
  const projectId = context.projectId;
  const task = detail.task;
  const seen = leaderSeen(task, leader);
  const plan = leader.plan;
  return <div className="flex flex-col">
    <ActionRow defaultOpen={open === "plan"} title="设置计划、截止与优先级" description={plan && (plan.priority || plan.dueAt || plan.plannedStartAt)
      ? [plan.priority ? `P${plan.priority}` : "", plan.plannedStartAt ? `计划开始 ${date(plan.plannedStartAt)}` : "", plan.dueAt ? `截止 ${date(plan.dueAt)}` : ""].filter(Boolean).join(" · ")
      : "还没有设置。只是负责人的安排，不改变任务状态。"}>
      <CommandForm context={context} submitLabel="保存计划" baseline={{ taskVersion: seen.taskVersion, planVersion: seen.planVersion }}
        options={{ validate: value => { leaderWorkPlanCommandSchema.parse(withoutOperationType(value)); },
          send: command => api().leaderPlan(projectId, task.id, command as unknown as LeaderWorkPlanCommand) }}
        fields={[
          { name: "plannedStartAt", label: "计划开始", kind: "datetime", optional: true, initial: localInput(plan?.plannedStartAt), hint: "只表示负责人安排的开始时间，不改变任务状态。" },
          { name: "dueAt", label: "计划截止", kind: "datetime", optional: true, initial: localInput(plan?.dueAt) },
          { name: "priority", label: "优先级", kind: "select", optional: true, initial: plan?.priority ? String(plan.priority) : "",
            options: [{ value: "1", label: "P1 · 最高" }, { value: "2", label: "P2" }, { value: "3", label: "P3" }, { value: "4", label: "P4 · 最低" }] },
          reasonField()]}
        build={(values, recorded) => planCommand(task.id, recorded, { plannedStartAt: values.plannedStartAt ?? "", dueAt: values.dueAt ?? "",
          priority: values.priority ?? "", reason: values.reason ?? "" })} />
    </ActionRow>
    <ActionRow defaultOpen={open === "dependencies"} title="设置前置任务依赖" description={leader.dependencies.length
      ? `${leader.dependencies.length} 项前置任务，${leader.dependencies.filter(item => !item.acceptanceSatisfied).length} 项尚未验收` : "没有前置任务。"}>
      <DependenciesForm context={context} detail={detail} leader={leader} onReread={context.onChanged} />
    </ActionRow>
    <ActionRow defaultOpen={open === "review"} title="记录统筹处理决定" description={leader.review ? `${leader.review.decision === "deferred" ? "已暂缓" : "已核对"} · ${date(leader.review.at)}` : "对这项任务的当前版本记“已核对”或“暂缓”。"}>
      <CommandForm context={context} submitLabel="保存决定" baseline={{ taskVersion: seen.taskVersion, revisionId: seen.revisionId, workChangeSequence: seen.workChangeSequence }}
        options={{ validate: value => { leaderWorkReviewCommandSchema.parse(withoutOperationType(value)); },
          send: command => api().leaderReview(projectId, task.id, command as unknown as LeaderWorkReviewCommand) }}
        notes={<Fine>决定只对这一版任务和当前工作位置有效；相关事实变化后，旧决定退出对账摘要。</Fine>}
        fields={[
          { name: "decision", label: "决定", kind: "select", initial: leader.review?.decision ?? "acknowledged",
            options: [{ value: "acknowledged", label: "已核对当前工作" }, { value: "deferred", label: "暂缓，等待明确条件" }] },
          { ...reasonField(), initial: leader.review?.reason ?? "" }]}
        build={(values, recorded) => reviewCommand(task.id, recorded, { decision: values.decision ?? "", reason: values.reason ?? "" })} />
    </ActionRow>
  </div>;
}

const taskIdPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Prerequisites by name: keep or drop the current ones, add from the loaded task list or by a pasted task link. */
function DependenciesForm({ context, detail, leader, onReread }: { context: MutationContext; detail: TaskDetail; leader: LeaderWorkTask; onReread(): void }) {
  const projectId = context.projectId;
  const task = detail.task;
  const current = leader.dependencies.map(item => item.taskId);
  const command = useCommand(context, { taskVersion: task.version, dependencyVersion: leader.dependencyVersion }, {
    validate: value => { leaderWorkDependenciesCommandSchema.parse(withoutOperationType(value)); },
    send: built => api().leaderDependencies(projectId, task.id, built as unknown as LeaderWorkDependenciesCommand),
    onStale: onReread,
    // Applied, now or when an unknown result is read back: the list sent becomes the base and the reason is cleared.
    onApplied: () => { setReason(""); setPasted(""); setBase(chosen); setTried(false); },
  });
  const pages = useProjectPages(projectId, ["tasks", "list"], (cursor, signal) => api().tasks(projectId, cursor, signal));
  const known = (pages.data?.pages ?? []).flatMap(page => page.items);
  // `base` is the list the form was last filled with; the person's changes are what differs from it.
  const [base, setBase] = React.useState<string[]>(current);
  const [chosen, setChosen] = React.useState<string[]>(current);
  const [adding, setAdding] = React.useState("");
  const [pasted, setPasted] = React.useState("");
  const [reason, setReason] = React.useState("");
  const currentKey = current.join(",");
  const title = (id: string) => leader.dependencies.find(item => item.taskId === id)?.title || known.find(item => item.id === id)?.title || "任务（名称待读取）";
  const dirty = chosen.join(",") !== base.join(",") || !!reason || !!pasted;
  const refill = () => { setBase(current); setChosen(current); };
  // An untouched form follows the latest prerequisites; a changed one waits for the person (the rule of every task form).
  React.useEffect(() => {
    if (dirty || command.awaitingReread) return;
    if (command.baselineChanged) command.rebase();
    if (command.baselineChanged || currentKey !== base.join(",")) refill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, command.baselineChanged, command.awaitingReread, dirty]);
  /** “保留我的修改”: what the person added or removed is applied to the latest list. */
  const keep = () => {
    const removed = base.filter(id => !chosen.includes(id)), added = chosen.filter(id => !base.includes(id));
    command.rebase(); setBase(current);
    setChosen([...current.filter(id => !removed.includes(id)), ...added.filter(id => !current.includes(id))]);
  };
  const pastedId = taskIdPattern.exec(pasted)?.[1]?.toLowerCase() ?? null;
  const [tried, setTried] = React.useState(false);
  async function submit() {
    setTried(true);
    if (!reason.trim() || overLimitText(reason, 4000)) return;
    await command.submit(seen => dependenciesCommand(task.id, seen, { dependsOnTaskIds: chosen, reason }));
  }
  return <CommandFrame context={context} command={command} label="设置前置任务依赖" submitLabel="保存前置任务" dirty={dirty} onSubmit={() => void submit()}
    onReread={onReread} onRefill={() => { command.rebase(); refill(); }} onKeep={keep} keepNote="保留我的修改：你加入和移除的前置任务套用到最新的列表上。">
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-label font-semibold text-foreground">前置任务</legend>
      {!chosen.length && <p className="text-label text-text-secondary">没有前置任务。</p>}
      {chosen.map(id => <label key={id} className="flex items-center gap-2 text-label text-foreground">
        <Checkbox checked onCheckedChange={() => setChosen(list => list.filter(item => item !== id))} />
        <a className="text-primary hover:underline" href={href(projectId, "task", id)}>{title(id)}</a>
        <span className="text-caption text-muted-foreground">{leader.dependencies.find(item => item.taskId === id)?.acceptanceSatisfied ? "已验收" : current.includes(id) ? "等待验收" : "新加入"}</span>
      </label>)}
      <p className="text-caption text-muted-foreground">取消勾选即移除。依赖只在前置任务真实验收或队列按验收放行后才算满足。</p>
    </fieldset>
    <div className="flex flex-wrap items-end gap-2">
      <Field label="从已载入的任务中添加" className="min-w-0 flex-1">{control => <Select {...control} value={adding} onChange={event => setAdding(event.target.value)} className="w-full">
        <option value="">请选择</option>
        {known.filter(item => item.id !== task.id && !chosen.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </Select>}</Field>
      <Button size="compact" disabled={!adding} onClick={() => { setChosen(list => [...list, adding]); setAdding(""); }}>添加</Button>
    </div>
    {pages.hasNextPage && <p className="text-caption text-muted-foreground">任务列表还有未载入的页；不在下拉里的任务可以粘贴它的链接。</p>}
    <div className="flex flex-wrap items-end gap-2">
      <Field label="按任务链接添加" hint="粘贴任务页的地址。" className="min-w-0 flex-1">{control => <Input {...control} value={pasted} onChange={event => setPasted(event.target.value)} autoComplete="off" />}</Field>
      <Button size="compact" disabled={!pastedId || pastedId === task.id || chosen.includes(pastedId)} onClick={() => { setChosen(list => [...list, pastedId!]); setPasted(""); }}>添加</Button>
    </div>
    <Field label="理由与依据" error={tried && !reason.trim() ? "请填写理由与依据。" : overLimitText(reason, 4000) ?? undefined}>{control =>
      <Textarea {...control} required value={reason} onChange={event => setReason(event.target.value)} rows={3} />}</Field>
  </CommandFrame>;
}

