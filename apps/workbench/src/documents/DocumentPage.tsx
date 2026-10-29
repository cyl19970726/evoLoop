import { useEffect, useState } from "react";
import type { DocumentDetail, DocumentRevision, DocumentTaskReference } from "@evoloop/contracts";
import { ApiError, api, errorText } from "../api";
import { Alert, ShortId, date, documentReturnHref, href, readRoute } from "../ui/shared";
import { MarkdownBody } from "../ui/MarkdownBody";
import { OriginalDocumentReader } from "./OriginalDocumentReader";
import { ActionForm, type MutationContext } from "../workflow/ActionForm";
import { UploadDocument } from "./UploadDocument";
import { DocumentOrigin } from "./DocumentOrigin";
import "./document.css";
const kindLabel = { task: "任务正文", issue: "问题", spec: "规范", discussion: "讨论", report: "报告" } as const;
const statusLabel = { draft: "草稿", published: "已发布", archived: "已归档" } as const;
const relationLabel = { content: "任务正文", link: "已关联", basis: "当前固定依据" } as const;
const readProblem = (cause: unknown): string => cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
  ? "当前身份无权读取该文档" : errorText(cause);
export function DocumentPage({ token, projectId, id, selectedRevision, context, refresh }: { token: string; projectId: string; id: string; selectedRevision?: string; context: MutationContext; refresh: number }) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [revision, setRevision] = useState<DocumentRevision | null>(null);
  const [loadedScope, setLoadedScope] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploadBaselineVersion, setUploadBaselineVersion] = useState<number | null>(null);
  const [uploadGeneration, setUploadGeneration] = useState(0);
  const [readVersion, setReadVersion] = useState(0);
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [relatedTasks, setRelatedTasks] = useState<DocumentTaskReference[]>([]);
  const [relatedScope, setRelatedScope] = useState("");
  const [relatedLoading, setRelatedLoading] = useState(true);
  const [relatedError, setRelatedError] = useState("");
  const [relatedPartial, setRelatedPartial] = useState(false);
  const scope = JSON.stringify([token, projectId, id, selectedRevision ?? null]);
  const taskScope = JSON.stringify([token, projectId, id]);
  useEffect(() => { setUploadBaselineVersion(null); setUploadGeneration(0); }, [token, projectId, id]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    api(token).document(projectId, id).then(async d => {
      const r = selectedRevision ? await api(token).documentRevision(projectId, id, selectedRevision) : d.current;
      if (d.document.projectId !== projectId || d.document.id !== id || d.current.projectId !== projectId ||
        d.current.documentId !== id || r.projectId !== projectId || r.documentId !== id ||
        selectedRevision && r.id !== selectedRevision) throw new Error("文档响应与当前项目或固定修订不符");
      if (active) { setDetail(d); setRevision(r); setLoadedScope(scope); setObservedAt(new Date()); setUploadBaselineVersion(value => value ?? d.document.version); setLoading(false); }
    }).catch(cause => { if (active) { setError(readProblem(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [token, projectId, id, selectedRevision, refresh, readVersion, scope]);
  useEffect(() => {
    const isCurrent = () => { const route = readRoute(); return route.section === "document" && route.projectId === projectId &&
      route.id === id && route.revision === selectedRevision; };
    let wasCurrent = isCurrent();
    const returned = () => { const current = isCurrent(); if (current && !wasCurrent) setReadVersion(value => value + 1); wasCurrent = current; };
    const reread = () => { if (document.visibilityState === "visible" && isCurrent()) setReadVersion(value => value + 1); };
    window.addEventListener("hashchange", returned);
    window.addEventListener("focus", reread);
    return () => { window.removeEventListener("hashchange", returned); window.removeEventListener("focus", reread); };
  }, [id, projectId, selectedRevision]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (relatedScope !== taskScope) setRelatedTasks([]);
    setRelatedLoading(true); setRelatedError(""); setRelatedPartial(false);
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
        setRelatedScope(taskScope); setRelatedTasks([...matches.values()]);
        pages++;
        if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new Error("分页游标重复，关联任务读取未完成");
        if (page.nextCursor) seen.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
        if (cursor && (pages >= 20 || matches.size >= 1000)) {
          if (active) { setRelatedPartial(true); setRelatedLoading(false); }
          return;
        }
      } while (cursor);
      if (active) { setRelatedScope(taskScope); setRelatedTasks([...matches.values()]); setRelatedLoading(false); }
    })().catch(cause => { if (active) { setRelatedLoading(false); setRelatedError(readProblem(cause)); } });
    return () => { active = false; controller.abort(); };
  }, [token, projectId, id, refresh, readVersion]);
  if (!detail || !revision || loadedScope !== scope || detail.document.projectId !== projectId || detail.document.id !== id || revision.projectId !== projectId || revision.documentId !== id || selectedRevision && revision.id !== selectedRevision) {
    return <div className="content"><a className="back" href={documentReturnHref(projectId)}>← 返回来源</a><p>{loading ? "正在读取文档…" : "当前文档尚未读回。"}</p>{error && <Alert kind="error">{error}</Alert>}</div>;
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
    {taskOwned && <Alert>这是任务主文档。此处只阅读固定修订；请从{detail.document.primaryTaskId
      ? <a href={href(projectId, "task", detail.document.primaryTaskId)}>所属任务</a> : "所属任务页"}修改正文。</Alert>}
    <p className="doc-reading-version">正在阅读 <strong>{revision.id === detail.current.id ? "当前版" : "固定历史版"}</strong> <ShortId value={revision.id} /> · {date(revision.createdAt)}{detail.document.primaryTaskId && <> · <a href={href(projectId, "task", detail.document.primaryTaskId)}>所属任务</a></>}</p>
    {revision.id !== detail.current.id && <Alert>所读为固定历史版。当前版已更新；请核对任务实际采用的修订。</Alert>}
    {revision.id !== detail.adopted?.id && <p className="muted">所读修订不是已发布版；引用它时请核对任务固定依据。</p>}
    <div className="actions doc-version-actions">
      {revision.id !== detail.current.id && <a className="button-link" href={href(projectId, "document", id, detail.current.id)}>阅读当前版</a>}
      {detail.adopted && revision.id !== detail.adopted.id && <a className="button-link" href={href(projectId, "document", id, detail.adopted.id)}>阅读已发布版</a>}
      {revision.previousRevisionId && <a className="button-link" href={href(projectId, "document", id, revision.previousRevisionId)}>上一版</a>}
    </div>
    <section className="doc-primary-body" aria-label="文档完整正文">
      {revision.body !== null && revision.format === "markdown" ? <><MarkdownBody source={revision.body} identity={revision.id} projectId={projectId} /><details><summary>查看 Markdown 原文</summary><pre>{revision.body}</pre></details></>
        : <OriginalDocumentReader token={token} projectId={projectId} documentId={id} revisionId={revision.id} />}
    </section>
    <details className="doc-reading-details" open><summary>版本、原件与来源</summary>
      <div className="doc-version-status" aria-label="文档修订状态">
        <span><strong>正在阅读</strong> <ShortId value={revision.id} /><small>{date(revision.createdAt)}</small></span>
        <span><strong>当前版</strong> <a href={href(projectId, "document", id, detail.current.id)}><ShortId value={detail.current.id} /></a><small>{date(detail.current.createdAt)}</small></span>
        <span><strong>已发布版</strong> {detail.adopted ? <><a href={href(projectId, "document", id, detail.adopted.id)}><ShortId value={detail.adopted.id} /></a><small>{date(detail.adopted.createdAt)}</small></> : "尚未发布"}</span>
      </div>
      <p>原件 {revision.format} · 作者 {revision.author} · 修订理由 {revision.reason}</p>
      <p>内容 SHA-256 <code>{revision.contentHash}</code></p>
      {detail.document.origin && <DocumentOrigin token={token} projectId={projectId} documentId={id} revisionId={revision.id}
        refreshKey={`${refresh}:${readVersion}`} origin={detail.document.origin} />}
    </details>
    <section className="panel doc-related-tasks"><h2>引用此文档的任务</h2>{relatedLoading && <p role="status">正在读取当前关联任务；已显示关联来自上次读取。</p>}{relatedError && <Alert kind="error">任务关联本次未读完整：{relatedError}。下列可能包含上次读回的任务，不能视为当前完整结果。</Alert>}{relatedPartial && <Alert>已达 20 页或 1000 项读取上限；下列任务未必完整。</Alert>}
      {relatedScope === taskScope && relatedTasks.length ? <ul>{relatedTasks.map(task => <li key={task.id}><a href={href(projectId, "task", task.id)}>{task.title}</a><span>{task.relations.map(relation => relationLabel[relation]).join(" · ")} · {task.state === "todo" ? "待办" : task.state === "in_progress" ? "进行中" : task.state === "done" ? "已完成" : "已取消"} · 责任者 {task.owner}</span></li>)}</ul> : !relatedLoading && !relatedError && !relatedPartial && <p className="empty">当前没有任务引用此文档。</p>}
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
