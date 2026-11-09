// One knowledge page read in full (docs/frontend/pages/knowledge.md): title, the three separate labels, which version
// is on screen against the current one, then the whole body. Sources, challenges, relations and versions are in the
// right column; a named entry (来源与反例) opens it when it is collapsed or a drawer.
import { useEffect, useRef } from "react";
import { ArrowLeft, PanelRight } from "lucide-react";
import {
  Badge, Button, ErrorState, LoadingState, Notice, RefreshingIndicator, StatusTag, Tabs, TabsContent, TabsList, TabsTrigger, cn,
} from "@evoloop/ui";
import { errorDetail, errorText } from "../../shared/api";
import { useContextPanel } from "../../shared/ui/ContextPanel";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { readingProse, readingSource } from "../../shared/ui/readingProse";
import type { KnowledgeReading } from "./knowledgeRead";
import { knowledgeHref } from "./knowledgeRoute";
import {
  epistemicLabel, label, pageRelations, pageTypeLabel, readingStanding, sourceReview, validityLabel, validityTone,
} from "./knowledgePresentation";

export interface ReaderRead {
  data: KnowledgeReading | undefined; previous: boolean; error: unknown; checking: boolean; observedAt: number;
}

export function KnowledgeReader({ projectId, read, fixed, returnHref, pendingTitle, canWrite, onRevise, onReread }: {
  projectId: string; read: ReaderRead; fixed: boolean; returnHref: string | null; pendingTitle: string | null;
  canWrite: boolean; onRevise(page: KnowledgeReading["page"]): void; onReread(): void;
}) {
  const panel = useContextPanel();
  const heading = useRef<HTMLHeadingElement>(null);
  const reading = read.data;
  const shownKey = reading && !read.previous ? `${reading.page.knowledgeId}@${reading.page.revision}` : "";
  // A link in the right column may be replaced when the next page arrives; focus then goes to the new title
  // instead of being dropped on the page body.
  useEffect(() => {
    if (!shownKey) return;
    const active = document.activeElement;
    if (!active || active === document.body) heading.current?.focus({ preventScroll: true });
  }, [shownKey]);
  const back = <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    {returnHref && <a href={returnHref} className="inline-flex items-center gap-1 text-label font-medium text-primary hover:underline">
      <ArrowLeft size={15} aria-hidden="true" />返回来源</a>}
    <a href={knowledgeHref(projectId)} className={cn("text-label", returnHref ? "text-muted-foreground hover:text-foreground" : "inline-flex items-center gap-1 font-medium text-primary hover:underline")}>
      {!returnHref && <ArrowLeft size={15} aria-hidden="true" />}全部知识</a>
  </div>;
  if (!reading) return <div className="flex flex-col gap-4">
    {back}
    {read.error ? <ErrorState title="这一页没有读回" happened={`${errorText(read.error)}。`} next="可以重试，或回到列表重新打开。"
      diagnostics={errorDetail(read.error) ?? undefined} action={<Button size="compact" onClick={onReread}>重新读取</Button>} />
      : <LoadingState lines={6} label={pendingTitle ? `正在读取「${pendingTitle}」` : "正在读取知识页"} />}
  </div>;
  const { page, current } = reading;
  const standing = readingStanding(page.revision, fixed, current);
  const relations = pageRelations(page, reading.graph, standing.current);
  const challenges = relations.filter(item => item.edge.type === "contradicts").length;
  const review = sourceReview(page.sources);
  const failed = !!read.error && !read.previous;
  return <article aria-busy={read.previous || undefined} className="flex flex-col">
    <header className="flex flex-col gap-2 pb-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 compact:pr-12">
        {back}
        <div className="flex items-center gap-1 text-caption text-muted-foreground">
          {read.previous ? <RefreshingIndicator label={`正在读取${pendingTitle ? `「${pendingTitle}」` : "所选页面"}；下面仍是上一页`} />
            : read.checking ? <RefreshingIndicator label="正在核对这一页" /> : <span>{failed ? "上次读于" : "读于"} {new Date(read.observedAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>}
          <Button variant="ghost" size="compact" aria-label="重新读取这一页" onClick={onReread}>重新读取</Button>
          {panel && <Button variant="ghost" size="compact" aria-expanded={panel.open} onClick={() => panel.setOpen(!panel.open)}>
            <PanelRight aria-hidden="true" />来源与反例{challenges > 0 && <Badge className="ml-0.5">{challenges}</Badge>}</Button>}
        </div>
      </div>
      <h1 ref={heading} tabIndex={-1} className="text-title font-semibold leading-[1.3] outline-none [overflow-wrap:anywhere]">{page.title}</h1>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-text-secondary">
        <StatusTag tone={validityTone[page.observedValidity] ?? "unknown"} label={label(validityLabel, page.observedValidity)} />
        <span>{label(pageTypeLabel, page.pageType)}</span>
        <span aria-hidden="true">·</span>
        <span>{label(epistemicLabel, page.epistemicStatus)}</span>
        <span aria-hidden="true">·</span>
        <span>正在读 <strong className="font-medium text-foreground">{standing.label}</strong></span>
      </p>
      {standing.historical ? <Notice tone="waiting" title={standing.note}
        action={<Button asChild size="compact"><a href={knowledgeHref(projectId, { knowledgeId: page.knowledgeId })}>阅读当前版</a></Button>} />
        : standing.note && <p className="text-caption text-muted-foreground">{standing.note}</p>}
      {page.validity !== page.observedValidity && <Notice tone="waiting" title={`这一版发布时是“${label(validityLabel, page.validity)}”，目前标为“${label(validityLabel, page.observedValidity)}”`}>使用前请复核来源。</Notice>}
      {review && <Notice tone="waiting" title={review}>来源核对见右栏“来源”。</Notice>}
      {challenges > 0 && <p className="text-label text-text-secondary">此版登记了 {challenges} 条挑战或反例{panel && <>，<button type="button" className="text-primary underline underline-offset-2" onClick={() => panel.setOpen(true)}>在右栏查看</button></>}。</p>}
      {failed && <Notice tone="error" title="这一页这次没有读回">{errorText(read.error)}。下面是上次读回的内容，当前待核对。</Notice>}
    </header>
    <section aria-label="知识页完整正文" className={cn("transition-opacity duration-150", read.previous && "opacity-60")}>
      <Tabs defaultValue="rendered">
        <TabsList aria-label="阅读方式" className="mb-4"><TabsTrigger value="rendered">排版</TabsTrigger><TabsTrigger value="source">原文</TabsTrigger></TabsList>
        <TabsContent value="rendered" className={readingProse}>
          <MarkdownBody source={page.body} identity={`knowledge-${page.knowledgeId}-${page.revision}`} omitLeadingTitle={page.title} projectId={projectId} />
        </TabsContent>
        <TabsContent value="source"><pre className={readingSource}>{page.body}</pre></TabsContent>
      </Tabs>
    </section>
    {canWrite && !read.previous && <section aria-label="修订这一页" className="mt-10 flex flex-col items-start gap-2 border-t border-border pt-5">
      <h2 className="text-small font-semibold text-foreground">发现问题？</h2>
      {standing.current ? <>
        <p className="text-label text-text-secondary">以正在读的当前版为基线提出修订候选；保存后仍要审阅、发布，当前版才会改变。</p>
        <Button size="compact" onClick={() => onRevise(page)}>基于此页提出修订候选</Button>
      </> : <p className="text-label text-text-secondary">正在读的不是当前版。请先阅读当前版，再基于当前版提出修订；历史正文不会自动当作当前基线。</p>}
    </section>}
  </article>;
}
