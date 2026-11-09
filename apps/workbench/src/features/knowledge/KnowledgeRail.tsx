// The inner rail on 知识空间 (docs/frontend/layout.md 内层上下文栏): the 文档 / 知识 switch, search and filters, the
// entry to 候选与审阅, then the directory (专题 first, an open topic's members under it, then the other pages), and
// what the list covers with 载入更多. Rows are links, so a plain click closes the narrow drawer and a modified click
// opens a new tab.
import React from "react";
import { Search } from "lucide-react";
import type { KnowledgeSummary } from "@evoloop/contracts/knowledge";
import { Badge, Button, Input, ListRow, RefreshingIndicator, cn } from "@evoloop/ui";
import type { ListCoverage } from "../../shared/listCoverage";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { ReadingSpaceSwitch } from "../../shared/ui/ReadingSpaceSwitch";
import { knowledgeHref } from "./knowledgeRoute";
import {
  coverageText, emptyKnowledgeText, label, listProblemText, pageTypeLabel, pageTypes, validityLabel, type KnowledgeFilter, type ListProblem,
} from "./knowledgePresentation";

const select = "h-8 min-w-0 rounded-md bg-field px-2 text-label text-foreground outline-none focus-visible:shadow-[var(--focus-ring)]";

export function KnowledgeFilters({ filter, update, layout = "rail" }: { filter: KnowledgeFilter; update(patch: Partial<KnowledgeFilter>): void; layout?: "rail" | "toolbar" }) {
  return <div className={cn("flex flex-wrap items-center gap-2", layout === "rail" && "px-1")}>
    <label className={cn("relative flex items-center", layout === "rail" ? "w-full" : "min-w-[200px] flex-1 compact:max-w-[340px]")}>
      <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-muted-foreground" />
      <Input aria-label="搜索知识" placeholder="搜索知识标题" value={filter.query} onChange={event => update({ query: event.target.value })} className="h-8 pl-8 text-label" type="search" />
    </label>
    <select aria-label="页面类型筛选" value={filter.type} onChange={event => update({ type: event.target.value as KnowledgeFilter["type"] })} className={cn(select, layout === "rail" && "flex-1")}>
      <option value="all">全部类型</option>
      {pageTypes.map(type => <option key={type} value={type}>{pageTypeLabel[type]}</option>)}
    </select>
    <select aria-label="有效状态筛选" value={filter.validity} onChange={event => update({ validity: event.target.value as KnowledgeFilter["validity"] })} className={cn(select, layout === "rail" && "flex-1")}>
      <option value="all">全部状态</option>
      {(Object.keys(validityLabel) as Array<keyof typeof validityLabel>).map(value => <option key={value} value={value}>{validityLabel[value]}</option>)}
    </select>
  </div>;
}

export interface DirectoryList {
  topics: KnowledgeSummary[]; pages: KnowledgeSummary[]; members: KnowledgeSummary[]; openTopicId: string | null;
  loaded: number; matched: number; filtered: boolean; more: boolean; fullRead: boolean;
  reading: boolean; checking: boolean; loadingMore: boolean; coverage: ListCoverage; problem: ListProblem | null; loadMore(): void; reread(): void;
}

/** The note above a list that was not (fully) read, with the retry it allows (none for an unconfigured backend). */
export function ListProblemNote({ problem, what, onReread, onLoadMore, className }: {
  problem: ListProblem; what: string; onReread(): void; onLoadMore(): void; className?: string;
}) {
  const note = listProblemText(problem, what);
  return <div role="alert" className={cn("rounded-md bg-danger-soft px-3 py-2 text-caption text-text-secondary", problem.kind === "unconfigured" && "bg-warning-soft", className)}>
    {note.text}
    {note.retry && <button type="button" className="ml-1 text-primary underline" onClick={problem.kind === "page" ? onLoadMore : onReread}>{note.retry}</button>}
    {problem.detail && <details className="mt-1"><summary className="cursor-pointer">诊断信息</summary><code className="break-all font-mono">{problem.detail}</code></details>}
  </div>;
}

export function KnowledgeDirectory({ projectId, list, selectedId, compact = false }: { projectId: string; list: DirectoryList; selectedId: string | null; compact?: boolean }) {
  const row = (item: KnowledgeSummary, nested = false) => <li key={`${nested ? "member" : "page"}:${item.knowledgeId}`}>
    <ListRow href={knowledgeHref(projectId, { knowledgeId: item.knowledgeId })} selected={item.knowledgeId === selectedId}
      className={nested ? "pl-7" : undefined} title={<span title={item.title}>{item.title}</span>}
      meta={`${label(pageTypeLabel, item.pageType)} · ${label(validityLabel, item.validity)}`} />
  </li>;
  const empty = emptyKnowledgeText({ filtered: list.filtered, more: list.more, fullRead: list.fullRead });
  const heading = cn("px-3 pb-1 pt-2 text-caption text-muted-foreground", compact && "px-1");
  // A list never read says only that; one kept from before or missing its next page still shows what was read.
  const unread = !!list.problem && (list.problem.kind === "failed" || list.problem.kind === "unconfigured");
  return <div className="flex flex-col gap-1">
    {list.problem && <ListProblemNote problem={list.problem} what="知识列表" onReread={list.reread} onLoadMore={list.loadMore} className="mx-1" />}
    {list.reading && !list.problem && <p role="status" className="mx-1 text-caption text-muted-foreground">正在读取知识页…</p>}
    {!list.reading && !unread && list.matched === 0 && <div className="mx-1 rounded-md bg-muted px-3 py-2.5 text-caption text-text-secondary">
      <p className="font-medium text-foreground">{empty.title}</p><p className="mt-0.5">{empty.reason}</p></div>}
    {list.topics.length > 0 && <nav aria-label="专题目录" className="flex flex-col">
      <span className={heading}>专题 · {list.topics.length}</span>
      <ul className="flex flex-col gap-0.5">{list.topics.map(topic => <React.Fragment key={topic.knowledgeId}>
        {row(topic)}
        {topic.knowledgeId === list.openTopicId && list.members.length > 0 && <li><ul aria-label={`${topic.title}的成员`} className="flex flex-col gap-0.5">{list.members.map(item => row(item, true))}</ul></li>}
      </React.Fragment>)}</ul>
    </nav>}
    {list.pages.length > 0 && <nav aria-label={list.fullRead ? "知识页面" : "可核对的固定引用"} className="flex flex-col">
      <span className={heading}>{list.fullRead ? "知识页" : "可核对的固定引用"} · {list.pages.length}</span>
      <ul className="flex flex-col gap-0.5">{list.pages.map(item => row(item))}</ul>
    </nav>}
    <div className={cn("mx-1 mt-1 flex flex-col gap-1.5 text-caption text-muted-foreground", compact && "mx-0")}>
      {!list.reading && !unread && <span>{coverageText({ loaded: list.loaded, matched: list.matched, filtered: list.filtered, more: list.more, coverage: list.coverage })}</span>}
      {list.checking && <RefreshingIndicator label="正在核对列表" />}
      {list.loadingMore && <RefreshingIndicator label="正在载入下一页" />}
      {list.more && list.problem?.kind !== "page" && <Button variant="secondary" size="compact" className="self-start" disabled={list.checking || list.loadingMore} onClick={list.loadMore}>载入更多</Button>}
    </div>
  </div>;
}

export function KnowledgeRail({ projectId, filter, update, list, selectedId, reviewing, pendingCandidates }: {
  projectId: string; filter: KnowledgeFilter; update(patch: Partial<KnowledgeFilter>): void; list: DirectoryList;
  selectedId: string | null; reviewing: boolean; pendingCandidates: string | null;
}) {
  return <ContextRailContent><section data-ui="" aria-label="知识目录" className="flex flex-col gap-2.5 pb-2">
    <ReadingSpaceSwitch projectId={projectId} current="knowledge" className="mx-1" />
    <KnowledgeFilters filter={filter} update={update} />
    <ListRow href={knowledgeHref(projectId, "review")} selected={reviewing} title="候选与审阅"
      trailing={pendingCandidates ? <Badge aria-label={`已载入的候选里 ${pendingCandidates} 条待审`}>{pendingCandidates}</Badge> : undefined} />
    <KnowledgeDirectory projectId={projectId} list={list} selectedId={selectedId} />
  </section></ContextRailContent>;
}
