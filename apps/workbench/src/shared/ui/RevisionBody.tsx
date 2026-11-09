// One fixed document revision: Markdown is rendered, other formats open in the original reader.
import type { DocumentRevision } from "@evoloop/contracts";
import { OriginalDocumentReader } from "./OriginalDocumentReader";
import { MarkdownBody } from "./MarkdownBody";
import { ShortId, date } from "./shared";

export function RevisionBody({ revision, label, token }: { revision: DocumentRevision; label?: string; token: string }) {
  return <section className="revision-body">
    {label && <div className="eyebrow">{label}</div>}
    <div className="revision-meta"><span>修订 <ShortId value={revision.id} /></span><span>{date(revision.createdAt)}</span><span>作者 {revision.author}</span></div>
    {revision.body !== null && revision.format === "markdown" ? <><MarkdownBody source={revision.body} identity={revision.id} projectId={revision.projectId} /><details><summary>查看 Markdown 原文</summary><pre>{revision.body}</pre></details></> : <OriginalDocumentReader token={token} projectId={revision.projectId} documentId={revision.documentId} revisionId={revision.id} />}
    <p className="muted">原件 {revision.format} · <code title={revision.contentHash}>{revision.contentHash.slice(0, 22)}…</code></p>
  </section>;
}
