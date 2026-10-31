import { acceptancePoints } from "./acceptancePresentation";
import { useEffect, useRef, useState, useId, type FormEvent } from "react";
import type { BasisSet, Command, DocumentDetail, DocumentRevision, Impact, TaskDetail, TaskRevision } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { api, ApiError, errorText, isUnconfirmed } from "../api";
import { Alert, ShortId, RevisionBody, date, href, taskListHref } from "../ui/shared";
import type { MutationContext } from "./ActionForm";
import { RuntimePanel } from "../runtime/RuntimePanel";
import { TaskAssignmentPanel } from "../sessions/TaskAssignmentPanel";
import { ReferencePanel } from "../references/ReferencePanel";
import { TaskWorkflow } from "./TaskWorkflow";
import { TaskOwner } from "./TaskOwner";
import { taskStateLabel } from "./TaskWorkflow";
import { MarkdownBody } from "../ui/MarkdownBody";
import { legacyDecisionLabel } from "./taskListPresentation";
import { DeliveryArtifact, DeliveryObservation, DeliveryPanel, useDeliveryNames } from "./DeliveryPanel";
import { EvidenceText } from "./EvidenceText";
import { observationResultLabel, observationsForDelivery, observerKindLabel } from "./observationPresentation";
import { navigateTaskTab, scrollToTaskSection, taskRunFromHash, taskSectionFromHash } from "../orchestration/navigation";
import { LeaderTaskFacts } from "./LeaderTaskFacts";
import { leaderPhaseLabel, leaderProjectionMatchesTask } from "./leaderWorkLoad";
import "./task-page.css";
import "./task-experience.css";
import { currentDelivery } from "./taskExperience";
import { taskGoal, taskType } from "./taskWorkspacePresentation";
type UnknownCommand = Command;
type TaskTab = "overview" | "basis" | "delivery" | "runtime" | "history" | "actions";
const taskTabs: { id: TaskTab; label: string }[] = [
  { id: "overview", label: "当前工作" }, { id: "basis", label: "依据与影响" },
  { id: "delivery", label: "交付与使用" }, { id: "runtime", label: "运行与关联" },
  { id: "history", label: "历史" }, { id: "actions", label: "任务操作" },
];
const emptyDeliveries: NonNullable<TaskDetail["deliveries"]> = [];
function Basis({ basis, projectId, documents }: { basis: BasisSet | null; projectId: string; documents?: Record<string, DocumentDetail> }) {
  if (!basis) return <p className="empty">这个任务修订没有固定依据集合。</p>;
  return <ul className="basis-list task-basis-list">{basis.members.map(member => {
    const document = documents?.[member.documentId];
    const retention = basis.retentions?.find(item => item.documentId === member.documentId && item.revisionId === member.revisionId);
    return <li key={`${member.documentId}:${member.revisionId}`}>
      <a href={href(projectId, "document", member.documentId, member.revisionId)}>{document?.document.title || <>过程文档 <ShortId value={member.documentId} /></>} · 固定修订 <ShortId value={member.revisionId} /> ↗</a>
      {document && <span className="task-basis-status">{document.document.adoptedRevisionId === member.revisionId ? "文档现发布此版" : document.document.adoptedRevisionId ? <>文档现发布 <ShortId value={document.document.adoptedRevisionId} />；本任务仍固定此版</> : "文档当前无发布修订；本任务仍固定此版"}</span>}
      {retention && <details><summary>开始时明确保留旧版的审阅记录</summary><p>{retention.reason}</p><p>当时核对的发布版 <ShortId value={retention.observedAdoptedRevisionId} /> · {retention.actorId} · {date(retention.createdAt)}</p><p className="muted">此决定只覆盖当时观察的发布版；来源再改版仍需复核。</p></details>}
    </li>;
  })}</ul>;
}

function ImpactReview({ token, projectId, detail, impact, onChanged, onAttempt, onKnown, blockedByUnknown, blockedByRead, canReview }: {
  token: string; projectId: string; detail: TaskDetail; impact: Impact;
  onChanged: () => void; onAttempt: (command: UnknownCommand) => boolean | Promise<boolean>; onKnown: (operationId: string) => void; blockedByUnknown: boolean; blockedByRead: boolean; canReview: boolean;
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
    if (busy || conflict || blockedByUnknown || blockedByRead || !canReview || impact.state !== "pending" || !reason.trim()) return;
    const command: UnknownCommand = {
      type: "task.reviewBasis", projectId, taskId: detail.task.id,
      expectedVersion: readVersion, impactId: impact.id, decision,
      reason: reason.trim(), ...(decision === "adopt" && acceptance.trim() ? { acceptance: acceptance.trim() } : {}),
      operationId: crypto.randomUUID(),
    };
    setBusy(true);
    let recorded = false;
    try { recorded = await onAttempt(command); } catch { /* Do not send without a recovery receipt. */ }
    if (!recorded) {
      setBusy(false);
      setMessage(`无法保存操作回执，本次未发送。请启用浏览器会话存储后重试。操作 ID：${command.operationId}`);
      return;
    }
    setMessage("");
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
      <button className="primary" type="submit" disabled={busy || conflict || blockedByUnknown || blockedByRead || !canReview || impact.state !== "pending" || !before || !after}>{busy ? "正在提交…" : "提交复核决定"}</button>
      {!canReview && <Alert>当前身份没有复核权限，仍可阅读固定依据。</Alert>}
      {impact.state !== "pending" && <Alert>这项影响已不再待复核。保留当前输入供你核对，不能按旧状态提交。</Alert>}
      {blockedByUnknown && <Alert kind="error">同一任务有结果未确认的命令。请先按上方操作 ID 核对。</Alert>}
      {blockedByRead && <Alert>当前任务回读尚未完成，暂不能按旧版本提交复核。</Alert>}
      {conflict && !blockedByUnknown && <button type="button" className="quiet" onClick={() => { setReadVersion(detail.task.version); setConflict(false); setMessage("请再次核对原依据、新修订和当前任务，再提交保留的输入。"); }}>重新核对当前版本</button>}
      {message && <Alert kind={conflict ? "error" : "info"}>{message}</Alert>}
    </form>
    </details>
  </div>;
}

export function TaskPage({ context, token, projectId, id, selectedRevision, refresh, onChanged, onAttempt, onKnown, blockedByUnknown, canReview, active }: {
  context: MutationContext; token: string; projectId: string; id: string; refresh: number;
  selectedRevision?: string;
  onChanged: () => void; onAttempt: (command: UnknownCommand) => boolean | Promise<boolean>; onKnown: (operationId: string) => void; blockedByUnknown: boolean; canReview: boolean; active: boolean;
}) {
  const routeQuery = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const proposedReturn = routeQuery.get("return");
  const sessionReturn = active && routeQuery.get("actor") === context.principal.actorId
    && proposedReturn?.startsWith(`${href(projectId, "runtime")}?`)
    && new URLSearchParams(proposedReturn.split("?")[1] ?? "").get("session")?.match(/^(owned|external):[0-9a-f-]{36}$/i)
    ? proposedReturn : null;
  const sessionReturnTitle = routeQuery.get("returnTitle")?.slice(0, 80).trim() || "Session";
  const listReturnRef = useRef<string | null>(null);
  const requestedList = routeQuery.get("list");
  if (active && requestedList?.split("?")[0] === href(projectId, "work")) listReturnRef.current = requestedList;
  if (!listReturnRef.current) try {
    const saved = sessionStorage.getItem(`evoloop:list:${projectId}`);
    if (saved?.split("?")[0] === href(projectId, "work")) listReturnRef.current = saved;
  } catch { /* optional return state */ }
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [leaderTask, setLeaderTask] = useState<LeaderWorkTask | null>(null);
  const [leaderTaskError, setLeaderTaskError] = useState("");
  const [responsibleName, setResponsibleName] = useState<string | null>(null);
  const [selectedImpactId, setSelectedImpactId] = useState<string | null>(null);
  const [historical, setHistorical] = useState<{ taskId: string; revision: TaskRevision; basis: BasisSet | null } | null>(null);
  const landingRef = useRef<TaskTab | null>(null);
  const [landingVersion, setLandingVersion] = useState(0);
  const [tab, setTab] = useState<TaskTab>(() => selectedRevision ? "history" :
    taskSectionFromHash(window.location.hash, projectId, id) ?? "overview");
  useEffect(() => {
    const onHash = (navigated: boolean) => {
      const requested = taskSectionFromHash(window.location.hash, projectId, id);
      if (requested) {
        if (navigated || requested !== "overview") {
          landingRef.current = requested;
          setLandingVersion(value => value + 1);
        }
        setTab(requested);
      }
    };
    const onHashChange = () => onHash(true);
    window.addEventListener("hashchange", onHashChange);
    onHash(false);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [projectId, id, selectedRevision]);
  const [basisDocuments, setBasisDocuments] = useState<Record<string, DocumentDetail>>({});
  const [basisError, setBasisError] = useState("");
  const [error, setError] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const wasActive = useRef(active);
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [reading, setReading] = useState(false);
  const historyRequestRef = useRef(0);
  const leaderRequestRef = useRef(0);
  useEffect(() => { ++historyRequestRef.current; setHistorical(null);
    setTab(selectedRevision ? "history" : taskSectionFromHash(window.location.hash, projectId, id) ?? "overview");
    setDetail(null); setBasisDocuments({}); setLeaderTask(null); setLeaderTaskError(""); setResponsibleName(null);
  }, [id, projectId]);
  useEffect(() => {
    if (!detail || detail.task.id !== id || landingRef.current !== tab) return;
    const targetRun = tab === "runtime" ? taskRunFromHash(window.location.hash, projectId, id) : null;
    if (targetRun && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetRun)) {
      landingRef.current = null;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (scrollToTaskSection(projectId, id, tab, selectedRevision, value => document.getElementById(value))) {
        landingRef.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail, id, projectId, selectedRevision, tab, landingVersion]);
  useEffect(() => {
    let active = true;
    setError(""); setReading(true);
    api(token).task(projectId, id).then(value => {
      if (!active) return;
      setDetail(value); setObservedAt(new Date()); setReading(false);
      setSelectedImpactId(current => value.impacts.some(i => i.id === current && i.state === "pending") ? current : value.impacts.find(i => i.state === "pending")?.id || null);
    }).catch(cause => { if (active) { setError(errorText(cause)); setReading(false); } });
    return () => { active = false; };
  }, [token, projectId, id, refresh, readVersion]);
  useEffect(() => {
    if (!detail || detail.task.id !== id) return;
    const request = ++leaderRequestRef.current;
    let active = true;
    setLeaderTask(null); setLeaderTaskError("");
    api(token).leaderTask(projectId, id).then(value => {
      if (!active || request !== leaderRequestRef.current) return;
      if (!leaderProjectionMatchesTask(value, {
        id, version: detail.task.version, currentRevisionId: detail.task.currentRevisionId,
      })) {
        setLeaderTaskError("任务或工作安排已在读取期间变化；正在重新核对。");
        setReadVersion(current => current + 1);
        return;
      }
      setLeaderTask(value);
    }).catch(cause => {
      if (active && request === leaderRequestRef.current) {
        setLeaderTask(null);
        setLeaderTaskError(`当前工作安排暂未读回：${errorText(cause)}`);
      }
    });
    return () => { active = false; };
  }, [token, projectId, id, refresh, readVersion, detail?.task.version, detail?.task.currentRevisionId]);
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible") setReadVersion(value => value + 1); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [id, projectId]);
  useEffect(() => {
    if (active && !wasActive.current) setReadVersion(value => value + 1);
    wasActive.current = active;
  }, [active]);
  useEffect(() => {
    if (!detail || detail.task.id !== id) return;
    let active = true;
    setBasisDocuments({}); setBasisError("");
    const documentIds = [...new Set([...(detail.basis?.members.map(member => member.documentId) ?? []), ...detail.links.map(link => link.documentId)])];
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
  const deliveryNames = useDeliveryNames(token, projectId, detail?.deliveries ?? emptyDeliveries);
  if (error && !detail) return <div className="content"><Alert kind="error">{error}</Alert></div>;
  if (!detail || detail.task.id !== id) return <div className="content"><p>正在读取任务…</p></div>;
  const taskContext = { ...context, blocked: context.blocked || reading || !!error,
    draftScope: `task:${id}`, draftBaseline: detail.revision.id };
  const pending = detail.impacts.filter(i => i.state === "pending");
  const selected = detail.impacts.find(i => i.id === selectedImpactId);
  const deliveries = detail.deliveries ?? [];
  const latest = currentDelivery(detail);
  const acceptance = acceptancePoints(detail.task.acceptance);
  const visibleAcceptance = acceptance?.slice(0, 2) ?? [];
  const remainingAcceptance = acceptance?.slice(2) ?? [];
  const mobileAcceptance = acceptance?.slice(0, 1) ?? [];
  const mobileRemainingAcceptance = acceptance?.slice(1) ?? [];
  const latestObservations = latest ? observationsForDelivery(detail.observations ?? [], latest.id) : [];
  const instanceId = selectedRevision ?? "current";
  const tabId = (value: TaskTab) => `task-tab-${projectId}-${id}-${instanceId}-${value}`;
  const tabsId = `task-tabs-${projectId}-${id}-${instanceId}`;
  const panelId = (value: TaskTab) => `task-panel-${projectId}-${id}-${instanceId}-${value}`;
  function selectTab(value: TaskTab) {
    if (selectedRevision && value === "history") return;
    if (!navigateTaskTab(projectId, id, value, window.location)) {
      landingRef.current = value;
      setLandingVersion(current => current + 1);
      setTab(value);
    }
  }
  const goal = taskGoal(leaderTask, detail.task);
  const progressLabel = leaderTask ? leaderPhaseLabel[leaderTask.phase] : taskStateLabel[detail.task.state];
  const responsibilityLabel = !leaderTask ? "职责尚未读回"
    : leaderTask.responsible.kind === "role"
      ? responsibleName ? `负责职责：${responsibleName}` : "负责职责待核对"
      : leaderTask.responsible.label;
  const acceptanceNote = `${detail.proposal?.acceptanceMode === "independent_agent" ? "须由不同于实际提交者的 Agent 使用当前交付" : detail.proposal?.acceptanceMode === "human_required" ? "须由指定的受信用户本人使用当前交付" : "按任务原有验收合同核对"}${detail.proposal?.consumer ? ` · 指定身份 ${detail.proposal.consumer}` : detail.proposal?.acceptanceMode ? " · 验收身份待实际签收" : ""}。任务状态、技术检查和实际使用分别记录。`;
  return <div className="content task-page">
    <div className="task-detail-toolbar">
      <div className="task-detail-backlinks">
        {sessionReturn && <a className="back" href={sessionReturn}>← 返回【{sessionReturnTitle}】</a>}
        <a className="back" href={listReturnRef.current ?? taskListHref(projectId)}>← 返回任务列表</a>
      </div>
      <div className="task-read-status"><span>{reading ? "正在核对当前任务…" : observedAt ? `当前任务读于 ${date(observedAt.toISOString())}` : "当前任务尚未读回"}</span><button type="button" className="quiet" onClick={() => setReadVersion(value => value + 1)}>重新读取当前任务</button></div>
    </div>
    {selectedRevision && <Alert>正在查看固定历史任务修订 <ShortId value={selectedRevision} />。下方页首是当前任务摘要；历史面板单独列出当时状态与依据。<a href={href(projectId, "task", id)}>返回当前任务</a></Alert>}
    <header className="task-page-header task-detail-header">
      <div className="task-detail-heading">
        <div className="eyebrow">任务 · v{detail.task.version}</div>
        <h1>{detail.task.title}</h1>
        <p className="task-goal-summary">{goal}</p>
        <div className="task-header">
          <span className="pill">{taskStateLabel[detail.task.state]}</span>
          <span className="pill subtle">{taskType(detail.task.kind)}</span>
          <span>当前进展：{progressLabel}</span>
          <span>{responsibilityLabel}</span>
        </div>
      </div>
      {!selectedRevision && <button className="primary task-header-result" onClick={() => selectTab("delivery")}>查看固定成果</button>}
    </header>
    {!leaderTask && !leaderTaskError && <p className="task-fineprint" role="status">正在核对本任务当前的进展与具体责任…</p>}
    {leaderTaskError && <Alert kind="error">{leaderTaskError}</Alert>}
    {detail.task.legacyDecision && <Alert><strong>{legacyDecisionLabel(detail.task.legacyDecision)}</strong>。当前状态为“{taskStateLabel[detail.task.state]}”，请先核对旧判断与理由，再决定是否推进。<br />旧判断理由：{detail.task.legacyDecision.reason} <button type="button" className="quiet" onClick={() => selectTab("history")}>查看历史时间线 →</button></Alert>}
    {error && <Alert kind="error">当前任务回读失败：{error}。页首保留上次读回内容，不能视为当前状态；编辑草稿仍留在本页。</Alert>}
    <div className="task-tabs" role="tablist" id={tabsId} aria-label="任务详情">{taskTabs.map(item => <button key={item.id} type="button" className={["runtime", "history", "actions"].includes(item.id) ? "task-aux-tab" : undefined} role="tab" id={tabId(item.id)} aria-controls={panelId(item.id)} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => selectTab(item.id)} onKeyDown={event => { if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return; event.preventDefault(); const index = taskTabs.findIndex(candidate => candidate.id === item.id); const next = taskTabs[(index + (event.key === "ArrowRight" ? 1 : -1) + taskTabs.length) % taskTabs.length]; selectTab(next.id); document.getElementById(tabId(next.id))?.focus({ preventScroll: true }); }}>
      {item.label}{item.id === "basis" && pending.length > 0 && <span className="task-tab-count">{pending.length}</span>}
    </button>)}</div>
    <section role="tabpanel" id={panelId("overview")} aria-labelledby={tabId("overview")} hidden={tab !== "overview"}>
      <div className="task-overview-grid">
        <div className="task-narrative">
        <section className="panel task-focus task-acceptance"><h2>完成条件</h2>
          {acceptance ? <>
            <div className="task-acceptance-desktop"><ol className="task-acceptance-points">{visibleAcceptance.map((point,index) => <li key={index}>{point}</li>)}</ol>
              {remainingAcceptance.length > 0 && <details className="task-acceptance-more"><summary>其余 {remainingAcceptance.length} 条完成条件</summary><ol className="task-acceptance-points" start={3}>{remainingAcceptance.map((point,index) => <li key={index}>{point}</li>)}</ol></details>}
            </div>
            <div className="task-acceptance-mobile"><ol className="task-acceptance-points">{mobileAcceptance.map((point,index) => <li key={index}>{point}</li>)}</ol>
              {mobileRemainingAcceptance.length > 0 && <details className="task-acceptance-more"><summary>其余 {mobileRemainingAcceptance.length} 条完成条件</summary><ol className="task-acceptance-points" start={2}>{mobileRemainingAcceptance.map((point,index) => <li key={index}>{point}</li>)}</ol></details>}
            </div>
          </> : <p>{detail.task.acceptance}</p>}
          <p className="task-fineprint task-acceptance-note">{acceptanceNote}</p>
          <details className="task-acceptance-contract-mobile"><summary>验收记录方式</summary><p className="task-fineprint">{acceptanceNote}</p></details>
        </section>
        <section className="panel task-focus task-main-content"><div className="panel-head"><h2>任务正文</h2><a href={href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId)}>阅读固定原件 <ShortId value={detail.task.contentRevisionId} /> ↗</a></div><MarkdownBody source={detail.task.content} identity={`task-${detail.revision.id}`} projectId={projectId} /><p className="task-fineprint">正文来自任务固定的主文档修订；通过“更新任务内容”修改，不从文档页绕过任务。</p></section>
        </div>
        <aside className="task-evidence-rail" aria-label="交付、依据与关联">
        <section className="panel task-focus task-detail-result"><div className="panel-head"><h2>当前结果</h2><button type="button" className="quiet" onClick={() => selectTab("delivery")}>查看完整记录 →</button></div>
          <dl className="task-result-facts">
            <div><dt>主进展</dt><dd>{progressLabel}</dd></div>
            <div><dt>下一责任</dt><dd>{leaderTask?.nextAction ?? "打开运行关联核对当前工作安排"}<small>{responsibilityLabel}</small></dd></div>
            <div><dt>固定成果</dt><dd>{latest ? <DeliveryArtifact delivery={latest} projectId={projectId} name={deliveryNames[latest.id]} /> : <span>{deliveries.length ? "当前修订尚无交付；历史交付不沿用" : "当前修订尚无交付"}</span>}</dd></div>
            <div><dt>技术检查</dt><dd>{latest ? <><strong>{latest.technicalResult === "passed" ? "通过" : "失败"}</strong><small>登记于 {date(latest.createdAt)}</small></> : "尚无当前交付"}</dd></div>
            <div><dt>实际使用范围</dt><dd>{latestObservations.length
              ? latestObservations.map(observation => <span key={observation.id}>{observerKindLabel[observation.observerKind]} · {observationResultLabel[observation.result]} · {observation.observer}</span>)
              : "尚无本次交付的使用观察；旧记录不沿用"}</dd></div>
          </dl>
          {latest && <><EvidenceText label="技术检查证据" value={latest.technicalEvidence} />
            <div className="task-use-evidence"><strong>本次交付的使用观察</strong>{latestObservations.length ? latestObservations.map(observation => <DeliveryObservation key={observation.id} observation={observation} />) : <p>尚无本次交付的使用观察。</p>}</div></>}
        </section>
        <section className="panel task-focus"><div className="panel-head"><h2>当前固定依据</h2><button type="button" className="quiet" onClick={() => selectTab("basis")}>查看依据与变化 →</button></div><Basis basis={detail.basis} projectId={projectId} documents={basisDocuments} />{basisError && <Alert kind="error">文档现采纳版本暂不可读：{basisError}；任务固定修订仍可打开。</Alert>}{pending.length > 0 && <p className="task-attention">{pending.length} 项上游变化待复核；固定依据尚未随文档自动改变。</p>}</section>
        <section className="panel task-focus"><h2>关联过程文档</h2>{detail.links.length ? <ul className="basis-list task-basis-list">{detail.links.map(link => <li key={link.id}><a href={href(projectId, "document", link.documentId)}>{basisDocuments[link.documentId]?.document.title ?? `文档 ${link.documentId.slice(0, 8)}`} →</a></li>)}</ul> : <p className="empty">此任务没有另行关联的过程文档。</p>}{basisError && <Alert kind="error">部分关联文档名称暂不可读，仍可按链接打开：{basisError}</Alert>}</section>

        </aside>
        {leaderTask && <details className="task-arrangement-details"><summary>计划、对账来源与依赖</summary><LeaderTaskFacts leader={leaderTask} detail={detail} projectId={projectId} responsibleName={responsibleName} /></details>}

      </div>
      <details className="task-provenance"><summary>职责、任务修订与评价入口</summary><p>任务固定修订 <ShortId value={detail.revision.id} /></p>    <details className="task-role-history"><summary>负责职责与同 Role 的其他会话（不代表本任务承接）</summary><TaskOwner token={token} projectId={projectId} owner={detail.task.owner} readKey={`${refresh}:${readVersion}:${detail.revision.id}`} onResolved={setResponsibleName} /></details>
    <p className="task-fineprint"><a href={`${href(projectId, "evaluations")}?taskId=${encodeURIComponent(id)}`}>查看此任务的评价与后果 →</a></p>
      </details>
    </section>
    <section role="tabpanel" id={panelId("basis")} aria-labelledby={tabId("basis")} hidden={tab !== "basis"}>
      <section className="panel"><div className="panel-head"><h2>任务当前固定依据</h2><span>任务修订 <ShortId value={detail.revision.id} /></span></div><p><a href={href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId)}>主正文固定原件 <ShortId value={detail.task.contentRevisionId} /> ↗</a></p><p className="task-fineprint">点击文档打开任务所用的固定修订。文档后来发布新版，不会自动改写此任务的依据。</p><Basis basis={detail.basis} projectId={projectId} documents={basisDocuments} />{basisError && <Alert kind="error">文档现发布版本暂不可读：{basisError}</Alert>}</section>
      <section className="panel"><div className="panel-head"><h2>待复核的依据变化</h2><span>{pending.length} 项</span></div>
        {!pending.length && <p className="empty">当前没有待复核影响。</p>}
        {pending.length > 0 && <div className="impact-tabs">{pending.map(i => <button type="button" key={i.id} className={i.id === selectedImpactId ? "active" : ""} onClick={() => setSelectedImpactId(i.id)}>文档 <ShortId value={i.documentId} /> · 新版 <ShortId value={i.toRevisionId} /></button>)}</div>}
        {selected && <><p className="task-fineprint">任务固定版 <ShortId value={selected.fromRevisionId} /> → 文档新版 <ShortId value={selected.toRevisionId} />。请先核对两版，再决定采用或保留。</p><ImpactReview key={selected.id} token={token} projectId={projectId} detail={detail} impact={selected} onChanged={onChanged} onAttempt={onAttempt} onKnown={onKnown} blockedByUnknown={blockedByUnknown} blockedByRead={reading || !!error} canReview={canReview} /></>}
      </section>
    </section>
    <section role="tabpanel" id={panelId("delivery")} aria-labelledby={tabId("delivery")} hidden={tab !== "delivery"}>
      <DeliveryPanel token={token} detail={detail} projectId={projectId} names={deliveryNames} onChanged={onChanged} active={active && tab === "delivery"} />
    </section>
    <section role="tabpanel" id={panelId("runtime")} aria-labelledby={tabId("runtime")} hidden={tab !== "runtime"}>
      <TaskAssignmentPanel context={context} task={detail.task} refresh={refresh} />
      <RuntimePanel context={context} refresh={refresh} task={detail.task} taskDetail={detail} />
      <ReferencePanel key={`refs:${detail.task.currentRevisionId}`} context={context} taskId={detail.task.id} taskRevisionId={detail.task.currentRevisionId} taskVersion={detail.task.version} />
    </section>
    <section role="tabpanel" id={panelId("history")} aria-labelledby={tabId("history")} hidden={tab !== "history"}>
    {selectedRevision && <section className="panel"><h2>固定历史任务修订</h2>
      {!historical && !error && <p>正在读取指定修订与当时的完整依据…</p>}
      {!historical && error && <Alert kind="error">固定修订不可读取；不能把当前任务当成当时依据。</Alert>}
      {historical?.taskId === id && <><p><strong>v{historical.revision.version} · {taskStateLabel[historical.revision.state]}</strong> · {date(historical.revision.createdAt)} · {historical.revision.actorId}</p><p><strong>当次理由：</strong>{historical.revision.reason}</p><p><a href={href(projectId, "document", historical.revision.contentDocumentId, historical.revision.contentRevisionId)}>当次正文原件 <ShortId value={historical.revision.contentRevisionId} /> ↗</a></p><MarkdownBody source={historical.revision.content} identity={`history-${historical.revision.id}`} projectId={projectId} /><p><strong>当时验收：</strong>{historical.revision.acceptance}</p><Basis basis={historical.basis} projectId={projectId} /></>}
      <p><a href={href(projectId, "task", id)}>返回当前任务 →</a></p>
    </section>}
    <TaskWorkflow key={detail.task.id} context={taskContext} detail={detail} leader={leaderTask} mode="history" />
    <section className="panel"><h2>已作决定</h2>
      {!detail.decisions.length && <p className="empty">尚无复核决定。</p>}
      {detail.decisions.map(d => <div className="decision" key={d.id}><strong>{d.decision === "adopt" ? "采用新修订" : "保留原依据"}</strong><span>{date(d.createdAt)} · {d.actorId}</span><p>{d.reason}</p><button className="quiet" onClick={() => showHistory(d.previousTaskRevisionId)}>查看决定前的任务依据</button></div>)}
      {!selectedRevision && historical?.taskId === id && <div className="history"><h3>固定任务修订 v{historical.revision.version} · {taskStateLabel[historical.revision.state]}</h3><p><strong>当次理由：</strong>{historical.revision.reason}</p><p><a href={href(projectId, "document", historical.revision.contentDocumentId, historical.revision.contentRevisionId)}>当次正文原件 ↗</a></p><MarkdownBody source={historical.revision.content} identity={`decision-${historical.revision.id}`} projectId={projectId} /><p><strong>当时验收：</strong>{historical.revision.acceptance}</p><Basis basis={historical.basis} projectId={projectId} /></div>}
    </section>
    </section>
    <section role="tabpanel" id={panelId("actions")} aria-labelledby={tabId("actions")} hidden={tab !== "actions"}>
      <TaskWorkflow key={detail.task.id} context={taskContext} detail={detail} documents={basisDocuments}
        leader={leaderTask} mode="actions" />
    </section>
  </div>;
}
