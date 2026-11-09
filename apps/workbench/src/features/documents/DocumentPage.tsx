// One document read in full (docs/frontend/pages/documents.md): the center holds the text of the revision the
// address names; the inner rail keeps the document list; the right column holds version, source, the tasks that
// reference it and the outline. A fixed historical link stays on its revision and offers the current one.
import React, { useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PanelRight } from "lucide-react";
import type { DocumentDetail, DocumentRevision } from "@evoloop/contracts";
import {
  Button, ErrorState, LoadingState, Notice, RefreshingIndicator, StatusTag, Tabs, TabsContent, TabsList, TabsTrigger, cn,
} from "@evoloop/ui";
import { api } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { href } from "../../shared/routes";
import { useContextPanel } from "../../shared/ui/ContextPanel";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { date, documentReturnHref } from "../../shared/ui/shared";
import { DocumentFacts } from "./DocumentFacts";
import { DocumentRail } from "./DocumentRail";
import { DocumentRevise, canRevise } from "./DocumentRevise";
import { Foot, HtmlReport } from "./HtmlReport";
import { kindText, lifecycleLabel, lifecycleTone, readingStanding, returnSourceLabel } from "./documentPresentation";
import { readProblem } from "./useDocumentList";
import { useRereadOnReturn } from "./useRereadOnReturn";

/** Markdown typography on design tokens. MarkdownBody keeps its own rendering and link rules. */
const prose = cn("text-body leading-[1.8] text-foreground",
  "[&_:is(p,li,td,th,h1,h2,h3,h4,dt,dd)]:text-foreground",
  "[&_h1]:mb-3 [&_h1]:mt-9 [&_h1]:text-heading [&_h1]:font-semibold [&_h1]:leading-[1.35]",
  "[&_h2]:mb-3 [&_h2]:mt-9 [&_h2]:text-heading [&_h2]:font-semibold [&_h2]:leading-[1.35]",
  "[&_h3]:mb-2 [&_h3]:mt-7 [&_h3]:text-body [&_h3]:font-semibold",
  "[&_h4]:mb-2 [&_h4]:mt-6 [&_h4]:font-semibold",
  "[&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_li]:my-1",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.88em]",
  "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-small [&_pre]:leading-[1.6] [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-4 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5");

function useDocument(projectId: string, id: string, selectedRevision?: string) {
  const detail = useProjectQuery(projectId, ["document", id, "detail"], async () => {
    const value = await api().document(projectId, id);
    if (value.document.projectId !== projectId || value.document.id !== id || value.current.projectId !== projectId || value.current.documentId !== id
      || value.adopted && (value.adopted.projectId !== projectId || value.adopted.documentId !== id)) throw new Error("文档响应与当前项目不符");
    return value;
  });
  // A fixed revision never changes; it is read once and kept outside the rereads that follow the current version.
  const fixed = useProjectQuery(projectId, ["fixed-revision", id, selectedRevision ?? "", "revision"], async () => {
    const value = await api().documentRevision(projectId, id, selectedRevision!);
    if (value.projectId !== projectId || value.documentId !== id || value.id !== selectedRevision) throw new Error("文档响应与所选的固定修订不符");
    return value;
  }, { enabled: !!selectedRevision });
  const revision: DocumentRevision | undefined = selectedRevision ? fixed.data : detail.data?.current;
  return { detail, fixed, revision };
}

export function DocumentPage({ context, refresh, projectId, id, selectedRevision }: {
  context: MutationContext; refresh: number; projectId: string; id: string; selectedRevision?: string;
}) {
  const client = useQueryClient();
  const body = useRef<HTMLElement | null>(null);
  const { detail, fixed, revision } = useDocument(projectId, id, selectedRevision);
  const reread = () => {
    void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "document", id) });
    if (fixed.isError) void fixed.refetch();
  };
  const active = useRereadOnReturn(reread, refresh);
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
    {failure ? <ErrorState title="文档没有读回" happened={readProblem(failure, "该文档")} next="可以重试，或回到来源核对链接。"
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
      <h1 tabIndex={-1} className={cn("font-semibold leading-[1.3] outline-none [overflow-wrap:anywhere]", html ? "text-heading" : "text-title")}>{document.title}</h1>
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
          {revision.body === null ? <ErrorState title="这一版没有可读的正文" happened="Markdown 正文没有随这一版保存。" next="可以回到来源核对，或阅读其他版本。" />
            : <Tabs defaultValue="rendered">
              <TabsList aria-label="阅读方式" className="mb-4"><TabsTrigger value="rendered">排版</TabsTrigger><TabsTrigger value="source">原文</TabsTrigger></TabsList>
              <TabsContent value="rendered" className={prose}>
                <MarkdownBody source={revision.body} identity={revision.id} omitLeadingTitle={document.title} projectId={projectId} />
              </TabsContent>
              <TabsContent value="source">
                <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-4 font-mono text-small leading-[1.7] [overflow-wrap:anywhere]">{revision.body}</pre>
              </TabsContent>
            </Tabs>}
        </section>
        {revise && <details data-legacy="" className="workflow-detail mt-10"><summary>修订与发布</summary>{revise}</details>}
      </>}
  </div>;
}
