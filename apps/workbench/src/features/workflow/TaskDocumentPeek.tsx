// A related document opened in the right column from a task (docs/frontend/scenarios.md 对象之间怎样互相查看):
// the revision the task fixed, with whether the document has moved on since. Markdown reads here; other formats
// open in the center.
import { Notice, LoadingState } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { date, href } from "../../shared/ui/shared";

export function TaskDocumentPeek({ projectId, documentId, revisionId, relation }: {
  projectId: string; documentId: string; revisionId: string | null; relation: string;
}) {
  const documentRead = useProjectQuery(projectId, ["document-detail", documentId], () => api().document(projectId, documentId));
  const shownRevision = revisionId ?? documentRead.data?.current.id ?? null;
  const revisionRead = useProjectQuery(projectId, ["document-revision", documentId, shownRevision], () => api().documentRevision(projectId, documentId, shownRevision!), { enabled: !!shownRevision });
  const document = documentRead.data?.document;
  const revision = revisionRead.data;
  const fixed = !!revisionId;
  const moved = fixed && document && document.currentRevisionId !== revisionId;
  return <article data-ui="" className="flex flex-col gap-3" aria-label={document?.title ?? "关联文档"}>
    <header className="flex flex-col gap-1">
      <p className="text-caption text-muted-foreground">{relation}</p>
      <h3 className="text-body font-semibold text-foreground">{document?.title ?? (documentRead.error ? "文档暂不可读" : "正在读取文档…")}</h3>
      {revision && <p className="text-caption text-muted-foreground">{fixed ? "任务固定的修订" : "当前修订"} · {date(revision.createdAt)} · {revision.author}</p>}
      {moved && <p className="text-caption text-warning">文档已有新版；任务仍按这一版。<a className="text-primary hover:underline" href={href(projectId, "document", documentId)}>查看当前版</a></p>}
      {fixed && document && !moved && <p className="text-caption text-muted-foreground">这一版也是文档的当前修订。</p>}
    </header>
    {(documentRead.error || revisionRead.error) && <Notice tone="error">读取失败：{errorText(documentRead.error ?? revisionRead.error)}。可以在中间打开再试。</Notice>}
    {!revision && !revisionRead.error && !documentRead.error && <LoadingState lines={6} label="正在读取文档正文" />}
    {revision && (revision.body !== null && revision.format === "markdown"
      ? <div data-legacy=""><MarkdownBody source={revision.body} identity={`peek-${revision.id}`} projectId={projectId} /></div>
      : <p className="text-label text-text-secondary">这份原件是 {revision.format.toUpperCase()}，需要更宽的阅读区。<a className="text-primary hover:underline" href={href(projectId, "document", documentId, revision.id)}>在中间宽屏阅读</a></p>)}
  </article>;
}
