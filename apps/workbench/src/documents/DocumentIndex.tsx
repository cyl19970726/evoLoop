import { useEffect, useRef, useState } from "react";
import type { Document, Page } from "@evoloop/contracts";
import type { LeaderWorkDocument } from "@evoloop/contracts/work-index";
import { ApiError, api, errorText } from "../api";
import { Alert, ShortId, date, href } from "../ui/shared";
import { ActionForm, option, type MutationContext } from "../workflow/ActionForm";
import { loadLeaderDocumentsForIds, visibleLeaderDocuments } from "../workflow/leaderWorkLoad";
import { UploadDocument } from "./UploadDocument";
import { documentLifecycleMatches, mergeDocumentPage, readDocumentRange, validDocumentPage } from "./documentListModel";
import "./document.css";

const kinds = { issue: "问题", spec: "规范", discussion: "讨论", report: "报告", organization_review: "组织复盘", task: "任务正文" } as const;
const statuses = { draft: "草稿", published: "已发布", archived: "已归档" } as const;
const empty: Page<Document> = { items: [], nextCursor: null };
const automaticPageLimit = 10;
const automaticItemLimit = 500;
type SavedList = { scope: string; page: Page<Document>; query: string; kind: string; status: string; scroll: number };
let savedList: SavedList | null = null;
const readProblem = (cause: unknown): string => cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
  ? "当前身份无权读取该项目文档" : errorText(cause);

export function DocumentIndex({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { token, projectId } = context;
  const scope = JSON.stringify([token, projectId, context.principal.actorId]);
  const prior = savedList?.scope === scope ? savedList : null;
  const [pageState, setPageState] = useState<{ scope: string; page: Page<Document> }>({ scope, page: prior?.page ?? empty });
  const [query, setQuery] = useState(prior?.query ?? "");
  const [kind, setKind] = useState(prior?.kind ?? "all");
  const [status, setStatus] = useState(prior?.status ?? "active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState(false);
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [lifecycleStateData, setLifecycleStateData] = useState<{ scope: string; values: Record<string, LeaderWorkDocument> }>({ scope, values: {} });
  const [lifecycleState, setLifecycleState] = useState<"loading" | "complete" | "partial">("loading");
  const [lifecycleError, setLifecycleError] = useState("");
  const [reread, setReread] = useState(0);
  const epoch = useRef(0);
  const currentPage = useRef<Page<Document>>(prior?.page ?? empty);
  const cursors = useRef(new Set<string>());
  const pending = useRef<Promise<boolean> | null>(null);
  const pageCount = useRef(0);
  const restoreScroll = useRef<number | null>(prior?.scroll ?? null);
  const scopeRef = useRef(scope);
  const filterScope = useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    currentPage.current = empty;
    cursors.current = new Set();
    pageCount.current = 0;
    restoreScroll.current = null;
  }
  const shownPage = pageState.scope === scope && pageState.page.items.every(item => item.projectId === projectId) ? pageState.page : empty;
  const lifecycle = lifecycleStateData.scope === scope ? lifecycleStateData.values : {};
  const visible = visibleLeaderDocuments(shownPage.items, status, kind, query.trim());
  const visibleKey = visible.map(item => `${item.id}:${item.version}`).join(",");

  useEffect(() => {
    if (filterScope.current === scope) return;
    filterScope.current = scope;
    setQuery(""); setKind("all"); setStatus("active"); setCreate(false);
  }, [scope]);

  useEffect(() => {
    let active = true;
    const generation = ++epoch.current;
    pending.current = null;
    cursors.current = new Set();
    pageCount.current = 0;
    setLoading(true); setBusy(false); setError(""); setSearchError("");
    setLifecycleStateData(previous => previous.scope === scope ? previous : { scope, values: {} });
    setLifecycleState("loading"); setLifecycleError("");
    const previousCount = currentPage.current.items.length;
    void readDocumentRange(cursor => {
      if (!active || generation !== epoch.current) throw new Error("列表读取范围已变化");
      return api(token).documents(projectId, cursor, kind === "all" ? undefined : kind as Document["kind"]);
    }, projectId, previousCount).then(result => {
      if (!active || generation !== epoch.current) return;
      currentPage.current = result.page; pageCount.current = result.pages; cursors.current = result.cursors;
      setPageState({ scope, page: result.page }); setObservedAt(new Date()); setLoading(false);
    }).catch(cause => { if (active && generation === epoch.current) { setError(readProblem(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [token, projectId, refresh, reread, kind]);

  useEffect(() => {
    if (loading || error || restoreScroll.current === null) return;
    const position = restoreScroll.current;
    restoreScroll.current = null;
    const frame = requestAnimationFrame(() => window.scrollTo(0, position));
    return () => cancelAnimationFrame(frame);
  }, [loading, error, scope]);

  useEffect(() => {
    const returned = () => { if (document.visibilityState === "visible") setReread(value => value + 1); };
    window.addEventListener("focus", returned);
    return () => window.removeEventListener("focus", returned);
  }, []);

  function more(): Promise<boolean> {
    if (pending.current) return pending.current;
    const cursor = currentPage.current.nextCursor;
    if (!cursor) return Promise.resolve(false);
    const generation = epoch.current;
    const request = api(token).documents(projectId, cursor, kind === "all" ? undefined : kind as Document["kind"]).then(result => {
      if (generation !== epoch.current || currentPage.current.nextCursor !== cursor) return false;
      validDocumentPage(result, projectId, cursor);
      if (result.nextCursor && cursors.current.has(result.nextCursor)) throw new Error("文档分页游标重复，无法确认后续结果");
      cursors.current.add(cursor);
      const next = mergeDocumentPage(currentPage.current, result);
      currentPage.current = next; pageCount.current++; setPageState({ scope, page: next });
      return true;
    });
    pending.current = request;
    void request.finally(() => { if (pending.current === request) pending.current = null; }).catch(() => {});
    return request;
  }

  useEffect(() => {
    if (loading || !query.trim() || !shownPage.nextCursor) { setSearching(false); return; }
    let active = true;
    const generation = epoch.current;
    setSearching(true); setSearchError("");
    const timer = window.setTimeout(async () => {
      try {
        while (active && generation === epoch.current && currentPage.current.nextCursor) {
          if (pageCount.current >= automaticPageLimit || currentPage.current.items.length + 50 > automaticItemLimit)
            throw new Error(`自动搜索达到 ${automaticPageLimit} 页或 ${automaticItemLimit} 项上限；可继续手动载入。`);
          if (!await more()) return;
        }
      } catch (cause) { if (active) setSearchError(readProblem(cause)); }
      finally { if (active) setSearching(false); }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [token, projectId, refresh, reread, query, loading, shownPage.nextCursor]);

  useEffect(() => {
    let active = true;
    if (loading || error || !visible.length) { setLifecycleState(visible.length ? "loading" : "complete"); return; }
    setLifecycleState("loading"); setLifecycleError("");
    void loadLeaderDocumentsForIds(cursor => api(token).leaderWork(projectId, "documents", cursor,
      status === "all" || status === "archived"), visible.map(item => item.id)).then(result => {
      if (!active) return;
      const matched = Object.fromEntries([...result.items].filter(([id, projection]) => {
        const document = visible.find(item => item.id === id);
        return document && documentLifecycleMatches(document, projection);
      }));
      setLifecycleStateData({ scope, values: matched }); setLifecycleState(result.complete && Object.keys(matched).length === visible.length ? "complete" : "partial");
    }).catch(cause => { if (active) { setLifecycleState("partial"); setLifecycleError(cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
      ? "当前身份无权读取文档用途与关联工作" : errorText(cause)); } });
    return () => { active = false; };
  }, [token, projectId, refresh, reread, loading, error, visibleKey, status]);

  function remember() { savedList = { scope, page: shownPage, query, kind, status, scroll: window.scrollY }; }
  async function loadMore() {
    if (busy) return;
    const generation = epoch.current;
    setBusy(true);
    try { await more(); if (generation === epoch.current) setError(""); }
    catch (cause) { if (generation === epoch.current) setError(readProblem(cause)); }
    finally { if (generation === epoch.current) setBusy(false); }
  }
  const canWrite = context.principal.permissions.includes("write");
  return <div className="content work-index document-index">
    <div className="page-title-row"><div><h1>过程文档</h1><p className="lede">从固定原件读工作依据，核对版本与关联任务。</p></div>
      {canWrite && <button type="button" onClick={() => setCreate(value => !value)} aria-expanded={create}>保存文档</button>}</div>
    <nav className="context-links" aria-label="文档与知识"><a href={href(projectId, "documents")} aria-current="page">过程文档</a><a href={href(projectId, "knowledge")}>知识空间</a><a href={href(projectId, "repository")}>仓库规范</a></nav>
    {create && <div className="panel"><h2>保存过程文档</h2><ActionForm context={context} title="创建 Markdown 文档" fields={[{ name: "title", label: "文档名称" }, { name: "kind", label: "类型（可选）", kind: "select", optional: true, options: Object.entries(kinds).filter(([key]) => key !== "task" && key !== "organization_review").map(([key, label]) => option(key, label)) }, { name: "body", label: "完整 Markdown 正文", kind: "textarea" }]} build={values => ({ type: "document.create", documentId: crypto.randomUUID(), title: values.title, body: values.body, kind: values.kind || null })} /><UploadDocument context={context} /></div>}
    <section className="list-surface" aria-label="过程文档" aria-busy={loading}>
      <p className="doc-index-read">{loading ? "正在核对文档列表；已显示内容来自上次读取。" : error ? "本次列表读取失败；已显示内容仅供核对。" : observedAt ? `列表读于 ${observedAt.toLocaleString("zh-CN")}。` : "列表尚未读回。"}</p>
      <div className="list-toolbar"><label className="search-field"><input aria-label="搜索文档" placeholder="搜索标题或文档 ID…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="文档类型筛选" value={kind} onChange={event => setKind(event.target.value)}><option value="all">全部类型</option>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <select aria-label="文档状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="active">未归档</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="all">全部状态</option></select>
        <button type="button" className="quiet" onClick={() => setReread(value => value + 1)}>重新读取</button></div>
      {error && <div className="list-message"><Alert kind="error">列表读取失败：{error}。旧数据不是当前结果。</Alert><button onClick={() => setReread(value => value + 1)}>重试</button></div>}
      {searching && <p className="list-message" role="status">正在搜索后续页面；结果尚未完整。</p>}
      {searchError && <Alert kind="error">搜索未完成：{searchError}。以下只覆盖已载入文档。</Alert>}
      {lifecycleState === "loading" && visible.length > 0 && <p className="list-message" role="status">正在核对用途与关联工作；已有说明来自上次读取。</p>}
      {lifecycleState === "partial" && <Alert>用途与关联工作未完整读回；已有说明可能来自上次读取，没有资料的行保持未知。{lifecycleError && <details><summary>诊断信息</summary>{lifecycleError}</details>}</Alert>}
      <p className="doc-table-hint">表格可横向查看版本与时间；打开文档标题阅读完整正文。</p>
      <div className="table-wrap" role="region" aria-label="过程文档表格，可横向查看" tabIndex={0}><table><thead><tr><th>文档</th><th>用途与关联工作</th><th>版本状态</th><th>最近变化</th></tr></thead><tbody>{visible.map(item => {
        const projection = lifecycle[item.id];
        const work = projection && documentLifecycleMatches(item, projection) ? projection : undefined;
        return <tr key={item.id}><td><a className="doc-index-title" href={href(projectId, "document", item.id)} onClick={remember}>{item.title}</a><small>{item.kind ? kinds[item.kind] : "未分类"}</small></td>
          <td>{work ? <><span>{work.nextAction}</span>{work.references.length ? <><ul className="doc-index-references">{work.references.slice(0,1).map(ref => <li key={ref.taskId}><a href={href(projectId, "task", ref.taskId)} onClick={remember}>{ref.title}</a><small>{ref.relations.includes("basis") ? "固定依据" : ref.relations.includes("content") ? "任务正文" : "已关联"}</small></li>)}</ul>{work.references.length > 1 && <details><summary>其他 {work.references.length - 1} 项引用任务</summary><ul className="doc-index-references">{work.references.slice(1).map(ref => <li key={ref.taskId}><a href={href(projectId, "task", ref.taskId)} onClick={remember}>{ref.title}</a><small>{ref.relations.includes("basis") ? "固定依据" : ref.relations.includes("content") ? "任务正文" : "已关联"}</small></li>)}</ul></details>}</> : <small>尚无引用任务</small>}{item.primaryTaskId && !work.references.some(ref => ref.taskId === item.primaryTaskId) && <small><a href={href(projectId, "task", item.primaryTaskId)} onClick={remember}>所属任务</a></small>}</> : <><span>用途待核对</span>{item.primaryTaskId && <small><a href={href(projectId, "task", item.primaryTaskId)} onClick={remember}>所属任务</a></small>}</>}</td>
          <td><span className="pill subtle">{statuses[item.status]}</span><small>当前 <a href={href(projectId, "document", item.id, item.currentRevisionId)} onClick={remember}><ShortId value={item.currentRevisionId} /></a></small><small>已发布 {item.adoptedRevisionId ? <a href={href(projectId, "document", item.id, item.adoptedRevisionId)} onClick={remember}><ShortId value={item.adoptedRevisionId} /></a> : "尚未发布"}</small></td>
          <td>{work?.dates.changedAt ? date(work.dates.changedAt) : "最近变化待核对"}<details><summary>标识与时间</summary><p>文档 <ShortId value={item.id} /> · 当前 v{item.version}</p>{work && <p>创建 {date(work.dates.createdAt)}<br />当前修订 {date(work.dates.currentRevisionAt)}{work.dates.adoptedAt && <><br />发布 {date(work.dates.adoptedAt)}</>}</p>}</details></td></tr>;
      })}</tbody></table></div>
      {!loading && !error && !visible.length && <div className="list-empty"><h2>{query || kind !== "all" || status !== "active" ? "已载入范围没有匹配文档" : shownPage.nextCursor ? "当前页没有未归档文档" : "还没有过程文档"}</h2><p>{shownPage.nextCursor ? "仍有后续页面；继续载入才能确认全部结果。" : "可清除筛选，或与负责 Agent 确认下一份过程文档。"}</p><button onClick={() => { setQuery(""); setKind("all"); setStatus("active"); }}>清除筛选</button></div>}
      <div className="list-footer"><span>已载入 {shownPage.items.length} 项 · 当前条件匹配 {visible.length} 项{shownPage.nextCursor ? " · 后续页面未读" : " · 已读完分页"}</span>{shownPage.nextCursor && <button disabled={busy} onClick={() => void loadMore()}>{busy ? "载入中…" : "载入更多"}</button>}</div>
    </section>
  </div>;
}
