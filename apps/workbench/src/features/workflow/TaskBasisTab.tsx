// 依据与影响 (tasks.md 固定依据与新版): the document revisions the task fixed when it started, whether each document
// has published a newer one since, and every pending change handled on its own — read both versions, then adopt
// the new one or keep the fixed one, with a reason. Nothing here follows a document's newer version by itself.
import React from "react";
import type { BasisSet, DocumentRevision, Impact, TaskDetail } from "@evoloop/contracts";
import { Badge, LoadingState, Notice, StatusTag } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { OriginalDocumentReader } from "../../shared/ui/OriginalDocumentReader";
import { readingSource } from "../../shared/ui/readingProse";
import { date } from "../../shared/ui/shared";
import { useRevisionOrigin } from "../../shared/useRevisionOrigin";
import { CommandForm } from "../../shared/command";
import { DocumentLink } from "./DocumentLink";
import { impactSeen, reviewBasisCommand } from "./taskCommands";
import { useFixedRevision, type DocumentRead } from "./taskDocuments";
import { ActionRow, Fine, TabSection, reasonField } from "./TaskForms";

/** Where one fixed revision stands against the document's published version, as far as the read can tell. */
export function basisStanding(revisionId: string, read: DocumentRead | undefined): { tone: "done" | "waiting" | "unknown" | "idle"; label: string; note: string } {
  const document = read?.data?.document;
  if (!document) return read?.error
    ? { tone: "unknown", label: "无法判断", note: `文档现状暂不可读：${errorText(read.error)}；无法判断是否已有新版。` }
    : { tone: "unknown", label: "正在读取", note: "正在读取文档现状…" };
  if (document.adoptedRevisionId === revisionId) return { tone: "done", label: "现发布此版", note: "文档现在发布的就是这一版。" };
  if (document.adoptedRevisionId) return { tone: "waiting", label: "已有新版", note: "文档已发布新版；本任务仍固定这一版，新版要复核后才会采用。" };
  return { tone: "idle", label: "无发布版", note: "文档当前没有发布版；本任务仍固定这一版。" };
}

/** The fixed basis of one task revision. `reads` (the documents' current state) is left out for history. */
export function BasisList({ projectId, basis, content, reads }: {
  projectId: string; basis: BasisSet | null; content?: { documentId: string; revisionId: string };
  reads?: Record<string, DocumentRead>;
}) {
  const rows = [
    ...(content ? [{ key: "content", documentId: content.documentId, revisionId: content.revisionId, group: "主正文" }] : []),
    ...(basis?.members ?? []).filter(member => !content || member.documentId !== content.documentId || member.revisionId !== content.revisionId)
      .map(member => ({ key: `${member.documentId}:${member.revisionId}`, documentId: member.documentId, revisionId: member.revisionId, group: "固定依据" })),
  ];
  if (!basis && !rows.length) return <p className="text-label text-text-secondary">这个任务修订没有固定依据集合。</p>;
  return <ul className="flex flex-col" aria-label="固定依据">
    {rows.map(row => {
      const read = reads?.[row.documentId];
      const title = read?.data?.document?.title ?? (read?.error ? "文档名称暂不可读" : reads ? "正在读取文档名称…" : row.group === "主正文" ? "主正文" : "过程文档");
      const standing = reads ? basisStanding(row.revisionId, read) : null;
      const retention = basis?.retentions?.find(item => item.documentId === row.documentId && item.revisionId === row.revisionId);
      return <li key={row.key} className="flex flex-col gap-1 border-t border-border py-3 first:border-t-0 first:pt-0" data-basis-document={row.documentId}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge>{row.group}</Badge>
          <DocumentLink projectId={projectId} documentId={row.documentId} revisionId={row.revisionId} title={title}
            relation={`${row.group} · 任务固定的修订`} className="text-small font-medium">{title}</DocumentLink>
          {standing && <StatusTag tone={standing.tone} label={standing.label} />}
        </div>
        {standing && <Fine>{standing.note}</Fine>}
        {retention && <details className="text-caption text-text-secondary">
          <summary className="w-fit cursor-pointer text-primary hover:underline">开始时明确保留旧版的记录</summary>
          <p className="mt-1 whitespace-pre-wrap text-label text-foreground">{retention.reason}</p>
          <Fine>{retention.actorId} · {date(retention.createdAt)}；这个决定只覆盖当时核对的发布版，来源再改版仍要复核。</Fine>
        </details>}
        <FullIdentifiers rows={[{ label: "文档", value: row.documentId }, { label: "固定修订", value: row.revisionId },
          { label: "当时核对的发布版", value: retention?.observedAdoptedRevisionId }, { label: "文档现发布版", value: read?.data?.document?.adoptedRevisionId }]} />
      </li>;
    })}
  </ul>;
}

export function TaskBasisTab({ context, detail, reads, canReview }: {
  context: MutationContext; detail: TaskDetail; reads: Record<string, DocumentRead>; canReview: boolean;
}) {
  const projectId = context.projectId;
  const pending = detail.impacts.filter(impact => impact.state === "pending");
  const handled = detail.impacts.filter(impact => impact.state !== "pending");
  return <div className="flex flex-col gap-8">
    <TabSection title="任务固定的依据" meta={`第 ${detail.task.version} 版 · 开始时固定`}>
      <Fine>点文档在右栏打开任务固定的那一版。文档以后发布新版，不会自动改写这项任务的依据。</Fine>
      <BasisList projectId={projectId} basis={detail.basis} content={{ documentId: detail.task.contentDocumentId, revisionId: detail.task.contentRevisionId }} reads={reads} />
    </TabSection>
    <TabSection title="待复核的依据变化" meta={`${pending.length} 项`}>
      {pending.length === 0 ? <p className="text-label text-text-secondary">当前没有待复核的依据变化。</p>
        : <>
          <Fine>每项变化单独处理：先读任务固定的旧版和文档的新版，再决定采用新版或保留旧版。{canReview ? "" : "当前身份没有复核权限，可以阅读两版。"}</Fine>
          <div className="flex flex-col" data-impact-list="">
            {pending.map((impact, index) => <ImpactItem key={impact.id} context={context} detail={detail} impact={impact}
              title={reads[impact.documentId]?.data?.document?.title ?? (reads[impact.documentId]?.error ? "文档名称暂不可读" : "正在读取文档名称…")}
              canReview={canReview} defaultOpen={index === 0} />)}
          </div>
        </>}
    </TabSection>
    {handled.length > 0 && <TabSection title="已处理的依据变化" meta={`${handled.length} 项`}>
      <ul className="flex flex-col gap-2">{handled.map(impact => {
        const decision = detail.decisions.find(item => item.impactId === impact.id);
        const title = reads[impact.documentId]?.data?.document?.title ?? "过程文档";
        return <li key={impact.id} className="flex flex-col gap-0.5">
          <p className="text-label text-foreground">{title} · {impact.state === "superseded" ? "已被更新的变化取代" : decision ? decision.decision === "adopt" ? "采用了新版" : "保留了旧版" : "已处理"}</p>
          {decision && <Fine>{decision.actorId} · {date(decision.createdAt)} · {decision.reason}</Fine>}
        </li>;
      })}</ul>
    </TabSection>}
  </div>;
}

function ImpactItem({ context, detail, impact, title, canReview, defaultOpen }: {
  context: MutationContext; detail: TaskDetail; impact: Impact; title: string; canReview: boolean; defaultOpen: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  // Once opened, the content (and any draft in it) stays until the page goes away.
  const [opened, setOpened] = React.useState(defaultOpen);
  const projectId = context.projectId;
  const before = useFixedRevision(projectId, impact.documentId, impact.fromRevisionId, opened);
  const after = useFixedRevision(projectId, impact.documentId, impact.toRevisionId, opened);
  return <details open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setOpened(true); }} className="group border-t border-border first:border-t-0" data-impact={impact.id}>
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-3 outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <span className="text-small font-medium text-foreground">{title}</span>
      <StatusTag tone="waiting" label="待复核" />
      <span className="text-caption text-muted-foreground">新版发布于 {date(impact.createdAt)} · {open ? "收起" : "核对两版并决定"}</span>
    </summary>
    {opened && <div className="flex flex-col gap-4 pb-5">
      <div data-impact-compare="" className="grid grid-cols-2 gap-4 max-compact:grid-cols-1">
        <RevisionColumn label="任务固定的旧版" read={before} />
        <RevisionColumn label="文档的新版" read={after} />
      </div>
      <FullIdentifiers rows={[{ label: "文档", value: impact.documentId }, { label: "任务固定修订", value: impact.fromRevisionId },
        { label: "文档新修订", value: impact.toRevisionId }, { label: "变化记录", value: impact.id }]} />
      {!canReview ? <Fine>当前身份没有复核权限，不能决定采用或保留。</Fine>
        : !before.data || !after.data ? <Fine>读到两版后才能决定。</Fine>
          : <div className="flex flex-col"><ActionRow title="决定采用新版或保留旧版" description="读完两版再决定；提交时按打开这里时的任务版本核对。"><CommandForm context={context} label={`复核《${title}》的变化`} submitLabel="提交复核决定" baseline={impactSeen(detail.task, impact)}
            fields={[
              { name: "decision", label: "这次变化怎样影响任务", kind: "radio", initial: "adopt",
                options: [{ value: "adopt", label: "采用新版" }, { value: "retain", label: "保留任务固定的旧版" }] },
              reasonField("理由", "说明判断依据和对任务的影响。"),
              { name: "acceptance", label: "新的验收条件", kind: "textarea", optional: true, rows: 3, maxLength: 4000,
                hint: "只在采用新版时使用；留空沿用当前验收条件。" },
            ]}
            build={(values, seen) => reviewBasisCommand(detail.task.id, seen, {
              decision: values.decision === "retain" ? "retain" : "adopt", reason: values.reason ?? "", acceptance: values.acceptance ?? "" })} /></ActionRow></div>}
    </div>}
  </details>;
}

function RevisionColumn({ label, read }: { label: string; read: { data: DocumentRevision | undefined; error: unknown; isPending: boolean } }) {
  const revision = read.data;
  const origin = useRevisionOrigin(revision?.projectId ?? "", { actorId: revision?.author, reason: revision?.reason });
  return <section aria-label={label} className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted p-4">
    <h3 className="text-label font-semibold text-foreground">{label}</h3>
    {!revision ? read.error ? <Notice tone="error">这一版暂不可读取：{errorText(read.error)}</Notice> : <LoadingState lines={5} label={`正在读取${label}`} />
      : <>
        <p className="text-caption text-muted-foreground">{date(revision.createdAt)} · {origin.author}</p>
        {revision.body !== null && revision.format === "markdown"
          ? <>
            <MarkdownBody className="text-label" source={revision.body} identity={`impact-${revision.id}`} projectId={revision.projectId} topHeading={4} />
            <details><summary className="w-fit cursor-pointer text-caption text-primary hover:underline">查看 Markdown 原文</summary>
              <pre className={`mt-2 max-h-96 ${readingSource}`}>{revision.body}</pre></details>
          </>
          : <OriginalDocumentReader token="" projectId={revision.projectId} documentId={revision.documentId} revisionId={revision.id} />}
        <FullIdentifiers rows={[{ label: "修订", value: revision.id }, { label: "内容摘要", value: revision.contentHash }]} />
      </>}
  </section>;
}
