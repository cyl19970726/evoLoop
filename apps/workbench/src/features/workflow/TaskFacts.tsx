// The task's right column (docs/frontend/layout.md 右栏, 任务): state and reconciliation phase → the agent that took
// it → related documents → delivery and use → version. The same blocks serve the task page and the table view's
// selected row. Documents open as tabs beside the center (useContextPanel().openInPanel), never replacing it.
import React from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask, LeaderWorkTaskTiming } from "@evoloop/contracts/work-index";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight, FileText } from "lucide-react";
import { Button, ErrorState, ListRow, LoadingState, Notice, StatusTag, cn } from "@evoloop/ui";
import { ApiError, api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { deliveryTarget } from "../../shared/deliveryPresentation";
import { isRoleOwnerId, readOwnerRole } from "../../shared/ownerRole";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { timingDuration, timingStageLabel } from "../../shared/taskTiming";
import type { TaskSection } from "../../shared/taskNavigation";
import { phaseStatus, taskStateStatus } from "../../shared/taskStatus";
import { useContextPanel } from "../../shared/ui/ContextPanel";
import { date, href } from "../../shared/ui/shared";
import { readAgent } from "./agentRead";
import { TaskAgentBlock } from "./TaskAgentBlock";
import { TaskDocumentPeek } from "./TaskDocumentPeek";
import { observationResultLabel, observationsForDelivery } from "./observationPresentation";
import { assignmentSessionKey, currentDelivery, matchingProjection, matchingTaskDetail } from "./taskExperience";
import { taskPreviewResponsibility } from "./taskPreviewResponsibility";
import { taskTimestamp, taskType } from "./taskWorkspacePresentation";

const documentKinds: Record<string, string> = { issue: "问题", spec: "规范", discussion: "讨论", report: "报告", organization_review: "组织复盘", task: "任务正文" };
const waitingLabel: Record<LeaderWorkTaskTiming["current"]["waitingFor"]["kind"], string> = {
  session: "智能体", consumer: "使用方", leader: "统筹", role: "负责职责", publisher: "维护者", user: "用户", task: "前置任务", unknown: "责任未知",
};
const relayStage = { candidate: "候选验收", formal: "正式复验" } as const;
const relayState = { pending: "等待投递或接手", linked: "消息已入队", blocked: "投递受阻", superseded: "已被替代", released: "已释放" } as const;

function FactsSection({ title, children, label }: { title: string; children: React.ReactNode; label?: string }) {
  return <details open aria-label={label ?? title} className="group border-t border-border py-3 first:border-t-0 first:pt-1">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label font-semibold text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />{title}
    </summary>
    <div className="mt-2.5 flex flex-col gap-2.5 pl-5">{children}</div>
  </details>;
}

// Facts are label/value pairs in plain blocks: the old CSS still styles every `dl > div` as a two-column grid.
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div role="group" aria-label={label} className="flex flex-col gap-0.5"><p className="text-caption text-muted-foreground">{label}</p><div className="text-label text-foreground">{children}</div></div>;
}

/** The right column for one task. `detail` and `leader` are passed when the page already read them. */
export function TaskFacts({ context, taskId, detail: given, leader: givenLeader, leaderKnown: givenKnown, linkForTab, heading = false, outsideFilter = false }: {
  context: MutationContext; taskId: string; detail?: TaskDetail | null; leader?: LeaderWorkTask | null; leaderKnown?: boolean;
  linkForTab(tab: TaskSection): string; heading?: boolean; outsideFilter?: boolean;
}) {
  const projectId = context.projectId;
  const detailRead = useProjectQuery(projectId, ["task", taskId, "detail"], async () => {
    const value = await api().task(projectId, taskId);
    if (!matchingTaskDetail(value, projectId, taskId)) throw new Error("任务响应与所选项目、任务不符");
    return value;
  }, { enabled: given === undefined });
  const detail = given ?? (detailRead.data && matchingTaskDetail(detailRead.data, projectId, taskId)) ?? null;
  const leaderRead = useProjectQuery(projectId, ["task", taskId, "leader"], async () => {
    try { return await api().leaderTask(projectId, taskId); }
    catch (cause) { if (cause instanceof ApiError && cause.status === 404) return null; throw cause; }
  }, { enabled: givenLeader === undefined });
  const leader = givenLeader !== undefined ? givenLeader : leaderRead.data;
  const leaderKnown = givenKnown ?? (givenLeader !== undefined || leaderRead.isSuccess || leaderRead.isError);
  const outside = outsideFilter && <p className="mb-2 rounded-md bg-muted px-3 py-1.5 text-caption text-text-secondary">保留所选任务 · 不在当前筛选结果中</p>;
  if (!detail) return <div data-ui="" data-task-facts={taskId}>{outside}{detailRead.error
    ? <ErrorState title="任务信息读取失败" happened={errorText(detailRead.error)} next="可以重新读取，或打开任务查看。"
      action={<span className="flex gap-2"><Button size="compact" onClick={() => void detailRead.refetch()}>重新读取</Button><Button asChild size="compact" variant="ghost"><a href={linkForTab("overview")}>打开任务</a></Button></span>} />
    : <LoadingState lines={6} label="正在读取任务信息" />}</div>;
  const projection = matchingProjection(detail.task, leader ?? undefined);
  return <div data-ui="" className="flex flex-col" data-task-facts={taskId}>
    {outside}
    {heading && <header className="mb-2 flex flex-col gap-1">
      <p className="text-caption text-muted-foreground">{taskType(detail.task.kind)} · 第 {detail.task.version} 版</p>
      <h2 className="text-body font-semibold leading-snug text-foreground">{detail.task.title}</h2>
      <a href={linkForTab("overview")} className="self-start text-label text-primary hover:underline">打开任务</a>
    </header>}
    <FactsSection title="状态与对账阶段"><StatusFacts context={context} detail={detail} projection={projection} leaderKnown={leaderKnown} leaderStale={!!leader && !projection} linkForTab={linkForTab} /></FactsSection>
    <FactsSection title="承接智能体"><TaskAgentBlock context={context} task={detail.task} leader={projection} leaderKnown={leaderKnown && (!leader || !!projection)} runtimeHref={linkForTab("runtime")} /></FactsSection>
    <FactsSection title="关联文档"><DocumentFacts projectId={projectId} detail={detail} /></FactsSection>
    <FactsSection title="交付与使用"><DeliveryFacts projectId={projectId} detail={detail} linkForTab={linkForTab} /></FactsSection>
    <FactsSection title="版本"><VersionFacts projectId={projectId} detail={detail} linkForTab={linkForTab} /></FactsSection>
  </div>;
}

function StatusFacts({ context, detail, projection, leaderKnown, leaderStale, linkForTab }: {
  context: MutationContext; detail: TaskDetail; projection: LeaderWorkTask | undefined; leaderKnown: boolean; leaderStale: boolean; linkForTab(tab: TaskSection): string;
}) {
  const projectId = context.projectId;
  const task = detail.task;
  const open = task.state === "todo" || task.state === "in_progress";
  const roleRead = useProjectQuery(projectId, ["roles", task.owner], signal => readOwnerRole("", projectId, task.owner, signal), { enabled: isRoleOwnerId(task.owner) });
  const sessionKey = projection ? assignmentSessionKey(projection) : null;
  const agentRead = useProjectQuery(projectId, ["session-names", sessionKey], signal => readAgent(projectId, sessionKey!, signal), { enabled: !!sessionKey });
  const agentName = agentRead.data?.profile?.displayName?.trim() || agentRead.data?.title || null;
  const roleName = roleRead.isSuccess ? roleRead.data.proposal.title.trim() : null;
  const pending = detail.impacts.filter(impact => impact.state === "pending").length;
  const timing = projection?.timing;
  const state = taskStateStatus[task.state];
  return <div className="flex flex-col gap-2.5" aria-label="状态与下一步">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-1.5 text-caption text-muted-foreground">任务<StatusTag tone={state.tone} label={state.label} /></span>
      <span className="flex items-center gap-1.5 text-caption text-muted-foreground">对账{projection
        ? <StatusTag tone={phaseStatus[projection.phase].tone} label={phaseStatus[projection.phase].label} />
        : <StatusTag tone="unknown" label={leaderStale ? "正在重新核对" : leaderKnown ? "未登记" : "未读回"} />}</span>
    </div>
    {open || projection ? <Fact label="下一步">{projection?.nextAction ?? (leaderKnown ? "当前工作安排未登记；与统筹沟通后回读" : "正在核对当前工作安排…")}
      {projection && <span className="mt-0.5 block text-caption text-muted-foreground">{taskPreviewResponsibility(projection, agentName, roleName, roleRead.isSuccess ? task.owner : null)}</span>}</Fact> : null}
    {timing && <Fact label="阶段时间">{timingStageLabel[timing.current.stage] ?? "阶段未知"}
      <span className="mt-0.5 block text-caption text-muted-foreground">已历时 {timingDuration(timing.current.elapsedMs)} · 等待{waitingLabel[timing.current.waitingFor.kind]}</span></Fact>}
    {projection?.plan && (projection.plan.priority || projection.plan.dueAt || projection.plan.plannedStartAt) && <Fact label="优先级与截止">
      {[projection.plan.priority ? `P${projection.plan.priority}` : "", projection.plan.dueAt ? `截止 ${taskTimestamp(projection.plan.dueAt)}` : "",
        projection.plan.plannedStartAt ? `计划开始 ${taskTimestamp(projection.plan.plannedStartAt)}` : ""].filter(Boolean).join(" · ")}</Fact>}
    {projection && projection.dependencies.length > 0 && <Fact label="前置任务">{projection.dependencies.filter(item => !item.acceptanceSatisfied).length
      ? `${projection.dependencies.filter(item => !item.acceptanceSatisfied).length} 项尚未验收` : `${projection.dependencies.length} 项均已验收`}</Fact>}
    {projection?.review && <Fact label="统筹决定">{projection.review.decision === "deferred" ? "已暂缓" : "已核对"}<span className="mt-0.5 block text-caption text-muted-foreground">{projection.review.reason}</span></Fact>}
    {pending > 0 && <p className="text-label text-warning">{pending} 项依据变化待复核。<a className="text-primary hover:underline" href={linkForTab("basis")}>去复核</a></p>}
  </div>;
}

type RelatedDocument = { key: string; group: string; documentId: string; revisionId: string | null };

function DocumentFacts({ projectId, detail }: { projectId: string; detail: TaskDetail }) {
  const panel = useContextPanel();
  const task = detail.task;
  const latest = currentDelivery(detail);
  const deliveryDoc = latest ? deliveryTarget(latest, projectId) : null;
  const rows: RelatedDocument[] = [
    { key: "content", group: "主正文", documentId: task.contentDocumentId, revisionId: task.contentRevisionId },
    ...detail.links.map(link => ({ key: `link:${link.id}`, group: "关联文档", documentId: link.documentId, revisionId: null })),
    ...(detail.basis?.members ?? []).filter(member => !(member.documentId === task.contentDocumentId && member.revisionId === task.contentRevisionId))
      .map(member => ({ key: `basis:${member.documentId}:${member.revisionId}`, group: "固定依据", documentId: member.documentId, revisionId: member.revisionId })),
    ...(deliveryDoc?.kind === "document" ? [{ key: "delivery", group: "交付物", documentId: deliveryDoc.documentId, revisionId: deliveryDoc.revisionId }] : []),
  ];
  const ids = [...new Set(rows.map(row => row.documentId))];
  const reads = useQueries({ queries: ids.map(id => ({ queryKey: queryKeys.project(projectId, "document-detail", id), queryFn: () => api().document(projectId, id), retry: false })) });
  const documents = Object.fromEntries(ids.map((id, index) => [id, reads[index]]));
  const groups = ["主正文", "关联文档", "固定依据", "交付物"];
  return <div className="flex flex-col gap-2.5">
    {groups.map(group => {
      const items = rows.filter(row => row.group === group);
      if (!items.length) return group === "关联文档" ? <p key={group} className="text-caption text-muted-foreground">没有另行关联的过程文档。</p> : null;
      return <div key={group} className="flex flex-col gap-0.5">
        <h4 className="text-caption font-medium text-muted-foreground">{group}</h4>
        <ul className="-mx-3 flex flex-col">{items.map(row => {
          const read = documents[row.documentId];
          const document = read?.data?.document;
          const title = document?.title ?? (read?.error ? "文档名称暂不可读" : "正在读取…");
          const kind = document?.kind ? documentKinds[document.kind] : null;
          const moved = row.revisionId && document && document.currentRevisionId !== row.revisionId;
          const meta = [kind, row.revisionId ? moved ? "任务固定旧版 · 文档已有新版" : "任务固定修订" : "当前修订"].filter(Boolean).join(" · ");
          const relation = `${group}${row.revisionId ? " · 任务固定的修订" : ""}`;
          const open = () => panel?.openInPanel({
            id: `document:${row.documentId}@${row.revisionId ?? "current"}`, title: document?.title ?? "文档",
            href: href(projectId, "document", row.documentId, row.revisionId ?? undefined),
            render: () => <TaskDocumentPeek projectId={projectId} documentId={row.documentId} revisionId={row.revisionId} relation={relation} />,
          });
          return <li key={row.key}>{panel
            ? <ListRow onSelect={open} leading={<FileText size={15} className="text-muted-foreground" />} title={title} meta={meta} />
            : <ListRow href={href(projectId, "document", row.documentId, row.revisionId ?? undefined)} leading={<FileText size={15} className="text-muted-foreground" />} title={title} meta={meta} />}</li>;
        })}</ul>
      </div>;
    })}
    <p className="text-caption text-muted-foreground">需求总图与统筹总览关联到任务后列在“关联文档”；系统尚未单独标记它们。</p>
  </div>;
}

function DeliveryFacts({ projectId, detail, linkForTab }: { projectId: string; detail: TaskDetail; linkForTab(tab: TaskSection): string }) {
  const panel = useContextPanel();
  const latest = currentDelivery(detail);
  const relays = useProjectQuery(projectId, ["task", detail.task.id, "acceptance-relay"], () => api().acceptanceRelay(projectId, detail.task.id));
  const observations = latest ? observationsForDelivery(detail.observations ?? [], latest.id) : [];
  const target = latest ? deliveryTarget(latest, projectId) : null;
  return <div className="flex flex-col gap-2.5">
    {latest && target ? <div className="flex flex-col gap-2.5">
      <Fact label="固定成果">{target.kind === "document"
        ? panel ? <button type="button" className="text-left text-primary hover:underline" onClick={() => panel.openInPanel({
          id: `document:${target.documentId}@${target.revisionId}`, title: "交付物", href: target.href,
          render: () => <TaskDocumentPeek projectId={projectId} documentId={target.documentId} revisionId={target.revisionId} relation="交付物 · 本次交付的固定修订" />,
        })}>阅读本次交付的文档</button> : <a className="text-primary hover:underline" href={target.href}>阅读本次交付的文档</a>
        : target.href ? <a className="text-primary hover:underline" href={target.href} target={target.href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">{target.kind === "fallback" ? target.label : target.label}</a>
          : <span>{target.kind === "fallback" ? target.label : "成果入口不可打开"}</span>}
        <span className="mt-0.5 block text-caption text-muted-foreground">登记于 {date(latest.createdAt)}</span></Fact>
      <Fact label="技术检查"><StatusTag tone={latest.technicalResult === "passed" ? "done" : "blocked"} label={latest.technicalResult === "passed" ? "已通过" : "未通过"} /></Fact>
      <Fact label="使用记录">{observations.length
        ? <ul className="flex flex-col gap-0.5">{observations.map(item => <li key={item.id}>{observationResultLabel[item.result]} · {item.observer}（{item.observerKind === "human" ? "人" : "智能体"}）</li>)}</ul>
        : <span className="text-text-secondary">尚无本次交付的使用记录；旧记录不沿用。</span>}</Fact>
    </div> : <p className="text-label text-text-secondary">{(detail.deliveries ?? []).length ? "当前修订尚无交付；历史交付不沿用。" : "当前修订尚无交付。运行结束不代替成果。"}</p>}
    {relays.error && <p role="status" className="text-caption text-muted-foreground">验收安排暂未读回：{errorText(relays.error)}</p>}
    {!!relays.data?.items?.length && <div className="flex flex-col gap-1.5" aria-label="验收接力">
      <h4 className="text-caption font-medium text-muted-foreground">验收接力</h4>
      {relays.data.items.map(item => <div key={item.relayId} className="rounded-md bg-muted px-3 py-2 text-caption text-text-secondary">
        <p className="font-medium text-foreground">{relayStage[item.stage]} · {item.scopeKey} · {relayState[item.state]}</p>
        <p>交给{item.mode === "human" ? "指定的人" : item.mode === "leader" ? "统筹" : "业务智能体"} · {item.recipientActorId}</p>
        {item.blockedReason && <p className="text-warning">待处理：{item.blockedReason}</p>}
        <p>消息{item.messageState ?? "尚未投递"} · 处理{item.processingState ?? "尚未开始"} · 本人读取{item.readActorId || item.humanReadAt ? "已记录" : "未记录"} · 使用{item.observationResult ?? "尚未关联"}</p>
      </div>)}
    </div>}
    <a href={linkForTab("delivery")} className="self-start text-label text-primary hover:underline">交付与使用的完整记录</a>
  </div>;
}

function VersionFacts({ projectId, detail, linkForTab }: { projectId: string; detail: TaskDetail; linkForTab(tab: TaskSection): string }) {
  const { task, revision } = detail;
  const pending = detail.impacts.filter(impact => impact.state === "pending").length;
  return <div className="flex flex-col gap-2">
    <div className="flex flex-col gap-2.5">
      <Fact label="当前版本">第 {task.version} 版 · {date(revision.createdAt)}<span className="mt-0.5 block text-caption text-muted-foreground">{revision.actorId} · {revision.reason}</span></Fact>
      <Fact label="固定依据">{detail.basis ? `${detail.basis.members.length} 份文档的固定修订` : "这个修订没有固定依据集合"}{pending > 0 && <span className="mt-0.5 block text-caption text-warning">{pending} 项依据变化待复核</span>}</Fact>
    </div>
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-label">
      <a className="text-primary hover:underline" href={linkForTab("history")}>历史修订与决定</a>
      <a className="text-primary hover:underline" href={linkForTab("basis")}>依据与影响</a>
      <a className="text-primary hover:underline" href={`${href(projectId, "evaluations")}?taskId=${encodeURIComponent(task.id)}`}>评价与后果</a>
    </div>
    <details className={cn("text-caption text-muted-foreground")}>
      <summary className="cursor-pointer">来源</summary>
      <div className="mt-1 flex flex-col gap-0.5 break-all font-mono">
        <p>任务 {task.id}</p><p>任务修订 {revision.id}</p><p>正文文档 {task.contentDocumentId} @ {task.contentRevisionId}</p>
      </div>
    </details>
    {detail.task.legacyDecision && <Notice tone="waiting">这个任务带有旧版判断记录，请在历史里核对理由。</Notice>}
  </div>;
}
