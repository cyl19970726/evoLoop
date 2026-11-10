// Formal relations after a discussion decision: the linked task, role, document or stage, and who accepted the same
// task revision. Names are read for display; fixed revisions, IDs and sources sit in 来源与完整标识.
import { useRef } from "react";
import type { DiscussionRecord } from "@evoloop/contracts/discussions";
import { Button, CollapsibleRow, Notice, RefreshingIndicator, StatusTag } from "@evoloop/ui";
import { safeArtifactHref } from "../../shared/api";
import { appPath } from "../../shared/appPath";
import { date } from "../../shared/ui/shared";
import type { MutationContext } from "../../shared/ActionForm";
import type { AllocationTrace } from "./allocationClient";
import { muted } from "./formParts";
import {
  acceptanceGapSentence, assignmentStatusLabel, limitationText, nameOr, sourceKindLabel, targetKindLabel, targetStatusTag,
} from "./discussionPresentation";
import { allocationSessionKey, useAllocationNameState, type AllocationKnownNames } from "./useAllocationNames";
import { useAllocationTraces } from "./useAllocationTraces";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const project = (projectId: string) => `/p/${encodeURIComponent(projectId)}`;
const journeyHref = (projectId: string) => `${project(projectId)}/journey`;
const link = "text-primary underline-offset-4 hover:underline outline-none focus-visible:shadow-[var(--focus-ring)] rounded-sm";
const code = "font-mono text-caption [overflow-wrap:anywhere]";

function targetHref(projectId: string, target: Extract<AllocationTrace["relation"], { kind: "decision-target" }>["target"]): string {
  const id = encodeURIComponent(target.id);
  if (target.kind === "task") return `${project(projectId)}/tasks/${id}?revision=${encodeURIComponent(target.revisionId)}`;
  if (target.kind === "document") return `${project(projectId)}/documents/${id}?revision=${encodeURIComponent(target.revisionId)}`;
  if (target.kind === "role") return `${project(projectId)}/roles?role=${id}`;
  return journeyHref(projectId);
}

export function AllocationTraceCard({ trace, projectId, names, reading = () => false }: { trace: AllocationTrace; projectId: string; names: Record<string, string>; reading?: (key: string) => boolean }) {
  const relation = trace.relation;
  return <article className="flex flex-col gap-1.5 border-t border-border py-3 first:border-t-0 first:pt-0" aria-label="正式关系">
    {relation.kind === "decision-target" ? <>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-small text-foreground [overflow-wrap:anywhere]">
          <span className="text-muted-foreground">{targetKindLabel[relation.target.kind]} · </span>
          <a className={link} href={targetHref(projectId, relation.target)}>{relation.target.kind === "stage"
            ? `第 ${relation.target.version} 版`
            : nameOr(names[`${relation.target.kind}:${relation.target.id}`], targetKindLabel[relation.target.kind], reading(`${relation.target.kind}:${relation.target.id}`))}</a>
        </p>
        <StatusTag {...targetStatusTag[relation.targetStatus]} />
      </div>
      {relation.target.kind === "stage" && <p className={muted}>链接打开当前阶段入口，不是这一版的历史。</p>}
      {relation.target.kind === "task" && relation.taskAcceptanceGap !== undefined && <p className={muted}>{acceptanceGapSentence(relation.taskAcceptanceGap)}</p>}
    </> : <>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-small text-foreground [overflow-wrap:anywhere]">
          <a className={link} href={`${project(projectId)}/sessions?session=${encodeURIComponent(allocationSessionKey(relation.assignment.target))}`}>
            {nameOr(names[`session:${allocationSessionKey(relation.assignment.target)}`], "智能体", reading(`session:${allocationSessionKey(relation.assignment.target)}`))}</a>
          <span className="text-text-secondary"> 接手了 </span>
          <a className={link} href={`${project(projectId)}/tasks/${encodeURIComponent(relation.task.id)}?revision=${encodeURIComponent(relation.task.revisionId)}`}>
            {nameOr(names[`task:${relation.task.id}`], "任务", reading(`task:${relation.task.id}`))}</a>
        </p>
        <StatusTag {...targetStatusTag[relation.taskRevisionStatus]} />
      </div>
      <p className={muted}>{assignmentStatusLabel[relation.assignmentStatus]} · {relation.assignment.target.kind === "external" ? "外部连接" : "项目受管"}
        {" · "}{relation.assignment.method === "direct" ? "接手者本人确认" : "负责人观察到接手"} · {date(relation.assignment.acceptedAt)}</p>
      {relation.assignment.method === "lead-observed" && <p className={muted}>这是负责人的观察记录，不是接手者本人确认。</p>}
    </>}
    {!trace.decisionIsLatest && <p className="text-caption text-warning">关联的是历史决定；当前决定已变化，这条关系需要重新核对。</p>}
    {trace.decisionDocumentRevisionId && <a className={`${link} text-caption`} href={`${project(projectId)}/documents/${encodeURIComponent(trace.discussion.document.id)}?revision=${encodeURIComponent(trace.decisionDocumentRevisionId)}`}>阅读这次决定依据的固定原文</a>}
    <CollapsibleRow summary="来源与完整标识">
      <ul className="flex flex-col gap-1 text-caption text-muted-foreground">
        <li>关系 <code className={code}>{trace.id}</code></li>
        <li>决定事件 <code className={code}>{trace.decisionEventId}</code>{trace.decisionDocumentRevisionId && <> · 决定原文修订 <code className={code}>{trace.decisionDocumentRevisionId}</code></>}</li>
        {relation.kind === "decision-target"
          ? <li>{targetKindLabel[relation.target.kind]} <code className={code}>{relation.target.id}</code> · {relation.target.kind === "stage" ? `第 ${relation.target.version} 版` : <>固定修订 <code className={code}>{relation.target.revisionId}</code></>} · 链接事件 <code className={code}>{relation.actionEventId}</code></li>
          : <li>智能体 <code className={code}>{allocationSessionKey(relation.assignment.target)}</code> · 任务 <code className={code}>{relation.task.id}</code> · 任务修订 <code className={code}>{relation.task.revisionId}</code> · 分派第 {relation.assignment.version} 版 · 链接事件 <code className={code}>{relation.taskActionEventId}</code>{relation.assignment.method === "lead-observed" && <> · 观察者 <code className={code}>{relation.assignment.observerActorId}</code></>}</li>}
        {trace.sources.map((source, index) => {
          const href = source.kind === "stage" ? (appPath(source.href) === journeyHref(projectId) ? journeyHref(projectId) : null) : safeArtifactHref(source.href, projectId);
          const label = <>{sourceKindLabel[source.kind] ?? source.kind} <code className={code}>{source.id}</code>{source.revision && <> · <code className={code}>{source.revision}</code></>}</>;
          return <li key={`${source.kind}:${source.id}:${index}`}>{href ? <a className={link} href={href}>{label}</a> : label}</li>;
        })}
      </ul>
    </CollapsibleRow>
  </article>;
}

/** Read state of a relation list: when it was read, whether it is complete, and what it cannot prove. */
export function RelationReadState({ noun, traces }: { noun: "关系" | "来源"; traces: ReturnType<typeof useAllocationTraces> }) {
  const { observedAt, loading, changesError, error, errorDetail, partial, limitations, items, cursor } = traces;
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <span className={muted}>{observedAt ? `${noun}读于 ${date(observedAt)}` : loading ? `正在读取${noun}` : `${noun}尚未读回`}</span>
      {loading && observedAt && <RefreshingIndicator />}
      {/* Named after what it rereads: the host pages (agent, role card) have their own 重新读取. */}
      <Button size="compact" variant="ghost" disabled={loading} onClick={traces.reread}>重新读取{noun}</Button>
    </div>
    {changesError && <Notice tone="waiting">{changesError}</Notice>}
    {error && <Notice tone="error">{noun}读取失败：{error}。不能据此判断没有{noun === "关系" ? "承接" : "关联"}。{observedAt ? "下面仍是上次读到的内容。" : ""}<ErrorDetails failure={{ text: error, detail: errorDetail }} /></Notice>}
    {partial && <Notice tone="waiting">来源没有读完整，下面只是已经读到的部分。</Notice>}
    {limitations.length > 0 && <CollapsibleRow summary={`来源限制 · ${limitations.length} 项`}>
      <ul className="flex flex-col gap-1 text-caption text-text-secondary">{limitations.map(item => {
        const { text, original } = limitationText(item);
        return <li key={item}>{text}{original && <code className={`${code} mt-0.5 block text-muted-foreground`}>{original}</code>}</li>;
      })}</ul>
    </CollapsibleRow>}
    {!loading && !error && items.length === 0 && <p className="text-small text-text-secondary">{partial
      ? `来源没有读完整，暂时不能判断有没有${noun === "关系" ? "正式关系" : "关联"}。`
      : cursor ? `这一页没有${noun}，后续页还没读。` : noun === "关系"
        ? "还没有正式链接的后续对象。讨论内容和拟交接的智能体都不算实际承接。"
        : "还没有能确认的正式分工讨论来源。"}</p>}
  </>;
}

/** The right column's 关联的任务、职责与文档 for an allocation discussion. */
export function AllocationRelations({ context, record, refresh, known, namesReady }: { context: MutationContext; record: DiscussionRecord;
  refresh: number; known: AllocationKnownNames; namesReady: boolean }) {
  const root = useRef<HTMLElement>(null);
  const traces = useAllocationTraces(context, { discussionId: record.id }, refresh, root, "关系");
  const { names, reading } = useAllocationNameState(context.token, context.projectId, traces.items, known, namesReady && !traces.loading,
    `${record.id}\0${refresh}\0${traces.readAgain}`);
  return <section ref={root} aria-label="正式关系与具体承接" className="flex flex-col gap-2">
    <p className={muted}>只列决定后正式链接的对象，以及同一任务修订的接受记录。接受不等于已经运行、交付或实际使用。</p>
    <RelationReadState noun="关系" traces={traces} />
    {traces.items.length > 0 && <div className="flex flex-col">{traces.items.map(item => <AllocationTraceCard key={item.id} trace={item} projectId={context.projectId} names={names} reading={reading} />)}</div>}
    {traces.cursor && <Button size="compact" variant="ghost" className="self-start" disabled={traces.moreBusy || traces.loading} onClick={() => void traces.more()}>{traces.moreBusy ? "正在读取…" : "加载更多关系"}</Button>}
  </section>;
}
