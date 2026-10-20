import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  BasisSet, Command, Document, DocumentDetail, DocumentRevision, Impact,
  Operation, Page, Principal, Project, Task, TaskDetail, TaskRevision,
} from "@evoloop/contracts";
import { api, ApiError, errorText, isUnconfirmed, type Session } from "./api";
import { addReceipt, readReceipts, removeReceipt, visibleReceipts as forPrincipal, writeReceipts, type OperationReceipt } from "./recovery";

type Section = "overview" | "work" | "knowledge" | "task" | "document";
type Route = { projectId: string | null; section: Section; id?: string; revision?: string };
type UnknownCommand = Extract<Command, { type: "task.reviewBasis" }>;

function readRoute(): Route {
  const raw = window.location.hash.slice(1) || "/";
  const [pathname, search = ""] = raw.split("?");
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "p" || !parts[1]) return { projectId: null, section: "overview" };
  const section = parts[2];
  const revision = new URLSearchParams(search).get("revision") || undefined;
  if (section === "tasks" && parts[3]) return { projectId: parts[1], section: "task", id: parts[3], revision };
  if (section === "documents" && parts[3]) return { projectId: parts[1], section: "document", id: parts[3], revision };
  if (section === "work" || section === "knowledge") return { projectId: parts[1], section };
  return { projectId: parts[1], section: "overview" };
}

function href(projectId: string, section: Section, id?: string, revision?: string): string {
  const part = section === "task" ? `tasks/${id}` : section === "document" ? `documents/${id}` : section;
  return `#/p/${projectId}/${part}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`;
}

function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

function date(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("zh-CN");
}

function ShortId({ value }: { value: string }) {
  return <code title={value}>{value.slice(0, 8)}</code>;
}

function Alert({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "error" | "success" }) {
  return <div className={`notice ${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

function AuthGate({ onSuccess, hasReceipts }: { onSuccess: (token: string, session: Session) => void; hasReceipts: boolean }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const value = input.trim();
      const session = await api(value).session();
      setInput("");
      onSuccess(value, session);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <main className="auth-shell">
    <div className="auth-card">
      <div className="eyebrow">evoLoop · 本机工作台</div>
      <h1>进入项目工作台</h1>
      <p>输入本机访问令牌以读取你有权限的项目。令牌只保存在当前页面内存中，刷新后需要重新输入。</p>
      {hasReceipts && <Alert>本浏览器会话保留了尚未核对的操作 ID。用原身份登录后可逐项查询；回执不包含令牌或复核正文。</Alert>}
      <form onSubmit={submit}>
        <label htmlFor="token">访问令牌</label>
        <input id="token" type="password" autoComplete="off" value={input} onChange={e => setInput(e.target.value)} required />
        <button className="primary" type="submit" disabled={busy}>{busy ? "正在核对…" : "进入"}</button>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
    </div>
  </main>;
}

function OperationCheck({ receipt, token, onConfirmed }: {
  receipt: OperationReceipt; token: string;
  onConfirmed: (result: Operation["result"]) => void;
}) {
  const [status, setStatus] = useState("这次复核可能已提交。请按原操作 ID 核对，确认前不要为同一任务重发。");
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    try {
      const operation: Operation = await api(token).operation(receipt.projectId, receipt.operationId);
      if (operation.id !== receipt.operationId || operation.projectId !== receipt.projectId
        || operation.actorId !== receipt.actorId || operation.commandType !== receipt.commandType
        || operation.result.operationId !== receipt.operationId) {
        setStatus("操作记录与本地回执不匹配；仍需人工核对，不能据此重发。");
        return;
      }
      onConfirmed(operation.result);
    } catch (cause) {
      setStatus(cause instanceof ApiError && cause.status === 404
        ? "尚未查到操作记录；结果仍未确认。请核对服务状态后继续用同一 ID 查询。"
        : `暂未核清：${errorText(cause)}`);
    } finally { setBusy(false); }
  }
  return <Alert kind="error">
    <strong>提交结果待核对</strong><p>{status}</p>
    <p>项目 <ShortId value={receipt.projectId} /> · 任务 <ShortId value={receipt.taskId} /> · 提交于 {date(receipt.createdAt)}</p>
    <p>操作 ID：<code>{receipt.operationId}</code></p>
    <div className="actions"><button onClick={check} disabled={busy}>{busy ? "核对中…" : "按操作 ID 核对"}</button></div>
  </Alert>;
}

function ProjectChooser({ token, principal, receipts, onRefreshSession }: { token: string; principal: Principal; receipts: OperationReceipt[]; onRefreshSession: () => Promise<void> }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all(principal.projectIds.map(async id => {
      try { return { project: await api(token).project(id), id }; }
      catch { return { project: null, id }; }
    })).then(results => {
      if (!active) return;
      setProjects(results.flatMap(r => r.project ? [r.project] : []));
      setMissing(results.filter(r => !r.project).map(r => r.id));
    });
    return () => { active = false; };
  }, [principal.projectIds, token, refresh]);
  async function refreshProjects() {
    if (refreshing) return;
    setRefreshing(true); setRefreshError("");
    try { await onRefreshSession(); setRefresh(value => value + 1); }
    catch (cause) { setRefreshError(errorText(cause)); }
    finally { setRefreshing(false); }
  }
  return <section className="content narrow">
    <div className="eyebrow">选择项目</div><h1>你的项目</h1>
    <button type="button" className="quiet" onClick={refreshProjects} disabled={refreshing}>{refreshing ? "刷新中…" : "刷新项目"}</button>
    {refreshError && <Alert kind="error">刷新失败：{refreshError}</Alert>}
    {projects.length ? <div className="project-list">{projects.map(p => <a className="project-item" key={p.id} href={href(p.id, "overview")}><strong>{p.title}</strong><span>{receipts.filter(r => r.projectId === p.id).length > 0 && `待核对操作 ${receipts.filter(r => r.projectId === p.id).length} 项 · `}<ShortId value={p.id} />　进入工作台 →</span></a>)}</div> : <Alert>当前没有可读取的项目。可用 CLI 准备项目与首份需求，再回到这里。</Alert>}
    {missing.length > 0 && <Alert kind="error">有 {missing.length} 个授权项目暂不可读取；请核对服务端项目状态。</Alert>}
  </section>;
}

function Board({ token, projectId, section, refresh }: { token: string; projectId: string; section: "overview" | "work"; refresh: number }) {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Page<Task> | null>(null);
  const [documents, setDocuments] = useState<Page<Document> | null>(null);
  const [impacts, setImpacts] = useState<Impact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<string[]>([]);
  const [error, setError] = useState("");
  const epochRef = useRef(0);
  const moreInFlightRef = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    const epoch = ++epochRef.current;
    moreInFlightRef.current.clear();
    setLoading(true); setLoadingMore([]); setError("");
    const client = api(token);
    Promise.all([client.project(projectId), client.tasks(projectId), client.documents(projectId), client.impacts(projectId)])
      .then(([p, t, d, i]) => { if (active && epoch === epochRef.current) { setProject(p); setTasks(t); setDocuments(d); setImpacts(i); } })
      .catch(cause => { if (active && epoch === epochRef.current) setError(errorText(cause)); })
      .finally(() => { if (active && epoch === epochRef.current) setLoading(false); });
    return () => { active = false; };
  }, [token, projectId, refresh]);
  async function more(kind: "tasks" | "documents") {
    if (moreInFlightRef.current.has(kind)) return;
    const epoch = epochRef.current;
    moreInFlightRef.current.add(kind);
    setLoadingMore(current => [...current, kind]);
    try {
      const client = api(token);
      if (kind === "tasks" && tasks?.nextCursor) {
        const page = await client.tasks(projectId, tasks.nextCursor);
        if (epoch === epochRef.current) setTasks({ items: [...tasks.items, ...page.items], nextCursor: page.nextCursor });
      }
      if (kind === "documents" && documents?.nextCursor) {
        const page = await client.documents(projectId, documents.nextCursor);
        if (epoch === epochRef.current) setDocuments({ items: [...documents.items, ...page.items], nextCursor: page.nextCursor });
      }
    } catch (cause) { if (epoch === epochRef.current) setError(errorText(cause)); }
    finally {
      if (epoch === epochRef.current) {
        moreInFlightRef.current.delete(kind);
        setLoadingMore(current => current.filter(value => value !== kind));
      }
    }
  }
  if (loading) return <div className="content"><p>正在读取项目…</p></div>;
  if (error) return <div className="content"><Alert kind="error">{error}</Alert></div>;
  return <div className="content">
    <div className="eyebrow">{section === "overview" ? "项目总览" : "工作"}</div>
    <h1>{project?.title || "项目"}</h1>
    <p className="lede">从待复核影响进入决定，或沿任务与过程文档查看固定依据。</p>
    <div className="stats"><div><strong>{impacts.filter(i => i.state === "pending").length}</strong><span>待复核影响</span></div><div><strong>{tasks?.items.length || 0}</strong><span>已载入任务</span></div><div><strong>{documents?.items.length || 0}</strong><span>已载入过程文档</span></div></div>
    <section className="panel"><div className="panel-head"><h2>待复核</h2><span>依据变化需要明确决定</span></div>
      {impacts.filter(i => i.state === "pending").length ? <ul className="impact-list">{impacts.filter(i => i.state === "pending").map(i => <li key={i.id}><a href={href(projectId, "task", i.taskId)}><strong>任务 <ShortId value={i.taskId} /></strong><span>过程文档版本 <ShortId value={i.fromRevisionId} /> → <ShortId value={i.toRevisionId} /></span><span className="arrow">查看影响 →</span></a></li>)}</ul> : <p className="empty">当前没有待复核影响。</p>}
    </section>
    <section className="panel"><div className="panel-head"><h2>任务</h2><span>固定执行依据见任务详情</span></div>
      <div className="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>负责人</th><th>版本</th></tr></thead><tbody>{tasks?.items.map(t => <tr key={t.id}><td><a href={href(projectId, "task", t.id)}>{t.title}</a><small><ShortId value={t.id} /></small></td><td><span className="pill">{t.state}</span></td><td>{t.owner}</td><td>v{t.version}</td></tr>)}</tbody></table></div>
      {!tasks?.items.length && <p className="empty">还没有任务。可用 CLI 准备第一条任务。</p>}
      {tasks?.nextCursor && <button className="more" disabled={loadingMore.includes("tasks")} onClick={() => more("tasks")}>{loadingMore.includes("tasks") ? "加载中…" : "加载更多任务"}</button>}
    </section>
    <section className="panel"><div className="panel-head"><h2>过程文档</h2><span>按需读取完整正文</span></div>
      <div className="table-wrap"><table><thead><tr><th>文档</th><th>当前修订</th><th>已采纳修订</th><th>版本</th></tr></thead><tbody>{documents?.items.map(d => <tr key={d.id}><td><a href={href(projectId, "document", d.id)}>{d.title}</a><small><ShortId value={d.id} /></small></td><td><ShortId value={d.currentRevisionId} /></td><td>{d.adoptedRevisionId ? <ShortId value={d.adoptedRevisionId} /> : "未采纳"}</td><td>v{d.version}</td></tr>)}</tbody></table></div>
      {!documents?.items.length && <p className="empty">还没有过程文档。可用 CLI 准备第一份 Markdown 需求。</p>}
      {documents?.nextCursor && <button className="more" disabled={loadingMore.includes("documents")} onClick={() => more("documents")}>{loadingMore.includes("documents") ? "加载中…" : "加载更多文档"}</button>}
    </section>
  </div>;
}

function RevisionBody({ revision, label }: { revision: DocumentRevision; label?: string }) {
  return <section className="revision-body">
    {label && <div className="eyebrow">{label}</div>}
    <div className="revision-meta"><span>修订 <ShortId value={revision.id} /></span><span>{date(revision.createdAt)}</span><span>作者 {revision.author}</span></div>
    <pre>{revision.body}</pre>
    <p className="muted">原文 Markdown · <code title={revision.contentHash}>{revision.contentHash.slice(0, 22)}…</code> · 仅按文本展示</p>
  </section>;
}

function DocumentPage({ token, projectId, id, selectedRevision }: { token: string; projectId: string; id: string; selectedRevision?: string }) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [revision, setRevision] = useState<DocumentRevision | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setDetail(null); setRevision(null); setError("");
    api(token).document(projectId, id).then(async d => {
      const r = selectedRevision ? await api(token).documentRevision(projectId, id, selectedRevision) : d.current;
      if (active) { setDetail(d); setRevision(r); }
    }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [token, projectId, id, selectedRevision]);
  if (error) return <div className="content"><Alert kind="error">{error}</Alert></div>;
  if (!detail || !revision) return <div className="content"><p>正在读取文档…</p></div>;
  return <div className="content reading">
    <a className="back" href={href(projectId, "work")}>← 返回工作</a>
    <div className="eyebrow">过程文档</div><h1>{detail.document.title}</h1>
    <p className="lede">{selectedRevision ? "正在阅读固定历史修订。" : "正在阅读当前修订。"} 已采纳版与当前版分别标明。</p>
    <div className="actions">
      <a className="button-link" href={href(projectId, "document", id, detail.current.id)}>当前版 <ShortId value={detail.current.id} /></a>
      {detail.adopted && <a className="button-link" href={href(projectId, "document", id, detail.adopted.id)}>已采纳版 <ShortId value={detail.adopted.id} /></a>}
      {revision.previousRevisionId && <a className="button-link" href={href(projectId, "document", id, revision.previousRevisionId)}>上一版</a>}
    </div>
    <RevisionBody revision={revision} />
  </div>;
}

function Basis({ basis, projectId }: { basis: BasisSet | null; projectId: string }) {
  if (!basis) return <p className="empty">这个任务修订没有固定依据集合。</p>;
  return <ul className="basis-list">{basis.members.map(member => <li key={`${member.documentId}:${member.revisionId}`}><a href={href(projectId, "document", member.documentId, member.revisionId)}>过程文档 <ShortId value={member.documentId} /> · 修订 <ShortId value={member.revisionId} /> →</a></li>)}</ul>;
}

function ImpactReview({ token, projectId, detail, impact, onChanged, onAttempt, onKnown, blockedByUnknown, canReview }: {
  token: string; projectId: string; detail: TaskDetail; impact: Impact;
  onChanged: () => void; onAttempt: (command: UnknownCommand) => boolean; onKnown: (operationId: string) => void; blockedByUnknown: boolean; canReview: boolean;
}) {
  const [before, setBefore] = useState<DocumentRevision | null>(null);
  const [after, setAfter] = useState<DocumentRevision | null>(null);
  const [reason, setReason] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [decision, setDecision] = useState<"adopt" | "retain">("adopt");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState("");
  const [readVersion, setReadVersion] = useState(detail.task.version);
  useEffect(() => {
    let active = true;
    setBefore(null); setAfter(null); setMessage(""); setConflict(false);
    setReadVersion(detail.task.version);
    Promise.all([
      api(token).documentRevision(projectId, impact.documentId, impact.fromRevisionId),
      api(token).documentRevision(projectId, impact.documentId, impact.toRevisionId),
    ]).then(([a, b]) => { if (active) { setBefore(a); setAfter(b); } })
      .catch(cause => { if (active) setMessage(errorText(cause)); });
    return () => { active = false; };
  }, [token, projectId, impact.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || conflict || blockedByUnknown || !canReview || impact.state !== "pending" || !reason.trim()) return;
    const command: UnknownCommand = {
      type: "task.reviewBasis", projectId, taskId: detail.task.id,
      expectedVersion: readVersion, impactId: impact.id, decision,
      reason: reason.trim(), ...(decision === "adopt" && acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
      operationId: crypto.randomUUID(),
    };
    if (!onAttempt(command)) {
      setMessage(`无法保存操作回执，本次未发送。请启用浏览器会话存储后重试。操作 ID：${command.operationId}`);
      return;
    }
    setBusy(true); setMessage("");
    try {
      const result = await api(token).command(command);
      onKnown(command.operationId);
      if (result.status === "applied") {
        setMessage("复核已应用，正在回读任务与列表。");
        onChanged();
      } else {
        setMessage(`复核被拒绝：${result.message}`);
        setConflict(true);
        onChanged();
      }
    } catch (cause) {
      if (isUnconfirmed(cause)) {
        setMessage("结果尚未确认。先核对原操作 ID，暂勿再次提交。");
        setConflict(true);
      } else {
        onKnown(command.operationId);
        if (cause instanceof ApiError && cause.status === 409) {
          setMessage(`版本已变化：${cause.message}。输入已保留；请查看回读后的依据并明确重新选择。`);
          setConflict(true); onChanged();
        } else { setMessage(errorText(cause)); }
      }
    } finally { setBusy(false); }
  }
  return <div className="review-layout">
    <div className="compare">
      {before ? <RevisionBody revision={before} label="任务原依据" /> : <p>正在读取原依据…</p>}
      {after ? <RevisionBody revision={after} label="新文档修订" /> : <p>正在读取新修订…</p>}
    </div>
    <form className="review-form" onSubmit={submit}>
      <div className="eyebrow">复核决定 · Task v{readVersion}</div>
      <h3>这次变化如何影响任务？</h3>
      <label className="choice"><input type="radio" checked={decision === "adopt"} onChange={() => setDecision("adopt")} />采用新修订</label>
      <label className="choice"><input type="radio" checked={decision === "retain"} onChange={() => setDecision("retain")} />保留原依据</label>
      <label htmlFor="reason">理由</label>
      <textarea id="reason" value={reason} onChange={e => setReason(e.target.value)} minLength={1} maxLength={4000} required rows={4} placeholder="说明判断依据与影响" />
      {decision === "adopt" && <><label htmlFor="acceptance">新的验收条件（可选）</label><textarea id="acceptance" value={acceptance} onChange={e => setAcceptance(e.target.value)} maxLength={4000} rows={3} placeholder="留空则沿用当前验收条件" /></>}
      <button className="primary" type="submit" disabled={busy || conflict || blockedByUnknown || !canReview || impact.state !== "pending" || !before || !after}>{busy ? "正在提交…" : "提交复核决定"}</button>
      {!canReview && <Alert>当前身份没有复核权限，仍可阅读固定依据。</Alert>}
      {impact.state !== "pending" && <Alert>这项影响已不再待复核。保留当前输入供你核对，不能按旧状态提交。</Alert>}
      {blockedByUnknown && <Alert kind="error">同一任务有结果未确认的命令。请先按上方操作 ID 核对。</Alert>}
      {conflict && !blockedByUnknown && <button type="button" className="quiet" onClick={() => { setReadVersion(detail.task.version); setConflict(false); setMessage("请再次核对原依据、新修订和当前任务，再提交保留的输入。"); }}>重新核对当前版本</button>}
      {message && <Alert kind={conflict ? "error" : "info"}>{message}</Alert>}
    </form>
  </div>;
}

function TaskPage({ token, projectId, id, refresh, onChanged, onAttempt, onKnown, blockedByUnknown, canReview }: {
  token: string; projectId: string; id: string; refresh: number;
  onChanged: () => void; onAttempt: (command: UnknownCommand) => boolean; onKnown: (operationId: string) => void; blockedByUnknown: boolean; canReview: boolean;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [selectedImpactId, setSelectedImpactId] = useState<string | null>(null);
  const [historical, setHistorical] = useState<{ taskId: string; revision: TaskRevision; basis: BasisSet | null } | null>(null);
  const [error, setError] = useState("");
  const historyRequestRef = useRef(0);
  useEffect(() => { ++historyRequestRef.current; setHistorical(null); }, [id, projectId]);
  useEffect(() => {
    let active = true;
    setError("");
    api(token).task(projectId, id).then(value => {
      if (!active) return;
      setDetail(value);
      setSelectedImpactId(current => value.impacts.some(i => i.id === current) ? current : value.impacts.find(i => i.state === "pending")?.id || null);
    }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [token, projectId, id, refresh]);
  async function showHistory(revisionId: string) {
    const sequence = ++historyRequestRef.current;
    setHistorical(null); setError("");
    try {
      const value = await api(token).taskRevision(projectId, id, revisionId);
      if (sequence === historyRequestRef.current) setHistorical({ taskId: id, ...value });
    } catch (cause) { if (sequence === historyRequestRef.current) setError(errorText(cause)); }
  }
  if (error && !detail) return <div className="content"><Alert kind="error">{error}</Alert></div>;
  if (!detail || detail.task.id !== id) return <div className="content"><p>正在读取任务…</p></div>;
  const pending = detail.impacts.filter(i => i.state === "pending");
  const selected = detail.impacts.find(i => i.id === selectedImpactId);
  return <div className="content">
    <a className="back" href={href(projectId, "work")}>← 返回工作</a>
    <div className="eyebrow">任务 · v{detail.task.version}</div><h1>{detail.task.title}</h1>
    <div className="task-header"><span className="pill">{detail.task.state}</span><span>负责人：{detail.task.owner}</span><span>当前修订 <ShortId value={detail.revision.id} /></span></div>
    {error && <Alert kind="error">{error}</Alert>}
    <section className="panel"><h2>目标与验收</h2><p>{detail.task.goal}</p><h3>验收条件</h3><p>{detail.task.acceptance}</p></section>
    <section className="panel"><div className="panel-head"><h2>当前固定依据</h2><span>任务修订 <ShortId value={detail.revision.id} /></span></div><Basis basis={detail.basis} projectId={projectId} /></section>
    <section className="panel"><div className="panel-head"><h2>待复核的依据变化</h2><span>{pending.length} 项</span></div>
      {!pending.length && <p className="empty">当前没有待复核影响。</p>}
      {pending.length > 0 && <div className="impact-tabs">{pending.map(i => <button key={i.id} className={i.id === selectedImpactId ? "active" : ""} onClick={() => setSelectedImpactId(i.id)}>文档 <ShortId value={i.documentId} /> · <ShortId value={i.toRevisionId} /></button>)}</div>}
      {selected && <ImpactReview key={selected.id} token={token} projectId={projectId} detail={detail} impact={selected} onChanged={onChanged} onAttempt={onAttempt} onKnown={onKnown} blockedByUnknown={blockedByUnknown} canReview={canReview} />}
    </section>
    <section className="panel"><h2>已作决定</h2>
      {!detail.decisions.length && <p className="empty">尚无复核决定。</p>}
      {detail.decisions.map(d => <div className="decision" key={d.id}><strong>{d.decision === "adopt" ? "采用新修订" : "保留原依据"}</strong><span>{date(d.createdAt)} · {d.actorId}</span><p>{d.reason}</p><button className="quiet" onClick={() => showHistory(d.previousTaskRevisionId)}>查看决定前的任务依据</button></div>)}
      {historical?.taskId === id && <div className="history"><h3>决定前 · Task v{historical.revision.version}</h3><p>{historical.revision.goal}</p><p><strong>当时验收：</strong>{historical.revision.acceptance}</p><Basis basis={historical.basis} projectId={projectId} /></div>}
    </section>
  </div>;
}

export function App() {
  const route = useRoute();
  const [token, setToken] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [receipts, setReceipts] = useState<OperationReceipt[]>(readReceipts);
  const receiptsRef = useRef(receipts);
  const [receiptStorageAvailable, setReceiptStorageAvailable] = useState(true);
  const [operationNotice, setOperationNotice] = useState("");
  const [projectError, setProjectError] = useState("");
  const projectId = route.projectId && session?.principal.projectIds.includes(route.projectId) ? route.projectId : null;
  const client = useMemo(() => api(token), [token]);
  const visibleReceipts = session ? forPrincipal(receipts, session.principal.actorId, session.principal.projectIds) : [];
  function replaceReceipts(next: OperationReceipt[]) {
    receiptsRef.current = next;
    setReceipts(next);
    setReceiptStorageAvailable(writeReceipts(next));
  }
  function beginAttempt(command: UnknownCommand): boolean {
    if (!session) return false;
    const next = addReceipt(receiptsRef.current, {
      actorId: session!.principal.actorId,
      projectId: command.projectId,
      taskId: command.taskId,
      operationId: command.operationId,
      commandType: command.type,
      createdAt: new Date().toISOString(),
    });
    if (!writeReceipts(next)) { setReceiptStorageAvailable(false); return false; }
    receiptsRef.current = next;
    setReceipts(next);
    setReceiptStorageAvailable(true);
    return true;
  }
  function finishKnown(operationId: string) {
    replaceReceipts(removeReceipt(receiptsRef.current, operationId));
  }
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!receiptsRef.current.length) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  useEffect(() => {
    if (!projectId || !session) return;
    let active = true;
    client.project(projectId).then(() => { if (active) setProjectError(""); })
      .catch(cause => { if (active) setProjectError(errorText(cause)); });
    return () => { active = false; };
  }, [client, projectId, session, refresh]);
  if (!session) return <AuthGate hasReceipts={receipts.length > 0} onSuccess={(value, next) => { setToken(value); setSession(next); }} />;
  const principal = session.principal;
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#/">evoLoop <span>工作台</span></a><div className="identity"><span>{principal.actorId}</span><button className="quiet" onClick={() => {
      if (visibleReceipts.length && !window.confirm(`仍有 ${visibleReceipts.length} 个结果未确认的操作。回执会留在当前浏览器会话；退出后请用同一身份登录核对。确定退出？`)) return;
      setToken(""); setSession(null);
    }}>退出</button></div></header>
    {projectId ? <>
      <nav className="main-nav" aria-label="主导航">
        <a className={route.section === "overview" ? "active" : ""} href={href(projectId, "overview")}>总览</a>
        <a className={["work", "task", "document"].includes(route.section) ? "active" : ""} href={href(projectId, "work")}>工作</a>
        <a className={route.section === "knowledge" ? "active" : ""} href={href(projectId, "knowledge")}>知识</a>
        <a href="#/">切换项目</a>
      </nav>
      {visibleReceipts.filter(r => r.projectId === projectId).map(receipt => <div className="global-alert" key={receipt.operationId}><OperationCheck receipt={receipt} token={token} onConfirmed={result => {
        setOperationNotice(result.status === "applied" ? `操作 ${receipt.operationId} 已应用；正在回读当前数据。` : `操作 ${receipt.operationId} 被拒绝：${result.message}`);
        replaceReceipts(removeReceipt(receiptsRef.current, receipt.operationId));
        setRefresh(v => v + 1);
      }} /></div>)}
      {!receiptStorageAvailable && <div className="global-alert"><Alert kind="error">浏览器未能暂存操作回执。请复制上方操作 ID；刷新或关闭页面后可能无法从此界面找回。</Alert></div>}
      {operationNotice && <div className="global-alert"><Alert kind="info">{operationNotice} <button className="quiet" onClick={() => setOperationNotice("")}>关闭</button></Alert></div>}
      {projectError ? <div className="content"><Alert kind="error">项目暂不可读取：{projectError}</Alert><button onClick={() => setRefresh(v => v + 1)}>重试读取项目</button></div> : <>
        {(route.section === "overview" || route.section === "work") && <Board token={token} projectId={projectId} section={route.section} refresh={refresh} />}
        {route.section === "knowledge" && <div className="content narrow"><div className="eyebrow">知识</div><h1>知识空间尚未接通</h1><Alert>当前切片仅支持过程文档、任务固定依据与影响复核。Wiki、知识图谱和来源查询须待知识后端接入后开放。</Alert><p className="muted">飞书同步与 Codex 会话控制也尚未接通。</p></div>}
        {route.section === "task" && route.id && <TaskPage token={token} projectId={projectId} id={route.id} refresh={refresh} onChanged={() => setRefresh(v => v + 1)} onAttempt={beginAttempt} onKnown={finishKnown} blockedByUnknown={visibleReceipts.some(r => r.projectId === projectId && r.taskId === route.id)} canReview={principal.permissions.includes("review")} />}
        {route.section === "document" && route.id && <DocumentPage token={token} projectId={projectId} id={route.id} selectedRevision={route.revision} />}
      </>}
    </> : <ProjectChooser token={token} principal={principal} receipts={visibleReceipts} onRefreshSession={async () => setSession(await api(token).session())} />}
  </div>;
}
