import { useEffect, useRef, useState, useId, type FormEvent } from "react";
import type { BasisSet, Command, DocumentDetail, DocumentRevision, Impact, TaskDetail, TaskRevision } from "@evoloop/contracts";
import { api, ApiError, errorText, isUnconfirmed, safeArtifactHref } from "../api";
import { Alert, ShortId, RevisionBody, date, href, taskListHref } from "../ui/shared";
import type { MutationContext } from "./ActionForm";
import { RuntimePanel } from "../runtime/RuntimePanel";
import { ReferencePanel } from "../references/ReferencePanel";
import { TaskWorkflow } from "./TaskWorkflow";
import { taskStateLabel, taskKindLabel } from "./TaskWorkflow";
import { MarkdownBody } from "../ui/MarkdownBody";
import { legacyDecisionLabel } from "./taskListPresentation";
import "./task-page.css";
type UnknownCommand = Command;
type TaskTab = "overview" | "basis" | "delivery" | "runtime" | "history" | "actions";
const taskTabs: { id: TaskTab; label: string }[] = [
  { id: "overview", label: "概览" }, { id: "basis", label: "依据与影响" },
  { id: "delivery", label: "交付与使用" }, { id: "runtime", label: "运行与关联" },
  { id: "history", label: "历史" }, { id: "actions", label: "任务操作" },
];
const useResults = { used: "已使用", failed: "使用失败", notUsed: "尚未使用" } as const;
function Basis({ basis, projectId, documents }: { basis: BasisSet | null; projectId: string; documents?: Record<string, DocumentDetail> }) {
  if (!basis) return <p className="empty">这个任务修订没有固定依据集合。</p>;
  return <ul className="basis-list task-basis-list">{basis.members.map(member => {
    const document = documents?.[member.documentId];
    return <li key={`${member.documentId}:${member.revisionId}`}>
      <a href={href(projectId, "document", member.documentId, member.revisionId)}>{document?.document.title || <>过程文档 <ShortId value={member.documentId} /></>} · 固定修订 <ShortId value={member.revisionId} /> ↗</a>
      {document && <span className="task-basis-status">{document.document.adoptedRevisionId === member.revisionId ? "文档现发布此版" : document.document.adoptedRevisionId ? <>文档现发布 <ShortId value={document.document.adoptedRevisionId} />；本任务仍固定此版</> : "文档当前无发布修订；本任务仍固定此版"}</span>}
    </li>;
  })}</ul>;
}

function ImpactReview({ token, projectId, detail, impact, onChanged, onAttempt, onKnown, blockedByUnknown, canReview }: {
  token: string; projectId: string; detail: TaskDetail; impact: Impact;
  onChanged: () => void; onAttempt: (command: UnknownCommand) => boolean; onKnown: (operationId: string) => void; blockedByUnknown: boolean; canReview: boolean;
}) {
  const formId = useId();
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
      {before ? <RevisionBody token={token} revision={before} label="任务原依据" /> : <p>正在读取原依据…</p>}
      {after ? <RevisionBody token={token} revision={after} label="新文档修订" /> : <p>正在读取新修订…</p>}
    </div>
    <details className="task-review-disclosure"><summary>复核并决定此项变化</summary>
    <form className="review-form" onSubmit={submit}>
      <div className="eyebrow">复核决定 · Task v{readVersion}</div>
      <h3>这次变化如何影响任务？</h3>
      <label className="choice"><input type="radio" checked={decision === "adopt"} onChange={() => setDecision("adopt")} />采用新修订</label>
      <label className="choice"><input type="radio" checked={decision === "retain"} onChange={() => setDecision("retain")} />保留原依据</label>
      <label htmlFor={`${formId}-reason`}>理由</label>
      <textarea id={`${formId}-reason`} value={reason} onChange={e => setReason(e.target.value)} minLength={1} maxLength={4000} required rows={4} placeholder="说明判断依据与影响" />
      {decision === "adopt" && <><label htmlFor={`${formId}-acceptance`}>新的验收条件（可选）</label><textarea id={`${formId}-acceptance`} value={acceptance} onChange={e => setAcceptance(e.target.value)} maxLength={4000} rows={3} placeholder="留空则沿用当前验收条件" /></>}
      <button className="primary" type="submit" disabled={busy || conflict || blockedByUnknown || !canReview || impact.state !== "pending" || !before || !after}>{busy ? "正在提交…" : "提交复核决定"}</button>
      {!canReview && <Alert>当前身份没有复核权限，仍可阅读固定依据。</Alert>}
      {impact.state !== "pending" && <Alert>这项影响已不再待复核。保留当前输入供你核对，不能按旧状态提交。</Alert>}
      {blockedByUnknown && <Alert kind="error">同一任务有结果未确认的命令。请先按上方操作 ID 核对。</Alert>}
      {conflict && !blockedByUnknown && <button type="button" className="quiet" onClick={() => { setReadVersion(detail.task.version); setConflict(false); setMessage("请再次核对原依据、新修订和当前任务，再提交保留的输入。"); }}>重新核对当前版本</button>}
      {message && <Alert kind={conflict ? "error" : "info"}>{message}</Alert>}
    </form>
    </details>
  </div>;
}

export function TaskPage({ context, token, projectId, id, selectedRevision, refresh, onChanged, onAttempt, onKnown, blockedByUnknown, canReview }: {
  context: MutationContext; token: string; projectId: string; id: string; refresh: number;
  selectedRevision?: string;
  onChanged: () => void; onAttempt: (command: UnknownCommand) => boolean; onKnown: (operationId: string) => void; blockedByUnknown: boolean; canReview: boolean;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [selectedImpactId, setSelectedImpactId] = useState<string | null>(null);
  const [historical, setHistorical] = useState<{ taskId: string; revision: TaskRevision; basis: BasisSet | null } | null>(null);
  const [tab, setTab] = useState<TaskTab>("overview");
  const [basisDocuments, setBasisDocuments] = useState<Record<string, DocumentDetail>>({});
  const [basisError, setBasisError] = useState("");
  const [error, setError] = useState("");
  const historyRequestRef = useRef(0);
  useEffect(() => { ++historyRequestRef.current; setHistorical(null); setTab("overview"); setDetail(null); setBasisDocuments({}); }, [id, projectId]);
  useEffect(() => {
    let active = true;
    setError("");
    api(token).task(projectId, id).then(value => {
      if (!active) return;
      setDetail(value);
      setSelectedImpactId(current => value.impacts.some(i => i.id === current && i.state === "pending") ? current : value.impacts.find(i => i.state === "pending")?.id || null);
    }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [token, projectId, id, refresh]);
  useEffect(() => {
    if (!detail || detail.task.id !== id) return;
    let active = true;
    setBasisDocuments({}); setBasisError("");
    const documentIds = [...new Set(detail.basis?.members.map(member => member.documentId) ?? [])];
    Promise.all(documentIds.map(documentId => api(token).document(projectId, documentId)))
      .then(documents => { if (active) setBasisDocuments(Object.fromEntries(documents.map(document => [document.document.id, document]))); })
      .catch(cause => { if (active) setBasisError(errorText(cause)); });
    return () => { active = false; };
  }, [token, projectId, id, detail?.revision.id]);
  async function showHistory(revisionId: string) {
    const sequence = ++historyRequestRef.current;
    setHistorical(null); setError("");
    try {
      const value = await api(token).taskRevision(projectId, id, revisionId);
      if (sequence === historyRequestRef.current) setHistorical({ taskId: id, ...value });
    } catch (cause) { if (sequence === historyRequestRef.current) setError(errorText(cause)); }
  }
  useEffect(() => {
    if (selectedRevision) void showHistory(selectedRevision);
    else { ++historyRequestRef.current; setHistorical(null); }
    if (selectedRevision) setTab("history");
  }, [selectedRevision, token, projectId, id]);
  if (error && !detail) return <div className="content"><Alert kind="error">{error}</Alert></div>;
  if (!detail || detail.task.id !== id) return <div className="content"><p>正在读取任务…</p></div>;
  const taskContext = { ...context, draftScope: `task:${id}`, draftBaseline: detail.revision.id };
  const pending = detail.impacts.filter(i => i.state === "pending");
  const selected = detail.impacts.find(i => i.id === selectedImpactId);
  const deliveries = detail.deliveries ?? [];
  const latest = deliveries.at(-1);
  const latestObservations = (detail.observations ?? []).filter(observation => observation.deliveryId === latest?.id);
  const instanceId = selectedRevision ?? "current";
  const tabId = (value: TaskTab) => `task-tab-${projectId}-${id}-${instanceId}-${value}`;
  const panelId = (value: TaskTab) => `task-panel-${projectId}-${id}-${instanceId}-${value}`;
  return <div className="content task-page">
    <a className="back" href={taskListHref(projectId)}>← 返回任务列表</a>
    {selectedRevision && <Alert>正在查看固定历史任务修订 <ShortId value={selectedRevision} />。下方页首是当前任务摘要；历史面板单独列出当时状态与依据。<a href={href(projectId, "task", id)}>返回当前任务</a></Alert>}
    <header className="task-page-header">
      <div className="eyebrow">任务 · v{detail.task.version}</div><h1>{detail.task.title}</h1>
      <p><a href={`${href(projectId, "evaluations")}?taskId=${encodeURIComponent(id)}`}>查看此任务的评价与后果 →</a></p>
      <div className="task-header"><span className="pill">{taskStateLabel[detail.task.state]}</span>{detail.task.kind && <span className="pill subtle">{taskKindLabel[detail.task.kind]}</span>}<span>责任者：{detail.task.owner}</span><span>任务固定修订 <ShortId value={detail.revision.id} /></span></div>
    </header>
    {detail.task.legacyDecision && <Alert><strong>{legacyDecisionLabel(detail.task.legacyDecision)}</strong>。当前状态为“{taskStateLabel[detail.task.state]}”，请先核对旧判断与理由，再决定是否推进。<br />旧判断理由：{detail.task.legacyDecision.reason} <button type="button" className="quiet" onClick={() => setTab("history")}>查看历史时间线 →</button></Alert>}
    {error && <Alert kind="error">{error}</Alert>}
    <div className="task-tabs" role="tablist" aria-label="任务详情">{taskTabs.map(item => <button key={item.id} type="button" role="tab" id={tabId(item.id)} aria-controls={panelId(item.id)} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => { if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return; event.preventDefault(); const index = taskTabs.findIndex(candidate => candidate.id === item.id); const next = taskTabs[(index + (event.key === "ArrowRight" ? 1 : -1) + taskTabs.length) % taskTabs.length]; setTab(next.id); document.getElementById(tabId(next.id))?.focus(); }}>
      {item.label}{item.id === "basis" && pending.length > 0 && <span className="task-tab-count">{pending.length}</span>}
    </button>)}</div>
    <section role="tabpanel" id={panelId("overview")} aria-labelledby={tabId("overview")} hidden={tab !== "overview"}>
      <div className="task-overview-grid">
        <section className="panel task-focus task-main-content"><div className="panel-head"><h2>任务正文</h2><a href={href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId)}>阅读固定原件 <ShortId value={detail.task.contentRevisionId} /> ↗</a></div><MarkdownBody source={detail.task.content} identity={`task-${detail.revision.id}`} /><p className="task-fineprint">正文来自任务固定的主文档修订；通过“更新任务内容”修改，不从文档页绕过任务。</p></section>
        <section className="panel task-focus"><h2>验收条件</h2><p>{detail.task.acceptance}</p><p className="task-fineprint">任务状态、技术检查和实际使用分别记录；关闭决定见交付记录。</p></section>
        <section className="panel task-focus"><div className="panel-head"><h2>当前固定依据</h2><button type="button" className="quiet" onClick={() => setTab("basis")}>查看依据与变化 →</button></div><Basis basis={detail.basis} projectId={projectId} documents={basisDocuments} />{basisError && <Alert kind="error">文档现采纳版本暂不可读：{basisError}；任务固定修订仍可打开。</Alert>}{pending.length > 0 && <p className="task-attention">{pending.length} 项上游变化待复核；固定依据尚未随文档自动改变。</p>}</section>
        <section className="panel task-focus task-delivery-summary"><div className="panel-head"><h2>最新交付与使用</h2><button type="button" className="quiet" onClick={() => setTab("delivery")}>查看完整记录 →</button></div>
          {!latest ? <p className="empty">尚无交付记录；执行状态不能代替交付。</p> : <><p><strong>技术检查：{latest.technicalResult === "passed" ? "通过" : "失败"}</strong></p><p className="task-use-summary"><strong>实际使用：</strong>{latestObservations.length ? latestObservations.map(o => `${o.observerKind === "human" ? "人类" : "Agent"} · ${useResults[o.result]}`).join("；") : "尚无本次交付的使用记录"}</p><details className="task-summary-evidence"><summary>阅读技术检查证据</summary><p className="task-evidence">{latest.technicalEvidence}</p></details><p className="task-fineprint break-anywhere">产物：{safeArtifactHref(latest.artifactRef, projectId) ? <a href={safeArtifactHref(latest.artifactRef, projectId)!} target={(safeArtifactHref(latest.artifactRef, projectId) ?? "").startsWith("#") ? undefined : "_blank"} rel={(safeArtifactHref(latest.artifactRef, projectId) ?? "").startsWith("#") ? undefined : "noopener noreferrer"}>{latest.artifactRef}</a> : latest.artifactRef}<br />固定修订：{latest.artifactRevision}<br />SHA-256 {latest.contentHash}</p>
            <div className="task-use-evidence"><strong>本次交付的实际使用</strong>{latestObservations.length ? latestObservations.map(observation => <p key={observation.id}>{observation.observer} · {useResults[observation.result]}：{observation.evidence}</p>) : <p>尚无本次交付的使用观察；旧交付的使用记录不沿用。</p>}</div></>}
        </section>
      </div>
    </section>
    <section role="tabpanel" id={panelId("basis")} aria-labelledby={tabId("basis")} hidden={tab !== "basis"}>
      <section className="panel"><div className="panel-head"><h2>任务当前固定依据</h2><span>任务修订 <ShortId value={detail.revision.id} /></span></div><p><a href={href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId)}>主正文固定原件 <ShortId value={detail.task.contentRevisionId} /> ↗</a></p><p className="task-fineprint">点击文档打开任务所用的固定修订。文档后来发布新版，不会自动改写此任务的依据。</p><Basis basis={detail.basis} projectId={projectId} documents={basisDocuments} />{basisError && <Alert kind="error">文档现发布版本暂不可读：{basisError}</Alert>}</section>
      <section className="panel"><div className="panel-head"><h2>待复核的依据变化</h2><span>{pending.length} 项</span></div>
        {!pending.length && <p className="empty">当前没有待复核影响。</p>}
        {pending.length > 0 && <div className="impact-tabs">{pending.map(i => <button type="button" key={i.id} className={i.id === selectedImpactId ? "active" : ""} onClick={() => setSelectedImpactId(i.id)}>文档 <ShortId value={i.documentId} /> · 新版 <ShortId value={i.toRevisionId} /></button>)}</div>}
        {selected && <><p className="task-fineprint">任务固定版 <ShortId value={selected.fromRevisionId} /> → 文档新版 <ShortId value={selected.toRevisionId} />。请先核对两版，再决定采用或保留。</p><ImpactReview key={selected.id} token={token} projectId={projectId} detail={detail} impact={selected} onChanged={onChanged} onAttempt={onAttempt} onKnown={onKnown} blockedByUnknown={blockedByUnknown} canReview={canReview} /></>}
      </section>
    </section>
    <section role="tabpanel" id={panelId("delivery")} aria-labelledby={tabId("delivery")} hidden={tab !== "delivery"}>
      <TaskWorkflow key={detail.task.id} context={taskContext} detail={detail} mode="delivery" />
    </section>
    <section role="tabpanel" id={panelId("runtime")} aria-labelledby={tabId("runtime")} hidden={tab !== "runtime"}>
      <RuntimePanel context={context} refresh={refresh} task={detail.task} />
      <ReferencePanel key={`refs:${detail.task.currentRevisionId}`} context={context} taskId={detail.task.id} taskRevisionId={detail.task.currentRevisionId} taskVersion={detail.task.version} />
    </section>
    <section role="tabpanel" id={panelId("history")} aria-labelledby={tabId("history")} hidden={tab !== "history"}>
    {selectedRevision && <section className="panel"><h2>固定历史任务修订</h2>
      {!historical && !error && <p>正在读取指定修订与当时的完整依据…</p>}
      {!historical && error && <Alert kind="error">固定修订不可读取；不能把当前任务当成当时依据。</Alert>}
      {historical?.taskId === id && <><p><strong>v{historical.revision.version} · {taskStateLabel[historical.revision.state]}</strong> · {date(historical.revision.createdAt)} · {historical.revision.actorId}</p><p><strong>当次理由：</strong>{historical.revision.reason}</p><p><a href={href(projectId, "document", historical.revision.contentDocumentId, historical.revision.contentRevisionId)}>当次正文原件 <ShortId value={historical.revision.contentRevisionId} /> ↗</a></p><MarkdownBody source={historical.revision.content} identity={`history-${historical.revision.id}`} /><p><strong>当时验收：</strong>{historical.revision.acceptance}</p><Basis basis={historical.basis} projectId={projectId} /></>}
      <p><a href={href(projectId, "task", id)}>返回当前任务 →</a></p>
    </section>}
    <TaskWorkflow key={detail.task.id} context={taskContext} detail={detail} mode="history" />
    <section className="panel"><h2>已作决定</h2>
      {!detail.decisions.length && <p className="empty">尚无复核决定。</p>}
      {detail.decisions.map(d => <div className="decision" key={d.id}><strong>{d.decision === "adopt" ? "采用新修订" : "保留原依据"}</strong><span>{date(d.createdAt)} · {d.actorId}</span><p>{d.reason}</p><button className="quiet" onClick={() => showHistory(d.previousTaskRevisionId)}>查看决定前的任务依据</button></div>)}
      {!selectedRevision && historical?.taskId === id && <div className="history"><h3>固定任务修订 v{historical.revision.version} · {taskStateLabel[historical.revision.state]}</h3><p><strong>当次理由：</strong>{historical.revision.reason}</p><p><a href={href(projectId, "document", historical.revision.contentDocumentId, historical.revision.contentRevisionId)}>当次正文原件 ↗</a></p><MarkdownBody source={historical.revision.content} identity={`decision-${historical.revision.id}`} /><p><strong>当时验收：</strong>{historical.revision.acceptance}</p><Basis basis={historical.basis} projectId={projectId} /></div>}
    </section>
    </section>
    <section role="tabpanel" id={panelId("actions")} aria-labelledby={tabId("actions")} hidden={tab !== "actions"}>
      <TaskWorkflow key={detail.task.id} context={taskContext} detail={detail} mode="actions" />
    </section>
  </div>;
}
