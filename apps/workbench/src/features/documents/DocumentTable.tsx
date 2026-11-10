// The document table in the center when no document is open (docs/frontend/architecture.md 过程文档表格与完整阅读):
// list metadata only, a real <table>, focusable title links, task links that open on their own, and on return the
// same conditions, range and row with focus back on the document last opened.
import React, { useContext, useEffect } from "react";
import type { Document } from "@evoloop/contracts";
import type { LeaderWorkDocument } from "@evoloop/contracts/work-index";
import { Button, EmptyState, ErrorState, LoadingState, Notice, RefreshingIndicator, StatusTag, cn } from "@evoloop/ui";
import { api, errorDiagnostic } from "../../shared/api";
import { loadLeaderDocumentsForIds } from "../../shared/leaderWorkLoad";
import { useProjectQuery } from "../../shared/query";
import { href } from "../../shared/routes";
import { date } from "../../shared/ui/shared";
import type { ReturnFrom } from "../../shared/returnLink";
import { documentListOrigin, taskLinkFrom } from "./taskLinks";
import { PageActive } from "../../shared/ui/pageActive";
import { documentLifecycleMatches } from "./documentListModel";
import {
  coverageText, emptyListText, kindText, lifecycleLabel, lifecycleTone, publicationText, referenceText,
} from "./documentPresentation";
import { initialListState, type DocumentListState } from "./documentListState";
import { readProblem, type useDocumentList } from "./useDocumentList";

type List = ReturnType<typeof useDocumentList>;

/**
 * What the lifecycle index says about each shown document: its uses and the tasks that reference it. Only this set's
 * own answer counts (another set of rows is another key, read from nothing); a failed reread of this set keeps its
 * answer as 上次读回 and never counts as complete, so no row concludes from it.
 */
function useDocumentUsage(projectId: string, documents: readonly Document[], status: DocumentListState["status"]) {
  const ids = documents.map(document => document.id).sort();
  const includeClosed = status === "all" || status === "archived";
  const usage = useProjectQuery(projectId, ["documents", "usage", includeClosed, ids.join(",")],
    () => loadLeaderDocumentsForIds(cursor => api().leaderWork(projectId, "documents", cursor, includeClosed), ids),
    { enabled: ids.length > 0 });
  const found = usage.data?.items ?? new Map<string, LeaderWorkDocument>();
  const matches = (document: Document): LeaderWorkDocument | undefined => {
    const projection = found.get(document.id);
    return projection && documentLifecycleMatches(document, projection) ? projection : undefined;
  };
  const complete = !!usage.data?.complete && !usage.stale && documents.every(document => !!matches(document));
  return { matches, checking: usage.isFetching, stale: usage.stale, partial: !usage.isFetching && ids.length > 0 && !complete,
    error: usage.error ? readProblem(usage.error, "文档用途与关联工作") : "", diagnostic: usage.error ? errorDiagnostic(usage.error) : "" };
}

export function DocumentTable({ projectId, list, state, update, toolbar, actorId }: {
  projectId: string; list: List; state: DocumentListState; update(patch: Partial<DocumentListState>): void; toolbar: React.ReactNode;
  /** The reader, so a task opened from the list comes back to it. */
  actorId?: string;
}) {
  const from = actorId ? documentListOrigin(projectId, actorId) : null;
  const usage = useDocumentUsage(projectId, list.visible, state.status);
  const active = useContext(PageActive);
  // Back from a document: the row it was opened from gets focus again, after the page restores its scroll position.
  // The shell focuses the main landmark in the next frame; the timer starts from a frame requested after that one,
  // so the row always comes last, however late frames run.
  useEffect(() => {
    if (!active || !state.lastOpened) return;
    let timer = 0;
    const frame = requestAnimationFrame(() => { timer = window.setTimeout(() => document.querySelector<HTMLElement>(
      `[data-ui] a[data-document-title="${CSS.escape(state.lastOpened!)}"]`)?.focus({ preventScroll: true }), 120); });
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [active, state.lastOpened]);
  const open = (id: string) => update({ lastOpened: id });
  const empty = emptyListText({ filtered: list.filtered, more: list.more });
  return <section aria-label="过程文档" aria-busy={list.loading || list.checking} className="flex flex-col gap-3">
    {toolbar}
    {list.error && <ErrorState title="列表本次没有读回" happened={`${list.error}。`} previousContentKept={list.stale}
      next={list.stale ? "可以重试；已显示的行只供核对，不能当作当前结果。" : "可以重试；没有读回之前不能判断有哪些文档。"}
      diagnostics={list.errorDetail ?? undefined} action={<Button size="compact" onClick={() => void list.reread()}>重试</Button>} />}
    {list.pageError && <ErrorState title="后面一页没有读回" happened={`${list.pageError}。`}
      next="已显示的行是读到的内容；后面的文档还没读到，可以只重试这一页。" diagnostics={list.errorDetail ?? undefined}
      action={list.more ? <Button size="compact" disabled={list.checking} onClick={list.loadMore}>重试这一页</Button> : undefined} />}
    {list.searchLimited && <Notice tone="waiting">搜索已自动读到 {list.items.length} 项的上限，结果可能不完整；可以在表格下方继续载入。</Notice>}
    {usage.partial && <Notice tone="waiting" title={usage.stale ? "用途与关联任务这次没有重新读回" : "用途与关联任务没有完整读回"}>
      {usage.stale ? "下面是上次读回的用途与引用，当前待核对，不代表现在的情况。" : "没有资料的行显示为“待核对”，不代表没有引用。"}
      {usage.error && <details className="mt-1 text-caption"><summary className="cursor-pointer">诊断信息</summary>{usage.diagnostic}</details>}</Notice>}
    {list.loading && !list.error ? <LoadingState lines={5} label="正在读取文档" />
      : !list.visible.length && !list.error ? <EmptyState title={empty.title} reason={empty.reason}
        action={list.filtered ? <Button size="compact" onClick={() => update({ query: initialListState.query, kind: initialListState.kind, status: initialListState.status })}>清除筛选</Button> : undefined} />
      : list.visible.length > 0 && <div role="region" aria-label="过程文档表格，可横向查看" tabIndex={0}
        className="overflow-x-auto rounded-lg border border-border outline-none focus-visible:shadow-[var(--focus-ring)]">
        <table className="w-full min-w-[720px] text-left text-small">
          <thead className="bg-muted text-caption text-muted-foreground">
            <tr><th scope="col" className="w-[38%] px-4 py-2.5 font-medium">文档</th><th scope="col" className="px-4 py-2.5 font-medium">用途与关联任务</th>
              <th scope="col" className="px-4 py-2.5 font-medium">版本</th><th scope="col" className="px-4 py-2.5 font-medium">最近变化</th></tr>
          </thead>
          <tbody>{list.visible.map(document => {
            const work = usage.matches(document);
            const [first, ...others] = work?.references ?? [];
            const owner = document.primaryTaskId && !work?.references.some(reference => reference.taskId === document.primaryTaskId)
              ? <a href={taskLinkFrom(projectId, document.primaryTaskId, from)} className="text-caption text-primary hover:underline">所属任务</a> : null;
            return <tr key={document.id} className={cn("border-t border-border align-top", state.lastOpened === document.id && "bg-selected/60")}>
              <td className="px-4 py-3">
                <a href={href(projectId, "document", document.id)} data-document-title={document.id} onClick={() => open(document.id)}
                  className="font-medium text-foreground outline-none [overflow-wrap:anywhere] hover:text-primary hover:underline focus-visible:shadow-[var(--focus-ring)]">{document.title}</a>
                <span className="mt-0.5 block text-caption text-muted-foreground">{kindText(document.kind)}</span>
              </td>
              <td className="px-4 py-3 text-text-secondary">
                {work ? first ? <ul className="flex flex-col gap-1">
                  <TaskReference projectId={projectId} from={from} taskId={first.taskId} title={first.title} relation={referenceText(first.relations)} />
                  {others.length > 0 && <li><details><summary className="cursor-pointer text-caption text-muted-foreground">另有 {others.length} 项任务引用</summary>
                    <ul className="mt-1 flex flex-col gap-1">{others.map(reference => <TaskReference key={reference.taskId} projectId={projectId} from={from}
                      taskId={reference.taskId} title={reference.title} relation={referenceText(reference.relations)} />)}</ul></details></li>}
                </ul> : <span className="text-muted-foreground">{usage.stale ? "上次读回时还没有任务引用" : "还没有任务引用"}</span>
                  : <span className="text-muted-foreground">{usage.checking ? "正在核对…" : "待核对"}</span>}
                {owner && <span className="mt-1 block">{owner}</span>}
              </td>
              <td className="px-4 py-3"><StatusTag tone={lifecycleTone[document.status]} label={lifecycleLabel[document.status]} />
                <span className="mt-1 block whitespace-nowrap text-caption text-muted-foreground">{publicationText(document)}</span></td>
              <td className="whitespace-nowrap px-4 py-3 text-caption text-muted-foreground">{work?.dates.changedAt ? date(work.dates.changedAt) : usage.checking ? "正在核对…" : "待核对"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
    <div className="flex flex-wrap items-center justify-between gap-3 text-caption text-muted-foreground">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{coverageText({ loaded: list.items.length, matched: list.visible.length, filtered: list.filtered, more: list.more, coverage: list.coverage })}</span>
        {list.checking ? <RefreshingIndicator label={state.query.trim() ? "正在搜索后续页面；结果尚未完整" : "正在核对列表；已显示的是上次读到的内容"} />
          : list.observedAt && <span>列表读于 {list.observedAt.toLocaleString("zh-CN")}</span>}
      </span>
      {list.more && !list.pageError && <Button size="compact" disabled={list.checking} onClick={list.loadMore}>载入更多</Button>}
    </div>
  </section>;
}

function TaskReference({ projectId, taskId, title, relation, from }: { projectId: string; taskId: string; title: string; relation: string; from: ReturnFrom | null }) {
  return <li className="flex flex-col"><a href={taskLinkFrom(projectId, taskId, from)} className="text-label text-primary [overflow-wrap:anywhere] hover:underline">{title}</a>
    <span className="text-caption text-muted-foreground">{relation}</span></li>;
}
