// 交付与使用 (tasks.md 内容与状态): every delivery of this task, newest first, with its fixed artifact, technical
// check, declared source run and the use observed for that delivery only; then the acceptance relay and the
// acceptance decisions. A finished run, a technical check and actual use are separate facts; old deliveries keep
// their own records and are never carried over to a newer revision.
import React from "react";
import { useQueries } from "@tanstack/react-query";
import type { DocumentDetail, DocumentRevision, RuntimeRunRecord, TaskDetail } from "@evoloop/contracts";
import { Button, StatusTag } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import { deliveryTarget, verifiedDocumentTitle, type DeliveryTarget } from "../../shared/deliveryPresentation";
import { fixedContent, queryKeys, useProjectQuery } from "../../shared/query";
import { runtimeClient } from "../../shared/runtimeClient";
import { taskSectionHref } from "../../shared/taskNavigation";
import { withReturn } from "../../shared/returnLink";
import { taskOrigin } from "./taskOrigin";
import { relayProgress, relayRecipient, relayStageLabel, relayStateLabel } from "../../shared/workPresentation";
import { appPath } from "../../shared/appPath";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { date, href } from "../../shared/ui/shared";
import { deliveryRunHref, recentDeliveryRunIds, verifiedDeliveryRun } from "./deliveryRun";
import { DocumentLink } from "./DocumentLink";
import { EvidenceText } from "./EvidenceText";
import { observationResultLabel, observationsForDelivery, observerKindLabel } from "./observationPresentation";
import { Fine, ReadNote, TabSection } from "./TaskForms";

type Delivery = NonNullable<TaskDetail["deliveries"]>[number];
type Observation = NonNullable<TaskDetail["observations"]>[number];
const emptyDeliveries: Delivery[] = [];

/** The verified title of each delivered document; a failed read never turns the declared reference into a title. */
function useDeliveryTitles(projectId: string, deliveries: Delivery[]) {
  const targets = deliveries.map(delivery => ({ delivery, target: deliveryTarget(delivery, projectId) }))
    .filter((item): item is { delivery: Delivery; target: Extract<DeliveryTarget, { kind: "document" }> } => item.target.kind === "document");
  const reads = useQueries({ queries: targets.flatMap(({ target }) => [
    { queryKey: queryKeys.project(projectId, "document-detail", target.documentId), queryFn: () => api().document(projectId, target.documentId), retry: false },
    { queryKey: queryKeys.project(projectId, fixedContent, target.documentId, target.revisionId, "revision"),
      queryFn: () => api().documentRevision(projectId, target.documentId, target.revisionId), retry: false, staleTime: Infinity },
  ]) });
  const titles: Record<string, { title: string | null; checked: boolean }> = {};
  targets.forEach(({ delivery, target }, index) => {
    const documentRead = reads[index * 2], revisionRead = reads[index * 2 + 1];
    const document = documentRead?.data as DocumentDetail | undefined, revision = revisionRead?.data as DocumentRevision | undefined;
    const checked = !documentRead?.isPending && !revisionRead?.isPending;
    titles[delivery.id] = { checked, title: document && revision ? verifiedDocumentTitle(delivery, target, projectId, document.document, revision) : null };
  });
  return titles;
}

export function TaskDeliveryTab({ projectId, detail, active, actionsHref, actorId }: {
  projectId: string; detail: TaskDetail; active: boolean; actionsHref: string; actorId?: string;
}) {
  const deliveries = detail.deliveries ?? emptyDeliveries;
  const latestId = deliveries.at(-1)?.id;
  const titles = useDeliveryTitles(projectId, deliveries);
  // The declared source runs are checked only while this tab is on screen: the latest five by themselves, older
  // ones on request.
  const [requested, setRequested] = React.useState<string[]>([]);
  const automatic = recentDeliveryRunIds(deliveries, projectId, detail.task.id);
  const runIds = [...new Set(deliveries.map(delivery => delivery.runId).filter((id): id is string => !!id))];
  const runReads = useQueries({ queries: runIds.map(runId => ({
    queryKey: queryKeys.project(projectId, "runtime", "run", runId),
    queryFn: async () => {
      const run = await runtimeClient("", projectId).run(runId);
      const verified = verifiedDeliveryRun(projectId, detail.task.id, runId, run);
      if (!verified) throw new Error("来源运行与交付登记的项目或任务不符");
      return verified;
    },
    enabled: active && (automatic.includes(runId) || requested.includes(runId)), retry: false,
  })) });
  const runs = Object.fromEntries(runIds.map((id, index) => [id, runReads[index]!]));
  const relays = useProjectQuery(projectId, ["task", detail.task.id, "acceptance-relay"], async () => {
    const value = await api().acceptanceRelay(projectId, detail.task.id);
    if (!Array.isArray(value?.items)) throw new Error("验收安排响应格式不符");
    return value;
  }, { enabled: active });
  // The right column reads the same key without checking the answer's shape; only a list counts here.
  const relayItems = Array.isArray(relays.data?.items) ? relays.data!.items : null;
  const open = detail.task.state === "in_progress";
  return <div className="flex flex-col gap-8">
    <TabSection title="交付记录" meta={deliveries.length ? `${deliveries.length} 次交付` : undefined}
      action={open ? <a href={actionsHref} className="text-label text-primary hover:underline">登记交付或使用观察</a> : undefined}>
      {active && deliveries.length > 5 && <Fine>只自动核对最近 5 次交付的来源运行；更早的可以逐条核对。</Fine>}
      {!deliveries.length && <p className="text-label text-text-secondary">还没有交付。任务状态和运行结束都不代替成果与使用记录。</p>}
      <div className="flex flex-col">
        {[...deliveries].reverse().map(delivery => <DeliveryRecord key={delivery.id} projectId={projectId} detail={detail} delivery={delivery}
          latest={delivery.id === latestId} title={titles[delivery.id]} run={delivery.runId ? runs[delivery.runId] : undefined}
          active={active} actorId={actorId} onCheckRun={id => setRequested(current => current.includes(id) ? current : [...current, id])} />)}
      </div>
    </TabSection>
    <TabSection title="验收接力">
      <ReadNote read={relays} what="验收安排" />
      {relayItems && (relayItems.length
        ? <ul className="flex flex-col gap-2" aria-label="验收接力">{relayItems.map(item => <li key={item.relayId} className="flex flex-col gap-0.5 rounded-lg bg-muted px-4 py-3">
          <p className="text-label font-medium text-foreground">{relayStageLabel[item.stage] ?? "验收"} · {relayStateLabel[item.state] ?? "状态未识别"} · {relayRecipient(item)}</p>
          <p className="text-label text-text-secondary">{item.scopeDescription}</p>
          <Fine>{relayProgress(item)}</Fine>
          {item.blockedReason && <p className="text-caption text-warning">投递受阻，需要处理；原因见完整标识。</p>}
          <FullIdentifiers rows={[{ label: "验收范围", value: item.scopeKey }, { label: "接收者", value: item.recipientActorId },
            { label: "受阻原因", value: item.blockedReason, text: true }, { label: "固定交付", value: item.deliveryId }, { label: "验收安排", value: item.relayId }]} />
        </li>)}</ul>
        : <p className="text-label text-text-secondary">还没有为这项任务安排验收接力。</p>)}
    </TabSection>
    <TabSection title="验收与关闭" meta={detail.closures?.length ? `${detail.closures.length} 次` : undefined}>
      {!(detail.closures ?? []).length ? <p className="text-label text-text-secondary">还没有验收决定；交付和使用记录不等于已验收。</p>
        : <div className="flex flex-col gap-4">{(detail.closures ?? []).map(closure => <article key={closure.id} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
          <h3 className="text-small font-semibold text-foreground">验收决定 · {date(closure.createdAt)}</h3>
          <Fine>{closure.decisionId ? "依据：已结算的判断。只完成本轮判断，不代表来源业务任务完成。" : "依据：本任务的交付。"} 审阅者 {closure.actorId}</Fine>
          <EvidenceText label="逐项验收证据" value={closure.acceptanceEvidence} />
          <EvidenceText label="理由" value={closure.reason} />
          {(closure.sourceTaskId || closure.handoffTaskId) && <p className="flex flex-wrap gap-x-3 text-label">
            {closure.sourceTaskId && <a className="text-primary hover:underline" href={href(projectId, "task", closure.sourceTaskId)}>原业务任务</a>}
            {closure.handoffTaskId && <a className="text-primary hover:underline" href={href(projectId, "task", closure.handoffTaskId)}>交接出的待办任务（仍要独立完成）</a>}
          </p>}
          {closure.waitingInboxId && <Fine>还有待承接的来源事项，原业务责任仍要处理。</Fine>}
          <FullIdentifiers rows={[{ label: "交付", value: closure.deliveryId }, { label: "判断", value: closure.decisionId },
            { label: "来源入站", value: closure.sourceInboxId }, { label: "来源事件", value: closure.sourceEventId },
            { label: "待承接入站", value: closure.waitingInboxId }, { label: "正式子派发", value: closure.handoffDispatchId }, { label: "验收记录", value: closure.id }]} />
        </article>)}</div>}
    </TabSection>
  </div>;
}

function DeliveryRecord({ projectId, detail, delivery, latest, title, run, active, onCheckRun, actorId }: {
  projectId: string; detail: TaskDetail; delivery: Delivery; latest: boolean; title?: { title: string | null; checked: boolean };
  run?: { data: RuntimeRunRecord | undefined; error: unknown; isFetching: boolean }; active: boolean; onCheckRun(id: string): void;
  actorId?: string | undefined;
}) {
  const observations = observationsForDelivery(detail.observations ?? [], delivery.id);
  const target = deliveryTarget(delivery, projectId);
  const inScope = delivery.projectId === projectId && delivery.taskId === detail.task.id;
  const current = delivery.taskRevisionId === detail.revision.id;
  return <article className="flex flex-col gap-3 border-t border-border py-5 first:border-t-0 first:pt-0" data-delivery={delivery.id} aria-label={latest ? "最新交付" : "历史交付"}>
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-small font-semibold text-foreground">{latest ? "最新交付" : "历史交付"}</h3>
      <StatusTag tone={delivery.technicalResult === "passed" ? "done" : "blocked"} label={delivery.technicalResult === "passed" ? "技术检查通过" : "技术检查未通过"} />
      {!current && <StatusTag tone="history" label="属于旧修订" />}
    </div>
    <Fine>登记于 {date(delivery.createdAt)} · 登记者 {delivery.actorId}{delivery.submittedByActorId ? ` · 提交者 ${delivery.submittedByActorId}` : ""}</Fine>
    <div className="flex flex-col gap-1">
      <p className="text-caption text-muted-foreground">固定成果</p>
      {target.kind === "document"
        ? <DocumentLink projectId={projectId} documentId={target.documentId} revisionId={target.revisionId} title={title?.title ?? "交付物"} relation="交付物 · 本次交付的固定修订"
          className="text-small font-medium">{title?.title || "交付的文档（标题未核实）"}</DocumentLink>
        : target.href ? <a className="text-small font-medium text-primary hover:underline [overflow-wrap:anywhere]" href={target.href}
          target={appPath(target.href) ? undefined : "_blank"} rel={appPath(target.href) ? undefined : "noopener noreferrer"}>{target.label}</a>
          : <p className="text-small font-medium text-foreground [overflow-wrap:anywhere]">{target.kind === "fallback" ? target.label : "成果入口不可打开"}</p>}
      {target.kind === "document" && title?.checked && !title.title && <Fine>标题或原件校验未通过；请在完整标识里核对原始位置。</Fine>}
      {(target.kind === "knowledge" || target.kind === "evaluation") && <Fine>入口指向{target.kind === "knowledge" ? "知识" : "评价"}的固定修订；产物声明的版本见完整标识。</Fine>}
    </div>
    <p className="text-label text-text-secondary">登记时的任务修订：<a className="text-primary hover:underline" href={taskSectionHref(projectId, delivery.taskId, { revisionId: delivery.taskRevisionId })}>
      {current ? "当前修订" : "打开当时的修订（只读）"}</a></p>
    <div className="text-label text-text-secondary" data-delivery-run="">来源运行：{!delivery.runId ? "未声明来源运行；旧交付不会自动归于任何评价尝试。"
      : !inScope ? "交付来源与当前任务范围不符，不提供运行入口。"
        : run?.data ? <span className="inline-flex flex-wrap gap-x-3">
          <a className="text-primary hover:underline" href={taskSectionHref(projectId, delivery.taskId, { revisionId: run.data.taskRevisionId })}>实际执行的任务修订</a>
          <a className="text-primary hover:underline" href={deliveryRunHref(projectId, delivery.taskId, delivery.runId)}>核对这次运行 →</a>
          <a className="text-primary hover:underline" href={withReturn(`/p/${encodeURIComponent(projectId)}/sessions?session=${encodeURIComponent(`owned:${run.data.sessionId}`)}`,
            actorId ? taskOrigin(projectId, detail.task, actorId) : null)}>查看对应智能体 →</a></span>
          : run?.isFetching ? "正在核对来源运行…"
            : <span>尚未核对。<Button size="compact" variant="ghost" disabled={!active} onClick={() => onCheckRun(delivery.runId!)}>核对来源运行</Button>
              {!!run?.error && <span className="text-destructive"> {errorText(run.error)}</span>}</span>}</div>
    <EvidenceText label="技术检查证据" value={delivery.technicalEvidence} />
    <Fine>来源运行由登记者声明；运行结束不代表交付合格，也不证明产物由模型生成。产物修订、摘要和实际内容要分别核对。</Fine>
    <div className="flex flex-col gap-2" aria-label="这次交付的使用观察">
      <h4 className="text-label font-semibold text-foreground">这次交付的使用观察</h4>
      {!observations.length ? <p className="text-label text-text-secondary">尚无这次交付的使用观察。</p>
        : observations.map(item => <ObservationRecord key={item.id} observation={item} />)}
    </div>
    <FullIdentifiers summary="核对完整位置、修订与摘要" rows={[{ label: "原始位置", value: delivery.artifactRef },
      ...(target.kind !== "fallback" ? [{ label: "入口固定修订", value: target.revisionId }] : []),
      { label: "产物声明版本", value: delivery.artifactRevision }, { label: "SHA-256", value: delivery.contentHash },
      { label: "来源运行", value: delivery.runId }, { label: "登记时任务修订", value: delivery.taskRevisionId }, { label: "交付", value: delivery.id }]} />
  </article>;
}

export function ObservationRecord({ observation }: { observation: Observation }) {
  return <div className="flex flex-col gap-1.5 rounded-lg bg-muted px-4 py-3" data-observation={observation.id}>
    <p className="text-label font-medium text-foreground">{observation.observer} · {observerKindLabel[observation.observerKind]} · {observationResultLabel[observation.result]}</p>
    <Fine>观察登记于 {date(observation.createdAt)} · 登记者 {observation.actorId}</Fine>
    <EvidenceText label="使用证据" value={observation.evidence} />
    <EvidenceText label="记录理由" value={observation.reason} />
  </div>;
}
