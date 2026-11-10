import { acceptancePoints } from "./acceptancePresentation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { Button, ErrorState, LoadingState, Notice, StatusTag, Tabs, TabsContent, TabsList, TabsTrigger } from "@evoloop/ui";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorText } from "../../shared/api";
import { queryKeys } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import type { MutationContext } from "../../shared/ActionForm";
import { TaskCollaborationThread } from "../discussions";
import { TaskOwner } from "./TaskOwner";
import { MarkdownBody } from "../../shared/ui/MarkdownBody";
import { ContextPanelContent, useContextPanel } from "../../shared/ui/ContextPanel";
import { legacyDecisionLabel } from "./taskListPresentation";
import { navigateTaskTab, scrollToTaskSection, taskRunFromHash, taskSectionFromHash, taskSessionReturn, type TaskSection } from "../../shared/taskNavigation";
import { timingDuration, timingStageLabel } from "../../shared/taskTiming";
import { leaderProjectionMatchesTask } from "../../shared/leaderWorkLoad";
import { phaseStatus, taskStateStatus } from "../../shared/taskStatus";
import { ResponsibleName } from "../../shared/ui/RecordName";
import type { ReadState } from "./taskFactsPresentation";
import { PeekBoundary, TaskDocumentPeek } from "./TaskDocumentPeek";
import { TaskFacts } from "./TaskFacts";
import { progressEventName, taskGoal, taskType } from "./taskWorkspacePresentation";
import { appLocation, currentPath, onNavigate } from "../../shared/navigation";
import { taskStateLabel } from "./taskCommands";
import { useTaskDocuments } from "./taskDocuments";
import { TaskWriteBlock } from "./TaskForms";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { TaskBasisTab } from "./TaskBasisTab";
import { TaskDeliveryTab } from "./TaskDeliveryTab";
import { TaskRuntimeTab } from "./TaskRuntimeTab";
import { TaskHistoryTab } from "./TaskHistoryTab";
import { TaskActionsTab } from "./TaskActionsTab";
import { TaskArrangementFacts, TaskAttentionSection } from "./TaskArrangement";
import { timingSummary, useTaskTiming } from "./TaskScheduleSection";
type TaskTab = "overview" | "basis" | "delivery" | "runtime" | "history" | "actions";
const taskTabs: { id: TaskTab; label: string }[] = [
  { id: "overview", label: "当前工作" }, { id: "basis", label: "依据与影响" },
  { id: "delivery", label: "交付与使用" }, { id: "runtime", label: "运行与关联" },
  { id: "history", label: "历史" }, { id: "actions", label: "任务操作" },
];

/** The one line the task's text gives its timing; changing it is in 任务操作. */
function TimingLine({ projectId, taskId, onOpen }: { projectId: string; taskId: string; onOpen(): void }) {
  const read = useTaskTiming(projectId, taskId);
  if (!read.data) return read.error ? <p className="text-caption text-muted-foreground">执行时间暂不可读取：{errorText(read.error)}</p> : null;
  return <p className="text-label text-text-secondary">约定执行：{timingSummary(read.data)} · <button type="button" className="text-primary hover:underline" onClick={onOpen}>调整执行时间与重复</button></p>;
}

/** One task in the center (tasks.md 中间): goal → completion conditions → body → progress and discussion, with the
 * evidence, delivery, run, history and write layers one tab away. The right column shows TaskFacts. */
export function TaskPage({ context, token, projectId, id, selectedRevision, refresh, canReview, active, viewSwitch, linkForTab }: {
  context: MutationContext; token: string; projectId: string; id: string; refresh: number;
  selectedRevision?: string;
  canReview: boolean; active: boolean;
  viewSwitch?: ReactNode; linkForTab(tab: TaskSection): string;
}) {
  const sessionReturn = active ? taskSessionReturn(currentPath(), projectId, id, context.principal.actorId) : null;
  const panel = useContextPanel();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [leaderTask, setLeaderTask] = useState<LeaderWorkTask | null>(null);
  const [leaderTaskError, setLeaderTaskError] = useState("");
  // What the current-work read allows to conclude: a 404 is "not registered", any other failure is "cannot tell".
  const [leaderState, setLeaderState] = useState<ReadState>("loading");
  const [responsibleName, setResponsibleName] = useState<string | null>(null);
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
  const [error, setError] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const wasActive = useRef(active);
  const [observedAt, setObservedAt] = useState<Date | null>(null);
  const [reading, setReading] = useState(false);
  const leaderRequestRef = useRef(0);
  const mismatchRef = useRef("");
  useEffect(() => {
    setTab(selectedRevision ? "history" : taskSectionFromHash(currentPath(), projectId, id) ?? "overview");
    setDetail(null); setLeaderTask(null); setLeaderTaskError(""); setLeaderState("loading"); setResponsibleName(null);
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
    if (section === "task-schedule") setTab("actions");
    const frame = window.requestAnimationFrame(() => document.getElementById(section === "attention" ? "task-attention" : "task-schedule")?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [active, leaderTask, detail, id, projectId, selectedRevision]);
  useEffect(() => {
    let active = true;
    setError(""); setReading(true);
    api(token).task(projectId, id).then(value => {
      if (!active) return;
      setDetail(value); setObservedAt(new Date()); setReading(false);
    }).catch(cause => { if (active) { setError(errorText(cause)); setReading(false); } });
    return () => { active = false; };
  }, [token, projectId, id, refresh, readVersion]);
  useEffect(() => {
    if (!detail || detail.task.id !== id) return;
    const request = ++leaderRequestRef.current;
    let active = true;
    setLeaderTask(null); setLeaderTaskError(""); setLeaderState(current => current === "checking" ? "checking" : "loading");
    api(token).leaderTask(projectId, id).then(value => {
      if (!active || request !== leaderRequestRef.current) return;
      if (!leaderProjectionMatchesTask(value, {
        id, version: detail.task.version, currentRevisionId: detail.task.currentRevisionId,
      })) {
        // One automatic recheck per task version; a projection that still lags is reported, not polled forever.
        const seen = `${id}:${detail.task.version}:${detail.task.currentRevisionId}`;
        if (mismatchRef.current !== seen) {
          mismatchRef.current = seen;
          setLeaderState("checking");
          setReadVersion(current => current + 1);
        } else {
          setLeaderState("failed");
          setLeaderTaskError("当前工作安排还停在任务的旧版本上，暂不显示；可稍后重新读取当前任务。");
        }
        return;
      }
      setLeaderTask(value); setLeaderState("ready");
    }).catch(cause => {
      if (active && request === leaderRequestRef.current) {
        setLeaderTask(null);
        if (cause instanceof ApiError && cause.status === 404) { setLeaderState("ready"); return; }
        setLeaderState("failed");
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
  // “重新读取当前任务” reads the task again and everything the tabs read about it (assignment, revisions, timing,
  // attention, runs, queues); each read keeps its last answer marked until the new one arrives.
  const queryClient = useQueryClient();
  const rereadTask = () => {
    setReadVersion(value => value + 1);
    for (const key of [["task", id], ["tasks", "timing", id], ["runtime"], ["resident-queues"], ["document-detail"]])
      void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId, ...key) });
  };
  // A fixed historical revision always opens 历史, where it is read (TaskHistoryTab).
  useEffect(() => { if (selectedRevision) setTab("history"); }, [selectedRevision, projectId, id]);
  const documents = useTaskDocuments(projectId, detail && detail.task.id === id ? detail : { basis: null, links: [], impacts: [] });
  if (error && !detail) return <div data-ui="" className="mx-auto w-full max-w-[880px] px-6 pt-6"><ErrorState title="任务读取失败" happened={error} next="可以重新读取；读取失败不代表任务不存在。"
    action={<Button size="compact" onClick={() => setReadVersion(value => value + 1)}>重新读取</Button>} /></div>;
  if (!detail || detail.task.id !== id) return <div data-ui="" className="mx-auto w-full max-w-[880px] px-6 pt-6"><LoadingState lines={6} label="正在读取任务…" /></div>;
  const taskContext = { ...context, blocked: context.blocked || reading || !!error || !!selectedRevision,
    draftScope: `task:${id}`, draftBaseline: detail.revision.id };
  const pending = detail.impacts.filter(i => i.state === "pending");
  // Why the page may not write now; an unconfirmed operation is reported by the form itself.
  const writeBlock = selectedRevision ? "正在查看历史修订；回到当前任务后再提交。" : error ? "当前任务回读失败，不能按旧版本提交；请先重新读取。"
    : reading ? "正在核对当前任务，读回后再提交。" : "";
  const openSchedule = () => { selectTab("actions"); window.requestAnimationFrame(() => document.getElementById("task-schedule")?.scrollIntoView({ block: "start" })); };
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
  const responsibilityLabel = leaderState === "loading" || leaderState === "checking" ? "正在核对责任…"
    : leaderState === "failed" ? "责任暂无法判断"
      : !leaderTask ? "当前工作安排未登记"
        : <ResponsibleName projectId={projectId} item={leaderTask} />;
  const acceptanceNote = `${detail.proposal?.acceptanceMode === "independent_agent" ? "须由不同于实际提交者的智能体使用当前交付" : detail.proposal?.acceptanceMode === "human_required" ? "须由指定的受信用户本人使用当前交付" : "按任务原有验收合同核对"}${detail.proposal?.consumer ? ` · 指定身份 ${detail.proposal.consumer}` : detail.proposal?.acceptanceMode ? " · 验收身份待实际签收" : ""}。任务状态、技术检查和实际使用分别记录。`;
  const state = taskStateStatus[detail.task.state];
  const sectionOpen = new URLSearchParams(currentPath().split("?")[1] ?? "").get("section");
  const heading = "text-heading font-semibold text-foreground";
  const openContent = () => panel?.openInPanel({
    id: `document:${detail.task.contentDocumentId}@${detail.task.contentRevisionId}`, title: "主正文",
    href: href(projectId, "document", detail.task.contentDocumentId, detail.task.contentRevisionId),
    render: () => <PeekBoundary><TaskDocumentPeek projectId={projectId} documentId={detail.task.contentDocumentId} revisionId={detail.task.contentRevisionId} relation="主正文 · 任务固定的修订" /></PeekBoundary>,
  });
  return <TaskWriteBlock.Provider value={writeBlock}><div data-ui="" className="mx-auto flex w-full max-w-[880px] flex-col gap-5 px-6 pb-16 pt-5 max-compact:px-4" data-task-page={id}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {sessionReturn && <a className="text-label text-primary hover:underline" href={sessionReturn.href}>← 返回【{sessionReturn.title}】</a>}
      {viewSwitch}
      <span className="flex-1" />
      <span className="text-caption text-muted-foreground">{reading ? "正在核对当前任务…" : observedAt ? `读于 ${date(observedAt.toISOString())}` : "尚未读回"}</span>
      <Button size="compact" variant="ghost" onClick={rereadTask}>重新读取当前任务</Button>
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
    {(leaderState === "loading" || leaderState === "checking") && <p className="text-caption text-muted-foreground" role="status">{leaderState === "checking" ? "任务或工作安排已在读取期间变化，正在重新核对…" : "正在核对本任务当前的进展与具体责任…"}</p>}
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
          <MarkdownBody source={detail.task.content} identity={`task-${detail.revision.id}`} projectId={projectId} topHeading={3} />
          <p className="text-caption text-muted-foreground">正文来自任务固定的主文档修订；修改走“任务操作”里的“更新任务内容”，不从文档页绕过任务。</p>
        </section>
        <section aria-labelledby={`${panelId("overview")}-progress`} className="flex flex-col gap-3" data-task-progress="">
          <h2 id={`${panelId("overview")}-progress`} className={heading}>进展与讨论</h2>
          {projection?.timing && <p className="text-label text-text-secondary">现在：{timingStageLabel[projection.timing.current.stage] ?? "阶段未知"} · 本阶段已历时 {timingDuration(projection.timing.current.elapsedMs)}{projection.latestProgress ? ` · 最近进展 ${progressEventName(projection.latestProgress)}（${date(projection.latestProgress.changedAt)}）` : " · 最近进展未记录"}</p>}
          <TimingLine projectId={projectId} taskId={id} onOpen={openSchedule} />
          <TaskCollaborationThread projectId={projectId} taskId={id} refresh={refresh + readVersion} />
          {leaderTask && <TaskAttentionSection key={`${projectId}:${id}:${detail.task.currentRevisionId}`} context={taskContext} detail={detail} leader={leaderTask} />}
          {leaderTask && <details id="task-timing" className="group border-t border-border pt-3" {...(sectionOpen === "timing" ? { open: true } : {})}>
            <summary className="w-fit cursor-pointer text-label font-medium text-primary hover:underline">阶段区间、计划与来源</summary>
            <div className="mt-3"><TaskArrangementFacts projectId={projectId} detail={detail} leader={leaderTask} responsibleName={responsibleName} /></div>
          </details>}
          <details data-task-owner="" className="border-t border-border pt-3"><summary className="w-fit cursor-pointer text-label font-medium text-primary hover:underline">负责职责与同职责的其他智能体</summary>
            <p className="mt-2 text-caption text-muted-foreground">职责是持续的分工，具体承接看右栏的绑定与接受记录；同职责的其他智能体不代表承接了本任务。</p>
            <div className="mt-2"><TaskOwner projectId={projectId} owner={detail.task.owner} readKey={`${refresh}:${readVersion}:${detail.revision.id}`} onResolved={setResponsibleName} /></div></details>
        </section>
      </TabsContent>
      <TabsContent value="basis" forceMount hidden={tab !== "basis"} id={panelId("basis")} aria-labelledby={tabId("basis")} className="pt-5 outline-none">
        <SectionBoundary label="依据与影响"><TaskBasisTab context={taskContext} detail={detail} reads={documents.reads} canReview={canReview} /></SectionBoundary>
      </TabsContent>
      <TabsContent value="delivery" forceMount hidden={tab !== "delivery"} id={panelId("delivery")} aria-labelledby={tabId("delivery")} className="pt-5 outline-none">
        <SectionBoundary label="交付与使用"><TaskDeliveryTab projectId={projectId} detail={detail} active={active && tab === "delivery"} actionsHref={linkForTab("actions")} /></SectionBoundary>
      </TabsContent>
      <TabsContent value="runtime" forceMount hidden={tab !== "runtime"} id={panelId("runtime")} aria-labelledby={tabId("runtime")} className="pt-5 outline-none">
        <SectionBoundary label="运行与关联"><TaskRuntimeTab context={taskContext} detail={detail} active={active && tab === "runtime"} overviewHref={linkForTab("overview")} /></SectionBoundary>
      </TabsContent>
      <TabsContent value="history" forceMount hidden={tab !== "history"} id={panelId("history")} aria-labelledby={tabId("history")} className="pt-5 outline-none">
        <SectionBoundary label="历史"><TaskHistoryTab projectId={projectId} detail={detail} selectedRevision={selectedRevision} /></SectionBoundary>
      </TabsContent>
      <TabsContent value="actions" forceMount hidden={tab !== "actions"} id={panelId("actions")} aria-labelledby={tabId("actions")} className="pt-5 outline-none">
        <SectionBoundary label="任务操作"><TaskActionsTab context={taskContext} detail={detail} leader={leaderTask} leaderState={leaderState}
          documents={documents.documents} documentsPending={documents.pending} documentsFailed={documents.failed} onRereadDocuments={rereadTask}
          onRereadLeader={() => setReadVersion(value => value + 1)} /></SectionBoundary>
      </TabsContent>
    </Tabs>
    <ContextPanelContent><TaskFacts context={context} taskId={id} detail={detail} leader={leaderTask} leaderState={leaderState} linkForTab={linkForTab} /></ContextPanelContent>
  </div></TaskWriteBlock.Provider>;
}
