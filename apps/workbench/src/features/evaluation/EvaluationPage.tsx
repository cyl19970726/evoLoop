// 评价与后果 (docs/frontend/pages/evaluations.md): the evaluations in the inner rail, the list or one frozen evaluation
// in the middle, and that evaluation's sources and identities in the right column.
import { useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { EvaluationRevision } from "@evoloop/contracts";
import { Button, EmptyState, ErrorState, LoadingState, Notice, RefreshingIndicator, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { navigate } from "../../shared/navigation";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { date } from "../../shared/ui/shared";
import { DefinitionForm } from "./DefinitionForm";
import { EvaluationDetail } from "./EvaluationDetail";
import { useEvaluationDetail, useEvaluationList, useEvaluationReread, type EvaluationFilter } from "./evaluationReads";
import { linkClass, muted } from "./parts";
import { evaluationHref, evaluationListHref, evaluationRowMeta, frozenTaskTitle } from "./presentation";
import { diagnosticOf } from "../../shared/errorPresentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const page = "mx-auto flex w-full max-w-[960px] flex-col gap-5 px-4 py-5 compact:px-8 compact:py-7";

export function EvaluationPage({ context, evaluationId, selectedRevision, taskId, knowledgePageId }: {
  context: MutationContext; evaluationId?: string | undefined; selectedRevision?: string | undefined; refresh: number;
  taskId?: string | undefined; knowledgePageId?: string | undefined;
}) {
  const filter: EvaluationFilter = evaluationId ? {} : { taskId, knowledgePageId };
  const filterKey = JSON.stringify([filter.taskId, filter.knowledgePageId]);
  const [more, setMore] = useState({ key: filterKey, pages: 1 });
  const pages = more.key === filterKey ? more.pages : 1;
  const list = useEvaluationList(context.projectId, filter, pages);
  const reread = useEvaluationReread(context.projectId);
  const rail = <EvaluationRail list={list} projectId={context.projectId} selectedId={evaluationId} filtered={!!(filter.taskId || filter.knowledgePageId)} />;
  if (evaluationId) return <div data-ui="" className={page}>{rail}
    <DetailView context={context} evaluationId={evaluationId} selectedRevision={selectedRevision} onReread={() => void reread(evaluationId)} /></div>;
  const items = list.data?.items ?? [];
  const loadingFirst = !list.data && !list.isError;
  return <div data-ui="" className={page}>
    {rail}
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>评价与后果</h1>
        <p className="mt-1 text-small text-text-secondary">同一共同任务、同一指令与环境下，逐次看真实运行、交付、成本和判断。失败与未知也保留。</p>
      </div>
      <Button onClick={() => void reread()} disabled={list.isFetching}><RefreshCw aria-hidden="true" className={list.isFetching ? "animate-spin" : undefined} />回读当前记录</Button>
    </header>
    {taskId && <p className="m-0 text-small text-text-secondary">当前仅看此任务的评价 · <a className={linkClass} href={`/p/${context.projectId}/tasks/${taskId}`}>返回来源任务</a> · <a className={linkClass} href={evaluationHref(context.projectId)}>查看全部评价</a></p>}
    {knowledgePageId && <p className="m-0 text-small text-text-secondary">当前仅看引用此知识页的评价 · <a className={linkClass} href={`/p/${context.projectId}/knowledge?knowledgeId=${encodeURIComponent(knowledgePageId)}`}>返回知识页</a> · <a className={linkClass} href={evaluationHref(context.projectId)}>查看全部评价</a></p>}
    <section aria-label="已建立的评价" aria-busy={list.isFetching} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-label font-semibold text-foreground">已建立的评价</h2>
        {list.checking && <RefreshingIndicator />}
      </div>
      {loadingFirst && <><p className="m-0 text-small text-text-secondary">正在读取当前范围的评价…</p><LoadingState label="正在读取评价" /></>}
      {list.isError && !list.data && <ErrorState title="评价列表没有读回" happened={errorText(list.error)} diagnostics={diagnosticOf(list.error)} next="可以重试；读回之前，无法判断当前范围有没有评价。"
        action={<Button size="compact" onClick={() => void list.refetch()}>重新读取</Button>} />}
      {list.isError && list.data && <Notice tone="waiting">重读失败：{errorText(list.error)}。下面是上次读回的列表，当前待核对。<ErrorDetails error={list.error} /></Notice>}
      {list.data && !items.length && (list.isError
        ? <p className="m-0 text-small text-text-secondary">上次读回时当前范围没有评价；当前待核对。</p>
        : <EmptyState title="还没有评价" reason="当前范围尚无评价定义。先准备进行中的共同任务与固定协议、材料和 Wiki 修订。" />)}
      {items.length > 0 && <ul aria-label="评价" className="m-0 flex list-none flex-col overflow-hidden rounded-xl bg-raised p-0 shadow-sm">{items.map(item => <li key={`${item.evaluationId}:${item.id}`} className="border-t border-border first:border-t-0">
        <a href={evaluationListHref(context.projectId, item)} className="flex flex-col gap-0.5 px-4 py-3 outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]">
          <span className="break-words text-small font-medium text-foreground">{item.definition.question}</span>
          <span className={muted}>{evaluationRowMeta(item, date)}</span>
        </a>
      </li>)}</ul>}
      {list.data?.nextCursor && <Button size="compact" variant="ghost" className="w-fit" disabled={list.isFetching}
        onClick={() => setMore({ key: filterKey, pages: pages + 1 })}>{list.isFetching ? "读取中…" : "继续读取"}</Button>}
    </section>
    <details className="rounded-xl bg-raised p-4 shadow-sm">
      <summary className="cursor-pointer text-small font-medium text-foreground">需要时建立新的冻结评价</summary>
      <div className="mt-3"><SectionBoundary label="建立评价表单">
        <DefinitionForm context={context} ownerTaskId={taskId} onApplied={id => { navigate(evaluationHref(context.projectId, id)); }} />
      </SectionBoundary></div>
    </details>
  </div>;
}

function DetailView({ context, evaluationId, selectedRevision, onReread }: {
  context: MutationContext; evaluationId: string; selectedRevision?: string | undefined; onReread(): void;
}) {
  const detail = useEvaluationDetail(context.projectId, evaluationId, selectedRevision);
  const read = detail.data;
  const hold = detail.isError && read ? "评价记录最近一次重读失败；页面保留上次读回，写入暂停。请先回读。" : undefined;
  return <>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <a className="inline-flex w-fit items-center gap-1 text-label font-medium text-primary hover:underline" href={evaluationHref(context.projectId)}>
          <ArrowLeft size={15} aria-hidden="true" />返回评价列表</a>
        <h1 className="break-words text-title font-semibold text-foreground" tabIndex={-1}>{read ? read.revision.definition.question : "评价详情"}</h1>
        <p className={cn(muted, "m-0 flex flex-wrap items-center gap-x-2")}>
          {read ? <>固定定义 v{read.revision.version} · 共同任务《{frozenTaskTitle(read.revision)}》 · 记录读于 {date(new Date(detail.dataUpdatedAt).toISOString())}</> : "固定评价与实际尝试"}
          {detail.checking && <RefreshingIndicator />}
        </p>
      </div>
      <Button onClick={onReread} disabled={detail.isFetching}><RefreshCw aria-hidden="true" className={detail.isFetching ? "animate-spin" : undefined} />回读当前记录</Button>
    </header>
    {hold && <Notice tone="waiting" title="上次读回，当前待核对">评价记录重读失败：{errorText(detail.error)}。写入已暂停。<ErrorDetails error={detail.error} /></Notice>}
    {!read && (detail.isError
      ? <ErrorState title="评价没有读回" happened={errorText(detail.error)} diagnostics={diagnosticOf(detail.error)} next="可以重试，或回到评价列表核对链接。读回之前，不能判断有没有尝试或结论。"
        action={<Button size="compact" onClick={() => void detail.refetch()}>重新读取</Button>} />
      : <><p className="m-0 text-small text-text-secondary">正在读取冻结定义与逐次记录…</p><LoadingState label="正在读取评价" lines={5} /></>)}
    {read && <SectionBoundary label="评价详情">
      <EvaluationDetail key={`${read.revision.evaluationId}:${read.revision.id}`} context={context} read={read} selectedRevision={!!selectedRevision} hold={hold} />
    </SectionBoundary>}
  </>;
}

function EvaluationRail({ list, projectId, selectedId, filtered }: {
  list: ReturnType<typeof useEvaluationList>; projectId: string; selectedId?: string | undefined; filtered: boolean;
}) {
  const items: EvaluationRevision[] = list.data?.items ?? [];
  return <ContextRailContent>
    <nav aria-label="评价目录" className="flex flex-col gap-0.5 pt-2">
      <span className="px-3 pb-1.5 pt-2 text-caption text-muted-foreground">{filtered ? "当前范围的评价" : "评价"}{list.data ? ` · ${items.length}${list.data.nextCursor ? "+" : ""}` : ""}</span>
      {!list.data && <p className="m-0 px-3 text-caption text-muted-foreground">{list.isError ? "评价列表没有读回，无法判断有没有其他评价。" : "正在读取评价…"}</p>}
      {list.data && !items.length && <p className="m-0 px-3 text-caption text-muted-foreground">{list.isError ? "上次读回时没有评价；当前待核对。" : "当前范围还没有评价。"}</p>}
      {items.map(item => {
        const selected = item.evaluationId === selectedId;
        return <a key={`${item.evaluationId}:${item.id}`} href={evaluationListHref(projectId, item)} aria-current={selected ? "page" : undefined}
          className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2 text-left outline-none focus-visible:shadow-[var(--focus-ring)]", selected ? "bg-raised shadow-sm" : "hover:bg-selected")}>
          <span className={cn("truncate text-small text-foreground", selected && "font-medium")}>{item.definition.question}</span>
          <span className="truncate text-caption text-muted-foreground">《{frozenTaskTitle(item)}》 · v{item.version}</span>
        </a>;
      })}
      {list.data && list.isError && items.length > 0 && <p className="m-0 px-3 pt-1 text-caption text-muted-foreground">上次读回，当前待核对。</p>}
    </nav>
  </ContextRailContent>;
}
