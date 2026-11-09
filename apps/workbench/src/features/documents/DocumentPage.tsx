// One document read in full (docs/frontend/pages/documents.md): the center holds the text of the revision the
// address names; the inner rail keeps the document list; the right column holds version, source, the tasks that
// reference it and the outline. A fixed historical link stays on its revision and offers the current one. Markdown
// saved only as its original (an uploaded file, an import) is read from that original.
import React, { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PanelRight } from "lucide-react";
import type { DocumentDetail, DocumentRevision } from "@evoloop/contracts";
import {
  Button, ErrorState, LoadingState, Notice, RefreshingIndicator, StatusTag, Tabs, TabsContent, TabsList, TabsTrigger, UnknownState, cn,
} from "@evoloop/ui";
import { api } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { fixedContent, queryKeys, useProjectQuery } from "../../shared/query";
import { href } from "../../shared/routes";
import { useContextPanel } from "../../shared/ui/ContextPanel";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { readingProse, readingSource } from "../../shared/ui/readingProse";
import { useRereadOnReturn } from "../../shared/ui/rereadOnReturn";
import { date, documentReturnHref } from "../../shared/ui/shared";
import { DocumentFacts } from "./DocumentFacts";
import { DocumentRail } from "./DocumentRail";
import { DocumentRevise, canRevise } from "./DocumentRevise";
import { Foot, HtmlReport } from "./HtmlReport";
import { kindText, lifecycleLabel, lifecycleTone, markdownSource, readingStanding, returnSourceLabel } from "./documentPresentation";
import { readProblem } from "./useDocumentList";
import { useOriginal } from "./useOriginal";

function useDocument(projectId: string, id: string, selectedRevision?: string) {
  const detail = useProjectQuery(projectId, ["document", id, "detail"], async () => {
    const value = await api().document(projectId, id);
    if (value.document.projectId !== projectId || value.document.id !== id || value.current.projectId !== projectId || value.current.documentId !== id
      || value.adopted && (value.adopted.projectId !== projectId || value.adopted.documentId !== id)) throw new Error("文档响应与当前项目不符");
    return value;
  });
  // A fixed revision never changes; it is read once and kept outside the rereads that follow the current version and writes.
  const fixed = useProjectQuery(projectId, [fixedContent, id, selectedRevision ?? "", "revision"], async () => {
    const value = await api().documentRevision(projectId, id, selectedRevision!);
    if (value.projectId !== projectId || value.documentId !== id || value.id !== selectedRevision) throw new Error("文档响应与所选的固定修订不符");
    return value;
  }, { enabled: !!selectedRevision });
  const revision: DocumentRevision | undefined = selectedRevision ? fixed.data : detail.data?.current;
  return { detail, fixed, revision };
}

export function DocumentPage({ context, projectId, id, selectedRevision }: {
  context: MutationContext; projectId: string; id: string; selectedRevision?: string;
}) {
  const client = useQueryClient();
  const body = useRef<HTMLElement | null>(null);
  const { detail, fixed, revision } = useDocument(projectId, id, selectedRevision);
  const reread = () => {
    void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "document", id) });
    if (fixed.isError) void fixed.refetch();
  };
  const active = useRereadOnReturn(reread);
  const scope = `${context.principal.actorId}:${projectId}`;
  // Read from the address while this page is on screen: the same page can be opened from several sources.
  const returnTo = active ? documentReturnHref(projectId) : href(projectId, "documents");
  const back = <div className="document-reading-backlinks flex flex-wrap items-center gap-x-3 gap-y-1">
    <a href={returnTo} className="inline-flex items-center gap-1 text-label font-medium text-primary hover:underline">
      <ArrowLeft size={15} aria-hidden="true" />返回来源<span className="font-normal text-muted-foreground"> · {returnSourceLabel(returnTo)}</span></a>
    {returnTo.split("?")[0] !== href(projectId, "documents") && <a href={href(projectId, "documents")} className="text-caption text-muted-foreground hover:text-foreground">全部文档</a>}
  </div>;
  const rail = <DocumentRail projectId={projectId} scope={scope} selectedId={id} />;
  const failure = detail.error ?? fixed.error;
  if (!detail.data || !revision) return <div data-ui="" className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-4 py-6 compact:px-8">
    {rail}{back}
    {failure ? <ErrorState title="文档没有读回" happened={`${readProblem(failure, "该文档")}。`} next="可以重试，或回到来源核对链接。"
      action={<Button size="compact" onClick={reread}>重新读取</Button>} />
      : <LoadingState lines={6} label="正在读取文档" />}
  </div>;
  return <Reader context={context} projectId={projectId} detail={detail.data} revision={revision} body={body} rail={rail} back={back}
    checking={detail.isFetching} failure={detail.error ? readProblem(detail.error, "该文档") : ""} observedAt={detail.dataUpdatedAt} reread={reread} />;
}

function Reader({ context, projectId, detail, revision, body, rail, back, checking, failure, observedAt, reread }: {
  context: MutationContext; projectId: string; detail: DocumentDetail; revision: DocumentRevision; body: React.RefObject<HTMLElement | null>;
  rail: React.ReactNode; back: React.ReactNode; checking: boolean; failure: string; observedAt: number; reread(): void;
}) {
  const panel = useContextPanel();
  const { document } = detail;
  const standing = readingStanding(revision.id, detail);
  const html = revision.format === "html";
  const revise = canRevise(detail) && <DocumentRevise context={context} detail={detail} checking={checking} failed={!!failure} />;
  const review = revision.organizationReview;
  const zone = review?.timeZone;
  return <div data-ui="" className={cn("flex w-full flex-col",
    html ? "h-[calc(100dvh-48px)] px-3 pb-2 pt-2.5 compact:h-[calc(100dvh-16px)] compact:px-6 compact:pt-3" : "mx-auto max-w-[920px] px-4 py-5 compact:px-10 compact:py-7")}>
    {rail}
    <DocumentFacts projectId={projectId} detail={detail} revision={revision} body={body} />
    <header className={cn("flex flex-none flex-col", html ? "gap-1 pb-2" : "gap-2 pb-5")}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 compact:pr-12">
        {back}
        <div className="flex items-center gap-1 text-caption text-muted-foreground">
          {checking ? <RefreshingIndicator label="正在核对当前文档" /> : <span>读于 {new Date(observedAt).toLocaleTimeString("zh-CN")}</span>}
          <Button variant="ghost" size="compact" aria-label="重新读取当前文档" onClick={reread}>重新读取</Button>
          {panel && <Button variant="ghost" size="compact" aria-expanded={panel.open} onClick={() => panel.setOpen(!panel.open)}>
            <PanelRight aria-hidden="true" />版本与来源</Button>}
        </div>
      </div>
      <h1 tabIndex={-1} className={cn("font-semibold leading-(--leading-tight) outline-none [overflow-wrap:anywhere]", html ? "text-heading" : "text-title")}>{document.title}</h1>
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-label text-text-secondary">
        <StatusTag tone={lifecycleTone[document.status]} label={lifecycleLabel[document.status]} />
        <span>{kindText(document.kind)}</span>
        <span aria-hidden="true">·</span>
        <span>正在读 <strong className="font-medium text-foreground">{standing.label}</strong></span>
        <time dateTime={revision.createdAt} className="text-muted-foreground">{date(revision.createdAt)}</time>
        {document.primaryTaskId && <a href={href(projectId, "task", document.primaryTaskId)} className="text-primary hover:underline">所属任务 →</a>}
      </p>
      {review && <p className="text-caption text-muted-foreground">观察期间：{new Date(review.observedFrom).toLocaleString("zh-CN", { timeZone: zone })} 至 {new Date(review.observedTo).toLocaleString("zh-CN", { timeZone: zone })} · {zone}
        {review.previous && <> · <a href={href(projectId, "document", review.previous.documentId, review.previous.revisionId)} className="text-primary hover:underline">上一轮复盘</a></>}</p>}
      {standing.historical ? <Notice tone="waiting" className={html ? "py-2" : undefined} title={standing.note}
        action={<Button asChild size="compact"><a href={href(projectId, "document", document.id, detail.current.id)}>查看当前版</a></Button>} />
        : standing.note && <p className="text-caption text-muted-foreground">{standing.note}</p>}
      {document.kind === "task" && <Notice>这是任务的主文档，这里只读固定修订。要修改正文，请到{document.primaryTaskId
        ? <a href={href(projectId, "task", document.primaryTaskId)} className="text-primary hover:underline">所属任务</a> : "所属任务"}。</Notice>}
      {failure && <Notice tone="error" title="当前文档这次没有读回">{failure}。页面保留上次读到的内容，不能当作当前状态；草稿仍留在本页。</Notice>}
    </header>
    {html ? <section aria-label="文档完整正文" className="flex min-h-0 flex-1 flex-col">
      <HtmlReport projectId={projectId} documentId={document.id} revisionId={revision.id}
        foot={revise && <Foot summary="修订与发布">{revise}</Foot>} />
    </section>
      : <>
        <section aria-label="文档完整正文" ref={body}>
          <MarkdownText projectId={projectId} revision={revision} title={document.title} />
        </section>
        {revise && <details data-legacy="" className="workflow-detail mt-10"><summary>修订与发布</summary>{revise}</details>}
      </>}
  </div>;
}

/**
 * The Markdown text of the revision on screen: saved with the revision, or read from its original when the revision
 * keeps only the original (an uploaded .md file, an import). Reading, a failed read and an unusable original are each
 * said as they are; a summary never stands in for the text.
 */
function MarkdownText({ projectId, revision, title }: { projectId: string; revision: DocumentRevision; title: string }) {
  const original = useOriginal(projectId, revision.documentId, revision.id, revision.body === null);
  const source = markdownSource(revision.body, original);
  const retry = () => void original.refetch();
  if (source.state === "reading") return <LoadingState lines={6} label="正在读取原件" />;
  if (source.state === "failed") return <ErrorState title="原件没有读回" happened={`${readProblem(source.error, "这份原件")}。`}
    next="可以重试；正文要从固定原件读出，不用摘要代替。" action={<Button size="compact" onClick={retry}>重试读取</Button>} />;
  if (source.state === "unavailable") return <UnknownState title="原件暂时不能完整读取" lastKnown="这一版已登记原件"
    reason={`原件不可用或没有通过校验（${source.reason}）`} howToCheck="检查存储与登记状态后重新核对。"
    action={<Button size="compact" onClick={retry}>重新核对</Button>} />;
  return <Tabs defaultValue="rendered">
    <TabsList aria-label="阅读方式" className="mb-4"><TabsTrigger value="rendered">排版</TabsTrigger><TabsTrigger value="source">原文</TabsTrigger></TabsList>
    <TabsContent value="rendered" className={readingProse}>
      <MarkdownBody source={source.text} identity={revision.id} omitLeadingTitle={title} projectId={projectId} />
    </TabsContent>
    <TabsContent value="source">
      <pre className={readingSource}>{source.text}</pre>
    </TabsContent>
  </Tabs>;
}
