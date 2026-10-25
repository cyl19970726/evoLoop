import { useEffect, useState } from "react";
import type { DocumentDetail, DocumentRevision, DocumentTaskReference } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { Alert, ShortId, RevisionBody, documentReturnHref, href } from "../ui/shared";
import { ActionForm, type MutationContext } from "../workflow/ActionForm";
import { UploadDocument } from "./UploadDocument";
import { DocumentOrigin } from "./DocumentOrigin";
import "./document.css";
const kindLabel = { task: "任务正文", issue: "问题", spec: "规范", discussion: "讨论", report: "报告" } as const;
const statusLabel = { draft: "草稿", published: "已发布", archived: "已归档" } as const;
const relationLabel = { content: "任务正文", link: "已关联", basis: "当前固定依据" } as const;
export function DocumentPage({ token, projectId, id, selectedRevision, context, refresh }: { token: string; projectId: string; id: string; selectedRevision?: string; context: MutationContext; refresh: number }) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [revision, setRevision] = useState<DocumentRevision | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploadBaselineVersion, setUploadBaselineVersion] = useState<number | null>(null);
  const [uploadGeneration, setUploadGeneration] = useState(0);
  const [readVersion, setReadVersion] = useState(0);
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [relatedTasks, setRelatedTasks] = useState<DocumentTaskReference[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(true);
  const [relatedError, setRelatedError] = useState("");
  const [relatedPartial, setRelatedPartial] = useState(false);
  useEffect(() => { setUploadBaselineVersion(null); setUploadGeneration(0); }, [projectId, id]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    api(token).document(projectId, id).then(async d => {
      const r = selectedRevision ? await api(token).documentRevision(projectId, id, selectedRevision) : d.current;
      if (active) { setDetail(d); setRevision(r); setObservedAt(new Date()); setUploadBaselineVersion(value => value ?? d.document.version); setLoading(false); }
    }).catch(cause => { if (active) { setError(errorText(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [token, projectId, id, selectedRevision, refresh, readVersion]);
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible") setReadVersion(value => value + 1); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [id, projectId]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRelatedTasks([]); setRelatedLoading(true); setRelatedError(""); setRelatedPartial(false);
    const client = api(token);
    void (async () => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      const matches = new Map<string, DocumentTaskReference>();
      let pages = 0;
      do {
        const page = await client.documentTasks(projectId, id, cursor, controller.signal);
        if (!active) return;
        if (page.items.length > 50 || page.items.some(item => item.projectId !== projectId)) throw new Error("关联任务分页响应无效");
        for (const task of page.items) matches.set(task.id, task);
        setRelatedTasks([...matches.values()]);
        pages++;
        if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new Error("分页游标重复，关联任务读取未完成");
        if (page.nextCursor) seen.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
        if (cursor && (pages >= 20 || matches.size >= 1000)) {
          if (active) { setRelatedPartial(true); setRelatedLoading(false); }
          return;
        }
      } while (cursor);
      if (active) setRelatedLoading(false);
    })().catch(cause => { if (active) { setRelatedLoading(false); setRelatedError(errorText(cause)); } });
    return () => { active = false; controller.abort(); };
  }, [token, projectId, id, refresh, readVersion]);
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
    <div className="doc-read-status"><span>{loading ? "正在核对当前文档…" : observedAt ? `当前文档读于 ${observedAt.toLocaleString("zh-CN")}` : "当前文档尚未读回"}</span><button type="button" className="quiet" onClick={() => setReadVersion(value => value + 1)}>重新读取当前文档</button></div>
    {loading && <Alert>正在核对当前修订；保存与采纳暂不可用。</Alert>}
    {error && <Alert kind="error">当前文档回读未完成：{error}。页首保留上次读回内容，不能视为当前状态；草稿仍留在本页。</Alert>}
    <div className="eyebrow">{detail.document.kind ? kindLabel[detail.document.kind] : "过程文档"} · {statusLabel[detail.document.status]}</div><h1>{detail.document.title}</h1>
    {detail.document.origin && <DocumentOrigin token={token} projectId={projectId} origin={detail.document.origin} />}
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
    <section className="panel doc-related-tasks"><h2>引用此文档的任务</h2>{relatedLoading && <p role="status">正在读取当前关联任务…</p>}{relatedError && <Alert kind="error">任务关联未读完整：{relatedError}。下列只含已核对的任务。</Alert>}{relatedPartial && <Alert>已达 20 页或 1000 项读取上限；下列任务未必完整。</Alert>}
      {relatedTasks.length ? <ul>{relatedTasks.map(task => <li key={task.id}><a href={href(projectId, "task", task.id)}>{task.title}</a><span>{task.relations.map(relation => relationLabel[relation]).join(" · ")} · {task.state === "todo" ? "待办" : task.state === "in_progress" ? "进行中" : task.state === "done" ? "已完成" : "已取消"} · 责任者 {task.owner}</span></li>)}</ul> : !relatedLoading && !relatedError && !relatedPartial && <p className="empty">当前没有任务引用此文档。</p>}
    </section>
    {!taskOwned && <details className="workflow-detail"><summary>修订与发布</summary>{!archived && detail.current.format === "markdown" && detail.current.body !== null && <ActionForm context={formContext} title="保存候选修订" fields={[{ name: "body", label: "完整正文", kind: "textarea", value: detail.current.body ?? "" }, { name: "reason", label: "修订理由", kind: "textarea" }]} build={v => ({ type: "document.revise", documentId: id, expectedVersion: detail.document.version, ...v })} />}
    {!archived && <>
    {uploadStale && <Alert kind="error">上传表单仍使用打开时的文档版本 v{uploadBaselineVersion}；当前为 v{detail.document.version}。
      请先核对新修订，再明确重新选择文件。<button onClick={() => {
        if (!window.confirm("重新选择文件会清空当前上传表单，确定继续？")) return;
        setUploadBaselineVersion(detail.document.version); setUploadGeneration(value => value + 1);
      }}>以当前版重新开始上传</button></Alert>}
    <UploadDocument key={`${id}:${uploadGeneration}`} context={{ ...formContext, blocked: formContext.blocked || uploadStale }} mode="revise"
      documentId={id} expectedVersion={uploadBaselineVersion ?? detail.document.version} />
    {detail.current.id === detail.adopted?.id
      ? <p className="muted">当前修订已发布；如需更新，请先保存新修订。</p>
      : <ActionForm context={formContext} review title="发布当前修订" fields={[{ name: "reason", label: "发布依据", kind: "textarea" }]} build={v => ({ type: "document.publish", documentId: id, expectedVersion: detail.document.version, revisionId: detail.current.id, ...v })} />}</>}
    <ActionForm context={formContext} review title={archived ? "恢复文档" : "归档文档"} fields={[{ name: "reason", label: archived ? "恢复理由" : "归档理由", kind: "textarea" }]} build={v => ({ type: archived ? "document.restore" : "document.archive", documentId: id, expectedVersion: detail.document.version, ...v })} /></details>}
  </div>;
}
