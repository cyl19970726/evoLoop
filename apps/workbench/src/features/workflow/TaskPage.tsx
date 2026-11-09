import { acceptancePoints } from "./acceptancePresentation";
import { useEffect, useRef, useState, useId, type FormEvent, type ReactNode } from "react";
import type { BasisSet, Command, DocumentDetail, DocumentRevision, Impact, TaskDetail, TaskRevision } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { Button, ErrorState, LoadingState, Notice, StatusTag, Tabs, TabsContent, TabsList, TabsTrigger } from "@evoloop/ui";
import { api, ApiError, errorText, isUnconfirmed } from "../../shared/api";
import { Alert, ShortId, date, href } from "../../shared/ui/shared";
import { RevisionBody } from "../../shared/ui/RevisionBody";
import type { MutationContext } from "../../shared/ActionForm";
import { RuntimePanel } from "../runtime";
import { TaskAssignmentPanel } from "../sessions";
import { ReferencePanel } from "../references";
import { TaskCollaborationThread } from "../discussions";
import { TaskWorkflow } from "./TaskWorkflow";
import { TaskOwner } from "./TaskOwner";
import { taskStateLabel } from "./TaskWorkflow";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { legacyDecisionLabel } from "./taskListPresentation";
import { DeliveryPanel, useDeliveryNames } from "./DeliveryPanel";
import { navigateTaskTab, scrollToTaskSection, taskRunFromHash, taskSectionFromHash, taskSessionReturn, type TaskSection } from "../../shared/taskNavigation";
import { LeaderTaskFacts, TaskAttention } from "./LeaderTaskFacts";
import { timingDuration, timingStageLabel } from "../../shared/taskTiming";
import { TaskSchedulePanel } from "./TaskSchedulePanel";
import { leaderProjectionMatchesTask } from "../../shared/leaderWorkLoad";
import { phaseStatus, taskStateStatus } from "../../shared/taskStatus";
import "./task-page.css";
import "./task-experience.css";
import { TaskDocumentPeek } from "./TaskDocumentPeek";
import { TaskFacts } from "./TaskFacts";
import { taskGoal, taskType } from "./taskWorkspacePresentation";
import { appLocation, currentPath, onNavigate } from "../../shared/navigation";
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

/** One task in the center (tasks.md 中间): goal → completion conditions → body → progress and discussion, with the
 * evidence, delivery, run, history and write layers one tab away. The right column shows TaskFacts. */
export function TaskPage({ context, token, projectId, id, selectedRevision, refresh, onChanged, onAttempt, onKnown, blockedByUnknown, canReview, active, viewSwitch, linkForTab }: {
  context: MutationContext; token: string; projectId: string; id: string; refresh: number;
  selectedRevision?: string;
  onChanged: () => void; onAttempt: (command: UnknownCommand) => boolean | Promise<boolean>; onKnown: (operationId: string) => void; blockedByUnknown: boolean; canReview: boolean; active: boolean;
  viewSwitch?: ReactNode; linkForTab(tab: TaskSection): string;
}) {
  const sessionReturn = active ? taskSessionReturn(currentPath(), projectId, id, context.principal.actorId) : null;
  const panel = useContextPanel();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [leaderTask, setLeaderTask] = useState<LeaderWorkTask | null>(null);
  const [leaderTaskError, setLeaderTaskError] = useState("");
  const [responsibleName, setResponsibleName] = useState<string | null>(null);
  const [selectedImpactId, setSelectedImpactId] = useState<string | null>(null);
  const [historical, setHistorical] = useState<{ taskId: string; revision: TaskRevision; basis: BasisSet | null } | null>(null);
  const landingRef = useRef<TaskTab | null>(null);
  const [landingVersion, setLandingVersion] = useState(0);
  const [tab, setTab] = useState<TaskTab>(() => selectedRevision ? "history" :
    taskSectionFromHash(currentPath(), projectId, id) ?? "overview");
  useEffect(() => {
    const onHash = (navigated: boolean) => {
      const requested = taskSectionFromHash(currentPath(), projectId, id);
      if (requested) {
        if (navigated || requested !== "overview") {
          landingRef.current = requested;
          setLandingVersion(value => value + 1);
        }
        setTab(requested);
      }
    };
    const onHashChange = () => onHash(true);
    const stopNavigate = onNavigate(onHashChange);
    onHash(false);
    return () => stopNavigate();
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
  const mismatchRef = useRef("");
  useEffect(() => { ++historyRequestRef.current; setHistorical(null);
    setTab(selectedRevision ? "history" : taskSectionFromHash(currentPath(), projectId, id) ?? "overview");
    setDetail(null); setBasisDocuments({}); setLeaderTask(null); setLeaderTaskError(""); setResponsibleName(null);
  }, [id, projectId]);
  useEffect(() => {
    if (!detail || detail.task.id !== id || landingRef.current !== tab) return;
    const targetRun = tab === "runtime" ? taskRunFromHash(currentPath(), projectId, id) : null;
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
    if (!active || !detail || detail.task.id !== id || selectedRevision) return;
    const params = new URLSearchParams(currentPath().split("?")[1] ?? "");
    const section = params.get("section");
    if ((section !== "attention" && section !== "task-schedule") || currentPath().split("?")[0] !== href(projectId, "task", id)) return;
    if (section === "attention" && !leaderTask) return;
    const frame = window.requestAnimationFrame(() => document.getElementById(section === "attention" ? "task-attention" : "task-schedule")?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [active, leaderTask, detail, id, projectId, selectedRevision]);
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
        // One automatic recheck per task version; a projection that still lags is reported, not polled forever.
        const seen = `${id}:${detail.task.version}:${detail.task.currentRevisionId}`;
        if (mismatchRef.current !== seen) {
          mismatchRef.current = seen;
          setLeaderTaskError("任务或工作安排已在读取期间变化；正在重新核对。");
          setReadVersion(current => current + 1);
        } else setLeaderTaskError("当前工作安排还停在任务的旧版本上，暂不显示；可稍后重新读取当前任务。");
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
  if (error && !detail) return <div data-ui="" className="mx-auto w-full max-w-[880px] px-6 pt-6"><ErrorState title="任务读取失败" happened={error} next="可以重新读取；读取失败不代表任务不存在。"
    action={<Button size="compact" onClick={() => setReadVersion(value => value + 1)}>重新读取</Button>} /></div>;
  if (!detail || detail.task.id !== id) return <div data-ui="" className="mx-auto w-full max-w-[880px] px-6 pt-6"><LoadingState lines={6} label="正在读取任务…" /></div>;
  const taskContext = { ...context, blocked: context.blocked || reading || !!error || !!selectedRevision,
    draftScope: `task:${id}`, draftBaseline: detail.revision.id };
  const pending = detail.impacts.filter(i => i.state === "pending");
  const selected = detail.impacts.find(i => i.id === selectedImpactId);
  const acceptance = acceptancePoints(detail.task.acceptance);
  const instanceId = selectedRevision ?? "current";
  const tabId = (value: TaskTab) => `task-tab-${projectId}-${id}-${instanceId}-${value}`;
  const tabsId = `task-tabs-${projectId}-${id}-${instanceId}`;
  const panelId = (value: TaskTab) => `task-panel-${projectId}-${id}-${instanceId}-${value}`;
  function selectTab(value: TaskTab) {
    if (selectedRevision && value === "history") return;
    if (!navigateTaskTab(projectId, id, value, appLocation, context.principal.actorId)) {
      landingRef.current = value;
      setLandingVersion(current => current + 1);
      setTab(value);
    }
  }
  const goal = taskGoal(leaderTask, detail.task);
  const projection = leaderTask ?? undefined;
  const responsibilityLabel = !leaderTask ? "职责尚未读回"
    : leaderTask.responsible.kind === "role" && leaderTask.responsible.id === detail.task.owner
      ? responsibleName ? `负责职责 · ${responsibleName}` : "负责职责待核对"
      : leaderTask.responsible.kind === "session" ? `智能体 · ${leaderTask.responsible.label.replace(/^(受管 Session|外部 HostLink|Session)\s*/, "") || "名称待核对"}`
        : leaderTask.responsible.label;
  const acceptanceNote = `${detail.proposal?.acceptanceMode === "independent_agent" ? "须由不同于实际提交者的智能体使用当前交付" : detail.proposal?.acceptanceMode === "human_required" ? "须由指定的受信用户本人使用当前交付" : "按任务原有验收合同核对"}${detail.proposal?.consumer ? ` · 指定身份 ${detail.proposal.consumer}` : detail.proposal?.acceptanceMode ? " · 验收身份待实际签收" : ""}。任务状态、技术检查和实际使用分别记录。`;
  const state = taskStateStatus[detail.task.state];
  const sectionOpen = new URLSearchParams(currentPath().split("?")[1] ?? "").get("section");
  const heading = "text-heading font-semibold text-foreground";
  const openContent = () => panel?.openInPanel({
    id: `document:${detail.task.contentDocumentId}@${detail.task.contentRevisionId}`, title: "主正文",
    href: href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId),
    render: () => <TaskDocumentPeek projectId={projectId} documentId={detail.task.contentDocumentId} revisionId={detail.task.contentRevisionId} relation="主正文 · 任务固定的修订" />,
  });
  return <div data-ui="" className="task-page mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 pb-16 pt-5 max-compact:px-4" data-task-page={id}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {sessionReturn && <a className="text-label text-primary hover:underline" href={sessionReturn.href}>← 返回【{sessionReturn.title}】</a>}
      {viewSwitch}
      <span className="flex-1" />
      <span className="text-caption text-muted-foreground">{reading ? "正在核对当前任务…" : observedAt ? `读于 ${date(observedAt.toISOString())}` : "尚未读回"}</span>
      <Button size="compact" variant="ghost" onClick={() => setReadVersion(value => value + 1)}>重新读取当前任务</Button>
      {/* Below 1100px the right column is a drawer: its facts open from here. */}
      {panel && <Button size="compact" className="min-[1100px]:hidden" onClick={() => panel.setOpen(true)}>任务信息</Button>}
    </div>
    {selectedRevision && <Notice title={<>正在查看固定历史修订</>}>页首是当前任务；“历史”里单独列出当时的正文、验收与依据。<a className="ml-1 text-primary hover:underline" href={href(projectId, "task", id)}>返回当前任务</a></Notice>}
    <header className="flex flex-col gap-2" data-task-header="">
      <p className="text-caption text-muted-foreground">{taskType(detail.task.kind)} · 第 {detail.task.version} 版</p>
      <h1 tabIndex={-1} className="text-title font-semibold leading-snug text-foreground outline-none">{detail.task.title}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <StatusTag tone={state.tone} label={state.label} />
        {projection && (detail.task.state === "todo" || detail.task.state === "in_progress") && <StatusTag tone={phaseStatus[projection.phase].tone} label={phaseStatus[projection.phase].label} />}
        <span className="text-label text-text-secondary">{responsibilityLabel}</span>
      </div>
    </header>
    {!leaderTask && !leaderTaskError && <p className="text-caption text-muted-foreground" role="status">正在核对本任务当前的进展与具体责任…</p>}
    {leaderTaskError && <Notice tone="error">{leaderTaskError}</Notice>}
    {detail.task.legacyDecision && <Notice tone="waiting" title={legacyDecisionLabel(detail.task.legacyDecision)}
      action={<Button size="compact" onClick={() => selectTab("history")}>查看历史</Button>}>当前状态为“{taskStateLabel[detail.task.state]}”，请先核对旧判断与理由，再决定是否推进。旧判断理由：{detail.task.legacyDecision.reason}</Notice>}
    {error && <Notice tone="error">当前任务回读失败：{error}。页首保留上次读回的内容，不能视为当前状态；编辑草稿仍留在本页。</Notice>}
    <Tabs value={tab} onValueChange={value => selectTab(value as TaskTab)}>
      <TabsList id={tabsId} aria-label="任务详情" className="max-w-full overflow-x-auto">
        {taskTabs.map(item => <TabsTrigger key={item.id} value={item.id} id={tabId(item.id)} aria-controls={panelId(item.id)}>
          {item.label}{item.id === "basis" && pending.length > 0 && <span className="ml-1 tabular-nums text-warning">{pending.length}</span>}
        </TabsTrigger>)}
      </TabsList>
      <TabsContent value="overview" forceMount hidden={tab !== "overview"} id={panelId("overview")} aria-labelledby={tabId("overview")} className="flex flex-col gap-7 pt-5 outline-none">
        <section aria-labelledby={`${panelId("overview")}-goal`} className="flex flex-col gap-2">
          <h2 id={`${panelId("overview")}-goal`} className={heading}>目标</h2>
          <p className="text-body leading-relaxed text-foreground">{goal}</p>
        </section>
        <section aria-labelledby={`${panelId("overview")}-acceptance`} className="flex flex-col gap-2" data-task-acceptance="">
          <h2 id={`${panelId("overview")}-acceptance`} className={heading}>完成条件</h2>
          {acceptance ? <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-body leading-relaxed text-foreground marker:text-muted-foreground">{acceptance.map((point, index) => <li key={index}>{point}</li>)}</ol>
            : <p className="whitespace-pre-wrap text-body leading-relaxed text-foreground">{detail.task.acceptance}</p>}
          <p className="text-caption text-muted-foreground">{acceptanceNote}</p>
        </section>
        <section aria-labelledby={`${panelId("overview")}-body`} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 id={`${panelId("overview")}-body`} className={heading}>正文</h2>
            {panel ? <button type="button" className="text-label text-primary hover:underline" onClick={openContent}>在右栏核对固定原件</button>
              : <a className="text-label text-primary hover:underline" href={href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId)}>阅读固定原件</a>}
          </div>
          <div data-legacy="" className="task-body"><MarkdownBody source={detail.task.content} identity={`task-${detail.revision.id}`} projectId={projectId} /></div>
          <p className="text-caption text-muted-foreground">正文来自任务固定的主文档修订；修改走“任务操作”里的“更新任务内容”，不从文档页绕过任务。</p>
        </section>
        <section aria-labelledby={`${panelId("overview")}-progress`} className="flex flex-col gap-3" data-task-progress="">
          <h2 id={`${panelId("overview")}-progress`} className={heading}>进展与讨论</h2>
          {projection?.timing && <p className="text-label text-text-secondary">现在：{timingStageLabel[projection.timing.current.stage] ?? "阶段未知"} · 本阶段已历时 {timingDuration(projection.timing.current.elapsedMs)}{projection.latestProgress ? ` · 最近进展 ${projection.latestProgress.eventName}（${date(projection.latestProgress.changedAt)}）` : " · 最近进展未记录"}</p>}
          <div data-legacy="" className="flex flex-col gap-4">
            <TaskCollaborationThread token={token} projectId={projectId} taskId={id} refresh={refresh + readVersion} />
            {leaderTask && <div id="task-attention"><TaskAttention key={`${projectId}:${id}:${detail.task.currentRevisionId}`} token={token} projectId={projectId} detail={detail} leader={leaderTask}
              canWrite={canReview && context.principal.permissions.includes("write")} blocked={blockedByUnknown || reading || !!error || !!context.blocked}
              onAttempt={onAttempt} onKnown={onKnown} onChanged={onChanged} /></div>}
            {leaderTask && <details className="task-arrangement-details" id="task-timing" {...(sectionOpen === "timing" ? { open: true } : {})}><summary>阶段区间、计划与来源</summary><LeaderTaskFacts leader={leaderTask} detail={detail} projectId={projectId} token={token} responsibleName={responsibleName} /></details>}
            <TaskSchedulePanel context={taskContext} detail={detail} refresh={refresh + readVersion} />
            <details className="task-provenance"><summary>负责职责与同职责的其他智能体</summary>
              <p className="task-fineprint">职责是持续的分工，具体承接看右栏的绑定与接受记录；同职责的其他智能体不代表承接了本任务。</p>
              <TaskOwner token={token} projectId={projectId} owner={detail.task.owner} readKey={`${refresh}:${readVersion}:${detail.revision.id}`} onResolved={setResponsibleName} /></details>
          </div>
        </section>
      </TabsContent>
      <TabsContent value="basis" forceMount hidden={tab !== "basis"} id={panelId("basis")} aria-labelledby={tabId("basis")} className="pt-5 outline-none">
        <div data-legacy="" className="flex flex-col gap-4">
          <section className="panel"><div className="panel-head"><h2>任务当前固定依据</h2><span>任务修订 <ShortId value={detail.revision.id} /></span></div><p><a href={href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId)}>主正文固定原件 <ShortId value={detail.task.contentRevisionId} /> ↗</a></p><p className="task-fineprint">点击文档打开任务所用的固定修订。文档后来发布新版，不会自动改写此任务的依据。</p><Basis basis={detail.basis} projectId={projectId} documents={basisDocuments} />{basisError && <Alert kind="error">文档现发布版本暂不可读：{basisError}</Alert>}</section>
          <section className="panel"><div className="panel-head"><h2>待复核的依据变化</h2><span>{pending.length} 项</span></div>
            {!pending.length && <p className="empty">当前没有待复核影响。</p>}
            {pending.length > 0 && <div className="impact-tabs">{pending.map(i => <button type="button" key={i.id} className={i.id === selectedImpactId ? "active" : ""} onClick={() => setSelectedImpactId(i.id)}>{basisDocuments[i.documentId]?.document.title ?? "过程文档"} · 新版 <ShortId value={i.toRevisionId} /></button>)}</div>}
            {selected && <><p className="task-fineprint">任务固定版 <ShortId value={selected.fromRevisionId} /> → 文档新版 <ShortId value={selected.toRevisionId} />。请先核对两版，再决定采用或保留。</p><ImpactReview key={selected.id} token={token} projectId={projectId} detail={detail} impact={selected} onChanged={onChanged} onAttempt={onAttempt} onKnown={onKnown} blockedByUnknown={blockedByUnknown} blockedByRead={reading || !!error} canReview={canReview} /></>}
          </section>
        </div>
      </TabsContent>
      <TabsContent value="delivery" forceMount hidden={tab !== "delivery"} id={panelId("delivery")} aria-labelledby={tabId("delivery")} className="pt-5 outline-none">
        <div data-legacy=""><DeliveryPanel token={token} detail={detail} projectId={projectId} names={deliveryNames} onChanged={onChanged} active={active && tab === "delivery"} /></div>
      </TabsContent>
      <TabsContent value="runtime" forceMount hidden={tab !== "runtime"} id={panelId("runtime")} aria-labelledby={tabId("runtime")} className="pt-5 outline-none">
        <div data-legacy="" className="flex flex-col gap-4">
          <TaskAssignmentPanel context={context} task={detail.task} refresh={refresh} />
          <RuntimePanel context={context} refresh={refresh} task={detail.task} taskDetail={detail} collaboration={false} />
          <ReferencePanel key={`refs:${detail.task.currentRevisionId}`} context={context} taskId={detail.task.id} taskRevisionId={detail.task.currentRevisionId} taskVersion={detail.task.version} />
        </div>
      </TabsContent>
      <TabsContent value="history" forceMount hidden={tab !== "history"} id={panelId("history")} aria-labelledby={tabId("history")} className="pt-5 outline-none">
        <div data-legacy="" className="flex flex-col gap-4">
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
        </div>
      </TabsContent>
      <TabsContent value="actions" forceMount hidden={tab !== "actions"} id={panelId("actions")} aria-labelledby={tabId("actions")} className="pt-5 outline-none">
        <div data-legacy="" className="flex flex-col gap-4">
          <p className="task-fineprint">“更新任务内容”默认只改本次。重复任务要修改本次及后续，或只改后续，
            <button type="button" className="quiet" onClick={() => { selectTab("overview"); window.requestAnimationFrame(() => document.getElementById("task-schedule")?.scrollIntoView({ block: "start" })); }}>打开执行时间与重复设置 →</button>
          </p>
          <TaskWorkflow key={detail.task.id} context={taskContext} detail={detail} documents={basisDocuments} leader={leaderTask} mode="actions" />
        </div>
      </TabsContent>
    </Tabs>
    <ContextPanelContent><TaskFacts context={context} taskId={id} detail={detail} leader={leaderTask} leaderKnown={!!leaderTask || !!leaderTaskError} linkForTab={linkForTab} /></ContextPanelContent>
  </div>;
}
