// The selected Role in the center: what it is for, the evidence it was proposed on, who carries it, the next steps
// its state allows, its history and the allocation discussions that point at it. Runtime, skills and trial facts are
// in the right column (RoleSide).
import { useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import type { RoleHandoff, RoleRecord, RoleRevision, RoleSessionBinding, RoleTrialReview } from "@evoloop/contracts/roles";
import { Badge, Button, Notice, StatusTag } from "@evoloop/ui";
import { ActionForm, type MutationContext } from "../../shared/ActionForm";
import { roleClient } from "../../shared/roleClient";
import { href } from "../../shared/ui/shared";
import { FactList, PageSection, mutedText } from "../../shared/ui/PageParts";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { actorRow, actorText } from "../../shared/actorPresentation";
import { SessionName, useRoleName } from "../../shared/ui/RecordName";
import { nameOnly, nameText } from "../../shared/workPresentation";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { AllocationBacklinks } from "../discussions";
import { RolePresence } from "./RolePresence";
import { SourceRef, SourceRefs, TaskLink } from "./SourceRef";
import { ackHandoffForm, bindForm, decideForm, handoffForm, retireForm, reviewForm, type RoleForm } from "./roleForms";
import {
  alternativeKindText, evidenceKindText, handoffText, reviewDecisionText, revisionReasonText, roleActions, roleClassText, roleIdPattern,
  roleStateText, roleStateTone,
} from "./rolePresentation";
import { failureOf, type Failure } from "../../shared/errorPresentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

export const stamp = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

export function RoleDetail({ context, role, refresh, checking, roleTitle }: {
  context: MutationContext; role: RoleRecord; refresh: number; checking: boolean; roleTitle(id: string): string | undefined;
}) {
  const p = role.proposal;
  const actions = roleActions(role.state);
  const forms: Array<{ form: RoleForm; note?: string }> = [
    ...actions.decide ? [{ form: decideForm(role) }] : [],
    ...actions.review ? [{ form: reviewForm(role), note: "到期不会自动确认职责；回看需写明实际效果、成本与基线对比。" }] : [],
    ...actions.handoff ? [{ form: handoffForm(role), note: "任务接收需先走普通任务修订，以新版本明确改变责任者；登记交接不会直接转移任务。" }] : [],
    ...actions.bind ? [{ form: bindForm(role), note: "只能绑定本项目已预留且就绪的受管智能体。" }] : [],
    ...actions.retire ? [{ form: retireForm(role), note: "撤回前核对未完任务、知识与在途智能体。" }] : [],
  ];
  const roleContext = { ...context, draftScope: `role:${role.id}`, draftBaseline: String(role.version) };
  return <article id={`role-${role.id}`} tabIndex={-1} aria-label={`职责 ${p.title}`} className="flex min-w-0 scroll-mt-20 flex-col gap-6 outline-none">
    <header className="flex flex-col gap-2">
      <a href={href(context.projectId, "roles")} className="flex w-fit items-center gap-1 text-small text-text-secondary hover:text-foreground">
        <ChevronLeft size={14} aria-hidden="true" />全部职责</a>
      <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>{p.title}</h1>
      <div className="flex flex-wrap items-center gap-2" data-role-facts="">
        <StatusTag tone={roleStateTone(role.state)} label={roleStateText[role.state]} />
        <Badge>{roleClassText(p)}</Badge>
        <span className={mutedText}>第 {role.version} 版{checking ? " · 正在核对" : ""}</span>
      </div>
    </header>
    <PageSection title="目标与范围">
      <FactList columns rows={[
        ["目标", p.goal], ["为什么需要独立判断", p.independentResponsibility], ["责任与授权范围", p.ownerScope],
        ["主要输入", p.inputs.join("；")], ["可写资产", p.writableAssets.join("；") || "未列出"], ["交付", p.deliverables.join("；")],
        ["触发条件", p.triggers.join("；")], ["交接边界", p.handoffBoundary],
      ]} />
      <FactList rows={[["检查、判断与交付流程", p.workflow], ["首项试行任务", <a key="task" href={href(context.projectId, "task", p.firstTaskId)} className="text-primary hover:underline">打开首项任务</a>]]} />
    </PageSection>
    <PageSection title="提出依据与比较" description={`试行前基线：${p.baseline}。期望效果：${p.expectedEffect}。成本上限：${p.costLimit}。`}>
      {p.evidence.length === 0 && <p className="text-small text-text-secondary">提案没有附观察记录。</p>}
      {p.evidence.length > 0 && <ul aria-label="提出依据" className="flex flex-col gap-3">{p.evidence.map((item, index) => <li key={index} className="flex min-w-0 flex-col gap-0.5">
        <span className="text-small font-medium text-foreground">{evidenceKindText(item.kind)}</span>
        <span className="whitespace-pre-wrap break-words text-small text-text-secondary">{item.observation}</span>
        <span className={mutedText}>来源 <SourceRef projectId={context.projectId} sourceRef={item.sourceRef} /> · 观察于 {stamp(item.observedAtUtc)}</span>
      </li>)}</ul>}
      {p.alternatives.length > 0 && <FactList columns rows={p.alternatives.map(item => [`备选：${alternativeKindText(item.kind)}`, `${item.assessment}；估计成本 ${item.estimatedCost}`])} />}
    </PageSection>
    <SectionBoundary label="承载与业务领域"><RolePresence context={context} role={role} /></SectionBoundary>
    <PageSection title="下一步" description={forms.length ? "只列出当前状态允许的操作；提交时服务端会按版本再次核对。" : "这项职责已结束，只保留历史。"}>
      {forms.map(({ form, note }) => <details key={form.title} className="min-w-0 rounded-xl bg-raised px-4 py-3 shadow-sm">
        <summary className="cursor-pointer text-small font-medium text-foreground">{form.title}</summary>
        {note && <p className={`${mutedText} mt-2`}>{note}</p>}
        <ActionForm context={roleContext} review embedded title={form.title} fields={form.fields} build={form.build} />
      </details>)}
    </PageSection>
    <RoleHistory context={roleContext} role={role} roleTitle={roleTitle} />
    <PageSection title="相关讨论与决定" description="指向这项职责的分工讨论；接手只认同一任务修订的接受记录，同职责不等于已接手。">
      <SectionBoundary label="相关讨论"><AllocationBacklinks context={context} filter={{ roleId: role.id }} refresh={refresh} /></SectionBoundary>
    </PageSection>
  </article>;
}

type History = { revisions: RoleRevision[]; reviews: RoleTrialReview[]; handoffs: RoleHandoff[]; bindings: RoleSessionBinding[]; version: number };

/** Revisions, trial reviews, handoffs and bindings are read on request: four reads per Role are not needed to decide. */
function RoleHistory({ context, role, roleTitle }: { context: MutationContext; role: RoleRecord; roleTitle(id: string): string | undefined }) {
  const who = (actorId: string) => actorText(actorId, context.principal.actorId);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const current = history?.version === role.version ? history : null;
  async function read() {
    setBusy(true); setError(null);
    try {
      const client = roleClient("", context.projectId);
      const [revisions, reviews, handoffs, bindings] = await Promise.all([client.revisions(role.id), client.reviews(role.id), client.handoffs(role.id), client.bindings(role.id)]);
      if (![revisions, reviews, handoffs, bindings].every(Array.isArray)) throw new Error("历史响应不完整");
      setHistory({ revisions, reviews, handoffs, bindings, version: role.version });
    } catch (cause) { setError(failureOf(cause)); } finally { setBusy(false); }
  }
  const block = (title: string, empty: string, items: ReactNode[]) => <div className="flex flex-col gap-2">
    <h3 className="text-small font-semibold text-foreground">{title}</h3>
    {items.length ? <ul className="flex flex-col gap-2">{items}</ul> : <p className="text-small text-text-secondary">{empty}</p>}
  </div>;
  // `actorId`: who recorded it; an opaque identifier is said in words and kept under 完整标识.
  const row = (key: string, title: ReactNode, body: ReactNode, meta: string, actorId?: string) => <li key={key} className="flex min-w-0 flex-col gap-0.5">
    <span className="text-small font-medium text-foreground">{title}</span>{body}<span className={mutedText}>{meta}</span>
    {actorId && <FullIdentifiers summary="记录者的完整标识" rows={[actorRow("记录者", actorId, context.principal.actorId)]} />}</li>;
  return <PageSection title="修订与交接历史" action={<Button size="compact" variant="ghost" disabled={busy} onClick={() => void read()}>
    {busy ? "读取中…" : current ? "重新读取历史" : "阅读修订与交接历史"}</Button>}>
    {error && <Notice tone="error" title="历史未读回">{error.text}<ErrorDetails failure={error} /></Notice>}
    {!current && !error && <p className="text-small text-text-secondary">{history ? "职责已有新版本，历史需要重新读取。" : "修订、试行回看、交接与绑定按需读取。"}</p>}
    {current && <div className="flex flex-col gap-5">
      {block("修订", "没有修订记录。", current.revisions.map(item => row(item.id, `第 ${item.version} 版 · ${roleStateText[item.state]}`,
        <RevisionReason reason={item.reason} />, `${who(item.actorId)} · ${stamp(item.createdAtUtc)}`, item.actorId)))}
      {block("试行回看", "尚无回看；到期不会自动确认职责。", current.reviews.map(item => row(item.id, reviewDecisionText(item.decision), <>
        <span className="whitespace-pre-wrap break-words text-small text-text-secondary">效果：{item.effectEvidence}</span>
        <span className="text-caption text-text-secondary">效果来源：<SourceRefs projectId={context.projectId} refs={item.effectEvidenceRefs} /></span>
        <span className="whitespace-pre-wrap break-words text-small text-text-secondary">成本：{item.costEvidence}</span>
        <span className="text-caption text-text-secondary">成本来源：<SourceRefs projectId={context.projectId} refs={item.costEvidenceRefs} /></span>
        <span className="whitespace-pre-wrap break-words text-small text-text-secondary">基线对比：{item.baselineComparison}</span>
      </>, `${who(item.actorId)} · ${stamp(item.createdAtUtc)}`, item.actorId)))}
      {block("交接", "尚无已登记交接事项。关闭前仍需核对未完任务、知识和在途智能体。", current.handoffs.map(item => row(item.id, handoffText(item), <>
        <span className="break-all text-small text-text-secondary">{item.kind === "task" && roleIdPattern.test(item.sourceRef)
          ? <TaskLink projectId={context.projectId} taskId={item.sourceRef} /> : <SourceRef projectId={context.projectId} sourceRef={item.sourceRef} />}
          {" → "}<a href={`${href(context.projectId, "roles")}?role=${encodeURIComponent(item.targetRoleId)}`} className="text-primary hover:underline">
            <RoleLabel projectId={context.projectId} roleId={item.targetRoleId} kind="接收职责" known={roleTitle(item.targetRoleId)} /></a></span>
        <FullIdentifiers rows={[{ label: "交接事项", value: item.id }, { label: "接收职责", value: item.targetRoleId }]} />
        {item.state === "prepared" && <ActionForm context={{ ...context, draftScope: `role:${role.id}:handoff:${item.id}` }} review {...ackHandoffForm(role, item)} />}
      </>, `登记于 ${stamp(item.preparedAtUtc)}${item.acknowledgedAtUtc ? ` · 确认于 ${stamp(item.acknowledgedAtUtc)}` : ""}`)))}
      {block("承载绑定", "尚无已确认绑定的受管智能体。", current.bindings.map(item => row(item.id,
        <a href={`${href(context.projectId, "runtime")}?session=${encodeURIComponent(item.sessionId)}`} className="text-primary hover:underline">
          <SessionName projectId={context.projectId} sessionKey={`owned:${item.sessionId}`} kind="受管智能体" /></a>,
        <>{item.note ? <span className="text-small text-text-secondary">{item.note}</span> : null}
          <FullIdentifiers rows={[{ label: "受管智能体", value: item.sessionId }, { label: "绑定", value: item.id }]} /></>,
        `${who(item.actorId)} · ${stamp(item.createdAtUtc)}`, item.actorId)))}
    </div>}
  </PageSection>;
}

/** Right column for the selected Role: trial facts and review time. */
export function RoleTrialFacts({ projectId, role, roleTitle }: { projectId: string; role: RoleRecord; roleTitle(id: string): string | undefined }) {
  const p = role.proposal;
  const due = Date.parse(role.reviewAtUtc);
  const live = role.state === "trial" || role.state === "active";
  return <FactList rows={[
    ["状态", `${roleStateText[role.state]} · 第 ${role.version} 版`],
    ["试行开始", role.trialStartedAtUtc ? stamp(role.trialStartedAtUtc) : "尚未开始试行"],
    ["最长试行", `${p.trialDays} 天`],
    ["回看时间", `${stamp(role.reviewAtUtc)}${live && Number.isFinite(due) && due < Date.now() ? "（已到期，等待回看记录）" : ""}`],
    ["试行前基线", p.baseline], ["期望效果", p.expectedEffect], ["成本上限", p.costLimit], ["停止或撤回判据", p.exitCriteria],
    ...role.mergeTargetRoleId ? [["并入的职责", <RoleLabel key="merge" projectId={projectId} roleId={role.mergeTargetRoleId} known={roleTitle(role.mergeTargetRoleId)} />] as [string, ReactNode]] : [],
  ]} />;
}

/**
 * A role by its title: the one already listed (`known`), else read by its identifier; until then the shared wording
 * (职责（名称待读取）, 未找到, 名称暂不可读). With `kind` the title follows it (“接收职责 · 开发职责”).
 */
function RoleLabel({ projectId, roleId, known, kind }: { projectId: string; roleId: string; known?: string | undefined; kind?: string }) {
  const read = useRoleName(projectId, known ? null : roleId);
  const name = known ? { state: "named" as const, name: known } : read;
  return <>{kind ? nameText(kind, name) : nameOnly("职责", name)}</>;
}

/** A revision's reason: service sentences in words, a person's text as written, anything unrecognised under 完整标识. */
function RevisionReason({ reason }: { reason: string }) {
  const shown = revisionReasonText(reason);
  return <>
    <span className="whitespace-pre-wrap break-words text-small text-text-secondary">{shown.text}</span>
    {shown.raw && <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">完整标识</summary><code className="break-all font-mono">{shown.raw}</code></details>}
  </>;
}
