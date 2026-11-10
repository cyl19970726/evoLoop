// The right column for an open document (docs/frontend/layout.md 右栏): 版本 → 全部版本 → 来源 → 引用它的任务 → 页内目录,
// each a block that folds on its own. Raw IDs and hashes live here, in the source layer, never in the text.
import React, { type RefObject } from "react";
import { ChevronRight } from "lucide-react";
import type { DocumentDetail, DocumentRevision, DocumentTaskReference } from "@evoloop/contracts";
import { ListRow, Notice, RefreshingIndicator, StatusTag } from "@evoloop/ui";
import { api } from "../../shared/api";
import { revisionLine, revisionNumberText, revisionStateText } from "../../shared/documentRevisions";
import type { DocumentRevisionList } from "../../shared/useDocumentRevisions";
import { RevisionListStatus } from "../../shared/ui/RevisionListStatus";
import { useProjectQuery } from "../../shared/query";
import { useRevisionOrigin } from "../../shared/useRevisionOrigin";
import { href } from "../../shared/routes";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { date } from "../../shared/ui/shared";
import { DocumentOrigin } from "./DocumentOrigin";
import { documentOrigin, taskLinkFrom } from "./taskLinks";
import { DocumentOutline } from "./DocumentOutline";
import { OwnerName } from "./OwnerName";
import { TaskPeek } from "./TaskPeek";
import {
  lifecycleLabel, lifecycleTone, publicationText, readingStanding, referenceText, relationLabel, taskStateLabel, taskStateTone,
} from "./documentPresentation";
import { readProblem } from "./useDocumentList";

const pageLimit = 20, itemLimit = 1000;

function Block({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return <details open={defaultOpen} className="group border-b border-border py-3 first:pt-0 last:border-b-0">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-label font-semibold text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight size={14} aria-hidden="true" className="text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />{title}
    </summary>
    <div className="mt-2.5 pl-5">{children}</div>
  </details>;
}

/** A labelled fact. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-0.5"><span className="text-caption text-muted-foreground">{label}</span><div className="text-label text-foreground">{children}</div></div>;
}

/** Every task that references the document, read page by page up to a limit that is said when reached. */
function useReferencingTasks(projectId: string, documentId: string) {
  return useProjectQuery(projectId, ["document", documentId, "tasks"], async signal => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    const tasks = new Map<string, DocumentTaskReference>();
    let pages = 0;
    do {
      const page = await api().documentTasks(projectId, documentId, cursor, signal);
      if (page.items.length > 50 || page.items.some(item => item.projectId !== projectId)) throw new Error("关联任务分页响应无效");
      for (const task of page.items) tasks.set(task.id, task);
      pages++;
      if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new Error("分页游标重复，关联任务读取未完成");
      if (page.nextCursor) seen.add(page.nextCursor);
      cursor = page.nextCursor ?? undefined;
      if (cursor && (pages >= pageLimit || tasks.size >= itemLimit)) return { tasks: [...tasks.values()], partial: true };
    } while (cursor);
    return { tasks: [...tasks.values()], partial: false };
  });
}

/**
 * Every revision of the document, newest first, each opening the read-only page of that version (第 N 版, how it stands
 * by the newest head read, when, by whom and why); more pages on request.
 */
function AllVersions({ projectId, documentId, reading, revisions }: { projectId: string; documentId: string; reading: string; revisions: DocumentRevisionList }) {
  const { model } = revisions;
  return <div className="flex flex-col gap-2">
    {model && model.items.length > 0 && <ul aria-label="全部版本" className="flex flex-col gap-0.5">{model.items.map(item => <li key={item.id}>
      <ListRow href={href(projectId, "document", documentId, item.id)} selected={item.id === reading}
        title={`第 ${item.revisionNumber} 版 · ${revisionStateText(item, model.head.status)}`}
        meta={revisionLine(item, date)} trailing={item.id === reading ? "正在读" : undefined} className="px-2" />
    </li>)}</ul>}
    <RevisionListStatus list={revisions} noun="版本" />
  </div>;
}

export function DocumentFacts({ projectId, detail, revision, body, actorId, revisions }: {
  projectId: string; detail: DocumentDetail; revision: DocumentRevision; body: RefObject<HTMLElement | null>;
  /** The reader, so a task opened from here comes back to this document. */
  actorId?: string;
  /** The document's revision list (read by the page, which says 第 N 版 / 共 M 版 too). */
  revisions: DocumentRevisionList;
}) {
  const { document } = detail;
  const panel = useContextPanel();
  const standing = readingStanding(revision.id, detail);
  const tasks = useReferencingTasks(projectId, document.id);
  const from = actorId ? documentOrigin(projectId, document, actorId) : null;
  const origin = useRevisionOrigin(projectId, { actorId: revision.author, reason: revision.reason });
  const openTask = (event: React.MouseEvent, reference: DocumentTaskReference) => {
    if (!panel || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    panel.openInPanel({ id: `task:${reference.id}`, title: reference.title, href: taskLinkFrom(projectId, reference.id, from),
      render: () => <TaskPeek projectId={projectId} reference={reference} documentTitle={document.title} from={from} /> });
  };
  const revisionLink = (target: DocumentRevision, label: string) => target.id === revision.id
    ? <span>{label} · 正在读</span>
    : <a href={href(projectId, "document", document.id, target.id)} className="text-primary hover:underline">{label}</a>;
  return <ContextPanelContent><div data-ui="" aria-label="文档版本、来源与关联" role="region">
    <Block title="版本">
      <div className="flex flex-col gap-2.5">
        <Fact label="正在读">{standing.label}<span className="block text-caption text-muted-foreground">
          {[revisionNumberText(revision.revisionNumber, revisions.model?.count), date(revision.createdAt), origin.author].filter(Boolean).join(" · ")}</span></Fact>
        <Fact label="当前版">{revisionLink(detail.current, date(detail.current.createdAt))}</Fact>
        <Fact label="已发布版">{detail.adopted ? revisionLink(detail.adopted, date(detail.adopted.createdAt)) : "尚未发布"}</Fact>
        {revision.previousRevisionId && <Fact label="上一版"><a href={href(projectId, "document", document.id, revision.previousRevisionId)} className="text-primary hover:underline">阅读上一版</a></Fact>}
        <Fact label="状态"><span className="flex flex-wrap items-center gap-2"><StatusTag tone={lifecycleTone[document.status]} label={lifecycleLabel[document.status]} />
          <span className="text-caption text-muted-foreground">{publicationText(document)}</span></span></Fact>
        <Fact label="这一版的修订理由"><span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{revision.reason ? origin.reason : "未写明"}</span></Fact>
      </div>
      <details className="mt-3 text-caption text-muted-foreground">
        <summary className="cursor-pointer">完整标识与哈希</summary>
        <p className="mt-1 [overflow-wrap:anywhere]">文档 <code className="font-mono">{document.id}</code></p>
        <p className="[overflow-wrap:anywhere]">所读修订 <code className="font-mono">{revision.id}</code></p>
        <p className="[overflow-wrap:anywhere]">内容 SHA-256 <code className="font-mono">{revision.contentHash}</code></p>
        <p>原件格式 {revision.format === "html" ? "HTML" : "Markdown"} · {revision.originalName}</p>
        {origin.identifiers.map(row => <p key={row.label} className="[overflow-wrap:anywhere]">{row.label} {row.text ? row.value : <code className="font-mono">{row.value}</code>}</p>)}
      </details>
    </Block>
    <Block title={revisions.model ? `全部版本 · ${revisions.model.count}` : "全部版本"} defaultOpen={false}>
      <AllVersions projectId={projectId} documentId={document.id} reading={revision.id} revisions={revisions} />
    </Block>
    <Block title="来源">
      {document.origin ? <DocumentOrigin projectId={projectId} documentId={document.id} origin={document.origin} from={from} />
        : <p className="text-label text-text-secondary">创建时没有登记来源任务。</p>}
      {document.primaryTaskId && <a href={taskLinkFrom(projectId, document.primaryTaskId, from)} className="mt-2 block text-label text-primary hover:underline">所属任务 →</a>}
    </Block>
    <Block title="引用它的任务">
      {tasks.isFetching && tasks.data && <RefreshingIndicator label="正在核对引用它的任务；下面是上次读到的" className="mb-2" />}
      {tasks.isPending && <p role="status" className="text-label text-muted-foreground">正在读取引用它的任务…</p>}
      {tasks.isError && <Notice tone="error" className="mb-2">引用它的任务这次没有读完整：{readProblem(tasks.error, "引用它的任务")}。{tasks.data ? "下面是上次读到的，不能当作当前完整结果。" : ""}</Notice>}
      {tasks.data?.partial && <Notice tone="waiting" className="mb-2">已读到 {pageLimit} 页或 {itemLimit} 项的上限，下面的任务未必完整。</Notice>}
      {tasks.data && (tasks.data.tasks.length ? <ul className="flex flex-col gap-0.5">{tasks.data.tasks.map(task => <li key={task.id}>
        <a href={taskLinkFrom(projectId, task.id, from)} onClick={event => openTask(event, task)}
          className="flex flex-col gap-1 rounded-md px-2 py-1.5 outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]">
          <span className="text-label font-medium text-foreground [overflow-wrap:anywhere]">{task.title}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">
            <StatusTag tone={taskStateTone[task.state]} label={taskStateLabel[task.state]} />
            {task.relations.map(relation => relationLabel[relation]).join(" · ") || referenceText(task.relations)} · 责任者 <OwnerName projectId={projectId} owner={task.owner} /></span>
        </a></li>)}</ul>
        : !tasks.isError && !tasks.data.partial && <p className="text-label text-text-secondary">目前没有任务引用这份文档。</p>)}
    </Block>
    {revision.format === "markdown" && <Block title="页内目录"><DocumentOutline body={body} revision={revision.id} /></Block>}
  </div></ContextPanelContent>;
}
