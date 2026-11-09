// The right column for an open knowledge page (docs/frontend/layout.md 右栏, 知识): 来源 → 挑战与反例 → 相关认识 →
// 版本 → 评价 → 关系图 → 完整标识, each a block that folds on its own. Raw IDs and hashes live only in 完整标识.
// While the next page loads, the previous page's facts stay, marked, so the column never collapses; history and relation
// links stay mounted across the switch, so keyboard focus is not dropped.
import React from "react";
import { ChevronRight } from "lucide-react";
import { RefreshingIndicator, StatusTag, cn } from "@evoloop/ui";
import { href } from "../../shared/routes";
import { ContextPanelContent } from "../../shared/ui/ContextPanel";
import type { KnowledgeReading } from "./knowledgeRead";
import { titleKey } from "./knowledgeRead";
import { findFixedKnowledgeTitle, knowledgeHref, sourceDocumentHref, unresolvedFixedKnowledgeTitle } from "./knowledgeRoute";
import {
  directionText, historyLabel, label, pageRelations, readingStanding, relationStateLabel, relationTypeLabel, sourceDocumentId,
  sourceStateLabel, validityLabel, validityTone, type PageRelation,
} from "./knowledgePresentation";
import { KnowledgeGraph } from "./KnowledgeGraph";

export function Block({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return <details open={defaultOpen} className="group border-b border-border py-3 first:pt-0 last:border-b-0">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label font-semibold text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight size={14} aria-hidden="true" className="text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />{title}
    </summary>
    <div className="mt-2.5 pl-5">{children}</div>
  </details>;
}

/** A labelled fact. Plain blocks, not <dl>: the old global `dl > div` grid would override the layout. */
export function Fact({ label: name, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-0.5"><span className="text-caption text-muted-foreground">{name}</span><div className="text-label text-foreground [overflow-wrap:anywhere]">{children}</div></div>;
}

export const quiet = "text-label text-text-secondary";
const link = "text-label font-medium text-primary outline-none hover:underline focus-visible:shadow-[var(--focus-ring)] [overflow-wrap:anywhere]";

export function KnowledgeFacts({ projectId, reading, previous, stale = false, sourceTitles }: {
  projectId: string; reading: KnowledgeReading; previous: boolean; sourceTitles: ReadonlyMap<string, string>;
  /** A reread of this page failed: the facts below are 上次读回，当前待核对. */
  stale?: boolean;
}) {
  const { page, current, history, graph, titles } = reading;
  const standing = readingStanding(page.revision, current !== page.revision, current);
  const readingCurrent = current === page.revision;
  const relations = pageRelations(page, graph, readingCurrent);
  const challenges = relations.filter(item => item.edge.type === "contradicts");
  const others = relations.filter(item => item.edge.type !== "contradicts");
  const here = knowledgeHref(projectId, { knowledgeId: page.knowledgeId, revision: page.revision });
  const name = (item: PageRelation) => findFixedKnowledgeTitle(item.otherId, item.otherRevision, graph?.nodes ?? [])
    ?? titles[titleKey(item.otherId, item.otherRevision)] ?? unresolvedFixedKnowledgeTitle;
  const relationList = (items: PageRelation[], withType: boolean) => <ul className="flex flex-col gap-2">{items.map(item => <li key={item.edge.edgeId} className="flex flex-col gap-0.5">
    <a href={knowledgeHref(projectId, { knowledgeId: item.otherId, revision: item.otherRevision })} className={link}>{name(item)}</a>
    <span className="text-caption text-muted-foreground">{withType ? `${label(relationTypeLabel, item.edge.type)} · ` : ""}{directionText(item)} · {label(relationStateLabel, item.edge.state)}{item.edge.sourceKeys.length ? "" : " · 未登记依据"}</span>
  </li>)}</ul>;
  const historyNote = !readingCurrent && <p className="mb-2 text-caption text-muted-foreground">这一版不是当前版：只列它自己登记的关系，指向它的关系只对当前版读取。</p>;
  return <ContextPanelContent><div data-ui="" role="region" aria-label="来源、反例与版本" aria-busy={previous || undefined}>
    {previous && <RefreshingIndicator label="正在读取所选页面；下面仍是上一页" className="mb-2" />}
    {stale && <p role="status" className="mb-2 rounded-md bg-warning-soft px-3 py-2 text-caption text-text-secondary">这一页这次没有重新读回；下面是上次读回的，当前待核对。</p>}
    <div className={cn("transition-opacity duration-150", previous && "opacity-60")}>
      <Block title="来源">
        {page.sources.length ? <ul className="flex flex-col gap-2.5">{page.sources.map((source, index) => {
          const documentId = sourceDocumentId(source.sourceKey);
          const title = documentId ? sourceTitles.get(documentId) : undefined;
          return <li key={`${source.sourceKey}:${source.originRevision}`} className="flex flex-col gap-0.5">
            {documentId ? <a href={sourceDocumentHref(projectId, documentId, source.originRevision, here)} className={link}>{title ? `《${title}》` : `过程文档 ${index + 1}`}</a>
              : <span className="text-label font-medium text-foreground">已登记的引用 {index + 1}</span>}
            <span className="text-caption text-muted-foreground">{documentId ? "固定原件" : "没有可打开的原件"} · {label(sourceStateLabel, source.state)}{source.fragment ? ` · 片段：${source.fragment}` : ""}</span>
          </li>;
        })}</ul> : <p className={quiet}>这一版没有登记来源，正文待复核。</p>}
      </Block>
      <Block title={`挑战与反例${challenges.length ? ` · ${challenges.length}` : ""}`}>
        {historyNote}
        {challenges.length ? relationList(challenges, false)
          : <p className={quiet}>此版未登记挑战关系；不能据此断言没有反例。请结合正文与来源判断。</p>}
        {readingCurrent && !graph && <p className="mt-2 text-caption text-warning">关系图这次没有读回，指向此页的关系可能不全。</p>}
      </Block>
      <Block title="相关认识">
        {others.length ? relationList(others, true) : <p className={quiet}>此版未登记其他关系。</p>}
      </Block>
      <Block title="版本">
        <div className="flex flex-col gap-2.5">
          <Fact label="正在读"><span className="flex flex-wrap items-center gap-2">{standing.label}<StatusTag tone={validityTone[page.observedValidity] ?? "unknown"} label={label(validityLabel, page.observedValidity)} /></span></Fact>
          {!readingCurrent && current && <Fact label="当前版"><a href={knowledgeHref(projectId, { knowledgeId: page.knowledgeId })} className={link}>阅读当前版</a></Fact>}
          <Fact label="创建于">{new Date(page.createdAt).toLocaleString("zh-CN", { hour12: false })}</Fact>
        </div>
        <p className="mb-1 mt-3 text-caption text-muted-foreground">历史版本</p>
        {history ? <ul aria-label="历史版本" className="flex flex-col gap-0.5">{history.items.map((item, index) => {
          const on = item.revision === page.revision;
          return <li key={item.revision}>
            <a href={knowledgeHref(projectId, { knowledgeId: item.knowledgeId, revision: item.revision })} aria-current={on ? "page" : undefined} title={`版本 ${item.revision.slice(0, 8)}`}
              className={cn("flex items-baseline justify-between gap-2 rounded-md px-2 py-1 text-label outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]", on ? "bg-selected font-medium text-foreground" : "text-primary")}>
              <span className="min-w-0 truncate">{historyLabel(index, item.revision, current)}{on ? " · 正在读" : ""}</span>
              <span className="shrink-0 text-caption text-muted-foreground">{label(validityLabel, item.validity)}</span>
            </a></li>;
        })}</ul> : <p className={quiet}>历史版本这次没有读回。</p>}
        {history?.nextCursor && <p className="mt-1 text-caption text-muted-foreground">已载入 {history.items.length} 个版本 · 更早的版本未读</p>}
      </Block>
      <Block title="评价">
        <a href={`${href(projectId, "evaluations")}?knowledgePageId=${encodeURIComponent(page.knowledgeId)}`} className={link}>查看与此页相关的评价 →</a>
      </Block>
      {readingCurrent && graph && <Block title="关系图" defaultOpen={false}><KnowledgeGraph projectId={projectId} graph={graph} focusId={page.knowledgeId} /></Block>}
      <Block title="完整标识" defaultOpen={false}>
        <div className="flex flex-col gap-1 text-caption text-muted-foreground [overflow-wrap:anywhere]">
          <p>知识页 <code className="font-mono">{page.knowledgeId}</code></p>
          <p>所读版本 <code className="font-mono">{page.revision}</code></p>
          <p>当前版本 <code className="font-mono">{current ?? "没有读回"}</code></p>
          {page.previousRevision && <p>上一版本 <code className="font-mono">{page.previousRevision}</code></p>}
          <p>正文 SHA-256 <code className="font-mono">{page.contentHash}</code></p>
          {page.sources.map((source, index) => <p key={`id:${source.sourceKey}:${source.originRevision}`}>来源 {index + 1} <code className="font-mono">{source.sourceKey}</code> · 版本 <code className="font-mono">{source.originRevision}</code> · SHA-256 <code className="font-mono">{source.contentHash}</code></p>)}
          {relations.map(item => <p key={`id:${item.edge.edgeId}`}>{label(relationTypeLabel, item.edge.type)} {name(item)} <code className="font-mono">{item.otherId}</code> · 版本 <code className="font-mono">{item.otherRevision}</code>{item.edge.sourceKeys.length ? <> · 依据 <code className="font-mono">{item.edge.sourceKeys.join("、")}</code></> : null}</p>)}
          {graph && <p>关系索引位置 {graph.watermark}</p>}
        </div>
      </Block>
    </div>
  </div></ContextPanelContent>;
}
