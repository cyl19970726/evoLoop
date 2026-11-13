// Two blocks of the task's 进展与讨论: 当前关注 (what the reconciliation flagged on this revision, and the follow-up
// the Leader records for it) and 阶段区间、计划与来源 (the current work's next step, stage time, plan, sources,
// acceptance, execution, delivery, the Leader's decision, the result notices and the prerequisites). Server text
// written for agents and raw identifiers stay in the full-identifier layer.
import React from "react";
import type { TaskAttentionFollowUp, TaskAttentionItem, TaskDetail } from "@evoloop/contracts";
import type { LeaderNotice } from "@evoloop/contracts/leader-notices";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { Button, Checkbox, Field, Input, Notice, Select, StatusTag, Textarea } from "@evoloop/ui";
import { api, errorText, request } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectPages, useProjectQuery } from "../../shared/query";
import { timingDuration, timingStageLabel, waitingKindLabel, waitingParty } from "../../shared/taskTiming";
import { responsibleText, waitingText, workItemNextStep } from "../../shared/workPresentation";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { ResponsibleName } from "../../shared/ui/RecordName";
import { date, href } from "../../shared/ui/shared";
import { CommandForm, CommandFrame, conflictingFields, followLatest, formDirty, keepEdits, overLimitText, useCommand, type FormState } from "../../shared/command";
import { attentionResolveCommand, followUpCommand, localInput, publicationCommand } from "./taskCommands";
import { runStateName } from "./taskExperience";
import { ActionRow, Fact, Fine, ReadNote, readCurrent, reasonField } from "./TaskForms";
import { withReturn } from "../../shared/returnLink";
import { taskOrigin } from "./taskOrigin";
import { actorRow, actorText } from "../../shared/actorPresentation";
import { ActorIdentifiers } from "../../shared/ui/ActorIdentifiers";

type FollowUpKind = NonNullable<TaskAttentionFollowUp["waitingOn"]>["kind"];
const followUpKinds: FollowUpKind[] = ["session", "consumer", "leader", "publisher", "user", "task", "unknown"];
const signalLabel: Record<TaskAttentionItem["signal"], string> = {
  stage_overdue: "阶段逾期", activity_without_progress: "有活动但缺少有效进展", observation_gap: "缺少使用观察",
};
const decisionLabel: Record<TaskAttentionFollowUp["decision"], string> = { waiting: "等待中", checked: "已核对", acted: "已采取行动" };
const noticeLabel: Record<LeaderNotice["kind"], string> = {
  task_todo: "待编排的任务", delivery: "交付已封存", observation: "验收结果", observation_used: "验收结果：已使用", observation_failed: "验收结果：失败或未使用（需处理）", line_entry_suspended: "队伍项挂起，无法开始", line_confirmation_returned: "执行确认被退回", direct_dispatch_blocked: "定时直派受阻或等待过久", direct_circuit_open: "定时直派熔断", schedule_skips_escalated: "定时任务连续跳过", task_question: "关键问题", task_blocker: "执行受阻",
  run_without_submission: "运行结束但没有提交", run_submission_blocked: "运行结果封存受阻", task_attention: "任务关注待跟进", acceptance_blocked: "验收投递受阻",
};

type AttentionRead = { followUp: TaskAttentionFollowUp | null; followUpHistory: TaskAttentionFollowUp[]; items: TaskAttentionItem[]; itemsNextCursor: string | null };

async function readAttention(projectId: string, taskId: string): Promise<AttentionRead> {
  const value = await request<AttentionRead>("", `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/attention`, 15000);
  if (!value || !Array.isArray(value.items) || !Array.isArray(value.followUpHistory) ||
    value.items.some(item => item.taskId !== taskId || !item.id || !item.taskRevisionId) ||
    value.followUp?.taskId !== undefined && value.followUp.taskId !== taskId) throw new Error("关注项响应与所选任务不符；请重新读取。");
  return value;
}

/** Who an attention item waits on: a kind, and an actor's name (a record's raw ID stays in 完整标识). */
function attentionWaiting(item: TaskAttentionItem, revisionId: string, leader: LeaderWorkTask): string {
  if (item.waitingOn) return `等待方 ${waitingParty(item.waitingOn)}`;
  if (item.taskRevisionId === revisionId && leader.timing?.current.stage === item.phase) return `等待方 ${waitingParty(leader.timing.current.waitingFor)}（当前阶段）`;
  return "等待方 责任未知";
}

/** 当前关注: the open attention items of this task, each resolvable on the current revision, and the follow-up. */
export function TaskAttentionSection({ context, detail, leader }: { context: MutationContext; detail: TaskDetail; leader: LeaderWorkTask }) {
  const projectId = context.projectId;
  const taskId = detail.task.id, revisionId = detail.task.currentRevisionId;
  const read = useProjectQuery(projectId, ["task", taskId, "attention", revisionId], () => readAttention(projectId, taskId));
  const [more, setMore] = React.useState<{ items: TaskAttentionItem[]; cursor: string | null; error: string } | null>(null);
  const value = read.data;
  const items = value ? [...value.items, ...(more?.items ?? []).filter(item => !value.items.some(old => old.id === item.id))] : [];
  const cursor = more ? more.cursor : value?.itemsNextCursor ?? null;
  const followUp = value?.followUp?.taskRevisionId === revisionId ? value.followUp : null;
  // A publication counts for this revision only when the follow-up that first recorded it was on this revision.
  const ordered = [...value?.followUpHistory ?? []].sort((a, b) => a.version - b.version);
  const firstPublication = ordered.findIndex(entry => !!entry.publication);
  const origin = firstPublication >= 0 ? ordered[firstPublication] : null;
  const proven = !!origin && (origin.version === 1 || firstPublication > 0 && !ordered[firstPublication - 1]!.publication);
  const publicationCurrent = !!followUp?.publication && proven && origin?.taskRevisionId === revisionId;
  const staleFollowUp = !!value?.followUp && !followUp;
  const permissions = context.principal.permissions;
  // Writes go out only from a current read: after a failed reread the last answer is shown, marked, and not written from.
  const canWrite = permissions.includes("review") && permissions.includes("write") && leader.currentRevisionId === revisionId && readCurrent(read);
  const open = items.filter(item => item.state === "open");
  async function readMore() {
    if (!cursor) return;
    try {
      const page = await request<{ items: TaskAttentionItem[]; nextCursor: string | null }>("", `/api/projects/${encodeURIComponent(projectId)}/task-attention/items?taskId=${encodeURIComponent(taskId)}&state=open&limit=100&cursor=${encodeURIComponent(cursor)}`, 15000);
      if (!Array.isArray(page.items) || page.items.some(item => item.taskId !== taskId || item.state !== "open")) throw new Error("关注项续页与当前任务不符");
      setMore(current => ({ items: [...current?.items ?? [], ...page.items], cursor: page.nextCursor, error: "" }));
    } catch (cause) { setMore(current => ({ items: current?.items ?? [], cursor, error: `续页读取失败：${errorText(cause)}` })); }
  }
  return <section id="task-attention" aria-label="任务当前关注" className="flex min-w-0 scroll-mt-20 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h3 className="text-small font-semibold text-foreground">当前关注</h3>
      {value && <span className="text-caption text-muted-foreground">{open.length ? `${open.length} 项已关注` : "已读范围内没有待处理的关注项"}{cursor ? "；还有未读的续页" : ""}</span>}
      <Button size="compact" variant="ghost" className="ml-auto" disabled={read.isFetching} onClick={() => { setMore(null); void read.refetch(); }}>重新读取</Button>
    </div>
    <ReadNote read={read} what="关注项" />
    {items.length > 0 && <ul className="flex flex-col gap-2">{items.map(item => <li key={item.id} className="flex flex-col gap-1 rounded-lg bg-muted px-4 py-3" data-attention-item={item.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label font-medium text-foreground">{signalLabel[item.signal] ?? "关注项"}</span>
        <StatusTag tone={item.state === "open" ? item.severity === "urgent" ? "blocked" : "waiting" : "done"} label={`${item.severity === "urgent" ? "紧急" : "观察"} · ${item.state === "open" ? "待解决" : "已解决"}`} />
      </div>
      <Fine>首次发现 {date(item.firstDetectedAt)} · 最近核对 {date(item.lastDetectedAt)} · {attentionWaiting(item, revisionId, leader)}</Fine>
      {item.taskRevisionId !== revisionId && <Fine>属于任务的旧修订，不能按当前版本解决。</Fine>}
      <Fine>依据：{Object.keys(item.evidence ?? {}).length ? `${Object.keys(item.evidence).length} 项观察记录` : "没有附带的观察记录"} · 来源观察于 {date(item.sourceObservedAt)}；原文见完整标识。</Fine>
      {item.state === "open" && item.taskRevisionId === revisionId && canWrite && <ActionRow title="解决这一项">
        <CommandForm context={context} submitLabel="记录已解决" baseline={{ itemId: item.id, itemVersion: item.version }} fields={[reasonField("解决依据")]}
          build={(values, seen) => attentionResolveCommand(item, seen, { reason: values.reason ?? "" })} /></ActionRow>}
      <FullIdentifiers rows={[{ label: "关注项", value: item.id }, { label: "通知", value: item.noticeId }, { label: "原因原文", value: item.reason, text: true },
        { label: "等待对象", value: item.waitingOn?.id }, { label: "依据原文", value: Object.keys(item.evidence ?? {}).length ? JSON.stringify(item.evidence) : null, text: true }]} />
    </li>)}</ul>}
    {cursor && <div><Button size="compact" variant="ghost" onClick={() => void readMore()}>读取更多关注项</Button></div>}
    {more?.error && <Notice tone="error">{more.error}</Notice>}
    {value && <div className="flex flex-col gap-2">
      <h4 className="text-label font-semibold text-foreground">跟进安排</h4>
      {staleFollowUp && <Fine>已有的跟进属于任务的旧修订；核对当前任务后，按已有跟进的第 {value.followUp!.version} 版保存新的安排。</Fine>}
      {followUp ? <p className="text-label text-text-secondary [overflow-wrap:anywhere]">{decisionLabel[followUp.decision]} · {followUp.actionTaken}</p> : !staleFollowUp && <p className="text-label text-text-secondary">还没有跟进安排。</p>}
      <Fine>等待 {followUp?.waitingOn ? waitingParty(followUp.waitingOn) : "责任未知"} · 下一检查点 {followUp?.nextCheckAt ? date(followUp.nextCheckAt) : "未定"}</Fine>
      {followUp?.releaseHandoff && <Fine>具备发布条件，等待维护者 · {date(followUp.releaseHandoff.readyForPublicationAt)} · {actorText(followUp.releaseHandoff.recipient)}</Fine>}
      {followUp?.releaseHandoff && <ActorIdentifiers actors={[["发布维护者", followUp.releaseHandoff.recipient]]} />}
      <Fine>{publicationCurrent ? `已发布且有固定证据 · ${date(followUp!.publication!.publishedAt)}`
        : followUp?.publication ? "有发布记录；当前修订的发布来源还要核对" : "当前修订的发布证据未知"}</Fine>
      {canWrite && <ActionRow title="填写跟进安排" description="跟进判断、已做的事、等待谁和下一检查时间。">
        <FollowUpForm context={context} detail={detail} value={value} followUp={followUp} onReread={() => read.refetch()} /></ActionRow>}
      {canWrite && followUp?.releaseHandoff && !followUp.publication && <ActionRow title="登记实际发布" description="只在维护者已发布、且有可以核对的固定证据时登记。">
        <CommandForm context={context} submitLabel="记录已发布" baseline={{ taskVersion: detail.task.version, revisionId, followUpVersion: followUp.version }} fields={[
          { name: "publishedAt", label: "实际发布时间", kind: "datetime" }, { name: "publicationRef", label: "发布证据引用", maxLength: 500 }, reasonField("记录理由")]}
          build={(values, seen) => publicationCommand(detail.task.id, seen, { publishedAt: values.publishedAt ?? "", publicationRef: values.publicationRef ?? "", reason: values.reason ?? "" })} /></ActionRow>}
      {!canWrite && <Fine>{read.error ? "关注项没有重新读回，暂不能按旧内容写入；先重新读取。" : "当前身份没有审阅与写入权限，或工作安排不是当前修订；可以阅读关注依据。"}</Fine>}
      {value.followUpHistory.length > 0 && <details><summary className="w-fit cursor-pointer text-caption text-primary hover:underline">跟进历史（{value.followUpHistory.length}）</summary>
        <ol className="mt-1 flex flex-col gap-0.5">{value.followUpHistory.map(item => <li key={item.version} className="text-caption text-text-secondary">第 {item.version} 版 · {date(item.updatedAt)} · {item.reason}</li>)}</ol></details>}
      <FullIdentifiers rows={[{ label: "等待对象", value: followUp?.waitingOn?.id }, { label: "依据引用", value: followUp?.evidenceRef },
        { label: "待发布产物", value: followUp?.releaseHandoff?.artifactRef }, { label: "发布证据", value: followUp?.publication?.publicationRef }]} />
    </div>}
  </section>;
}

const followUpValues = (followUp: TaskAttentionFollowUp | null, published: boolean) => ({
  decision: followUp?.decision ?? "waiting", actionTaken: followUp?.actionTaken ?? "", evidenceRef: followUp?.evidenceRef ?? "",
  waitingKind: followUp?.waitingOn?.kind ?? "unknown", waitingId: followUp?.waitingOn?.id ?? "", nextCheck: localInput(followUp?.nextCheckAt), reason: "",
  handoff: followUp?.releaseHandoff || published ? "1" : "", recipient: followUp?.releaseHandoff?.recipient ?? "",
  artifact: followUp?.releaseHandoff?.artifactRef ?? "", note: followUp?.releaseHandoff?.note ?? "", readyAt: localInput(followUp?.releaseHandoff?.readyForPublicationAt),
});

const followUpLabels: Record<string, string> = {
  decision: "跟进判断", actionTaken: "已做什么", evidenceRef: "依据引用", waitingKind: "等待谁", waitingId: "具体对象", nextCheck: "下一检查时间",
  reason: "跟进理由", handoff: "登记具备发布条件", recipient: "维护者或接收方", artifact: "待发布的固定产物引用", note: "交接说明", readyAt: "具备发布条件的时间",
};

/** 填写跟进安排. Untouched fields follow a newer follow-up (someone else's hand-off is never sent back as cleared). */
function FollowUpForm({ context, detail, value, followUp, onReread }: {
  context: MutationContext; detail: TaskDetail; value: AttentionRead; followUp: TaskAttentionFollowUp | null; onReread(): Promise<{ data?: AttentionRead | undefined }>;
}) {
  const revisionId = detail.task.currentRevisionId;
  const reread = () => { void onReread(); };
  // Applied, now or when an unknown result is read back: the fields go back to untouched (so the same follow-up is not
  // written twice) and only a reread that shows the newer follow-up on this revision proves the write.
  const command = useCommand(context, { taskVersion: detail.task.version, revisionId, followUpVersion: value.followUp?.version ?? 0 }, {
    onStale: reread,
    onApplied: () => {
      setForm({ base: latest, values: latest }); setTried(false);
      const before = value.followUp?.version ?? 0;
      void onReread().then(({ data }) => {
        if (!data?.followUp || data.followUp.version <= before || data.followUp.taskRevisionId !== revisionId)
          setVerify("写入已应用，但当前跟进版本还没有读回；请重新读取。");
      });
    },
  });
  const latest = followUpValues(followUp, !!value.followUp?.publication);
  const latestKey = JSON.stringify(latest);
  const [form, setForm] = React.useState<FormState>({ base: latest, values: latest });
  const [verify, setVerify] = React.useState("");
  const v = form.values;
  const dirty = formDirty(form);
  React.useEffect(() => {
    const next = followLatest(form, latest, command.baselineChanged, command.awaitingReread);
    if (!next) return;
    if (next.rebase) command.rebase();
    setForm(next.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestKey, command.baselineChanged, command.awaitingReread, dirty]);
  const set = (name: string) => (next: string) => setForm(current => ({ ...current, values: { ...current.values, [name]: next } }));
  const handoff = !!v.handoff;
  // The contract's limits (task-attention: 500 for a label, 4000 for a text), said under the field; the text is never cut.
  const limits: Record<string, number> = { actionTaken: 4000, reason: 4000, note: 4000, evidenceRef: 500, waitingId: 500, recipient: 500, artifact: 500 };
  const tooLong = (name: string) => overLimitText(v[name] ?? "", limits[name]) ?? undefined;
  const incomplete = !v.reason?.trim() || !v.actionTaken?.trim() || handoff && (!v.recipient?.trim() || !v.artifact?.trim() || !v.note?.trim() || !v.readyAt)
    || Object.keys(limits).some(name => tooLong(name));
  const [tried, setTried] = React.useState(false);
  const missing = (name: string, label: string) => tried && !v[name]?.trim() ? `请填写${label}。` : tooLong(name);
  async function submit() {
    setTried(true);
    if (incomplete) return;
    setVerify("");
    await command.submit(seen => followUpCommand(detail.task.id, seen, { waitingKind: v.waitingKind as FollowUpKind, waitingId: v.waitingId ?? "",
      decision: v.decision as TaskAttentionFollowUp["decision"], actionTaken: v.actionTaken ?? "", evidenceRef: v.evidenceRef ?? "", nextCheck: v.nextCheck ?? "", reason: v.reason ?? "",
      handoff: handoff ? { recipient: v.recipient ?? "", artifactRef: v.artifact ?? "", note: v.note ?? "", readyAt: v.readyAt ?? "" } : null }));
  }
  const conflicts = conflictingFields(form, latest).map(name => ({ name, label: followUpLabels[name] ?? name }));
  const input = (label: string, name: string, options: { required?: boolean; type?: string; hint?: string } = {}) =>
    <Field label={options.required ? label : `${label}（可选）`} hint={options.hint} error={options.required ? missing(name, label) : tooLong(name)}>{control => <Input {...control} type={options.type ?? "text"} value={v[name] ?? ""} required={options.required}
      onChange={event => set(name)(event.target.value)} autoComplete="off" />}</Field>;
  return <CommandFrame context={context} command={command} label="保存跟进安排" submitLabel="保存跟进安排" dirty={dirty} onSubmit={() => void submit()} onReread={reread}
    conflicts={conflicts} onResolve={choices => { command.rebase(); setForm(keepEdits(form, latest, choices)); }}
    onKeep={() => { command.rebase(); setForm(keepEdits(form, latest)); }} onRefill={() => { command.rebase(); setForm({ base: latest, values: latest }); }}>
    <Field label="跟进判断">{control => <Select {...control} value={v.decision} onChange={event => set("decision")(event.target.value)} className="w-full">
      {Object.entries(decisionLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>}</Field>
    <Field label="已做什么" error={missing("actionTaken", "已做什么")}>{control => <Textarea {...control} required value={v.actionTaken} onChange={event => set("actionTaken")(event.target.value)} rows={3} />}</Field>
    {input("依据引用", "evidenceRef")}
    <Field label="等待谁">{control => <Select {...control} value={v.waitingKind} onChange={event => set("waitingKind")(event.target.value)} className="w-full">
      {followUpKinds.map(kind => <option key={kind} value={kind}>{waitingKindLabel[kind]}</option>)}</Select>}</Field>
    {input("具体对象", "waitingId", { hint: "智能体、身份或任务的标识。" })}
    {input("下一检查时间", "nextCheck", { type: "datetime-local" })}
    <Field label="跟进理由" error={missing("reason", "跟进理由")}>{control => <Textarea {...control} required value={v.reason} onChange={event => set("reason")(event.target.value)} rows={3} />}</Field>
    <label className="flex items-center gap-2 text-label text-foreground">
      <Checkbox checked={handoff} disabled={!!followUp?.publication} onCheckedChange={checked => set("handoff")(checked === true ? "1" : "")} />
      登记具备发布条件，交给维护者</label>
    {handoff && <div className="flex flex-col gap-3 pl-6">
      {input("维护者或接收方", "recipient", { required: true })}
      {input("待发布的固定产物引用", "artifact", { required: true })}
      <Field label="交接说明" error={missing("note", "交接说明")}>{control => <Textarea {...control} required value={v.note} onChange={event => set("note")(event.target.value)} rows={3} />}</Field>
      {input("具备发布条件的时间", "readyAt", { required: true, type: "datetime-local" })}
    </div>}
    {verify && <Notice tone="waiting">{verify}</Notice>}
  </CommandFrame>;
}

/** 阶段区间、计划与来源: the facts of the current work behind the task's next step. */
export function TaskArrangementFacts({ projectId, detail, leader, responsibleName, actorId }: {
  projectId: string; detail: TaskDetail; leader: LeaderWorkTask; responsibleName?: string | null; actorId?: string;
}) {
  const notices = useProjectPages(projectId, ["task", detail.task.id, "leader-notices", detail.task.version], async cursor => {
    const page = await api().leaderNotices(projectId, detail.task.id, cursor);
    if (!Array.isArray(page?.items)) throw new Error("通知记录响应格式不符");
    return page;
  });
  const noticeItems = (notices.data?.pages ?? []).flatMap(page => page.items);
  const plan = leader.plan;
  const timing = leader.timing;
  const consumer = detail.proposal?.consumer ?? leader.delivery?.consumer ?? null;
  const responsibility = leader.responsible.kind === "role" && leader.responsible.id === detail.task.owner && responsibleName?.trim()
    ? responsibleText(leader.responsible, leader.assignment, { state: "named", name: responsibleName.trim() })
    : <ResponsibleName projectId={projectId} item={leader} />;
  return <div className="flex flex-col gap-4" data-task-arrangement="">
    <p data-task-next="" className="rounded-lg bg-accent px-4 py-2.5 text-label text-foreground"><strong>下一步：</strong>{workItemNextStep(leader)}</p>
    {timing ? <div className="flex flex-col gap-1">
      <p className="text-label text-foreground">{timingStageLabel[timing.current.stage] ?? "阶段未知"} · 本阶段 {date(timing.current.startedAt ?? undefined)} 起 · 已历时 {timingDuration(timing.current.elapsedMs)} · {waitingText(timing.current.waitingFor, leader.assignment)}</p>
      <Fine>任务创建 {timing.createdAt ? date(timing.createdAt) : "未知"} · 发布证据 {timing.publication.source === "explicit" && timing.publication.at ? `已发布 ${date(timing.publication.at)}` : "未知；具备发布条件不代表已发布"} ·
        最近有效进展 {timing.latestEffectiveProgress ? date(timing.latestEffectiveProgress.at) : "未知"} · 执行活动 {timing.executionActivity
          ? `${date(timing.executionActivity.at)} · ${timing.executionActivity.freshness === "live" ? "新近观察" : timing.executionActivity.freshness === "stale" ? "观察已过期" : "新鲜度未知"}` : "未知"}</Fine>
      {timing.rounds.length > 0 && <details><summary className="w-fit cursor-pointer text-caption text-primary hover:underline">查看 {timing.rounds.length} 轮阶段区间</summary>
        <ol className="mt-1 flex flex-col gap-1">{timing.rounds.map(round => <li key={round.number} className="text-caption text-text-secondary">
          第 {round.number} 轮 · {date(round.startedAt ?? undefined)} 至 {round.endedAt ? date(round.endedAt) : "进行中"} · {timingDuration(round.elapsedMs)}
          <ul className="pl-4">{round.intervals.map((interval, index) => <li key={index}>{timingStageLabel[interval.stage] ?? "阶段未知"} · {date(interval.startedAt ?? undefined)} 至 {interval.endedAt ? date(interval.endedAt) : "进行中"}</li>)}</ul>
        </li>)}</ol></details>}
      <Fine>阶段来源{timing.current.source ? "见完整标识" : "未知"} · 观察于 {date(timing.observedAt)}；未知的时间不计为零。</Fine>
    </div> : <Fine>阶段时间还没有读回。</Fine>}
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 max-compact:grid-cols-1">
      <Fact label="责任">{responsibility}{leader.assignment && <span className="block text-caption text-muted-foreground">
        {leader.assignment.state === "accepted" ? "已接手" : leader.assignment.state === "assigned" ? "待接手" : "已释放"}{leader.assignment.targetKind === "owned" ? " · 项目内智能体" : " · 外部接入的智能体"}</span>}</Fact>
      <Fact label="计划">{plan && (plan.priority || plan.plannedStartAt || plan.dueAt)
        ? `${plan.priority ? `P${plan.priority}` : "优先级未设"} · 计划开始 ${plan.plannedStartAt ? date(plan.plannedStartAt) : "未设"} · 截止 ${plan.dueAt ? date(plan.dueAt) : "未设"}`
        : "还没有设置计划时间、截止或优先级。"}</Fact>
      <Fact label="时间">创建 {date(leader.dates.createdAt)} · 业务变化 {date(leader.dates.businessChangedAt)}<span className="block text-caption text-muted-foreground">
        实际开始 {leader.dates.startedAt ? date(leader.dates.startedAt) : "未发生"} · 完成 {leader.dates.completedAt ? date(leader.dates.completedAt) : "未关闭"}</span></Fact>
      <Fact label="来源">{leader.goal ? `目标：${leader.goal.outcome}` : "没有关联目标"}{leader.stage && <span className="block">阶段：{leader.stage.deliverable}</span>}
        <span className="block text-caption text-muted-foreground">{detail.proposal?.evidence?.trim() || (detail.proposal ? "这项任务没有另写创建依据。" : "历史任务没有新的验收约定。")}</span></Fact>
      <Fact label="当前验收与使用者">{detail.proposal?.acceptanceMode === "independent_agent" ? "独立的智能体使用当前交付" : detail.proposal?.acceptanceMode === "human_required" ? "指定的人本人使用当前交付" : "历史约定"}
        {consumer ? ` · ${actorText(consumer)}` : " · 验收身份待签收"}<span className="block text-caption text-muted-foreground">{detail.proposal?.useRequired ? "关闭前要有当前交付的实际使用证据。" : "按既有约定核对使用证据。"}
          {detail.proposal?.stopCondition ? ` 停止条件：${detail.proposal.stopCondition}` : ""}</span></Fact>
      <Fact label="当前执行">{leader.latestRun ? `最近一次运行：${runStateName[leader.latestRun.state] ?? "状态未识别"}` : "当前修订没有可见的运行"}
        <span className="block text-caption text-muted-foreground">队列：{leader.queueHold ? "暂不派发" : "没有登记暂停"}{leader.pendingImpactCount > 0 ? ` · ${leader.pendingImpactCount} 项依据待复核` : ""}</span></Fact>
      <Fact label="当前交付">{leader.delivery ? `技术检查${leader.delivery.technicalResult === "passed" ? "通过" : "未通过"}` : "当前修订还没有交付。"}
        {leader.delivery && <span className="block text-caption text-muted-foreground">{leader.delivery.observationResult
          ? `使用：${leader.delivery.observationKind === "human" ? "本人" : "智能体"} ${actorText(leader.delivery.observationActorId)} · ${leader.delivery.observationResult === "used" ? "已使用" : leader.delivery.observationResult === "failed" ? "使用失败" : "未使用"}`
          : "还没有这次交付的使用观察"}</span>}</Fact>
      <Fact label="统筹决定">{leader.review ? `${leader.review.decision === "acknowledged" ? "已核对" : "暂缓"} · ${leader.review.reason}` : "当前工作位置还没有统筹决定。"}
        {leader.review && <span className="block text-caption text-muted-foreground">{actorText(leader.review.actorId)} · {date(leader.review.at)}</span>}</Fact>
    </div>
    <div className="flex flex-col gap-2" aria-label="结果回程">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-label font-semibold text-foreground">结果回程</h4>
        <Button size="compact" variant="ghost" className="ml-auto" disabled={notices.isFetching} onClick={() => void notices.refetch()}>重新读取通知</Button>
      </div>
      <ReadNote read={notices} what="通知记录" />
      {notices.data && (noticeItems.length ? <ul className="flex flex-col gap-1.5">{noticeItems.map(item => <li key={item.id} className="flex flex-col gap-0.5">
        <p className="text-label text-foreground">{noticeLabel[item.kind] ?? "通知"} · {date(item.occurredAt)}</p>
        <Fine>{noticeState(item)}{item.stale ? " · 来源属于历史修订" : ""}{item.linkedSessionId ? <> · <a className="text-primary hover:underline"
          href={withReturn(`/p/${encodeURIComponent(projectId)}/sessions?session=${encodeURIComponent(`owned:${item.linkedSessionId}`)}`,
            actorId ? taskOrigin(projectId, detail.task, actorId) : null)}>查看收到通知的智能体</a></> : null}</Fine>
        <FullIdentifiers rows={[{ label: "来源", value: item.sourceRef }, { label: "任务修订", value: item.taskRevisionId }, { label: "来源智能体", value: item.sourceSessionId },
          { label: "来源身份", value: item.sourceActorId }, { label: "受阻原因", value: item.blockedReason ?? item.messageBlockedReason, text: true },
          { label: "消息", value: item.messageId }, { label: "操作", value: item.operationId }, { label: "替代通知", value: item.recovery?.replacementNoticeId },
          { label: "继承的原通知", value: item.recovery?.parentNoticeId }]} />
      </li>)}</ul> : <p className="text-label text-text-secondary">还没有结果通知记录。</p>)}
      {notices.hasNextPage && <div><Button size="compact" variant="ghost" disabled={notices.isFetchingNextPage} onClick={() => void notices.fetchNextPage()}>读取较早的通知</Button></div>}
    </div>
    <div className="flex flex-col gap-2" aria-label="前置依赖">
      <h4 className="text-label font-semibold text-foreground">前置任务</h4>
      {leader.dependencies.length ? <ul className="flex flex-col gap-1">{leader.dependencies.map(item => <li key={item.taskId} className="flex flex-col">
        <a className="text-label text-primary hover:underline" href={href(projectId, "task", item.taskId)}>{item.title || "任务（名称待读取）"}</a>
        <Fine>{item.acceptanceSatisfied ? "当前修订已验收或已放行" : "仍在等待真实验收"}{item.reason ? ` · ${item.reason}` : ""}</Fine>
      </li>)}</ul> : <p className="text-label text-text-secondary">没有前置任务。</p>}
    </div>
    <FullIdentifiers rows={[{ label: "阶段来源", value: timing?.current.source ? `${timing.current.source.kind} · ${timing.current.source.id}` : null },
      { label: "最近有效进展来源", value: timing?.latestEffectiveProgress ? `${timing.latestEffectiveProgress.kind} · ${timing.latestEffectiveProgress.sourceId}` : null },
      { label: "最近一次运行", value: leader.latestRun?.runId }, { label: "当前交付", value: leader.delivery?.deliveryId },
      { label: "承接对象", value: leader.assignment?.targetId }, { label: "队列暂停代码", value: leader.queueHold },
      { label: "工作变化序号", value: String(leader.workChangeSequence) }, actorRow("指定使用者", consumer),
      actorRow("使用记录者", leader.delivery?.observationActorId), actorRow("统筹决定者", leader.review?.actorId)]} />
  </div>;
}

/** A notice that travels in a packet: where its own item is, not the (unused) one-notice message. */
function packetNoticeState(item: LeaderNotice): string {
  const packet = item.packet;
  if (!packet) return item.stale ? "来源属于历史修订，要核对当前任务" : "等待并入通知包（最早一项等满约 60 秒后合并送达）";
  const before = packet.readBefore ? "（上一轮可能已读到过）" : "";
  switch (packet.itemState) {
    case "withdrawn": return `已撤回，没有送达：${packet.withdrawnReason === "HUMAN_MESSAGE_FIRST" ? "有人的消息先送" : "来源已过时或不再需要"}${packet.withdrawnReason ? ` · ${packet.withdrawnReason}` : ""}`;
    case "pending": return packet.packetState === "building" ? "正在并入通知包，消息还没有发出" : `已并入通知包，等 Leader 开始这一轮${before}`;
    case "delivered": return `Leader 这一轮已开始读这包，尚未结束${before}`;
    case "seen": return "这一轮已正常结束（已看到）；还没有处置";
    case "handled": return packet.disposition === "deferred" ? `Leader 已延后${packet.deferUntil ? `到 ${date(packet.deferUntil)}` : ""}，到点再次送达` : "Leader 已处理";
    case "unknown": return packet.packetState === "blocked" ? `这包受阻（恢复门关闭），等 Leader 恢复这一包${before}`
      : packet.packetState === "unknown" ? "这一轮结果未知，只读核对，不会重发" : `这一轮没有读完，进入下一包重送${before}`;
    default: return "状态待核对";
  }
}

export function noticeState(item: LeaderNotice): string {
  if (item.viaPacket) return packetNoticeState(item);
  if (item.messageState === "failed" || item.messageState === "cancelled") return `原通知${item.messageState === "failed" ? "失败" : "已取消"}；要核对原消息和任务，再作新的安排`;
  if (item.blockedReason?.startsWith("MESSAGE_POST_REJECTED") || item.blockedReason === "PINNED_RECIPIENT_CHANGED") return "原消息被拒绝或接收者已变；核对原操作后另作安排";
  if (item.state === "linked") return item.readAt ? `统筹已记录收阅 · ${date(item.readAt)}；下一步另行核对` : item.messageBlockedReason ? "消息待恢复" : item.nativeTurnId ? "这一轮已关联；收阅与下一步另行核对" : "已保存给统筹的消息，还没有核到接收";
  if (item.blockedReason) return "待恢复";
  return item.stale ? "来源属于历史修订，要核对当前任务" : "待通知统筹";
}
