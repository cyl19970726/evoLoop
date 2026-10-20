import { useEffect, useRef, useState } from "react";
import type { Document, Impact, Page, Task } from "@evoloop/contracts";
import { Plus, Search, RefreshCw } from "lucide-react";
import { api, errorText } from "../api";
import { ActionForm, type MutationContext } from "./ActionForm";
import { UploadDocument } from "../documents/UploadDocument";
import { Alert, ShortId, href } from "../ui/shared";
import { Button } from "../components/ui/button";

const states: Record<string, string> = { proposed: "拟议", ready: "可做", active: "进行中", review: "待验收", done: "已完成", blocked: "阻塞", deferred: "暂缓", cancelled: "已取消" };

export function WorkIndex({ context, refresh, view }: { context: MutationContext; refresh: number; view: "work" | "inbox" | "documents" }) {
  const { token, projectId } = context;
  const [tasks, setTasks] = useState<Page<Task>>({ items: [], nextCursor: null });
  const [documents, setDocuments] = useState<Page<Document>>({ items: [], nextCursor: null });
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [judgements, setJudgements] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [create, setCreate] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    let active = true; ++epoch.current; setLoading(true); setError("");
    const client = api(token);
    Promise.all([client.tasks(projectId), client.documents(projectId), client.impacts(projectId)]).then(([t, d, i]) => {
      if (active) { setTasks(t); setDocuments(d); setImpacts(i); }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, projectId, refresh]);
  useEffect(() => {
    let active = true; setJudgements({}); let next = 0;
    const proposed = tasks.items.filter(t => t.state === "proposed");
    void Promise.all(Array.from({ length: Math.min(6, proposed.length) }, async () => {
      while (active && next < proposed.length) {
        const task = proposed[next++]!;
        try {
          const d = await api(token).task(projectId, task.id);
          const j = (d.judgements ?? []).filter(j => j.taskRevisionId === d.revision.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
          if (active) setJudgements(v => ({ ...v, [task.id]: j?.decision ?? "none" }));
        } catch { if (active) setJudgements(v => ({ ...v, [task.id]: "unavailable" })); }
      }
    }));
    return () => { active = false; };
  }, [token, projectId, tasks]);
  async function more() {
    if (busy) return; setBusy(true); const readEpoch = epoch.current;
    try {
      const client = api(token);
      if (view === "documents" && documents.nextCursor) {
        const page = await client.documents(projectId, documents.nextCursor);
        if (readEpoch === epoch.current) setDocuments(v => ({ items: [...v.items, ...page.items], nextCursor: page.nextCursor }));
      } else if (tasks.nextCursor) {
        const page = await client.tasks(projectId, tasks.nextCursor);
        if (readEpoch === epoch.current) setTasks(v => ({ items: [...v.items, ...page.items], nextCursor: page.nextCursor }));
      }
    } catch (cause) { if (readEpoch === epoch.current) setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const pending = impacts.filter(i => i.state === "pending");
  const visibleTasks = tasks.items.filter(t => (view !== "inbox" || t.state === "proposed") && (filter === "all" || t.state === filter) && `${t.title} ${t.owner} ${t.id}`.toLowerCase().includes(query.toLowerCase()));
  const visibleDocuments = documents.items.filter(d => `${d.title} ${d.id}`.toLowerCase().includes(query.toLowerCase()));
  const title = view === "documents" ? "过程文档" : view === "inbox" ? "待判断与复核" : "任务";
  return <div className="content work-index">
    <div className="page-title-row"><div><h1>{title}</h1><p className="lede">{view === "documents" ? "阅读完整原件，核对当前修订与已采纳版本。" : view === "inbox" ? "先读证据，再决定接受提议或复核依据变化。" : "查看任务进展、固定依据与最新结果。"}</p></div>
      {view === "documents" ? <Button onClick={() => setCreate(!create)} aria-expanded={create}><Plus size={16} />保存文档</Button> : <a className="button-link" href={`${href(projectId, "journey")}?action=propose`}><Plus size={16} aria-hidden="true" />提出任务</a>}
    </div>
    {view === "documents" && <div hidden={!create} className="panel"><h2>保存过程文档</h2><ActionForm context={context} title="创建文档" fields={[{ name: "title", label: "文档名称" }, { name: "body", label: "完整 Markdown 正文", kind: "textarea" }]} build={v => ({ type: "document.create", documentId: crypto.randomUUID(), ...v })} /><UploadDocument context={context} /></div>}
    {view === "inbox" && <section className="panel impact-summary"><div className="panel-head"><h2>依据变化</h2><span>{pending.length} 项待复核</span></div>{!pending.length ? <p className="empty">当前没有待复核的依据变化。</p> : <ul className="impact-list">{pending.map(i => <li key={i.id}><a href={href(projectId, "task", i.taskId)}><strong>{tasks.items.find(t => t.id === i.taskId)?.title ?? `任务 ${i.taskId.slice(0, 8)}`}</strong><span>固定 <ShortId value={i.fromRevisionId} /> / 新采纳 <ShortId value={i.toRevisionId} /></span><span>查看影响</span></a></li>)}</ul>}</section>}
    <section className="list-surface" aria-label={title} aria-busy={loading}>
      <div className="list-toolbar"><label className="search-field"><Search size={16} aria-hidden="true" /><input aria-label={view === "documents" ? "筛选已载入文档" : "筛选已载入任务"} placeholder={view === "documents" ? "查找已载入文档…" : "查找任务或责任者…"} value={query} onChange={e => setQuery(e.target.value)} /></label>
        {view === "work" && <select aria-label="执行状态筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部执行状态</option>{Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
        <button className="quiet" aria-label="重新读取列表" onClick={context.onChanged}><RefreshCw size={16} /></button>
      </div>
      {loading && <p className="list-message" role="status">正在读取{title}…</p>}
      {error && <div className="list-message"><Alert kind="error">读取失败：{error}</Alert><button onClick={context.onChanged}>重试读取</button></div>}
      {!loading && !error && <><div className="table-wrap">{view === "documents" ? <table><thead><tr><th>文档名称</th><th>当前修订</th><th>已采纳修订</th><th>版本</th></tr></thead><tbody>{visibleDocuments.map(d => <tr key={d.id}><td><a href={href(projectId, "document", d.id)}>{d.title}</a><small><ShortId value={d.id} /></small></td><td><ShortId value={d.currentRevisionId} /></td><td>{d.adoptedRevisionId ? <ShortId value={d.adoptedRevisionId} /> : "未采纳"}</td><td>v{d.version}</td></tr>)}</tbody></table> : <table><thead><tr><th>任务名称</th><th>执行状态</th><th>接受判断</th><th>责任者</th><th>版本</th></tr></thead><tbody>{visibleTasks.map(t => <tr key={t.id}><td><a href={href(projectId, "task", t.id)}>{t.title}</a><small>{pending.some(i => i.taskId === t.id) && <span className="impact-marker">依据待复核 · </span>}<ShortId value={t.id} /></small></td><td><span className="pill">{states[t.state]}</span></td><td><span className="pill subtle">{t.state !== "proposed" ? "已接受" : ({ approve: "可接受", reject: "已拒绝", defer: "暂缓判断", needsEvidence: "待补证", none: "待判断", unavailable: "判断不可读" } as Record<string, string>)[judgements[t.id] ?? ""] ?? "读取中…"}</span></td><td>{t.owner}</td><td>v{t.version}</td></tr>)}</tbody></table>}</div>
      {!(view === "documents" ? visibleDocuments : visibleTasks).length && <div className="list-empty"><FileEmpty /><h2>{query || filter !== "all" ? "没有匹配项" : view === "inbox" ? "没有待判断的提议" : `还没有${title}`}</h2><p>{query || filter !== "all" ? "试试其他关键词，或清除筛选。筛选仅覆盖当前已载入的条目。" : view === "documents" ? "保存第一份过程文档，再将固定修订用于任务。" : "从目标与阶段提出工作，保留证据和验收条件。"}</p>{(query || filter !== "all") && <button onClick={() => { setQuery(""); setFilter("all"); }}>清除筛选</button>}</div>}
      <div className="list-footer"><span>已载入 {view === "documents" ? documents.items.length : tasks.items.length} 项{query || filter !== "all" || view === "inbox" ? ` · 当前显示 ${view === "documents" ? visibleDocuments.length : visibleTasks.length} 项` : ""}</span>{(view === "documents" ? documents.nextCursor : tasks.nextCursor) && <button disabled={busy} onClick={() => void more()}>{busy ? "加载中…" : "加载更多"}</button>}</div></>}
    </section>
    {view === "work" && <><p className="work-guidance">需要推进或调整工作时，先与已有 Agent 沟通；由 Agent 执行变更后，在这里回读核对。</p><div className="context-links"><a href={href(projectId, "journey")}>目标与阶段</a><a href={href(projectId, "discussions")}>阅读负责人讨论材料</a><a href={href(projectId, "documents")}>阅读过程文档</a><a href={href(projectId, "inbox")}>依据复核{pending.length ? `（${pending.length}）` : ""}</a></div></>}
  </div>;
}

function FileEmpty() { return <Search size={27} strokeWidth={1.4} aria-hidden="true" />; }
