// One agent (Session): the conversation in the center, and in the right column who it is, what it works on (动态),
// what it produced (资料库), its environment and use, and the details and sources behind it. Reads go through
// useProjectQuery: the snapshot polls while a project-run agent is open, an external one checks the change feed, and
// recovery follows each snapshot. A read that is running or failed is never shown as “none”, “idle” or 0; a failed
// reread keeps the last answer and says so. The conversation's own long poll stays in useSessionTimeline.
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Info, RefreshCw, X } from "lucide-react";
import type { SessionSnapshot } from "@evoloop/contracts/session-observation";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { commandSchema, type Command } from "@evoloop/contracts";
import { AgentAvatar, Button, CollapsibleRow, Notice, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@evoloop/ui";
import { ApiError, api, errorText, isUnconfirmed } from "../../shared/api";
import { ActionForm, option, type MutationContext } from "../../shared/ActionForm";
import { deliveryTarget } from "../../shared/deliveryPresentation";
import { useProjectPages, useProjectQuery } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { runtimeClient } from "../../shared/runtimeClient";
import { sessionClient } from "../../shared/sessionClient";
import { timingDuration, timingStageLabel, timingWaitingFor } from "../../shared/taskTiming";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { FactList, Legacy, PanelSection, mutedText } from "../../shared/ui/PageParts";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { currentPath, onNavigate, replaceQuietly } from "../../shared/navigation";
import { AllocationBacklinks } from "../discussions";
import { SessionOpenEntry } from "./SessionOpenEntry";
import { queuePosition, queueStateLabel } from "./queuePresentation";
import { ActivityFeed, clearActivityDetails, type ActivityFilter } from "./ActivityFeed";
import { SessionRecoveryOverview, SessionRecoveryResources } from "./SessionRecoveryObservation";
import { checkedRecoveryView, permissionLabel, type RecoveryRead } from "./recoveryPresentation";
import { currentNativeRunId, currentWorkRelationLabel, idleSessionResult, latestSessionResult, agentHeaderStatus, sessionIdleSummary, sessionResultUseLabel } from "./sessionStatusPresentation";
import { NativeSessionPanel } from "./NativeSessionPanel";
import { SessionClosePanel } from "./SessionClosePanel";
import { SessionExecutionFacts } from "./SessionExecutionFacts";
import { SessionModelControl } from "./SessionModelControl";
import { SessionIdentityMark } from "./SessionIdentityMark";
import { SessionIdentityControl } from "./SessionIdentityControl";
import { nativeInputPresentation } from "./nativeInputPresentation";
import { nativeObservationPresentation } from "./nativeObservationPresentation";
import { observedRunTaskLink } from "./taskRunLink";
import { SessionTimeline, clearSessionTimelineViews } from "./SessionTimeline";
import { clearSessionTimelineReads } from "./useSessionTimeline";

/** `tab` in the address: activity and queue open 动态 in the right column, results opens 资料库. */
type Tab = "activity" | "queue" | "results";
type PanelTab = "activity" | "results";
const tabNames: Record<Tab, string> = { activity: "活动与对话", queue: "任务与队列", results: "成果" };
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
  const values = new URLSearchParams(currentPath().split("?")[1] ?? "");
  const value = values.get("tab");
  return values.get("session") === sessionKey && value && value in tabNames ? value as Tab : "activity";
}
function viewFromHash(sessionKey: string) {
  const values = new URLSearchParams(currentPath().split("?")[1] ?? "");
  const open = (values.get("open") ?? "").split(",").filter(Boolean).slice(0, 10);
  return values.get("session") === sessionKey ? {
    filter: values.get("filter") === "all" ? "all" as ActivityFilter : "important" as ActivityFilter,
    open, informationOpen: values.get("panel") === "information" || values.get("panel") !== "conversation" && open.length > 0,
  } : { filter: "important" as ActivityFilter, open: [] as string[], informationOpen: false };
}
export function clearSessionSnapshots() { clearActivityDetails(); clearSessionTimelineReads(); clearSessionTimelineViews(); }
const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1100px)").matches;
const shortTime = (value: string | null | undefined) => value ? date(value) : "时间未记录";

/** The project's execution queue for one agent (features/workflow's panel), supplied by the app so features stay apart. */
export type QueueSlot = (props: { sessionId: string; runs: RuntimeRunRecord[]; sessions: RuntimeSessionRecord[] }) => ReactNode;

export function SessionWorkspace({ context, sessionKey, active, refresh, queue }: {
  context: MutationContext; sessionKey: string; active: boolean; refresh: number; queue?: QueueSlot | undefined;
}) {
  const { projectId } = context;
  const owned = sessionKey.startsWith("owned:");
  const ownedId = owned ? sessionKey.slice("owned:".length) : null;
  const [tab, setTab] = useState<Tab>(() => tabFromHash(sessionKey));
  const [filter, setFilter] = useState<ActivityFilter>(() => viewFromHash(sessionKey).filter);
  const [open, setOpen] = useState<string[]>(() => viewFromHash(sessionKey).open);
  const [activitySectionOpen, setActivitySectionOpen] = useState(() => viewFromHash(sessionKey).open.length > 0);
  const [informationOpen, setInformationOpen] = useState(() => viewFromHash(sessionKey).informationOpen);
  const [closeOpen, setCloseOpen] = useState(false);
  const [readAgain, setReadAgain] = useState(0);
  const [accessReadAgain, setAccessReadAgain] = useState(0);
  const [changesError, setChangesError] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // A state, not a ref: the right column mounts its content again when it turns into a drawer, and the reveal follows.
  const [activityDetails, setActivityDetails] = useState<HTMLDetailsElement | null>(null);
  const pendingActivityScroll = useRef<string | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  // The agent itself. A project-run agent may show a question or a running turn only in its snapshot, so it polls.
  const snapshotRead = useProjectQuery(projectId, ["session-work", sessionKey], async signal => {
    const result = await sessionClient("", projectId).snapshot(sessionKey, signal);
    if (result.session.key !== sessionKey) throw new Error("会话响应与所选智能体不符");
    return result;
  }, { enabled: active, refetchInterval: active && owned ? 5000 : false, retry: false });
  const snapshot = snapshotRead.data?.session.key === sessionKey ? snapshotRead.data : undefined;
  const snapshotOk = !!snapshot && !snapshotRead.isError;
  const runtimeStatus = useProjectQuery(projectId, ["runtime", "status"], () => runtimeClient("", projectId).status(), { enabled: active && owned, retry: false });
  const recovery = useProjectQuery(projectId, ["runtime", "sessions", ownedId, "recovery"], async signal =>
    checkedRecoveryView(await sessionClient("", projectId).recovery(ownedId!, signal), projectId, ownedId!),
  { enabled: active && !!ownedId && !!snapshot && snapshot.session.target.kind === "owned", retry: false });
  // Recovery and the runtime's availability are read again after every newer snapshot, never before it.
  const lastSnapshotAt = useRef(0);
  useEffect(() => {
    const at = snapshotRead.dataUpdatedAt;
    if (!at || snapshotRead.isError || !owned) return;
    if (lastSnapshotAt.current && at !== lastSnapshotAt.current) { void recovery.refetch(); void runtimeStatus.refetch(); }
    lastSnapshotAt.current = at;
  }, [snapshotRead.dataUpdatedAt]);
  useEffect(() => { lastSnapshotAt.current = 0; setChangesError(""); setHistoryLoaded(false); setCloseOpen(false); }, [sessionKey, projectId]);
  // Coming back to the page reads the agent again at once.
  useEffect(() => {
    if (!active) return;
    const visible = () => { if (document.visibilityState === "visible") void snapshotRead.refetch(); };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [active, projectId, sessionKey]);
  // An external agent's snapshot is read again only when the change feed names it.
  const cursor = useRef<string | null>(null);
  useEffect(() => { if (snapshot) cursor.current = snapshot.observationCursor; }, [snapshotRead.dataUpdatedAt]);
  const externalInterval = !owned && snapshot?.session.busy === false ? 15000 : 5000;
  useEffect(() => {
    if (!active || owned) return;
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (document.visibilityState === "hidden" || !cursor.current || checking) return;
      checking = true;
      try {
        const client = sessionClient("", projectId);
        const seen = new Set<string>();
        const startedFrom = cursor.current;
        let next: string | null = startedFrom, affected = false;
        for (let batch = 0; batch < 3; batch++) {
          const changes = await client.changes(next!, sessionKey, controller.signal);
          if (changes.resetRequired) { affected = true; next = null; break; }
          if (seen.has(changes.nextCursor)) break;
          seen.add(changes.nextCursor);
          affected ||= changes.items.some(item => !item.sessionKeys.length || item.sessionKeys.includes(sessionKey));
          next = changes.nextCursor;
          if (!changes.hasMore) break;
        }
        if (controller.signal.aborted || cursor.current !== startedFrom) return;
        if (next) cursor.current = next;
        setChangesError("");
        if (affected) await snapshotRead.refetch();
      } catch (cause) { if (!controller.signal.aborted) setChangesError(`变化读取失败：${errorText(cause)}`); }
      finally { checking = false; }
    };
    const timer = window.setInterval(() => void check(), externalInterval);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [active, owned, projectId, sessionKey, externalInterval]);

  const currentTaskId = snapshot?.currentWork?.id, currentTaskRevision = snapshot?.currentWork?.revisionId;
  const timing = useProjectQuery(projectId, ["leader-task", currentTaskId, currentTaskRevision], async () => {
    const value: LeaderWorkTask = await api().leaderTask(projectId, currentTaskId!);
    if (value.taskId !== currentTaskId || value.currentRevisionId !== currentTaskRevision) throw new Error("任务阶段响应与当前任务修订不符");
    return value;
  }, { enabled: active && !!currentTaskId && !!currentTaskRevision, retry: false });

  useEffect(() => {
    const sync = () => {
      if (!active) return;
      setTab(tabFromHash(sessionKey));
      const view = viewFromHash(sessionKey);
      setFilter(view.filter);
      setOpen(view.open);
      setInformationOpen(view.informationOpen);
      if (view.open.length) {
        setActivitySectionOpen(true);
        pendingActivityScroll.current = view.open.at(-1) ?? null;
      }
    };
    sync(); return onNavigate(sync);
  }, [sessionKey, active]);
  // The page fills the window below what sits above it, so the composer stays at the bottom and the flow scrolls.
  useLayoutEffect(() => {
    const node = workspaceRef.current;
    if (!node || !active) return;
    const measure = () => node.style.setProperty("--session-top", `${Math.max(0, Math.round(node.getBoundingClientRect().top + window.scrollY))}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [!!snapshot, active]);
  function viewUrl(nextTab = tab, nextFilter = filter, nextOpen = open, nextInformationOpen = informationOpen) {
    const params = new URLSearchParams({ session: sessionKey, tab: nextTab, filter: nextFilter });
    if (nextOpen.length) params.set("open", nextOpen.slice(-10).join(","));
    if (nextInformationOpen || nextOpen.length) params.set("panel", nextInformationOpen ? "information" : "conversation");
    return `${href(projectId, "sessions")}?${params}`;
  }
  function taskHref(taskId: string) {
    const params = new URLSearchParams({ return: viewUrl(), actor: context.principal.actorId, returnTitle: snapshot?.session.title.slice(0, 80) ?? "智能体" });
    return `${href(projectId, "task", taskId)}?${params}`;
  }
  const panel = useContextPanel();
  const panelTab: PanelTab = tab === "results" ? "results" : "activity";
  // A link to this agent's queue or results asks for that view: on a wide window the right column opens on it.
  // Below 1100px the column is a drawer and opens only when the reader asks.
  useEffect(() => { if (active && (tab === "queue" || tab === "results") && wide()) panel?.setOpen(true); }, [active, tab]);
  function showPanelTab(next: PanelTab) {
    setTab(next);
    replaceQuietly(viewUrl(next, filter, open, informationOpen));
  }
  function showInformation(next: boolean) {
    if (next) panel?.setOpen(true);
    setInformationOpen(next);
    replaceQuietly(viewUrl(tab, filter, open, next));
  }
  useEffect(() => {
    if (!active || tab !== "activity" || !informationOpen || !open.length) return;
    setActivitySectionOpen(true);
    pendingActivityScroll.current = open.at(-1) ?? null;
  }, [active, tab, sessionKey, informationOpen]);
  useEffect(() => {
    const key = pendingActivityScroll.current;
    const section = activityDetails;
    if (!active || !informationOpen || !key || !activitySectionOpen || !section?.open) return;
    let attempts = 0;
    let frame = 0;
    const reveal = () => {
      const target = [...section.querySelectorAll<HTMLElement>("[data-activity-key]")].find(item => item.dataset.activityKey === key);
      // Only a target on screen is revealed; while the column is a closed drawer the request waits for it to open.
      if (target && target.getClientRects().length) { target.scrollIntoView({ block: "start" }); pendingActivityScroll.current = null; return; }
      if (++attempts < 12) frame = window.requestAnimationFrame(reveal);
    };
    frame = window.requestAnimationFrame(reveal);
    return () => window.cancelAnimationFrame(frame);
  }, [active, informationOpen, activitySectionOpen, open, snapshot, activityDetails]);

  // Earlier activity of this agent, read a page at a time on request; it stays with the project and agent it was read for.
  const history = useProjectPages(projectId, ["session-work", sessionKey, "activities"], async (cursor, signal) => {
    const page = await sessionClient("", projectId).activities(sessionKey, cursor, signal);
    if (page.items.some(item => item.sessionKey !== sessionKey)) throw new Error("活动历史与所选智能体不符");
    return page;
  }, { enabled: active && historyLoaded });
  const historyPages = history.data?.pages ?? [];

  // An explicit reread holds answers and closing until it is back; background polls do not interrupt a form being filled.
  const [rereading, setRereading] = useState(false);
  const reread = () => {
    setAccessReadAgain(value => value + 1); setReadAgain(value => value + 1);
    setRereading(true);
    void snapshotRead.refetch().finally(() => setRereading(false));
    if (currentTaskId) void timing.refetch();
  };
  if (!snapshot) return <div ref={workspaceRef} data-ui="" className="flex flex-col gap-3 p-4 compact:p-6">
    <h1 className="text-title font-semibold">智能体</h1>
    {snapshotRead.isError ? <Notice tone="error" title="智能体暂不可读取" action={<Button size="compact" onClick={() => void snapshotRead.refetch()}>重试</Button>}>{errorText(snapshotRead.error)}。</Notice>
      : <p role="status" className="text-small text-muted-foreground">正在读取智能体…</p>}
  </div>;

  const current = snapshot;
  const session = current.session;
  const work = current.currentWork;
  const readCurrent = snapshotOk && !rereading;
  const nativeReadCurrent = readCurrent;
  const native = session.kind === "owned" && session.target.kind === "owned"
    ? nativeInputPresentation(current.nativeInputRequests, session.target.sessionId) : { questions: [], error: null };
  const observation = session.kind === "owned" && session.target.kind === "owned"
    ? nativeObservationPresentation(current.nativeObservation, projectId, session.target.sessionId) : { progress: null, error: null };
  const runtimeAvailable = runtimeStatus.isError || typeof runtimeStatus.data?.available !== "boolean" ? null : runtimeStatus.data.available;
  const recoveryRead: RecoveryRead = snapshotRead.isError ? { status: "failed", message: "请先重新读取当前会话。" }
    : recovery.data && !recovery.isError ? { status: "ready", view: recovery.data }
      : recovery.isError ? recovery.error instanceof ApiError && recovery.error.status === 404 ? { status: "unavailable", message: "接口或对象不可用；请核对当前智能体与服务记录。" }
        : recovery.error instanceof ApiError && (recovery.error.status === 401 || recovery.error.status === 403) ? { status: "forbidden", message: "请核对项目读取权限。" }
          : recovery.error instanceof ApiError && recovery.error.status === 0 ? { status: "failed", message: "连接中断或超时；无法据此判断恢复状态。" }
            : { status: "failed", message: errorText(recovery.error) }
        : { status: "loading" };
  const discussionQuestionCount = current.questions.filter(question => !question.answered).length;
  const nativeQuestionCount = native.questions.filter(question => question.state === "pending").length;
  const idleResult = idleSessionResult(session, work, current.results);
  async function answerNative(requestId: string, expectedVersion: number, answers: Record<string, string[]>) {
    const request = native.questions.find(item => item.id === requestId && item.version === expectedVersion);
    if (!active || !nativeReadCurrent || native.error || context.blocked || !request?.canReply || request.state !== "pending")
      throw new Error("当前提问不能回复；请先重新读取状态。");
    let command: Command;
    try { command = commandSchema.parse({ type: "session.input.reply", projectId, operationId: crypto.randomUUID(), inputRequestId: requestId, expectedVersion, answers }); }
    catch { throw new Error("回答格式无法确认，请重新读取提问后再填写。"); }
    let recorded = false;
    try { recorded = await context.onAttempt(command); }
    catch { /* A receipt that cannot be saved must not send the answer. */ }
    if (!recorded) throw new Error("浏览器无法保存恢复回执，本次尚未发送。");
    let known = false;
    try {
      const result = await api().command(command);
      context.onKnown(command.operationId); known = true;
      if (result.status === "rejected") { void snapshotRead.refetch(); throw new Error(result.message); }
      void snapshotRead.refetch();
      context.onChanged();
    } catch (cause) {
      if (!known && !isUnconfirmed(cause)) context.onKnown(command.operationId);
      throw cause;
    }
  }
  const limitation = [...new Set([...session.metadata.limitations, ...current.metadata.limitations, ...historyPages.flatMap(page => page.metadata.limitations)])];
  const messageRunning = runtimeAvailable === true && nativeReadCurrent && observation.progress?.freshness === "live" && observation.progress.status === "active" && observation.progress.turn?.status === "inProgress" && observation.progress.turn.source?.kind === "message";
  const statusLabel = agentHeaderStatus(session, observation.progress, nativeReadCurrent && !observation.error, runtimeAvailable);
  const activeBusy = session.runtimeState === "ready" && session.busy === true;
  const displayedTaskId = work?.id ?? idleResult?.taskId;
  const relationLabel = work ? currentWorkRelationLabel(work, session, recoveryRead.status === "ready" ? recoveryRead.view.gate?.phase : undefined) : null;
  const currentRunId = currentNativeRunId(session, observation.progress, nativeReadCurrent && !observation.error, runtimeAvailable);
  const recentResult = latestSessionResult(current.results);
  const recentRunHref = session.latestBusinessRun ? observedRunTaskLink(session.latestBusinessRun, taskHref) : null;
  const failedRun = session.latestBusinessRun && ["failed", "interrupted", "unknown"].includes(session.latestBusinessRun.state) ? session.latestBusinessRun : null;
  const executionProfile = recoveryRead.status === "ready" ? recoveryRead.view.executionProfile : null;
  const configuredModel = executionProfile?.revision.model ?? current.resources.configuredModel.value;
  const actualModel = current.resources.actualModel.value;
  const busyNow = session.busy === true;
  const waitingTurnIds = new Set(native.questions.filter(question => question.state === "pending" && question.turnId).map(question => question.turnId!));
  const activity = [...historyPages.flatMap(page => page.items), ...current.activity].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
    .sort((a, b) => BigInt(a.sequence) === BigInt(b.sequence) ? 0 : BigInt(a.sequence) > BigInt(b.sequence) ? -1 : 1).slice(0, 300);
  const exactTiming = timing.data && !timing.isError ? timing.data.timing : null;
  const queueHref = href(projectId, "runtime");

  const currentWorkSection = <PanelSection title={work ? "当前任务" : "当前状态"} action={displayedTaskId ? <a className="text-caption text-primary hover:underline" href={taskHref(displayedTaskId)}>查看任务</a> : undefined}>
    <div className="session-current-work flex min-w-0 flex-col gap-1">
      {work ? <a className="text-small font-medium text-foreground hover:underline" href={taskHref(work.id)}>{work.title}</a>
        : idleResult ? <>
          <span className="text-caption text-muted-foreground">最近关联的交付 · 当前任务未确认</span>
          <a className="text-small font-medium text-foreground hover:underline" href={taskHref(idleResult.taskId)}>{idleResult.taskTitle || "任务标题未提供"}</a>
        </> : <span className="text-small text-text-secondary">{activeBusy ? messageRunning ? "正在回复消息" : "在途结果待核对" : sessionIdleSummary(session)}</span>}
      <span className={mutedText}>{work ? `${relationLabel} · 任务${taskProgress(work.state)}`
        : idleResult ? `最近关联交付 · 技术结果：${idleResult.technicalResult || "未提供"} · ${sessionResultUseLabel(idleResult)}${current.metadata.partial ? " · 已读范围有限" : ""}`
          : session.lastProgressAt ? `最近进展 ${date(session.lastProgressAt)}` : "没有可确认的当前任务"}{discussionQuestionCount + nativeQuestionCount > 0 && ` · 待答 ${discussionQuestionCount + nativeQuestionCount}`}</span>
      {work && <p className="session-current-task-timing text-caption text-text-secondary">{timing.isError
        ? `此任务的阶段时间暂不可读：${errorText(timing.error)}${timing.data ? "；上次读回，当前待核对" : ""}`
        : !exactTiming ? "正在读取阶段时间…"
          : `${timingStageLabel[exactTiming.current.stage] ?? "阶段未知"} · 已历时 ${timingDuration(exactTiming.current.elapsedMs)} · 等待 ${timingWaitingFor(exactTiming)}`}</p>}
    </div>
  </PanelSection>;
  const assignmentSection = <PanelSection title="具体分派">
    <div className="session-task-summary flex min-w-0 flex-col gap-1 text-small">
      {work && <p className="text-text-secondary">{(() => { const item = current.assignments.find(entry => entry.task.id === work.id && !entry.stale && entry.assignment.state !== "released"); return item ? assignmentLabel(item) : "没有可确认的当前修订接受记录"; })()}</p>}
      {current.assignments.filter(item => item.task.id !== work?.id).map(item => <p key={`${item.task.id}:${item.assignment.version}`} className="min-w-0"><a className="text-foreground hover:underline" href={taskHref(item.task.id)}>{item.task.title}</a><span className="text-caption text-muted-foreground"> · {assignmentLabel(item)}</span></p>)}
      {!work && !current.assignments.length && <p className={mutedText}>{current.metadata.partial ? "已读范围内没有具体分派；来源只读到部分记录。" : "没有具体分派。"}</p>}
    </div>
  </PanelSection>;
  const queueSection = <PanelSection title="执行队列" action={<a className="text-caption text-primary hover:underline" href={queueHref}>在分工与运行中查看</a>}>
    {current.queue.length ? <ol className="flex flex-col gap-1.5">{current.queue.map(item => <li key={item.entryId} className="flex min-w-0 items-start gap-2 text-small">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-field text-[11px] text-text-secondary" aria-label={`第 ${queuePosition(item.position)} 项`}>{queuePosition(item.position)}</span>
      <span className="min-w-0"><a className="text-foreground hover:underline" href={taskHref(item.taskId)}>{item.taskTitle}</a><span className="block text-caption text-muted-foreground">{queueStateLabel(item.state)}{item.holdReason && ` · ${item.holdReason}`}</span></span>
    </li>)}</ol> : <p className={mutedText}>{current.metadata.partial ? "已读范围内没有排队的任务；来源只读到部分记录。" : "没有排队的任务。"}</p>}
    {/* The project's execution queue for this agent, with its order, holds and attempts; read when opened. */}
    {session.kind === "owned" && session.target.kind === "owned" && <CollapsibleRow summary="查看并调整执行队列">
      <OwnedQueue context={context} sessionId={session.target.sessionId} enabled={active} queue={queue} />
    </CollapsibleRow>}
  </PanelSection>;
  const resultsSection = <PanelSection title="成果与使用">
    <p className={mutedText}>这里列出与这个智能体关联的交付；关联不证明由它提交。</p>
    {current.results.length ? <ul className="session-results flex min-w-0 flex-col">{current.results.map(item => {
      const target = deliveryTarget(item, projectId, viewUrl());
      return <li key={item.deliveryId} className="flex min-w-0 flex-col gap-1 border-t border-border py-2.5 text-small first:border-t-0">
        <a className="font-medium text-foreground hover:underline" href={taskHref(item.taskId)}>{item.taskTitle}</a>
        <span className="text-caption text-text-secondary">技术结果：{item.technicalResult} · {item.latestUse ? `使用观察：${({ used: "已使用", failed: "使用失败", notUsed: "未使用" } as Record<string, string>)[item.latestUse.result] ?? "结果待核对"}（${date(item.latestUse.createdAt)}）` : "尚无实际使用观察"}</span>
        <span className="text-caption">{target.href ? <a className="text-primary hover:underline" href={target.href}>打开固定成果</a> : target.kind === "fallback" ? target.label : "固定成果不可打开"} · 交付于 {date(item.submittedAt)}</span>
        <FullIdentifiers summary="交付来源与完整标识" rows={[{ label: "交付来源", value: item.artifactRef }, { label: "固定修订", value: item.artifactRevision }, { label: "内容 SHA-256", value: item.contentHash }, { label: "交付 ID", value: item.deliveryId }]} />
      </li>;
    })}</ul> : <p className={mutedText}>{current.metadata.partial ? "已读范围内没有交付记录；来源只读到部分记录。" : "还没有交付记录。"}</p>}
    {recentResult && <p className={mutedText}>最近一次交付：{recentResult.taskTitle} · {sessionResultUseLabel(recentResult)} · {date(recentResult.submittedAt)}</p>}
  </PanelSection>;
  const environmentSection = <PanelSection title="环境与用量">
    <FactList rows={[
      ["运行方式", session.kind === "owned" ? "项目受管" : "外部接入"],
      ["目标模型", configuredModel ? String(configuredModel) : recoveryRead.status === "loading" ? "正在读取" : "未读到"],
      ["思考强度", executionProfile?.revision.reasoningEffort ?? (recoveryRead.status === "loading" ? "正在读取" : "未配置或未读到")],
      ["执行权限", executionProfile ? permissionLabel(executionProfile.revision.sandbox, executionProfile.revision.approvalPolicy) : recoveryRead.status === "loading" ? "正在读取" : "未读到"],
      ["实际运行模型", actualModel ? String(actualModel) : "没有可靠记录"],
      ["用量", observation.progress?.usage ? `输入 ${observation.progress.usage.total.inputTokens ?? "未提供"} · 输出 ${observation.progress.usage.total.outputTokens ?? "未提供"}${observation.progress.freshness === "live" && nativeReadCurrent ? "" : "（上次记录）"}` : "没有可靠记录，不按 0 计"],
    ]} />
    {session.kind === "external" ? <p className={mutedText}>外部智能体的实时状态、模型与工具没有同步到这里。</p>
      : session.target.kind === "owned" && <SessionModelControl context={context} sessionId={session.target.sessionId} recovery={recoveryRead.status === "ready" ? recoveryRead.view : null} busy={busyNow} onApplied={() => void snapshotRead.refetch()} />}
  </PanelSection>;
  const details = <details ref={undefined} className="session-information group min-w-0 border-t border-border pt-4" id="session-information-panel" open={informationOpen}
    onToggle={event => { if (event.currentTarget.open !== informationOpen) showInformation(event.currentTarget.open); }}>
    <summary className="cursor-pointer text-label font-semibold text-foreground">详情与来源</summary>
    <div className="mt-3 flex min-w-0 flex-col gap-4">
      <section aria-label="原聊天入口" className="flex min-w-0 flex-col gap-1.5"><h3 className="text-label font-semibold">原聊天入口</h3><p className={mutedText}>{session.kind === "owned" ? "项目受管；消息保存后按顺序真实处理。" : "外部接入；消息只保存为人工转交。"}</p><SessionOpenEntry session={session} projectId={projectId} currentRead={active && readCurrent} active={active} /></section>
      <section aria-label="职责与分派" className="flex min-w-0 flex-col gap-1.5">
        <h3 className="text-label font-semibold">职责与分派</h3>
        <p className="text-small text-text-secondary">{session.profile?.purpose || "用途尚未登记"}</p>
        {session.roles.map(role => <p key={role.id} className="text-small"><a className="text-primary hover:underline" href={href(projectId, "roles")}>{role.title}</a><span className="text-text-secondary"> · {role.responsibility}</span></p>)}
        <CollapsibleRow summary={`职责范围内的任务 · ${current.roleTasks.length} 项`}><p className={mutedText}>职责负责这些任务，不表示这个智能体已接手。</p><ul className="flex flex-col gap-0.5 text-small">{current.roleTasks.map(task => <li key={task.id}><a className="hover:underline" href={taskHref(task.id)}>{task.title}</a></li>)}</ul></CollapsibleRow>
        {active && informationOpen && <Legacy><AllocationBacklinks context={context} filter={{ sessionKey }} refresh={refresh + readAgain} /></Legacy>}
        <SessionProfileForm context={context} snapshot={current} onApplied={() => void snapshotRead.refetch()} />
      </section>
      <section aria-label="资源观察" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-label font-semibold">资源观察</h3>
        <p className={mutedText}>配置模型、实际模型和用量分别列出；没有可靠来源时写明原因，不填 0。</p>
        {session.kind === "owned" && session.target.kind === "owned" && <SessionRecoveryResources read={recoveryRead} queueHref={queueHref} />}
        <FactList rows={([["configuredModel", "配置模型"], ["actualModel", "实际运行模型"], ["inputTokens", "输入用量（token）"], ["outputTokens", "输出用量（token）"], ["cost", "费用"], ["processMemory", "进程内存"]] as const)
          .map(([key, label]) => { const item = current.resources[key]; return [label, item.value === null ? `不可用 · ${item.unavailableReason ?? "没有可靠观察来源"}` : `${item.value}${item.unit ? ` ${item.unit}` : ""} · ${shortTime(item.observedAt)}`] as [string, ReactNode]; })} />
      </section>
      {session.kind === "owned" && session.target.kind === "owned" && <SessionRecoveryOverview read={recoveryRead} runtimeState={session.runtimeState} queueHref={queueHref} />}
      {session.kind === "owned" && session.target.kind === "owned" && <SessionExecutionFacts projectId={projectId} sessionId={session.target.sessionId} progress={observation.progress} currentRead={nativeReadCurrent && !observation.error} refreshKey={`${current.metadata.generatedAt}:${readAgain}`} />}
      {session.kind === "owned" && session.target.kind === "owned" && <NativeSessionPanel projectId={projectId} sessionId={session.target.sessionId} questions={native.questions} progress={observation.progress} progressError={observation.error} progressCurrentRead={nativeReadCurrent && !observation.error} readError={(snapshotRead.isError ? errorText(snapshotRead.error) : "") || native.error} replyBlockedReason={null} onAnswer={answerNative} taskHref={taskHref} section="diagnostics" />}
      <p className={mutedText}>工作区读于 {date(current.metadata.generatedAt)}。{current.metadata.partial || historyPages.some(page => page.metadata.partial) ? "来源只展示已读范围。" : ""}</p>
      {limitation.length > 0 && <CollapsibleRow summary="来源限制与未确认信息"><ul className="list-disc pl-5 text-caption text-muted-foreground">{limitation.map(item => <li key={item}>{item}</li>)}</ul></CollapsibleRow>}
      <details ref={setActivityDetails} className="session-project-activity min-w-0" open={activitySectionOpen} onToggle={event => setActivitySectionOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-label font-semibold">项目活动与来源记录<span className="ml-1.5 font-normal text-muted-foreground">{activity.length} 项已读</span></summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <ActivityFeed items={activity} filter={filter} onFilter={value => { setFilter(value); replaceQuietly(viewUrl(tab, value)); }} open={open} onOpen={value => { setOpen(value); replaceQuietly(viewUrl(tab, filter, value)); }} projectId={projectId} sessionKey={sessionKey} token={context.token} taskHref={taskHref} taskTitle={id => id === work?.id ? work.title : current.queue.find(item => item.taskId === id)?.taskTitle ?? current.roleTasks.find(item => item.id === id)?.title ?? null} currentRunId={currentRunId} />
          {history.isError && <Notice tone="error">活动历史暂不可读取：{errorText(history.error)}{historyPages.length ? "；上面是已读到的部分。" : ""}</Notice>}
          {(!historyLoaded || history.hasNextPage || history.isError) && <Button size="compact" variant="ghost" className="self-start" disabled={history.isFetching}
            onClick={() => { if (!historyLoaded) setHistoryLoaded(true); else if (history.isError && !historyPages.length) void history.refetch(); else void history.fetchNextPage(); }}>
            {history.isFetching ? "读取中…" : !historyLoaded || !historyPages.length ? "读取活动历史" : "加载更早活动"}</Button>}
        </div>
      </details>
      <FullIdentifiers rows={[{ label: "智能体标识", value: session.key }, { label: "来源", value: `${session.source.kind}:${session.source.id}` }]} />
    </div>
  </details>;
  // The right column: who this agent is, what it works on (动态) and what it produced (资料库), its environment, then details.
  const facts = <ContextPanelContent>
    <div className="session-panel flex min-w-0 flex-col gap-4">
      <section aria-label="智能体" className="flex min-w-0 items-start gap-3">
        <AgentAvatar seed={session.key} roleSeed={session.roles[0]?.id ?? session.title} size={44} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 font-semibold"><SessionIdentityMark target={session.target} identity={session.identity} name={session.title} size="small" /><span className="truncate">{session.title}</span></p>
          <p className="text-small text-text-secondary">{session.roles.map(role => role.title).join("、") || "职责待核对"}</p>
          <p className="mt-1 text-caption text-muted-foreground">{session.kind === "owned" ? "项目受管" : "外部接入"} · {sessionMembership(session.membership)} · 所在机器待接入</p>
          <p className="mt-1 flex items-center gap-1.5 text-caption"><span aria-hidden="true" className={busyNow ? "size-1.5 rounded-full bg-primary" : "size-1.5 rounded-full bg-border"} />{statusLabel}</p>
        </div>
      </section>
      <details className="session-identity-settings min-w-0 text-caption">
        <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">调整颜色与图标</summary>
        <div className="mt-2"><SessionIdentityControl context={context} session={session} onApplied={() => void snapshotRead.refetch()} /></div>
      </details>
      <Tabs value={panelTab} onValueChange={value => showPanelTab(value as PanelTab)}>
        <TabsList aria-label="动态与资料库"><TabsTrigger value="activity">动态</TabsTrigger><TabsTrigger value="results">资料库</TabsTrigger></TabsList>
        <TabsContent value="activity" className="flex flex-col gap-4 pt-3">
          <SectionBoundary label="当前任务">{currentWorkSection}</SectionBoundary>
          <SectionBoundary label="具体分派">{assignmentSection}</SectionBoundary>
          <SectionBoundary label="执行队列">{queueSection}</SectionBoundary>
        </TabsContent>
        <TabsContent value="results" className="flex flex-col gap-4 pt-3">
          <SectionBoundary label="成果与使用">{resultsSection}</SectionBoundary>
        </TabsContent>
      </Tabs>
      <SectionBoundary label="环境与用量">{environmentSection}</SectionBoundary>
      {closeOpen && <div id="session-close-panel" className="border-t border-border pt-4"><SectionBoundary label="结束会话"><SessionClosePanel context={context} snapshot={current} currentRead={active && readCurrent} onReadAgain={() => void snapshotRead.refetch()} /></SectionBoundary></div>}
      <SectionBoundary label="详情与来源">{details}</SectionBoundary>
    </div>
  </ContextPanelContent>;
  const headerButton = (label: string, icon: ReactNode, onClick: () => void, extra: Record<string, unknown> = {}) =>
    <Button variant="ghost" size="compact" aria-label={label} title={label} onClick={onClick} {...extra}>{icon}<span className="max-compact:sr-only">{label}</span></Button>;
  return <div ref={workspaceRef} data-ui="" className="session-workspace mx-auto flex h-[calc(100dvh-var(--session-top,0px)-0.5rem)] min-h-[420px] w-full min-w-0 max-w-[1480px] flex-col px-3 pt-3 max-compact:h-[calc(100dvh-var(--session-top,48px)-5rem)] max-compact:min-h-[360px] compact:px-6 compact:pt-4" data-view={panelTab}>
    {/* While the right column is closed its toggle sits at the top right of this area: the header leaves room for it. */}
    <header className={cn("session-detail-header mb-2 flex min-h-11 min-w-0 shrink-0 items-center gap-2", panel && !panel.open && "compact:pr-11")}>
      <div className="session-detail-heading flex min-w-0 flex-1 items-center gap-2 compact:justify-center">
        <div className="flex min-w-0 items-center gap-2 rounded-full bg-raised py-1 pl-1.5 pr-3.5 shadow-sm">
          <AgentAvatar seed={session.key} roleSeed={session.roles[0]?.id ?? session.title} size={26} />
          <h1 className="min-w-0 truncate text-body font-semibold">{session.title}</h1>
          <span aria-hidden="true" className={busyNow ? "size-1.5 shrink-0 rounded-full bg-primary" : "size-1.5 shrink-0 rounded-full bg-border"} />
          <span className="session-status-badge min-w-0 truncate text-caption text-muted-foreground">{statusLabel}</span>
        </div>
      </div>
      <div className="session-workspace-actions flex shrink-0 items-center gap-0.5">
        {headerButton("重新读取", <RefreshCw aria-hidden="true" className={snapshotRead.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} />, reread, { disabled: snapshotRead.isFetching && !snapshotRead.isRefetching })}
        {headerButton("会话详情", <Info aria-hidden="true" />, () => showInformation(!informationOpen), { "aria-expanded": informationOpen, "aria-controls": "session-information-panel" })}
        {headerButton(session.kind === "owned" ? "关闭受管智能体" : "归档与归类", session.kind === "owned" ? <X aria-hidden="true" /> : <FileText aria-hidden="true" />,
          () => { panel?.setOpen(true); setCloseOpen(value => !value); }, { "aria-expanded": closeOpen, "aria-controls": "session-close-panel" })}
      </div>
    </header>
    <div className="flex shrink-0 flex-col gap-2 empty:hidden">
      {snapshotRead.isError && <Notice tone="error">{errorText(snapshotRead.error)}。下面是上次读回，当前待核对；请重新读取。</Notice>}
      {changesError && <Notice tone="error">{changesError}。下面是上次读回，当前待核对。</Notice>}
      {failedRun && <Notice tone="waiting">最近运行{failedRun.state === "failed" ? "失败" : failedRun.state === "interrupted" ? "已中断" : "结果未知"}；{recentRunHref ? <>请先<a className="text-primary hover:underline" href={recentRunHref}>核对这次运行</a>和当前任务，再决定下一步。</> : "这次运行缺少可核对的任务关联，暂不能直达；请重新读取并核对任务的运行记录。"}</Notice>}
      {(session.runtimeState === "unknown" || session.runtimeState === "closed" || recoveryRead.status === "failed") && session.kind === "owned" &&
        <Notice tone="waiting" action={<Button size="compact" variant="ghost" onClick={() => showInformation(true)}>查看恢复与接入详情</Button>}>{session.runtimeState === "closed" ? "这个受管智能体已关闭。" : "当前执行状态尚待核对。"}</Notice>}
    </div>
    {active && <SessionTimeline key={`${context.principal.actorId}:${projectId}:${session.key}`} context={context} snapshot={current} taskHref={taskHref}
      refresh={refresh + readAgain} reauthorizeVersion={accessReadAgain} onApplied={() => void snapshotRead.refetch()} progress={observation.progress}
      waitingTurnIds={waitingTurnIds} composerFacts={configuredModel ? [`模型 ${String(configuredModel)}`] : []}>
      {session.kind === "owned" && session.target.kind === "owned" && (native.questions.some(request => request.state === "pending" || request.state === "response_saved") || native.error) &&
        <NativeSessionPanel projectId={projectId} sessionId={session.target.sessionId} questions={native.questions} progress={observation.progress} progressError={observation.error} progressCurrentRead={nativeReadCurrent && !observation.error}
          readError={(snapshotRead.isError ? errorText(snapshotRead.error) : "") || native.error}
          replyBlockedReason={snapshotRead.isError || native.error ? null : rereading ? "正在重新读取当前状态，请稍候。" : context.blocked ? "当前还有结果未确认的操作；请先按原操作核对，再回答。" : null}
          onAnswer={answerNative} taskHref={taskHref} section="questions" />}
    </SessionTimeline>}
    {facts}
  </div>;
}

/** The project's execution queue as it concerns this agent (#270's panel), with the runs and agents it names. */
function OwnedQueue({ context, sessionId, enabled, queue }: { context: MutationContext; sessionId: string; enabled: boolean; queue: QueueSlot | undefined }) {
  const { projectId } = context;
  const sessions = useProjectQuery(projectId, ["runtime", "sessions"], async () => {
    const items = await runtimeClient("", projectId).sessions();
    if (!Array.isArray(items)) throw new Error("智能体列表响应不完整");
    return items.filter(item => item.projectId === projectId);
  }, { enabled });
  const runs = useProjectQuery(projectId, ["runtime", "runs"], async () => {
    const items = await runtimeClient("", projectId).runs();
    if (!Array.isArray(items)) throw new Error("运行列表响应不完整");
    return items.filter(item => item.projectId === projectId);
  }, { enabled });
  if (!enabled) return null;
  if (!queue) return <p className={mutedText}>这里暂时不能显示执行队列，请在“分工与运行”中查看。</p>;
  return <>
    {(sessions.isError || runs.isError) && <p className={mutedText}>运行或智能体列表没有读回；队列里的运行状态暂无法判断。</p>}
    <Suspense fallback={<p role="status" className={mutedText}>正在打开执行队列…</p>}>{queue({ sessionId, runs: runs.data ?? [], sessions: sessions.data ?? [] })}</Suspense>
  </>;
}

function SessionProfileForm({ context, snapshot, onApplied }: { context: MutationContext; snapshot: SessionSnapshot; onApplied(): void }) {
  const profile = snapshot.session.profile;
  return <Legacy><ActionForm context={{ ...context, draftScope: `session-profile:${snapshot.session.key}`, draftBaseline: `${profile?.version ?? 0}` }} review title="设置展示信息" fields={[
    { name: "displayName", label: "展示名称", value: profile?.displayName ?? snapshot.session.title },
    { name: "purpose", label: "用途", kind: "textarea", optional: true, value: profile?.purpose ?? "" },
    { name: "membership", label: "团队归属", kind: "select", value: profile?.membership ?? snapshot.session.membership, options: [option("current", "当前团队"), option("historical", "历史"), option("unclassified", "待归类")] },
    { name: "tenure", label: "会话性质", kind: "select", value: profile?.tenure ?? "unknown", options: [option("resident", "常驻"), option("temporary", "临时"), option("unknown", "未知")] },
    { name: "reason", label: "变更依据", kind: "textarea" },
  ]} build={v => ({ type: "session.profile.set", target: profile?.target ?? snapshot.session.target, expectedVersion: profile?.version ?? 0, displayName: v.displayName, purpose: v.purpose, membership: v.membership, tenure: v.tenure, reason: v.reason })} onApplied={onApplied} /></Legacy>;
}
