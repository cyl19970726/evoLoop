import { useEffect, useRef, useState } from "react";
import type { SessionActivity, SessionSnapshot } from "@evoloop/contracts/session-observation";
import { commandSchema, type Command } from "@evoloop/contracts";
import { ApiError, api, errorText, isUnconfirmed } from "../api";
import { ActionForm, option, type MutationContext } from "../workflow/ActionForm";
import { deliveryTarget } from "../workflow/deliveryPresentation";
import { Alert, date, href } from "../ui/shared";
import { sessionClient } from "./client";
import { SessionOpenEntry } from "./SessionOpenEntry";
import { AllocationBacklinks } from "../discussions/AllocationBacklinks";
import { queuePosition, queueStateLabel } from "./queuePresentation";
import { ActivityFeed, clearActivityDetails, type ActivityFilter } from "./ActivityFeed";
import { SessionRecoveryOverview, SessionRecoveryResources } from "./SessionRecoveryObservation";
import { checkedRecoveryView, type RecoveryRead } from "./recoveryPresentation";
import { currentWorkRelationLabel, idleSessionResult, latestSessionResult, sessionHeaderStatusLabel, sessionIdleSummary, sessionResultUseLabel } from "./sessionStatusPresentation";
import { NativeSessionPanel } from "./NativeSessionPanel";
import { SessionClosePanel } from "./SessionClosePanel";
import { nativeInputPresentation } from "./nativeInputPresentation";
import { nativeObservationPresentation } from "./nativeObservationPresentation";
import { observedRunTaskLink } from "./taskRunLink";
import { SessionConversation } from "./SessionConversation";
import "./workspace.css";

type Tab = "activity" | "queue" | "results";
const tabLabels: Record<Tab, string> = { activity: "活动与对话", queue: "任务与队列", results: "成果" };
const sessionMembership = (value: SessionSnapshot["session"]["membership"]) =>
  value === "current" ? "当前团队" : value === "historical" ? "历史会话" : "待归类";
const taskProgress = (value: string) => ({ todo: "待开始", in_progress: "进行中", done: "已完成", cancelled: "已取消" } as Record<string, string>)[value] ?? "状态未识别";
function assignmentLabel({ assignment, task, stale }: SessionSnapshot["assignments"][number]): string {
  if (task.state === "done" || task.state === "cancelled") {
    const outcome = task.state === "done" ? "任务已完成" : "任务已取消";
    const history = assignment.state === "accepted"
      ? assignment.ack?.method === "direct" ? "（曾直接确认接手）"
        : assignment.ack?.method === "lead-observed" ? "（曾由负责人观察接手）" : "（曾记录接手）"
      : assignment.state === "released" ? "（已释放）" : "（未确认接手）";
    return `${outcome} · 历史分派${history}`;
  }
  if (stale) return "任务修订已变化，需重新确认";
  if (assignment.state === "accepted") return `已接手（${assignment.ack?.method === "direct" ? "本人确认" : "负责人观察"}）`;
  return assignment.state === "assigned" ? "待确认" : "已释放";
}
function tabFromHash(sessionKey: string): Tab {
  const values = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const value = values.get("tab");
  return values.get("session") === sessionKey && value && value in tabLabels ? value as Tab : "activity";
}
function viewFromHash(sessionKey: string) {
  const values = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return values.get("session") === sessionKey ? {
    filter: values.get("filter") === "all" ? "all" as ActivityFilter : "important" as ActivityFilter,
    open: (values.get("open") ?? "").split(",").filter(Boolean).slice(0, 10),
  } : { filter: "important" as ActivityFilter, open: [] as string[] };
}
const remember = new Map<string, SessionSnapshot>();
export function clearSessionSnapshots() { remember.clear(); clearActivityDetails(); }
function rememberSnapshot(scope: string, snapshot: SessionSnapshot) {
  remember.delete(scope); remember.set(scope, snapshot);
  while (remember.size > 2) remember.delete(remember.keys().next().value!);
}
const bounded = (old: SessionActivity[], newer: SessionActivity[]) => {
  const merged = new Map(old.map(item => [item.id, item]));
  for (const item of newer) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => BigInt(a.sequence) === BigInt(b.sequence) ? 0 : BigInt(a.sequence) > BigInt(b.sequence) ? -1 : 1).slice(0, 300);
};

export function SessionWorkspace({ context, sessionKey, active, refresh }: { context: MutationContext; sessionKey: string; active: boolean; refresh: number }) {
  const scope = `${context.principal.actorId}:${context.projectId}:${sessionKey}`;
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(() => remember.get(scope) ?? null);
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyPartial, setHistoryPartial] = useState(false);
  const [historyLimitations, setHistoryLimitations] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>(() => tabFromHash(sessionKey));
  const [filter, setFilter] = useState<ActivityFilter>(() => viewFromHash(sessionKey).filter);
  const [open, setOpen] = useState<string[]>(() => viewFromHash(sessionKey).open);
  const [informationOpen, setInformationOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [error, setError] = useState("");
  const [confirmedRead, setConfirmedRead] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [loading, setLoading] = useState(true);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [readAgain, setReadAgain] = useState(0);
  const [recoveryRead, setRecoveryRead] = useState<RecoveryRead>({ status: "loading" });
  const epoch = useRef(0);
  const historyAbort = useRef<AbortController | null>(null);
  const historyScope = useRef("");
  historyScope.current = `${context.token}\0${scope}\0${active}\0${refresh}\0${readAgain}`;
  const cursor = useRef<string | null>(null);
  const requestVersion = useRef(0);
  const readKey = `${context.token}\0${context.projectId}\0${sessionKey}`;
  const pollInterval = snapshot?.session.key === sessionKey && snapshot.session.kind !== "owned" && snapshot.session.busy === false ? 15000 : 5000;
  useEffect(() => {
    const sync = () => { if (active) { setTab(tabFromHash(sessionKey)); const view = viewFromHash(sessionKey); setFilter(view.filter); setOpen(view.open); } };
    sync(); window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [sessionKey, active]);
  function viewUrl(nextTab = tab, nextFilter = filter, nextOpen = open) {
    const params = new URLSearchParams({ session: sessionKey, tab: nextTab, filter: nextFilter });
    if (nextOpen.length) params.set("open", nextOpen.slice(-10).join(","));
    return `${href(context.projectId, "sessions")}?${params}`;
  }
  function taskHref(taskId: string) {
    const params = new URLSearchParams({ return: viewUrl(), actor: context.principal.actorId, returnTitle: snapshot?.session.title.slice(0, 80) ?? "Session" });
    return `${href(context.projectId, "task", taskId)}?${params}`;
  }
  useEffect(() => {
    if (!active) return;
    const current = ++epoch.current;
    historyAbort.current?.abort(); historyAbort.current = null;
    const controller = new AbortController();
    const client = sessionClient(context.token, context.projectId);
    let checking = false;
    let snapshotChecking = false;
    let recoveryChecking = false;
    let latestSnapshotVersion = 0;
    let recoveryTarget: string | null = null;
    cursor.current = null;
    const saved = remember.get(scope) ?? null;
    let pollOwnedSnapshot = saved?.session.kind === "owned" && saved.session.target.kind === "owned";
    setSnapshot(saved); setActivity(saved?.activity ?? []); setHistoryCursor(null); setHistoryLoaded(false);
    setHistoryPartial(false); setHistoryLimitations([]); setHistoryError(""); setHistoryBusy(false); setError(""); setConfirmedRead(""); setLoading(true);
    setRecoveryRead({ status: "loading" });
    async function readRecovery(sessionId: string, snapshotVersion = latestSnapshotVersion) {
      if (document.visibilityState === "hidden" || recoveryChecking || !snapshotVersion) return;
      recoveryChecking = true;
      try {
        const view = checkedRecoveryView(await client.recovery(sessionId, controller.signal), context.projectId, sessionId);
        if (epoch.current === current && recoveryTarget === sessionId && requestVersion.current === snapshotVersion)
          setRecoveryRead({ status: "ready", view });
      } catch (cause) {
        if (controller.signal.aborted || epoch.current !== current || recoveryTarget !== sessionId
          || requestVersion.current !== snapshotVersion) return;
        if (cause instanceof ApiError && cause.status === 404) setRecoveryRead({ status: "unavailable", message: "接口或对象不可用；请核对当前会话与服务记录。" });
        else if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setRecoveryRead({ status: "forbidden", message: "请核对项目读取权限。" });
        else if (cause instanceof ApiError && cause.status === 0) setRecoveryRead({ status: "failed", message: "连接中断或超时；无法据此判断恢复状态。" });
        else setRecoveryRead({ status: "failed", message: errorText(cause) });
      } finally {
        recoveryChecking = false;
        if (!controller.signal.aborted && epoch.current === current && recoveryTarget === sessionId
          && latestSnapshotVersion === requestVersion.current && latestSnapshotVersion !== snapshotVersion
          && document.visibilityState === "visible") void readRecovery(sessionId, latestSnapshotVersion);
      }
    }
    async function read(force = false) {
      if (snapshotChecking && !force) return;
      snapshotChecking = true;
      const version = ++requestVersion.current;
      try {
        const result = await client.snapshot(sessionKey, controller.signal);
        if (epoch.current !== current || version !== requestVersion.current) return;
        if (result.session.key !== sessionKey) throw new Error("会话响应与所选 Session 不符");
        cursor.current = result.observationCursor;
        rememberSnapshot(scope, result); setSnapshot(result); setConfirmedRead(readKey);
        setActivity(old => bounded(old, result.activity)); setError("");
        latestSnapshotVersion = version;
        pollOwnedSnapshot = result.session.kind === "owned" && result.session.target.kind === "owned";
        const nextRecoveryTarget = result.session.kind === "owned" && result.session.target.kind === "owned" ? result.session.target.sessionId : null;
        if (nextRecoveryTarget !== recoveryTarget) setRecoveryRead({ status: "loading" });
        recoveryTarget = nextRecoveryTarget;
        if (recoveryTarget) void readRecovery(recoveryTarget, version);
      } catch (cause) { if (!controller.signal.aborted && epoch.current === current && version === requestVersion.current) {
        recoveryTarget = null;
        setError(errorText(cause)); setConfirmedRead(""); setRecoveryRead({ status: "failed", message: "请先重新读取当前会话。" });
      } }
      finally { if (epoch.current === current && version === requestVersion.current) { snapshotChecking = false; setLoading(false); } }
    }
    void read();
    async function checkChanges() {
      if (document.visibilityState === "hidden" || !cursor.current || checking) return;
      checking = true;
      try {
        const seen = new Set<string>();
        const startedFrom = cursor.current;
        let next: string | null = startedFrom;
        let affected = false;
        for (let batch = 0; batch < 3; batch++) {
          const changes = await client.changes(next!, sessionKey, controller.signal);
          if (epoch.current !== current) return;
          if (changes.resetRequired) { affected = true; next = null; break; }
          if (seen.has(changes.nextCursor)) break;
          seen.add(changes.nextCursor);
          affected ||= changes.items.some(item => !item.sessionKeys.length || item.sessionKeys.includes(sessionKey));
          next = changes.nextCursor;
          if (!changes.hasMore) break;
        }
        if (epoch.current !== current || cursor.current !== startedFrom) return;
        if (next) cursor.current = next;
        if (affected) await read(true);
      } catch (cause) { if (!controller.signal.aborted && epoch.current === current) setError(`变化读取失败：${errorText(cause)}`); }
      finally { checking = false; }
    }
    // Native input is transient and may arrive without a session-work change entry.
    // Poll the owned snapshot itself so a pending question appears without a manual refresh.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      if (pollOwnedSnapshot || !cursor.current) void read();
      else void checkChanges();
    }, pollInterval);
    const visible = () => { if (document.visibilityState === "visible") { void read(true); } };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); historyAbort.current?.abort(); epoch.current++; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [context.token, context.projectId, context.principal.actorId, sessionKey, scope, readKey, active, refresh, readAgain, pollInterval]);
  async function moreActivity() {
    if (historyBusy || historyLoaded && !historyCursor) return;
    const requestScope = historyScope.current, requestEpoch = epoch.current;
    const controller = new AbortController();
    historyAbort.current = controller;
    const currentRequest = () => !controller.signal.aborted && historyScope.current === requestScope && epoch.current === requestEpoch;
    setHistoryBusy(true); setHistoryError("");
    try {
      const page = await sessionClient(context.token, context.projectId).activities(sessionKey, historyCursor ?? undefined, controller.signal);
      if (!currentRequest()) return;
      if (page.items.some(item => item.sessionKey !== sessionKey)) throw new Error("活动历史与所选 Session 不符");
      setActivity(old => bounded(old, page.items)); setHistoryCursor(page.nextCursor); setHistoryLoaded(true);
      setHistoryPartial(old => old || page.metadata.partial);
      setHistoryLimitations(old => [...new Set([...old, ...page.metadata.limitations])]);
    } catch (cause) { if (currentRequest()) setHistoryError(errorText(cause)); }
    finally { if (currentRequest()) { historyAbort.current = null; setHistoryBusy(false); } }
  }
  const current = snapshot?.session.key === sessionKey ? snapshot : null;
  if (!current) return <div className="content"><h1>Session</h1>{loading ? <p>正在读取会话工作区…</p> : <Alert kind="error">会话暂不可读取：{error || "未找到当前项目的会话"}。<button onClick={() => setReadAgain(value => value + 1)}>重试</button></Alert>}</div>;
  const session = current.session;
  const work = current.currentWork;
  const native = session.kind === "owned" && session.target.kind === "owned"
    ? nativeInputPresentation(current.nativeInputRequests, session.target.sessionId)
    : { questions: [], error: null };
  const observation = session.kind === "owned" && session.target.kind === "owned"
    ? nativeObservationPresentation(current.nativeObservation, context.projectId, session.target.sessionId)
    : { progress: null, error: null };
  const discussionQuestionCount = current.questions.filter(question => !question.answered).length;
  const nativeQuestionCount = native.questions.filter(question => question.state === "pending").length;
  const idleSummary = sessionIdleSummary(session);
  const idleResult = idleSessionResult(session, work, current.results);
  const nativeReadCurrent = confirmedRead === readKey && !loading && !error;
  async function answerNative(requestId: string, expectedVersion: number, answers: Record<string, string[]>) {
    const request = native.questions.find(item => item.id === requestId && item.version === expectedVersion);
    if (!active || !nativeReadCurrent || native.error || context.blocked || !request?.canReply || request.state !== "pending")
      throw new Error("当前原生请求不能回复；请先回读状态。");
    let command: Command;
    try { command = commandSchema.parse({ type: "session.input.reply", projectId: context.projectId,
      operationId: crypto.randomUUID(), inputRequestId: requestId, expectedVersion, answers }); }
    catch { throw new Error("回答格式无法确认，请重新读取原生请求后再填写。"); }
    let recorded = false;
    try { recorded = await context.onAttempt(command); }
    catch { /* A receipt that cannot be saved must not send the answer. */ }
    if (!recorded) throw new Error("浏览器无法保存恢复回执，本次尚未发送。");
    let known = false;
    try {
      const result = await api(context.token).command(command);
      context.onKnown(command.operationId); known = true;
      if (result.status === "rejected") { setReadAgain(value => value + 1); throw new Error(result.message); }
      setReadAgain(value => value + 1);
      context.onChanged();
    } catch (cause) {
      if (!known && !isUnconfirmed(cause)) context.onKnown(command.operationId);
      throw cause;
    }
  }
  const limitation = [...new Set([...session.metadata.limitations, ...current.metadata.limitations, ...historyLimitations])];
  const messageRunning = nativeReadCurrent && observation.progress?.freshness === "live" && observation.progress.status === "active" && observation.progress.turn?.status === "inProgress" && observation.progress.turn.source?.kind === "message";
  const statusLabel = sessionHeaderStatusLabel(session, messageRunning);
  const activeBusy = session.runtimeState === "ready" && session.busy === true;
  const displayedTaskId = work?.id ?? idleResult?.taskId;
  const relationLabel = work ? currentWorkRelationLabel(work, session, recoveryRead.status === "ready" ? recoveryRead.view.gate?.phase : undefined) : null;
  const currentRunId = activeBusy && ["requested", "dispatching", "running", "unknown"].includes(session.latestBusinessRun?.state ?? "")
    ? session.latestBusinessRun?.id ?? null : null;
  const queueAttention = current.queue.find(item => item.state === "claimed" || item.state === "held") ?? current.queue.find(item => item.state === "queued");
  const currentAssignment = current.assignments.find(item => item.task.id === work?.id && !item.stale && item.assignment.state !== "released");
  const recentResult = latestSessionResult(current.results);
  const recentRunHref = session.latestBusinessRun ? observedRunTaskLink(session.latestBusinessRun, taskHref) : null;
  const failedRun = session.latestBusinessRun && ["failed", "interrupted", "unknown"].includes(session.latestBusinessRun.state)
    ? session.latestBusinessRun : null;
  const executionProfile = recoveryRead.status === "ready" ? recoveryRead.view.executionProfile : null;
  const configuredModel = current.resources.configuredModel.value ?? executionProfile?.revision.model ?? "未同步";
  const actualModel = current.resources.actualModel.value ?? "未同步";
  const permissionScope = executionProfile ? `${executionProfile.revision.sandbox} · ${executionProfile.revision.approvalPolicy}` : "未同步";
  const turnLabel = observation.progress?.turn ? `${observation.progress.turn.status === "inProgress" ? "进行中" : observation.progress.turn.status === "completed" ? "已结束" : observation.progress.turn.status === "failed" ? "失败" : "状态待核对"} · ${date(observation.progress.lastEventAt)}` : "未同步";
  return <div className="content session-workspace">
    <header className="session-detail-header">
      <div className="session-detail-heading"><h1>{session.title}<span className="session-status-badge">{statusLabel}</span></h1><p>{session.kind === "owned" ? "项目受管" : "外部 Agent · 人工接入"}<span>·</span>{session.roles.map(role => role.title).join("、") || "职责待核对"}<span>·</span>{sessionMembership(session.membership)}</p></div>
      <div className="session-workspace-actions"><button type="button" onClick={() => setReadAgain(value => value + 1)} disabled={loading}>重新读取</button><button type="button" aria-expanded={closeOpen} aria-controls="session-close-panel" onClick={() => setCloseOpen(value => !value)}>{session.kind === "owned" ? "关闭受管 Session" : "归档与归类"}</button></div>
    </header>
    {error && <Alert kind="error">{error}。显示上次读回；请重新读取。</Alert>}
    {closeOpen && <div id="session-close-panel"><SessionClosePanel context={context} snapshot={current} currentRead={active && !loading && !error && confirmedRead === readKey} onReadAgain={() => setReadAgain(value => value + 1)} /></div>}
    <div className="session-context-band">
      <section className="session-current-work"><div>
        <small>{work ? "当前任务" : activeBusy ? "当前活动" : idleResult ? "最近已读关联交付 · 当前任务未确认" : "当前状态"}</small>
        <strong>{work ? <a href={taskHref(work.id)}>{work.title}</a> : activeBusy ? messageRunning ? "正在回复消息" : "在途结果待核对"
          : idleResult ? <a href={taskHref(idleResult.taskId)}>{idleResult.taskTitle || "任务标题未提供"}</a> : idleSummary}</strong>
        <span>{work ? `${relationLabel} · 任务${taskProgress(work.state)}`
          : idleResult ? `技术结果：${idleResult.technicalResult || "未提供"} · ${sessionResultUseLabel(idleResult)} · 交付 ${date(idleResult.submittedAt)}${idleResult.latestUse ? ` · 使用观察 ${date(idleResult.latestUse.createdAt)}` : ""}${current.metadata.partial ? " · 来源仅展示已读范围" : ""}`
            : session.lastProgressAt ? `最近进展 ${date(session.lastProgressAt)}` : "暂无可确认的当前 Task"}{discussionQuestionCount + nativeQuestionCount > 0 && ` · 待答 ${discussionQuestionCount + nativeQuestionCount}`}</span>
      </div>{displayedTaskId && <a className="session-task-link" href={taskHref(displayedTaskId)}>查看任务</a>}</section>
      <section className="session-agent-card" aria-labelledby="session-agent-title"><div className="session-agent-card-head"><h2 id="session-agent-title">Agent 信息</h2><span>{session.kind === "owned" ? "受管" : "外部"}</span></div><dl><div><dt>模型</dt><dd>{String(configuredModel)}</dd></div><div><dt>思考强度</dt><dd>未同步</dd></div><div><dt>权限</dt><dd>{permissionScope}</dd></div></dl>{session.kind === "external" ? <p>外部实时状态、模型与工具未同步。</p> : <p>实际运行 {String(actualModel)} · 最近 Turn {turnLabel.split(" · ")[0]}</p>}</section>
    </div>
    {failedRun && <p className="session-run-attention" role="status">最近运行{failedRun.state === "failed" ? "失败" : failedRun.state === "interrupted" ? "已中断" : "结果未知"}；{recentRunHref ? <>请先<a href={recentRunHref}>核对原 Run</a>和当前任务，再决定下一步。</> : "原 Run 缺少可核对的 Task 关联，暂不能直达；请重新读取会话并核对任务运行记录。"}</p>}
    {(session.runtimeState === "unknown" || session.runtimeState === "closed" || recoveryRead.status === "failed") && session.kind === "owned" && session.target.kind === "owned" && <SessionRecoveryOverview read={recoveryRead} runtimeState={session.runtimeState} queueHref={`${href(context.projectId, "runtime")}?view=execution`} />}
    <nav className="session-workspace-tabs" aria-label="Session 工作区栏目">{(Object.keys(tabLabels) as Tab[]).map(key => <button key={key} type="button" className={tab === key ? "selected" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => { setTab(key); window.location.hash = viewUrl(key); }}>{tabLabels[key]}</button>)}</nav>
    {tab === "activity" && <>
      {session.kind === "owned" && session.target.kind === "owned" && (native.questions.some(request => request.state === "pending" || request.state === "response_saved") || native.error) && <NativeSessionPanel projectId={context.projectId} sessionId={session.target.sessionId} questions={native.questions} progress={observation.progress} progressError={observation.error} progressCurrentRead={nativeReadCurrent && !observation.error} readError={error || native.error} replyBlockedReason={error || native.error ? null : !nativeReadCurrent ? "正在重新读取当前会话，请稍候。" : context.blocked ? "当前还有结果未确认的操作；请先按原操作 ID 核对，再回答。" : null} onAnswer={answerNative} taskHref={taskHref} section="questions" />}
      {active && <SessionConversation key={current.session.key} context={context} snapshot={current} progress={observation.progress} onApplied={() => setReadAgain(value => value + 1)} />}
      <details className="session-project-activity"><summary>项目活动与来源记录<span>{activity.length} 项已读</span></summary><ActivityFeed items={activity} filter={filter} onFilter={value => { setFilter(value); window.history.replaceState(null, "", viewUrl(tab, value)); }} open={open} onOpen={value => { setOpen(value); window.history.replaceState(null, "", viewUrl(tab, filter, value)); }} projectId={context.projectId} sessionKey={sessionKey} token={context.token} taskHref={taskHref} taskTitle={id => id === work?.id ? work.title : current.queue.find(item => item.taskId === id)?.taskTitle ?? current.roleTasks.find(item => item.id === id)?.title ?? null} currentRunId={currentRunId} />{(!historyLoaded || historyCursor) && <button type="button" disabled={historyBusy} onClick={() => void moreActivity()}>{historyBusy ? "读取中…" : historyCursor ? "加载更早活动" : "读取活动历史"}</button>}{historyError && <Alert kind="error">{historyError}</Alert>}</details>
    </>}
    {tab === "queue" && <section className="session-workspace-section"><div className="session-section-head"><div><h2>任务队列</h2><p className="muted">按已确认的顺序逐项处理；排队不表示已开始运行。</p></div><a href={`${href(context.projectId, "runtime")}?view=execution`}>管理受管队列</a></div><div className="session-queue-glance">{queueAttention && <p><strong>队列占用／顺位</strong><span><a href={taskHref(queueAttention.taskId)}>{queueAttention.taskTitle}</a> · {queueStateLabel(queueAttention.state)}{queueAttention.holdReason && ` · ${queueAttention.holdReason}`}</span></p>}{work && <p><strong>具体分派</strong><span>{currentAssignment ? assignmentLabel(currentAssignment) : "没有可确认的当前修订接受记录"}</span></p>}{recentResult && <p><strong>最近关联交付</strong><span><a href={taskHref(recentResult.taskId)}>{recentResult.taskTitle}</a> · {sessionResultUseLabel(recentResult)} · {date(recentResult.submittedAt)}</span></p>}</div><div className="session-task-summary"><h3>具体承接</h3>{work ? <p><a href={taskHref(work.id)}>{work.title}</a> · {taskProgress(work.state)} · {relationLabel}</p> : <p>当前没有可确认的具体承接。</p>}{current.assignments.filter(item => item.task.id !== work?.id).map(item => <p key={`${item.task.id}:${item.assignment.version}`}><a href={taskHref(item.task.id)}>{item.task.title}</a> · {assignmentLabel(item)}</p>)}</div><h3>排队顺序</h3>{current.queue.length ? <ol className="session-queue-list">{current.queue.map(item => <li key={item.entryId}><span className="session-queue-position" aria-label={`第 ${queuePosition(item.position)} 项`}>{queuePosition(item.position)}</span><div><strong><a href={taskHref(item.taskId)}>{item.taskTitle}</a></strong><small>{queueStateLabel(item.state)}{item.holdReason && ` · ${item.holdReason}`}</small></div></li>)}</ol> : <p className="empty">当前范围没有关联队列条目。</p>}</section>}
    {tab === "results" && <section className="session-workspace-section"><h2>成果与使用</h2><p className="muted">这里包含与本 Session 关联的交付；关联关系不证明由本 Session 提交。</p>{current.results.length ? <ul className="session-results">{current.results.map(item => { const target = deliveryTarget(item, context.projectId); return <li key={item.deliveryId}><strong><a href={taskHref(item.taskId)}>{item.taskTitle}</a></strong><p>技术结果：{item.technicalResult} · {item.latestUse ? `使用观察：${item.latestUse.result}（${item.latestUse.observerKind}，${date(item.latestUse.createdAt)}）` : "尚无实际使用观察"}</p><p>{target.href ? <a href={target.href}>打开固定成果</a> : target.kind === "fallback" ? target.label : "固定成果不可打开"} · 固定修订 <code>{item.artifactRevision}</code></p><details><summary>交付来源</summary><code>{item.artifactRef}</code><p>内容 SHA-256 <code>{item.contentHash}</code></p><p>交付 {date(item.submittedAt)}</p></details></li>; })}</ul> : <p className="empty">当前范围没有交付记录。</p>}</section>}
    <details className="session-support session-information" onToggle={event => setInformationOpen(event.currentTarget.open)}><summary>接入、职责、配置与恢复详情</summary>
      <div className="session-support-grid">
        <section><h2>原聊天入口</h2><p>{session.kind === "owned" ? "项目受管；消息保存后进入真实处理队列。" : "外部接入；消息只保存为人工转交。"}</p><SessionOpenEntry session={session} token={context.token} projectId={context.projectId} currentRead={active && !loading && !error} active={active} /></section>
        <section><h2>职责与分派</h2><p>{session.profile?.purpose || "用途尚未登记"}</p>{session.roles.map(role => <p key={role.id}><a href={href(context.projectId, "roles")}>{role.title}</a> · {role.responsibility}</p>)}<h3>具体分派</h3>{current.assignments.length ? <ul>{current.assignments.map(item => <li key={`${item.assignment.taskId}:${item.assignment.version}`}><a href={taskHref(item.task.id)}>{item.task.title}</a> · {assignmentLabel(item)}</li>)}</ul> : <p>没有具体分派。</p>}<details><summary>角色责任范围 · {current.roleTasks.length} 项</summary><p>角色负责这些任务，不表示此 Session 已接手。</p><ul>{current.roleTasks.map(task => <li key={task.id}><a href={taskHref(task.id)}>{task.title}</a></li>)}</ul></details>{active && informationOpen && <AllocationBacklinks context={context} filter={{ sessionKey }} refresh={refresh + readAgain} />}<SessionProfileForm context={context} snapshot={current} onApplied={() => setReadAgain(value => value + 1)} /></section>
      </div>
      <section><h2>资源观察</h2><p className="muted">配置模型、实际模型和用量分别列示；缺少可靠来源时显示不可用原因，不填零。</p>{session.kind === "owned" && session.target.kind === "owned" && <SessionRecoveryResources read={recoveryRead} queueHref={`${href(context.projectId, "runtime")}?view=execution`} />}<dl className="session-resource-list">{([
        ["configuredModel", "配置模型"], ["actualModel", "实际运行模型"], ["inputTokens", "输入 Token"], ["outputTokens", "输出 Token"], ["cost", "费用"], ["processMemory", "进程内存"],
      ] as const).map(([key, label]) => { const item = current.resources[key]; return <div key={key}><dt>{label}</dt><dd><strong>{item.value === null ? "不可用" : `${item.value}${item.unit ? ` ${item.unit}` : ""}`}</strong><small>{item.value === null ? item.unavailableReason ?? "没有可靠观察来源" : `${item.scope} · ${item.source ?? "来源未记录"} · ${date(item.observedAt ?? undefined)}`}</small></dd></div>; })}</dl></section>
      {session.kind === "owned" && session.target.kind === "owned" && <SessionRecoveryOverview read={recoveryRead} runtimeState={session.runtimeState} queueHref={`${href(context.projectId, "runtime")}?view=execution`} />}
      {session.kind === "owned" && session.target.kind === "owned" && <NativeSessionPanel projectId={context.projectId} sessionId={session.target.sessionId} questions={native.questions} progress={observation.progress} progressError={observation.error} progressCurrentRead={nativeReadCurrent && !observation.error} readError={error || native.error} replyBlockedReason={null} onAnswer={answerNative} taskHref={taskHref} section="diagnostics" />}
    </details>
    <p className="session-workspace-freshness">工作区读于 {date(current.metadata.generatedAt)}。{current.metadata.partial || historyPartial ? "来源仅展示已读范围。" : ""}</p>
    {limitation.length > 0 && <details className="session-workspace-limitations"><summary>来源限制与未确认信息</summary><ul>{limitation.map(item => <li key={item}>{item}</li>)}</ul></details>}
  </div>;
}

function SessionProfileForm({ context, snapshot, onApplied }: { context: MutationContext; snapshot: SessionSnapshot; onApplied(): void }) {
  const profile = snapshot.session.profile;
  return <ActionForm context={{ ...context, draftScope: `session-profile:${snapshot.session.key}`, draftBaseline: `${profile?.version ?? 0}` }} review title="设置 Session 展示信息" fields={[
    { name: "displayName", label: "展示名称", value: profile?.displayName ?? snapshot.session.title },
    { name: "purpose", label: "用途", kind: "textarea", optional: true, value: profile?.purpose ?? "" },
    { name: "membership", label: "团队归属", kind: "select", value: profile?.membership ?? snapshot.session.membership, options: [option("current", "当前团队"), option("historical", "历史"), option("unclassified", "待归类")] },
    { name: "tenure", label: "会话性质", kind: "select", value: profile?.tenure ?? "unknown", options: [option("resident", "常驻"), option("temporary", "临时"), option("unknown", "未知")] },
    { name: "reason", label: "变更依据", kind: "textarea" },
  ]} build={v => ({ type: "session.profile.set", target: snapshot.session.target, expectedVersion: profile?.version ?? 0, displayName: v.displayName, purpose: v.purpose, membership: v.membership, tenure: v.tenure, reason: v.reason })} onApplied={onApplied} />;
}
