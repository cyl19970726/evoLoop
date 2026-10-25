import { useEffect, useRef, useState } from "react";
import type { Document, Impact, Page, Task } from "@evoloop/contracts";
import { Plus, Search, RefreshCw } from "lucide-react";
import { api, errorText } from "../api";
import { ActionForm, option, type MutationContext } from "./ActionForm";
import { UploadDocument } from "../documents/UploadDocument";
import { Alert, ShortId, href } from "../ui/shared";
import { Button } from "../components/ui/button";
import { legacyDecisionLabel, taskNextStep } from "./taskListPresentation";
import { businessNextStep, cognitionSummary, visibleWorkGroups, type WorkTaskStatus } from "./workStatusPresentation";
import "./work-status.css";

const states: Record<Task["state"], string> = { todo: "待办", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
const taskKinds = { implementation: "实施", research: "调研", validation: "验证" } as const;
const documentKinds = { issue: "问题", spec: "规范", discussion: "讨论", report: "报告", task: "任务正文" } as const;
const documentStatuses = { draft: "草稿", published: "已发布", archived: "已归档" } as const;
const searchPageLimit = 10;
const searchItemLimit = 500;

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map(item => item.id));
  const merged = [...current];
  for (const item of incoming) if (!seen.has(item.id)) { seen.add(item.id); merged.push(item); }
  return merged;
}

export function WorkIndex({ context, refresh, view }: { context: MutationContext; refresh: number; view: "work" | "inbox" | "documents" }) {
  const { token, projectId } = context;
  const [tasks, setTasks] = useState<Page<Task>>({ items: [], nextCursor: null });
  const [documents, setDocuments] = useState<Page<Document>>({ items: [], nextCursor: null });
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [statuses, setStatuses] = useState<Record<string, WorkTaskStatus>>({});
  const [statusError, setStatusError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [recheck, setRecheck] = useState(0);
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [documentStatus, setDocumentStatus] = useState("active");
  const [create, setCreate] = useState(false);
  const epoch = useRef(0);
  const pages = useRef<{ tasks: Page<Task>; documents: Page<Document> }>({
    tasks: { items: [], nextCursor: null }, documents: { items: [], nextCursor: null },
  });
  const pendingPage = useRef<{ tasks?: Promise<boolean>; documents?: Promise<boolean> }>({});
  const cursorHistory = useRef<{ tasks: Set<string>; documents: Set<string> }>({ tasks: new Set(), documents: new Set() });
  const pageCount = useRef({ tasks: 0, documents: 0 });
  useEffect(() => {
    let active = true; ++epoch.current; pendingPage.current = {}; cursorHistory.current = { tasks: new Set(), documents: new Set() }; pageCount.current = { tasks: 0, documents: 0 }; setLoading(true); setError(""); setStatuses({}); setStatusError("");
    const client = api(token);
    Promise.all([client.tasks(projectId), client.documents(projectId), client.impacts(projectId)]).then(async ([t, d, i]) => {
      if (active) { pages.current = { tasks: t, documents: d }; pageCount.current = { tasks: 1, documents: 1 }; setTasks(t); setDocuments(d); setImpacts(i); setObservedAt(new Date()); }
      if (t.items.length) try {
        const work = await client.workStatuses(projectId,t.items.map(item => item.id));
        if (active) {setStatuses(Object.fromEntries(work.items.map(item => [item.taskId,item])));
          if (work.items.length !== t.items.length) setStatusError("部分任务的工作状态尚未读回；缺少状态的任务仍可直接阅读。");}
      } catch (cause) { if (active) setStatusError(`工作状态暂不可读：${errorText(cause)}。已载入任务仍可直接阅读。`); }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, projectId, refresh, recheck]);
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible") setRecheck(value => value + 1); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [projectId]);
  function nextPage(kind: "tasks" | "documents"): Promise<boolean> {
    const inFlight = pendingPage.current[kind];
    if (inFlight) return inFlight;
    const cursor = pages.current[kind].nextCursor;
    if (!cursor) return Promise.resolve(false);
    const readEpoch = epoch.current;
    const client = api(token);
    const request = (async () => {
      if (kind === "documents") {
        const page = await client.documents(projectId, cursor);
        if (readEpoch !== epoch.current || pages.current.documents.nextCursor !== cursor) return false;
        if (page.items.length > 50) throw new Error("文档分页响应超过每页上限");
        if (page.nextCursor && (page.nextCursor === cursor || cursorHistory.current.documents.has(page.nextCursor))) throw new Error("文档分页游标重复，无法确认后续结果");
        cursorHistory.current.documents.add(cursor);
        const merged = { items: mergeById(pages.current.documents.items, page.items), nextCursor: page.nextCursor };
        pages.current.documents = merged; pageCount.current.documents++; setDocuments(merged);
      } else {
        const page = await client.tasks(projectId, cursor);
        if (readEpoch !== epoch.current || pages.current.tasks.nextCursor !== cursor) return false;
        if (page.items.length > 50) throw new Error("任务分页响应超过每页上限");
        if (page.nextCursor && (page.nextCursor === cursor || cursorHistory.current.tasks.has(page.nextCursor))) throw new Error("任务分页游标重复，无法确认后续结果");
        cursorHistory.current.tasks.add(cursor);
        const known = new Set(pages.current.tasks.items.map(item => item.id));
        const added = mergeById<Task>([], page.items.filter(item => !known.has(item.id)));
        const merged = { items: [...pages.current.tasks.items, ...added], nextCursor: page.nextCursor };
        pages.current.tasks = merged; pageCount.current.tasks++; setTasks(merged);
        if (added.length) try {
          const work = await client.workStatuses(projectId, added.map(item => item.id));
          if (readEpoch === epoch.current) {
            setStatuses(current => ({ ...current, ...Object.fromEntries(work.items.map(item => [item.taskId, item])) }));
            if (work.items.length !== added.length) setStatusError("部分任务的工作状态尚未读回；缺少状态的任务仍可直接阅读。");
          }
        } catch (cause) { if (readEpoch === epoch.current) setStatusError(`工作状态暂不可读：${errorText(cause)}。已载入任务仍可直接阅读。`); }
      }
      return true;
    })();
    pendingPage.current[kind] = request;
    void request.then(() => { if (pendingPage.current[kind] === request) delete pendingPage.current[kind]; },
      () => { if (pendingPage.current[kind] === request) delete pendingPage.current[kind]; });
    return request;
  }
  // Search through later server pages before presenting a complete result.
  useEffect(() => {
    if (loading || !query.trim()) { setSearching(false); setSearchError(""); return; }
    const kind = view === "documents" ? "documents" : "tasks";
    if (!pages.current[kind].nextCursor) { setSearching(false); setSearchError(""); return; }
    let active = true;
    const readEpoch = epoch.current;
    setSearching(true); setSearchError("");
    const timer = window.setTimeout(async () => {
      try {
        const seen = new Set<string>();
        while (active && readEpoch === epoch.current && pages.current[kind].nextCursor) {
          const source = pages.current[kind];
          if (pageCount.current[kind] >= searchPageLimit || source.items.length + 50 > searchItemLimit)
            throw new Error(`自动搜索已达 ${searchPageLimit} 页或 ${searchItemLimit} 项上限；结果未完整。可继续手动加载，或缩小范围。`);
          const cursor = source.nextCursor!;
          if (seen.has(cursor)) throw new Error("分页游标重复，无法确认搜索完整性");
          seen.add(cursor);
          if (!await nextPage(kind)) return;
        }
        if (active) setSearching(false);
      } catch (cause) { if (active) { setSearching(false); setSearchError(errorText(cause)); } }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [token, projectId, refresh, recheck, view, query, loading, tasks.nextCursor, documents.nextCursor]);
  async function more() {
    if (busy) return; setBusy(true); const readEpoch = epoch.current;
    try {
      await nextPage(view === "documents" ? "documents" : "tasks");
    } catch (cause) { if (readEpoch === epoch.current) setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const pending = impacts.filter(i => i.state === "pending");
  const visibleTasks = tasks.items.filter(t => (view !== "inbox" || t.state === "todo") && (filter === "all" || t.state === filter) && (kindFilter === "all" || t.kind === kindFilter) &&
    `${t.title} ${t.owner} ${t.id} ${statuses[t.id]?.cognition ? cognitionSummary(statuses[t.id]!).title : ""}`.toLowerCase().includes(query.toLowerCase()));
  const classificationUnavailable = Boolean(statusError) && !Object.keys(statuses).length;
  const {primary:primaryTasks,cognition:cognitionTasks,unknown:unknownTasks,primaryKind}=visibleWorkGroups(visibleTasks,statuses,classificationUnavailable);
  const visibleDocuments = documents.items.filter(d => (documentStatus === "all" || (documentStatus === "active" ? d.status !== "archived" : d.status === documentStatus)) && (kindFilter === "all" || d.kind === kindFilter) && `${d.title} ${d.id}`.toLowerCase().includes(query.toLowerCase()));
  const title = view === "documents" ? "过程文档" : view === "inbox" ? "待判断与复核" : "任务";
  return <div className="content work-index">
    <div className="page-title-row"><div><h1>{title}</h1><p className="lede">{view === "documents" ? "按类型阅读完整正文、固定修订与发布状态。" : view === "inbox" ? "阅读待办任务与依据变化，按当前状态决定下一步。" : "阅读任务正文、验收、固定依据与最新结果。"}</p></div>
      {view === "documents" ? <Button onClick={() => setCreate(!create)} aria-expanded={create}><Plus size={16} />保存文档</Button> : <Button onClick={() => setCreate(!create)} aria-expanded={create}><Plus size={16} />新建任务</Button>}
    </div>
    {view === "documents" && create && <div className="panel"><h2>保存过程文档</h2><ActionForm context={context} title="创建 Markdown 文档" fields={[{ name: "title", label: "文档名称" }, { name: "kind", label: "类型（可选）", kind: "select", optional: true, options: Object.entries(documentKinds).filter(([key]) => key !== "task").map(([key, label]) => option(key, label)) }, { name: "body", label: "完整 Markdown 正文", kind: "textarea" }]} build={v => ({ type: "document.create", documentId: crypto.randomUUID(), title: v.title, body: v.body, kind: v.kind || null })} /><UploadDocument context={context} /></div>}
    {view !== "documents" && create && <div className="panel"><h2>新建任务</h2><p className="muted">直接写清任务正文与独立验收条件；系统会创建并固定主文档，无需预建过程文档。</p><ActionForm context={{ ...context, draftScope: "new-task" }} initiallyOpen title="创建待办任务" fields={[
      { name: "title", label: "任务名称" }, { name: "kind", label: "类型（可选）", kind: "select", optional: true, options: Object.entries(taskKinds).map(([key, label]) => option(key, label)) },
      { name: "content", label: "任务正文（Markdown）", kind: "textarea" }, { name: "acceptance", label: "独立验收条件", kind: "textarea" }, { name: "owner", label: "责任者", value: context.principal.actorId },
    ]} build={v => ({ type: "task.create", taskId: crypto.randomUUID(), title: v.title, kind: v.kind || null, content: v.content, acceptance: v.acceptance, owner: v.owner })}
      onApplied={result => { window.location.hash = `/p/${projectId}/tasks/${result.entityId}`; }} /></div>}
    {view === "inbox" && <section className="panel impact-summary"><div className="panel-head"><h2>依据变化</h2><span>{pending.length} 项待复核</span></div>{!pending.length ? <p className="empty">当前没有待复核的依据变化。</p> : <ul className="impact-list">{pending.map(i => <li key={i.id}><a href={href(projectId, "task", i.taskId)}><strong>{tasks.items.find(t => t.id === i.taskId)?.title ?? `任务 ${i.taskId.slice(0, 8)}`}</strong><span>固定 <ShortId value={i.fromRevisionId} /> / 新采纳 <ShortId value={i.toRevisionId} /></span><span>查看影响</span></a></li>)}</ul>}</section>}
    <section className="list-surface" aria-label={title} aria-busy={loading}>
      <p className="work-list-read-status">{loading ? "正在核对当前列表…" : observedAt ? `列表读于 ${observedAt.toLocaleString("zh-CN")}；返回窗口时自动重读，也可手动刷新。` : "列表尚未读回。"}</p>
      <div className="list-toolbar"><label className="search-field"><Search size={16} aria-hidden="true" /><input aria-label={view === "documents" ? "搜索全部文档" : "搜索全部任务"} placeholder={view === "documents" ? "查找文档…" : "查找任务或责任者…"} value={query} onChange={e => setQuery(e.target.value)} /></label>
        {view === "work" && <select aria-label="任务状态筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
        <select aria-label={view === "documents" ? "文档类型筛选" : "任务类型筛选"} value={kindFilter} onChange={e => setKindFilter(e.target.value)}><option value="all">全部类型</option>{Object.entries(view === "documents" ? documentKinds : taskKinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        {view === "documents" && <select aria-label="文档状态筛选" value={documentStatus} onChange={e => setDocumentStatus(e.target.value)}><option value="active">未归档</option>{Object.entries(documentStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="all">全部状态</option></select>}
        <button className="quiet" aria-label="重新读取列表" onClick={context.onChanged}><RefreshCw size={16} /></button>
      </div>
      {loading && <p className="list-message" role="status">正在读取{title}…</p>}
      {error && <div className="list-message"><Alert kind="error">读取失败：{error}</Alert><button onClick={context.onChanged}>重试读取</button></div>}
      {searching && <p className="list-message" role="status">正在搜索后续页面；结果尚未完整。</p>}
      {searchError && <div className="list-message"><Alert kind="error">搜索未完成：{searchError}。当前结果只覆盖已载入项目。</Alert></div>}
      {!loading && !error && <>{view === "documents" ? <div className="table-wrap"><table><thead><tr><th>文档名称</th><th>类型</th><th>状态</th><th>当前修订</th><th>已发布修订</th></tr></thead><tbody>{visibleDocuments.map(d => <tr key={d.id}><td><a href={href(projectId, "document", d.id)}>{d.title}</a><small><ShortId value={d.id} />{d.primaryTaskId && <> · <a href={href(projectId, "task", d.primaryTaskId)}>所属任务</a></>}</small></td><td>{d.kind ? documentKinds[d.kind] : "未分类"}</td><td><span className="pill subtle">{documentStatuses[d.status]}</span></td><td><ShortId value={d.currentRevisionId} /></td><td>{d.adoptedRevisionId ? <ShortId value={d.adoptedRevisionId} /> : "未发布"}</td></tr>)}</tbody></table></div> : view === "work" ? <>
        {statusError && <div className="work-status-warning"><Alert>{statusError}</Alert></div>}
        <div className="work-status-section"><h2>{primaryKind === "unclassified" ? "已载入任务 · 状态分类暂不可用" : "业务工作"} <span>{primaryTasks.length} 项已载入</span></h2>
          {primaryTasks.length ? <TaskListTable tasks={primaryTasks} statuses={statuses} projectId={projectId} pending={pending} /> : <p className="work-status-note">{primaryKind === "unclassified" ? "当前尚无已载入任务。" : "已载入部分暂无可确认的业务任务。"}{tasks.nextCursor ? "仍有下一页任务可读取。" : ""}</p>}</div>
        {unknownTasks.length > 0 && <section className="work-status-section work-status-group" aria-label="来源与状态待核对"><h2>来源与状态待核对 <span>{unknownTasks.length} 项已载入</span></h2><p>状态投影未读全，暂不把这些任务归为业务或系统记录。</p><TaskListTable tasks={unknownTasks} statuses={statuses} projectId={projectId} pending={pending} /></section>}
        {cognitionTasks.length > 0 && <details className="work-status-group"><summary>判断与接续记录 · {cognitionTasks.length} 项已载入</summary><p>由正式认知派发关联的任务；原任务与历史记录均可打开。这里的本轮结果不改写任务状态。</p><TaskListTable tasks={cognitionTasks} statuses={statuses} projectId={projectId} pending={pending} /></details>}
      </> : <TaskListTable tasks={visibleTasks} statuses={statuses} projectId={projectId} pending={pending} />}
      {!searching && !searchError && !(view === "documents" ? visibleDocuments : visibleTasks).length && <div className="list-empty"><FileEmpty /><h2>{query || filter !== "all" || kindFilter !== "all" || view === "documents" && documentStatus !== "active" ? "没有匹配项" : view === "inbox" ? "没有待办任务" : `还没有${title}`}</h2><p>可以清除筛选，或创建一项有明确正文与验收条件的工作。</p><button onClick={() => { setQuery(""); setFilter("all"); setKindFilter("all"); setDocumentStatus("active"); }}>清除筛选</button></div>}
      <div className="list-footer"><span>已载入 {view === "documents" ? documents.items.length : tasks.items.length} 项 · 当前匹配 {view === "documents" ? visibleDocuments.length : visibleTasks.length} 项{view === "work" && (primaryKind === "unclassified" ? `（分类未读回 ${primaryTasks.length}）` : `（业务 ${primaryTasks.length} · 判断 ${cognitionTasks.length} · 待核 ${unknownTasks.length}）`)}</span>{(view === "documents" ? documents.nextCursor : tasks.nextCursor) && <button disabled={busy || searching} onClick={() => void more()}>{busy || searching ? "加载中…" : "加载更多"}</button>}</div></>}
    </section>
    {view === "work" && <><p className="work-guidance">需要推进或调整工作时，先与已有 Agent 沟通；由 Agent 执行变更后，在这里回读核对。</p><div className="context-links"><a href={href(projectId, "journey")}>目标与阶段</a><a href={href(projectId, "discussions")}>阅读负责人讨论材料</a><a href={href(projectId, "documents")}>阅读过程文档</a><a href={href(projectId, "inbox")}>依据复核{pending.length ? `（${pending.length}）` : ""}</a></div></>}
  </div>;
}

function FileEmpty() { return <Search size={27} strokeWidth={1.4} aria-hidden="true" />; }

function TaskListTable({ tasks, statuses, projectId, pending }: { tasks: Task[]; statuses: Record<string, WorkTaskStatus>;
  projectId: string; pending: Impact[] }) {
  return <div className="table-wrap"><table className="task-list-table"><thead><tr><th>任务名称</th><th>状态</th><th>下一步</th><th>类型</th><th>责任者</th><th>版本</th></tr></thead><tbody>{tasks.map(t => {
    const status=statuses[t.id], cognition=status?.cognition ? cognitionSummary(status) : null;
    return <tr key={t.id}>
      <td className="task-list-title"><a href={href(projectId,"task",t.id)}>{cognition?.title ?? t.title}</a>
        <small>{pending.some(i => i.taskId===t.id) && <span className="impact-marker">依据待复核 · </span>}
          {cognition ? <>认知记录 · 原任务 <ShortId value={t.id} /></> : <ShortId value={t.id} />}</small>
        {cognition && <span className="work-status-context">{status?.goalOutcome && <>目标：{status.goalOutcome}</>}{status?.stageDeliverable && <> · 阶段产物：{status.stageDeliverable}</>}</span>}</td>
      <td className="task-list-state"><span className="mobile-field-label">当前状态</span><span className="pill">{cognition?.phase ?? states[t.state]}</span>
        {cognition && <small>任务台账：{states[t.state]}</small>}</td>
      <td className="task-list-next"><span className="mobile-field-label">下一步</span>
        {t.legacyDecision && <strong className="task-list-legacy">{legacyDecisionLabel(t.legacyDecision)}</strong>}
        {cognition?.next ?? (status && businessNextStep(t,status)) ?? taskNextStep(t.state,t.legacyDecision)}
        {cognition && <details className="task-list-legacy-reason"><summary>来源与决定理由</summary>
          <p>{status?.sourceKind === "loop.enrolled" ? "来自工作链首次规划。" : `正式来源：${status?.sourceKind ?? "未读回"}。`}</p>
          {status?.sourceTaskId && <p>源任务（现名称）：<a href={href(projectId,"task",status.sourceTaskId)}>{status.sourceTaskTitle ?? "打开源任务"}</a></p>}
          <p>署名决定：{status?.decisionKind ?? "未记录"}；{status?.decisionReason ?? "暂无可读理由"}</p>
          <a href={href(projectId,"task",t.id)}>打开原任务、运行与完整接续 →</a></details>}
        {t.legacyDecision && <details className="task-list-legacy-reason"><summary>查看旧判断理由</summary><p>{t.legacyDecision.reason}</p><a href={href(projectId,"task",t.id)}>打开任务核对历史 →</a></details>}</td>
      <td className="task-list-kind"><span className="mobile-field-label">类型</span>{t.kind ? taskKinds[t.kind] : "未分类"}</td>
      <td className="task-list-owner"><span className="mobile-field-label">责任者</span>{t.owner}</td>
      <td className="task-list-version"><span className="mobile-field-label">版本</span>v{t.version}</td>
    </tr>;
  })}</tbody></table></div>;
}
