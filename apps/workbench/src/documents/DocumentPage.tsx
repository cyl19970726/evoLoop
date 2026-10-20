import { useEffect, useState } from "react";
import type { DocumentDetail, DocumentRevision } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { Alert, ShortId, RevisionBody, documentReturnHref, href } from "../ui/shared";
import { ActionForm, type MutationContext } from "../workflow/ActionForm";
import { UploadDocument } from "./UploadDocument";
import "./document.css";
const kindLabel = { task: "任务正文", issue: "问题", spec: "规范", discussion: "讨论", report: "报告" } as const;
const statusLabel = { draft: "草稿", published: "已发布", archived: "已归档" } as const;
export function DocumentPage({ token, projectId, id, selectedRevision, context, refresh }: { token: string; projectId: string; id: string; selectedRevision?: string; context: MutationContext; refresh: number }) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [revision, setRevision] = useState<DocumentRevision | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploadBaselineVersion, setUploadBaselineVersion] = useState<number | null>(null);
  const [uploadGeneration, setUploadGeneration] = useState(0);
  useEffect(() => { setUploadBaselineVersion(null); setUploadGeneration(0); }, [projectId, id]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    api(token).document(projectId, id).then(async d => {
      const r = selectedRevision ? await api(token).documentRevision(projectId, id, selectedRevision) : d.current;
      if (active) { setDetail(d); setRevision(r); setUploadBaselineVersion(value => value ?? d.document.version); setLoading(false); }
    }).catch(cause => { if (active) { setError(errorText(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [token, projectId, id, selectedRevision, refresh]);
  if (!detail || !revision || detail.document.id !== id || revision.documentId !== id || selectedRevision && revision.id !== selectedRevision) {
    return <div className="content"><p>正在读取文档…</p>{error && <Alert kind="error">{error}</Alert>}</div>;
  }
  const formContext = { ...context, blocked: context.blocked || loading || !!error,
    draftScope: `document:${id}`, draftBaseline: `${detail.document.version}:${detail.current.id}:${detail.document.adoptedRevisionId ?? ""}` };
  const uploadStale = uploadBaselineVersion !== null && uploadBaselineVersion !== detail.document.version;
  const taskOwned = detail.document.kind === "task";
  const archived = detail.document.status === "archived";
  return <div className="content reading">
    <a className="back doc-back" href={documentReturnHref(projectId)}>← 返回来源</a>
    <a className="doc-list-link" href={href(projectId, "documents")}>全部文档</a>
    {loading && <Alert>正在核对当前修订；保存与采纳暂不可用。</Alert>}
    {error && <Alert kind="error">回读未完成：{error}。草稿仍留在本页。</Alert>}
    <div className="eyebrow">{detail.document.kind ? kindLabel[detail.document.kind] : "过程文档"} · {statusLabel[detail.document.status]}</div><h1>{detail.document.title}</h1>
    {taskOwned && <Alert>这是任务主文档。此处只阅读固定修订；请从{detail.document.primaryTaskId
      ? <a href={href(projectId, "task", detail.document.primaryTaskId)}>所属任务</a> : "所属任务页"}修改正文。</Alert>}
    <div className="doc-version-status" aria-label="文档修订状态">
      <span><strong>正在阅读</strong> <ShortId value={revision.id} />{revision.id === detail.current.id ? " · 当前版" : " · 固定历史版"}</span>
      <span><strong>当前版</strong> <ShortId value={detail.current.id} /></span>
      <span><strong>已发布版</strong> {detail.adopted ? <ShortId value={detail.adopted.id} /> : "尚未发布"}</span>
    </div>
    {revision.id !== detail.adopted?.id && <p className="muted">所读修订不是已发布版；引用它时请核对任务固定依据。</p>}
    <div className="actions doc-version-actions">
      {revision.id !== detail.current.id && <a className="button-link" href={href(projectId, "document", id, detail.current.id)}>阅读当前版</a>}
      {detail.adopted && revision.id !== detail.adopted.id && <a className="button-link" href={href(projectId, "document", id, detail.adopted.id)}>阅读已发布版</a>}
      {revision.previousRevisionId && <a className="button-link" href={href(projectId, "document", id, revision.previousRevisionId)}>上一版</a>}
    </div>
    <RevisionBody token={token} revision={revision} />
    {!taskOwned && <details className="workflow-detail"><summary>修订与发布</summary>{!archived && detail.current.format === "markdown" && detail.current.body !== null && <ActionForm context={formContext} title="保存候选修订" fields={[{ name: "body", label: "完整正文", kind: "textarea", value: detail.current.body ?? "" }, { name: "reason", label: "修订理由", kind: "textarea" }]} build={v => ({ type: "document.revise", documentId: id, expectedVersion: detail.document.version, ...v })} />}
    {!archived && <>
    {uploadStale && <Alert kind="error">上传表单仍使用打开时的文档版本 v{uploadBaselineVersion}；当前为 v{detail.document.version}。
      请先核对新修订，再明确重新选择文件。<button onClick={() => {
        if (!window.confirm("重新选择文件会清空当前上传表单，确定继续？")) return;
        setUploadBaselineVersion(detail.document.version); setUploadGeneration(value => value + 1);
      }}>以当前版重新开始上传</button></Alert>}
    <UploadDocument key={`${id}:${uploadGeneration}`} context={{ ...formContext, blocked: formContext.blocked || uploadStale }} mode="revise"
      documentId={id} expectedVersion={uploadBaselineVersion ?? detail.document.version} />
    {detail.current.id === detail.adopted?.id && <p className="muted">当前修订已发布；如需更新，请先保存新修订。</p>}<ActionForm context={{ ...formContext, blocked: formContext.blocked || detail.current.id === detail.adopted?.id }} review title="发布当前修订" fields={[{ name: "reason", label: "发布依据", kind: "textarea" }]} build={v => ({ type: "document.publish", documentId: id, expectedVersion: detail.document.version, revisionId: detail.current.id, ...v })} /></>}
    <ActionForm context={formContext} review title={archived ? "恢复文档" : "归档文档"} fields={[{ name: "reason", label: archived ? "恢复理由" : "归档理由", kind: "textarea" }]} build={v => ({ type: archived ? "document.restore" : "document.archive", documentId: id, expectedVersion: detail.document.version, ...v })} /></details>}
  </div>;
}
