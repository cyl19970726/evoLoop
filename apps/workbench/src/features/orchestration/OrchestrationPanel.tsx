// 自动循环 (tasks.md 运行与关联; team.md 分工与运行): the managed loops, what each dispatched, to whom, and what came of
// it. On a task it shows only the loops the task's formal dispatches belong to, and names the current loop only when a
// formal dispatch and the task's in-flight run agree. Everything is read-only and said as the records say it: a finished
// run is not a sealed delivery, a delivery is not use, and use is not the task's acceptance. Raw records and identifiers
// stay in the source layer at the end.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import type { OrchestrationDispatch, OrchestrationEvent, OrchestrationInbox, OrchestrationLoop, OrchestrationSourceFact, OrchestrationSubmission, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import { Button, ErrorState, LoadingState, Notice, RefreshingIndicator, StatusTag, cn, type StatusTone } from "@evoloop/ui";
import { ApiError, api, errorText } from "../../shared/api";
import { mergePage, orchestrationClient, type LoopPart, type LoopPartItem, type OrchestrationStatus, type ResultPage, type TaskLoopContext } from "../../shared/orchestrationClient";
import { useProjectQuery } from "../../shared/query";
import { taskSectionHref } from "../../shared/taskNavigation";
import { FullIdentifiers, type IdentifierRow } from "../../shared/ui/FullIdentifiers";
import { FactList, mutedText } from "../../shared/ui/PageParts";
import { RoleName } from "../../shared/ui/RecordName";
import { date } from "../../shared/ui/shared";
import type { WorkTaskStatus } from "../../shared/workStatusPresentation";
import {
  decisionHeading, deliveryMeaning, dispatchStateLabel, emptyLoopsText, dispositionLabel, inboxStateLabel, loopName, loopStateLabel, outcomeLabel, purposeLabel,
  scopeText, scopeTitleOf, sealReasonLabel, sourceTriggerLabel, storyTitle, submissionStateLabel, taskTitleText, type ScopeTitle,
} from "./presentation";
import { currentChainSummary, hasTerminalIntentGap, hasUnreadChainPages, inTaskContext, orderDispatches, readableOutcome, storyNextAction } from "./summary";
import { selectedTaskLoop, taskLoopAssociation } from "./taskLoopSelection";
import { actorRow, actorText } from "../../shared/actorPresentation";

type Client = ReturnType<typeof orchestrationClient>;
const link = "text-primary hover:underline";
const stateText = (value: string) => loopStateLabel[value] ?? "状态未知";
const dispatchTone: Record<OrchestrationDispatch["state"], StatusTone> = {
  pending: "waiting", claimed: "waiting", dispatching: "progress", accepted: "progress", unknown: "unknown", rejected: "blocked", completed: "done",
};

const notFound = (cause: unknown) => cause instanceof ApiError && cause.status === 404;

/** Each loop's goal and stage; a read that failed is said as failed, a record that is not there as not found. */
async function scopeTitles(client: Client, loops: OrchestrationLoop[]): Promise<Record<string, ScopeTitle>> {
  const labels: Record<string, ScopeTitle> = {};
  await Promise.all(loops.map(async loop => {
    const [goal, stage] = await Promise.allSettled([client.goal(loop.goalId), loop.stageId ? client.stage(loop.stageId) : Promise.resolve(null)]);
    labels[loop.id] = scopeTitleOf(goal, loop.stageId ? stage : null, notFound);
  }));
  return labels;
}

async function revisionIdsFor(client: Client, dispatches: OrchestrationDispatch[]) {
  const ids: Record<string, Record<number, string>> = {};
  await Promise.all([...new Set(dispatches.map(item => item.taskId))].map(async taskId => {
    try { ids[taskId] = Object.fromEntries((await client.taskRevisions(taskId)).map(item => [item.revision.version, item.revision.id])); }
    catch { /* The fixed link then says it cannot be checked, rather than treating today's task as the old revision. */ }
  }));
  return ids;
}

async function workStatusesFor(projectId: string, taskIds: string[]): Promise<Record<string, WorkTaskStatus>> {
  const ids = [...new Set(taskIds)];
  if (!ids.length) return {};
  const result = await api().workStatuses(projectId, ids);
  return Object.fromEntries(result.items.map(item => [item.taskId, item]));
}

async function decisionsFor(client: Client, events: OrchestrationEvent[]): Promise<Record<string, OrchestrationWorkerDecision>> {
  const decisions: Record<string, OrchestrationWorkerDecision> = {};
  await Promise.all(events.filter(item => item.kind === "worker.decision").map(async item => {
    try { decisions[item.entityId] = await client.decision(item.entityId); } catch { /* The card says the decision was not read back. */ }
  }));
  return decisions;
}

interface PanelData {
  status: OrchestrationStatus; loops: ResultPage<OrchestrationLoop>; titles: Record<string, ScopeTitle>;
  contexts: ResultPage<TaskLoopContext>; workStatus: WorkTaskStatus | null;
}

/** Rereads when `refresh` moves (the page's own polling or a reread button), keeping the answer on screen meanwhile. */
function useRefetchOn(refresh: number, refetch: () => unknown) {
  const first = useRef(refresh);
  useEffect(() => {
    if (first.current === refresh) return;
    first.current = refresh;
    void refetch();
  }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function OrchestrationPanel({ projectId, refresh, taskId, verifiedRuns }: {
  projectId: string; refresh: number; taskId?: string; verifiedRuns?: RuntimeRunRecord[] | null;
}) {
  const [manualLoopId, setManualLoopId] = useState<string | null>(null);
  const [lastVerifiedLoopId, setLastVerifiedLoopId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const read = useProjectQuery(projectId, ["orchestration", "panel", taskId ?? null], async (): Promise<PanelData> => {
    const client = orchestrationClient("", projectId);
    if (!taskId) {
      const { status, loops } = await client.overview();
      return { status, loops, titles: await scopeTitles(client, loops.items), contexts: { items: [], nextCursor: null }, workStatus: null };
    }
    const [{ status, contexts }, work] = await Promise.all([client.taskOverview(taskId), api().workStatuses(projectId, [taskId])]);
    const related = await Promise.all(contexts.items.map(item => client.loop(item.loopId)));
    return { status, loops: { items: related, nextCursor: null }, titles: await scopeTitles(client, related), contexts,
      workStatus: work.items.find(item => item.taskId === taskId) ?? null };
  });
  useRefetchOn(refresh + epoch, read.refetch);
  // Further pages of loops (or of the task's loop contexts), read on request and kept across rereads.
  const [more, setMore] = useState<{ loops: OrchestrationLoop[]; titles: Record<string, ScopeTitle>; contexts: TaskLoopContext[]; nextCursor: string | null } | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  useEffect(() => { setManualLoopId(null); setLastVerifiedLoopId(null); setMore(null); }, [projectId, taskId]);
  const data = read.data;
  const loops = data ? more ? mergePage(data.loops, { items: more.loops, nextCursor: null }).items : data.loops.items : [];
  const titles = { ...data?.titles, ...more?.titles };
  const contexts = data ? [...data.contexts.items, ...(more?.contexts ?? []).filter(item => !data.contexts.items.some(base => base.loopId === item.loopId))] : [];
  const nextCursor = more ? more.nextCursor : taskId ? data?.contexts.nextCursor ?? null : data?.loops.nextCursor ?? null;
  const problem = read.error ? errorText(read.error) : "";
  const association = taskId ? taskLoopAssociation(read.isFetching || problem ? null : data?.workStatus ?? null,
    contexts, verifiedRuns ?? null, !!(more ? more.nextCursor : data?.contexts.nextCursor)) : null;
  useEffect(() => {
    if (association?.kind === "current" || association?.kind === "recent") setLastVerifiedLoopId(association.loopId);
  }, [association?.kind, association?.kind !== "unresolved" ? association?.loopId : null]); // eslint-disable-line react-hooks/exhaustive-deps
  const loopIds = loops.map(item => item.id);
  const selected = taskId ? selectedTaskLoop(manualLoopId, association!, loopIds) ?? (lastVerifiedLoopId && loopIds.includes(lastVerifiedLoopId) ? lastVerifiedLoopId : null)
    : manualLoopId && loopIds.includes(manualLoopId) ? manualLoopId : loopIds[0] ?? null;
  async function loadMore() {
    if (!nextCursor || moreBusy) return;
    setMoreBusy(true); setMoreError("");
    try {
      const client = orchestrationClient("", projectId);
      if (taskId) {
        const page = await client.taskContext(taskId, nextCursor);
        const related = await Promise.all(page.items.map(item => client.loop(item.loopId)));
        const labels = await scopeTitles(client, related);
        setMore(current => ({ loops: [...current?.loops ?? [], ...related], titles: { ...current?.titles, ...labels },
          contexts: [...current?.contexts ?? [], ...page.items], nextCursor: page.nextCursor }));
      } else {
        const page = await client.loops(nextCursor);
        const labels = await scopeTitles(client, page.items);
        setMore(current => ({ loops: [...current?.loops ?? [], ...page.items], titles: { ...current?.titles, ...labels }, contexts: [], nextCursor: page.nextCursor }));
      }
    } catch (cause) { setMoreError(errorText(cause)); }
    finally { setMoreBusy(false); }
  }
  const status = data?.status;
  const selectedLoop = loops.find(item => item.id === selected);
  const runHref = (runId: string) => `${taskSectionHref(projectId, taskId!, { tab: "runtime" })}&run=${encodeURIComponent(runId)}`;
  const contextLine = (): ReactNode => {
    if (read.isFetching) return "正在重新核对当前循环；下面是上次读回的循环。";
    if (association?.kind === "current") return <>当前运行关联这个循环。{association.runId && <a className={cn(link, "ml-1")} href={runHref(association.runId)}>查看这次运行</a>}</>;
    if (association?.kind === "recent") return "最近一次正式派发关联这个循环；当前没有已核对的在途运行。";
    return `当前循环未确认：${problem ? "读取失败" : association?.kind === "unresolved" ? association.reason : "运行记录尚未读回"}。${selected ? "显示上次读回的循环，仅供核对。" : "可以手动查看历史循环。"}`;
  };
  return <section aria-label="自动循环观察" data-orchestration="" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="min-w-0 flex-1 text-label text-text-secondary">入站、派发与交付的记录。运行结束不表示交付已封存、已使用或任务已验收。</p>
      <Button size="compact" variant="ghost" disabled={read.isFetching} onClick={() => setEpoch(value => value + 1)}>重新读取</Button>
    </div>
    {read.isPending && <LoadingState lines={3} label="正在读取自动循环" />}
    {problem && !data && <ErrorState title="自动循环暂不可读取" happened={`自动循环读取未完成：${problem}`}
      next="可以重新读取；读取失败不代表没有循环或后续处理。" action={<Button size="compact" onClick={() => setEpoch(value => value + 1)}>重新读取</Button>} />}
    {problem && data && <Notice tone="error">自动循环读取未完成：{problem}。下面保留上次读回的循环供核对，当前关联未确认。</Notice>}
    {status && <StatusLine status={status} />}
    {data && !problem && !read.isFetching && loops.length === 0 && <p className="text-label text-text-secondary">{emptyLoopsText(!!taskId, status)}</p>}
    {taskId && loops.length > 0 && <p className="rounded-md bg-muted px-3 py-2 text-label text-foreground [overflow-wrap:anywhere]" role="status"
      data-association={read.isFetching ? "checking" : association?.kind ?? "unresolved"} data-association-loop={association && association.kind !== "unresolved" ? association.loopId : undefined}
      data-association-run={association && association.kind !== "unresolved" ? association.runId ?? undefined : undefined}
      data-shown-loop={selected ?? undefined}>{contextLine()}</p>}
    {loops.length > 0 && <div role="group" aria-label="选择循环" className="flex min-w-0 flex-wrap gap-2">
      {loops.map(loop => {
        const marker = taskId && association && association.kind !== "unresolved" && association.loopId === loop.id ? association.kind === "current" ? "当前运行 · " : "最近派发 · " : "";
        return <Button variant="row" key={loop.id} data-loop-id={loop.id} aria-pressed={selected === loop.id} onClick={() => setManualLoopId(loop.id)}
          className="w-auto max-w-full rounded-full bg-field px-3 py-1 text-label [overflow-wrap:anywhere] hover:bg-field">
          {marker}{loopName(titles[loop.id])} · {stateText(loop.state)} · 创建 {date(loop.createdAtUtc)}
        </Button>;
      })}
    </div>}
    {nextCursor && <Button size="compact" variant="ghost" className="w-fit" disabled={moreBusy} onClick={() => void loadMore()}>{moreBusy ? "读取中…" : `继续读取关联循环（已读 ${loops.length} 个，还有更多）`}</Button>}
    {moreError && <Notice tone="error">继续读取未完成：{moreError}。已读的循环保留。</Notice>}
    {taskId && manualLoopId && selected === manualLoopId && association?.kind !== "unresolved" && manualLoopId !== association?.loopId && selectedLoop &&
      <p className={mutedText} data-manual-loop={manualLoopId}>正在手动查看历史循环（{stateText(selectedLoop.state)}）；当前运行关联的循环见上方。</p>}
    {selectedLoop && <LoopObservation key={`${projectId}:${selectedLoop.id}`} projectId={projectId} loop={selectedLoop} scope={titles[selectedLoop.id]}
      taskId={taskId} context={contexts.find(item => item.loopId === selectedLoop.id)} refresh={refresh + epoch} />}
  </section>;
}

function StatusLine({ status }: { status: OrchestrationStatus }) {
  const headline = status.state === "disabled" ? "自动循环未配置或尚未启用" : status.running === false ? "自动循环当前未运行"
    : status.state ? `自动循环${stateText(status.state)}` : status.running ? "自动循环正在读取入站" : "自动循环状态未声明";
  const faults = status.faults ?? [];
  return <div className="flex flex-col gap-1">
    <p className="text-label text-foreground">{headline}{status.busy ? " · 正在核对入站" : ""}{status.lastError ? " · 最近一次检查出错" : ""}{faults.length ? ` · ${faults.length} 项运行故障` : ""}</p>
    <FullIdentifiers summary="错误与故障原文" rows={[{ label: "最近错误", value: status.lastError, text: true },
      ...faults.map(fault => ({ label: "运行故障", value: typeof fault === "string" ? fault : fault.code, text: true }))]} />
  </div>;
}

interface LoopData {
  inbox: ResultPage<OrchestrationInbox>; dispatches: ResultPage<OrchestrationDispatch>;
  submissions: ResultPage<OrchestrationSubmission>; events: ResultPage<OrchestrationEvent>;
  sources: ResultPage<OrchestrationSourceFact>; tasks: ResultPage<TaskDetail>;
  decisions: Record<string, OrchestrationWorkerDecision>; revisionIds: Record<string, Record<number, string>>;
  workStatuses: Record<string, WorkTaskStatus>; workStatusError: string;
}
type Extra = Partial<Pick<LoopData, LoopPart | "tasks">> & Pick<LoopData, "decisions" | "revisionIds" | "workStatuses">;
const parts: LoopPart[] = ["inbox", "dispatches", "submissions", "events", "sources"];

function mergeLoopData(base: LoopData, extra: Extra | null): LoopData {
  if (!extra) return base;
  const merged = { ...base, decisions: { ...base.decisions, ...extra.decisions }, revisionIds: { ...base.revisionIds, ...extra.revisionIds },
    workStatuses: { ...base.workStatuses, ...extra.workStatuses } };
  for (const kind of parts) {
    const page = extra[kind] as ResultPage<{ id: string }> | undefined;
    if (page) (merged as Record<string, unknown>)[kind] = mergePage(base[kind] as ResultPage<{ id: string }>, page);
  }
  if (extra.tasks) merged.tasks = { items: [...base.tasks.items, ...extra.tasks.items.filter(item => !base.tasks.items.some(known => known.task.id === item.task.id))],
    nextCursor: extra.tasks.nextCursor };
  return merged;
}

function LoopObservation({ projectId, loop, scope, taskId, context, refresh }: {
  projectId: string; loop: OrchestrationLoop; scope?: ScopeTitle | undefined; taskId?: string; context?: TaskLoopContext; refresh: number;
}) {
  // The goal and stage as words for the stories: only names that were read.
  const title = scope?.state === "named" ? scope.title : undefined;
  const read = useProjectQuery(projectId, ["orchestration", "loop", loop.id, "records"], async (): Promise<LoopData> => {
    const client = orchestrationClient("", projectId);
    const [inbox, dispatches, submissions, events, sources, tasks] = await Promise.all([client.part(loop.id, "inbox"), client.part(loop.id, "dispatches"),
      client.part(loop.id, "submissions"), client.part(loop.id, "events"), client.part(loop.id, "sources"), client.tasks(loop.id)]);
    const [decisions, revisions, statuses] = await Promise.all([decisionsFor(client, events.items),
      revisionIdsFor(client, dispatches.items), workStatusesFor(projectId, dispatches.items.map(item => item.taskId)).then(value => ({ value, error: "" }),
        cause => ({ value: {} as Record<string, WorkTaskStatus>, error: errorText(cause) }))]);
    return { inbox, dispatches, submissions, events, sources, tasks, decisions, revisionIds: revisions, workStatuses: statuses.value, workStatusError: statuses.error };
  });
  useRefetchOn(refresh, read.refetch);
  const [extra, setExtra] = useState<Extra | null>(null);
  const [more, setMore] = useState<LoopPart | "tasks" | null>(null);
  const [moreError, setMoreError] = useState("");
  // Reading further task pages failed: a task not among the loaded ones cannot be named until it is read.
  const [tasksFailed, setTasksFailed] = useState(false);
  const [moreStatusError, setMoreStatusError] = useState("");
  async function loadMore(kind: LoopPart, data: LoopData) {
    const cursor = data[kind].nextCursor; if (!cursor || more) return;
    setMore(kind); setMoreError("");
    try {
      const client = orchestrationClient("", projectId);
      const page = await client.part(loop.id, kind, cursor);
      const revisionIds = kind === "dispatches" ? await revisionIdsFor(client, page.items as OrchestrationDispatch[]) : {};
      let workStatuses: Record<string, WorkTaskStatus> = {};
      if (kind === "dispatches") try { workStatuses = await workStatusesFor(projectId, (page.items as OrchestrationDispatch[]).map(item => item.taskId)); }
      catch (cause) { setMoreStatusError(errorText(cause)); }
      const decisions = kind === "events" ? await decisionsFor(client, page.items as OrchestrationEvent[]) : {};
      setExtra(current => ({ ...current, decisions: { ...current?.decisions, ...decisions }, revisionIds: { ...current?.revisionIds, ...revisionIds },
        workStatuses: { ...current?.workStatuses, ...workStatuses },
        [kind]: current?.[kind] ? mergePage(current[kind] as ResultPage<LoopPartItem[typeof kind]>, page) : page }) as Extra);
    } catch (cause) { setMoreError(errorText(cause)); }
    finally { setMore(null); }
  }
  async function loadMoreTasks(data: LoopData) {
    const cursor = data.tasks.nextCursor; if (!cursor || more) return;
    setMore("tasks"); setMoreError("");
    try {
      const page = await orchestrationClient("", projectId).tasks(loop.id, cursor);
      setExtra(current => ({ decisions: {}, revisionIds: {}, workStatuses: {}, ...current,
        tasks: { items: [...current?.tasks?.items ?? [], ...page.items], nextCursor: page.nextCursor } }));
      setTasksFailed(false);
    } catch (cause) { setMoreError(errorText(cause)); setTasksFailed(true); }
    finally { setMore(null); }
  }
  const data = read.data ? mergeLoopData(read.data, extra) : null;
  const workStatusError = data?.workStatusError || moreStatusError;
  const taskName = (taskId: string) => taskTitleText(data?.tasks.items.find(value => value.task.id === taskId)?.task.title,
    { more: !!data?.tasks.nextCursor, failed: tasksFailed });
  const moreButton = (kind: LoopPart) => data?.[kind].nextCursor ? <Button size="compact" variant="ghost" className="w-fit" disabled={more !== null}
    onClick={() => void loadMore(kind, data)}>{more === kind ? "读取中…" : `继续读取（已读 ${data[kind].items.length} 条，还有更多）`}</Button> : null;
  const related = (item: OrchestrationDispatch) => !taskId || !!context && inTaskContext(item, context);
  const relatedSource = (sourceEventId: string) => !taskId || !!context && context.sourceEventIds.includes(sourceEventId);
  const relatedDispatchId = (dispatchId: string) => !taskId || !!context && (context.dispatchIds.includes(dispatchId) || context.parentDispatchIds.includes(dispatchId));
  const ordered = data ? orderDispatches(data.dispatches.items.filter(related), data.sources.items, data.submissions.items) : null;
  const relatedIds = new Set(ordered?.ordered.map(item => item.id) ?? []);
  const relatedTaskIds = new Set(ordered?.ordered.map(item => item.taskId) ?? []);
  const partial = !!data && hasUnreadChainPages([data.dispatches, data.tasks, data.inbox, data.submissions, data.events, data.sources]);
  const chainSummary = data ? currentChainSummary(loop, ordered?.ordered ?? [],
    data.submissions.items.filter(item => relatedIds.has(item.dispatchId)),
    Object.values(data.decisions).filter(item => relatedIds.has(item.dispatchId)),
    data.tasks.items.filter(item => relatedTaskIds.has(item.task.id) || item.task.id === taskId), taskId, !partial) : [];
  return <div className="flex min-w-0 flex-col gap-4 border-t border-border pt-4" data-loop-observation={loop.id}>
    <header className="flex flex-col gap-1">
      <h3 className="text-small font-semibold text-foreground [overflow-wrap:anywhere]">{scopeText(scope)} · {stateText(loop.state)}</h3>
      <p className={mutedText}>判断职责 <RoleName projectId={projectId} roleId={loop.cognitiveRoleId} /> · 执行职责 {loop.allowedBusinessRoleIds.map((roleId, index) =>
        <span key={roleId}>{index ? "、" : ""}<RoleName projectId={projectId} roleId={roleId} /></span>)} · 创建 {date(loop.createdAtUtc)}</p>
      <p className={mutedText}>派发预算 {loop.dispatchCount}/{loop.maxRuns}（记录请求次数，不等于成功运行数）· 同时最多 {loop.maxConcurrent} 个 · 入站起点 {date(loop.sourceAfter.createdAtUtc)}</p>
      {taskId && <p className={mutedText}>只列出与这项任务同来源或父子派发、已读回的记录，不是全项目的循环清单。</p>}
      <FullIdentifiers summary="循环的完整标识" rows={[{ label: "循环", value: loop.id }, { label: "目标", value: loop.goalId }, { label: "阶段", value: loop.stageId },
        { label: "授权人", value: loop.enrolledBy, text: true }, { label: "初始事件", value: loop.bootstrapEventId }, { label: "入站起点事件", value: loop.sourceAfter.eventId }]} />
    </header>
    {read.isPending && <LoadingState lines={4} label="正在读取这个循环的记录" />}
    {read.error && !data && <ErrorState title="这个循环的记录暂不可读取" happened={`本循环记录未完整读回：${errorText(read.error)}`}
      next="不要据此认定没有后续处理；可以重新读取。" action={<Button size="compact" onClick={() => void read.refetch()}>重新读取</Button>} />}
    {read.error && data && <Notice tone="waiting" title="上次读回，当前待核对">本循环记录这次未完整读回：{errorText(read.error)}。不要据此认定没有后续处理。</Notice>}
    {read.checking && !read.error && <RefreshingIndicator label="正在核对这个循环的记录" />}
    {moreError && <Notice tone="error">继续读取未完成：{moreError}。已读的记录保留，不要据此认定没有后续处理。</Notice>}
    {data && <>
      <section aria-label="工作与结果" className="flex min-w-0 flex-col gap-3">
        <h4 className="text-small font-semibold text-foreground">为什么做、交给谁、现在怎样</h4>
        <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2">
          <p className="text-label font-medium text-foreground">当前已读回的结论</p>
          {chainSummary.map((line, index) => <p key={index} className="text-label text-foreground">{line}</p>)}
        </div>
        {workStatusError && <Notice tone="waiting">任务的工作状态这次没有读回：{workStatusError}。下面只按正式来源和原任务记录展示。</Notice>}
        {partial && <Notice tone="waiting">还有记录没有读取；摘要与先后次序只覆盖已读的部分，不能据此判断整个循环已完成，或旧的等待至今有效。</Notice>}
        <p className={mutedText}>下面每一项记录派发当时的结果与下一步；当前责任以上面的已读回结论为准。只依据已读回的任务、决定、派发和交付记录；没有人的使用记录时不推定已使用。</p>
        {ordered?.ordered.length === 0 && <p className="text-label text-text-secondary">已读范围内还没有相关的派发。{data.inbox.items.some(item => relatedSource(item.sourceEventId) && item.state === "pending")
          ? "已有入站等待处理。" : "可以展开下方的来源核对入站情况。"}</p>}
        {ordered && ordered.ordered.length > 0 && <ol className="flex flex-col">{ordered.ordered.map(item => <li key={item.id}>
          <Story projectId={projectId} item={item} data={data} later={ordered.hasLater.has(item.id)} title={title} taskName={taskName(item.taskId)} />
        </li>)}</ol>}
        {moreButton("sources")}
        {data.tasks.nextCursor && <Button size="compact" variant="ghost" className="w-fit" disabled={more !== null} onClick={() => void loadMoreTasks(data)}>
          {more === "tasks" ? "读取中…" : `继续读取任务名称与交付（已读 ${data.tasks.items.length} 项，还有更多）`}</Button>}
      </section>
      <details className="min-w-0">
        <summary className="w-fit cursor-pointer text-label font-medium text-primary hover:underline">来源：入站、派发、提交与审计原记录</summary>
        <div className="mt-3 grid min-w-0 gap-6 desktop:grid-cols-2">
          <RecordList title="入站与决定" count={data.inbox.items.length} more={!!data.inbox.nextCursor} empty="已读范围内没有入站。" button={moreButton("inbox")}>
            {data.inbox.items.filter(item => relatedSource(item.sourceEventId)).map(item => <RecordItem key={item.id} title={purposeLabel(item.purpose)} state={inboxStateLabel[item.state]}
              rows={[{ label: "入站", value: item.id }, { label: "来源事件", value: item.sourceEventId }, { label: "后续派发", value: item.dispatchId }, { label: "证据", value: item.evidenceRef, text: true },
                actorRow("处理人", item.acknowledgedBy)]}>
              <p>接收职责 <RoleName projectId={projectId} roleId={item.recipientRoleId} /> · {dispositionLabel(item.disposition)} · 处理人 {item.acknowledgedBy ? actorText(item.acknowledgedBy) : "尚未署名"}</p>
              {item.reason && <p>处理理由：{item.reason}</p>}
            </RecordItem>)}
          </RecordList>
          <RecordList title="派发与实际运行" count={data.dispatches.items.length} more={!!data.dispatches.nextCursor} empty="已读范围内没有派发。" button={moreButton("dispatches")}>
            {data.dispatches.items.filter(related).map(item => <RecordItem key={item.id} title={<a className={link} href={taskSectionHref(projectId, item.taskId)}>{taskName(item.taskId)}</a>}
              state={dispatchStateLabel[item.state]} rows={[{ label: "派发", value: item.id }, { label: "来源事件", value: item.sourceEventId }, { label: "来源入站", value: item.inboxId },
                { label: "上游派发", value: item.parentDispatchId }, { label: "运行", value: item.runtimeRunId }, { label: "交付", value: item.deliveryId }, { label: "证据", value: item.evidenceRef, text: true },
                actorRow("请求人", item.requestedBy)]}>
              <p>{purposeLabel(item.purpose)} · 承接职责 <RoleName projectId={projectId} roleId={item.recipientRoleId} /> · 任务第 {item.taskVersion} 版 · 请求人 {actorText(item.requestedBy)}</p>
              <p>{item.runtimeRunId ? "已绑定实际运行；运行的终态在运行记录里核对。" : "还没有绑定运行。"}{item.outcome ? ` 执行方后续结果：${outcomeLabel(item.outcome)}。` : ""}</p>
              <p>原因：{item.reason}</p>
              {item.state === "unknown" && <Notice tone="error">派发结果未知；不能从这里认定外部没有执行。</Notice>}
            </RecordItem>)}
          </RecordList>
          <RecordList title="执行方提交与封存" count={data.submissions.items.length} more={!!data.submissions.nextCursor} empty="已读范围内没有执行方的提交。" button={moreButton("submissions")}>
            {data.submissions.items.filter(item => relatedDispatchId(item.dispatchId)).map(item => <RecordItem key={item.id}
              title={<a className={link} href={taskSectionHref(projectId, item.taskId, { revisionId: item.taskRevisionId })}>执行时的任务修订</a>} state={submissionStateLabel[item.state]}
              rows={[{ label: "提交", value: item.id }, { label: "派发", value: item.dispatchId }, { label: "运行", value: item.runId }, { label: "任务修订", value: item.taskRevisionId },
                { label: "交付", value: item.deliveryId }, { label: "输入摘要", value: item.runInputHash }, { label: "交付操作", value: item.deliveryOperationId },
                { label: "拟登记产物", value: `${item.deliveryIntent.artifactRef} · ${item.deliveryIntent.artifactRevision}`, text: true },
                { label: "附带证据", value: item.evidenceRefs.join("、"), text: true }, ...(item.reason && sealReasonLabel(item.reason) === item.reason ? [] : [{ label: "封存原记录码", value: item.reason }]),
                actorRow("提交人", item.submittedBy), actorRow("封存人", item.sealedBy)]}>
              <p>{deliveryMeaning(item)}</p>
              <p>提交人 {actorText(item.submittedBy)} · 封存人 {item.sealedBy ? actorText(item.sealedBy) : "尚无"}</p>
              <p>技术结果：{item.deliveryIntent.technicalResult} · {item.deliveryIntent.technicalEvidence}</p>
              {item.agentObservation && <p>提交时拟记录的智能体观察：{item.agentObservation}</p>}
              {item.reason && <p>封存结果：{sealReasonLabel(item.reason) === item.reason ? "原记录码见完整标识" : sealReasonLabel(item.reason)}</p>}
            </RecordItem>)}
          </RecordList>
          <RecordList title="审计事件" count={data.events.items.length} more={!!data.events.nextCursor} empty="已读范围内没有审计事件。" button={moreButton("events")}
            note="事件只说明曾登记的状态变化，不证明有人实际使用或任务已验收。">
            {data.events.items.filter(item => !taskId || relatedDispatchId(String(item.detail.dispatchId ?? item.entityId)) || relatedSource(String(item.detail.sourceEventId ?? "")) ||
              item.entityType === "decision" && data.decisions[item.entityId] && relatedDispatchId(data.decisions[item.entityId]!.dispatchId)).map(item =>
              <RecordItem key={item.id} title={item.kind === "worker.decision" ? `执行方判定：${dispositionLabel(typeof item.detail.kind === "string" ? item.detail.kind : null)}` : "状态变化"}
                state={date(item.createdAtUtc)} rows={[{ label: "事件类型", value: item.kind }, { label: "对象", value: `${item.entityType} ${item.entityId}` }, { label: "操作", value: item.operationId },
                  { label: "事件细节", value: JSON.stringify(item.detail), text: true }, actorRow("记录者", item.actorId)]}>
                <p>记录者 {actorText(item.actorId)}</p>
              </RecordItem>)}
          </RecordList>
        </div>
      </details>
    </>}
  </div>;
}

function Story({ projectId, item, data, later, title, taskName }: {
  projectId: string; item: OrchestrationDispatch; data: LoopData; later: boolean; title?: string | undefined; taskName: string;
}) {
  const detail = data.tasks.items.find(value => value.task.id === item.taskId);
  const inbox = data.inbox.items.find(value => value.id === item.inboxId);
  const source = data.sources.items.find(value => value.id === item.sourceEventId);
  const status = data.workStatuses[item.taskId];
  const matchedStatus = status?.dispatchId === item.id ? status : undefined;
  const sourceStatus = matchedStatus?.sourceTaskId ? data.workStatuses[matchedStatus.sourceTaskId] : undefined;
  const submission = data.submissions.items.find(value => value.dispatchId === item.id);
  const decisionEvent = data.events.items.find(value => value.kind === "worker.decision" && value.detail.dispatchId === item.id);
  const decision = decisionEvent ? data.decisions[decisionEvent.entityId] : undefined;
  const intentGap = hasTerminalIntentGap(item.id, data.events.items, submission, decision);
  const revisionId = data.revisionIds[item.taskId]?.[item.taskVersion];
  const state = later && item.outcome === "waiting" ? { tone: "history" as const, label: "当时等待 · 已有接续" }
    : intentGap ? { tone: "blocked" as const, label: "运行已结束，缺少提交" } : { tone: dispatchTone[item.state], label: dispatchStateLabel[item.state] };
  const rows: IdentifierRow[] = [{ label: "派发", value: item.id }, { label: "来源事件", value: item.sourceEventId }, { label: "入站", value: item.inboxId },
    { label: "上游派发", value: item.parentDispatchId }, { label: "提交", value: submission?.id }, { label: "交付", value: submission?.deliveryId }, { label: "运行", value: item.runtimeRunId },
    actorRow("请求人", item.requestedBy), actorRow("决定者", decision?.actorId), actorRow("处理人", inbox?.acknowledgedBy)];
  return <article className="flex min-w-0 flex-col gap-2 border-t border-border py-4 first:border-t-0" data-dispatch={item.id}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h5 className="min-w-0 text-small font-semibold text-foreground [overflow-wrap:anywhere]"><a className="hover:underline" href={taskSectionHref(projectId, item.taskId)}>
        {storyTitle(item, taskName, source, matchedStatus, sourceStatus, title)}</a></h5>
      <StatusTag tone={state.tone} label={state.label} />
    </div>
    <p className={mutedText}>派发登记 {date(item.createdAtUtc)}{detail && detail.task.version !== item.taskVersion ? ` · 派发时是任务第 ${item.taskVersion} 版，现名称可展开核对` : ""}</p>
    <FactList columns rows={[
      ["为什么做", `${sourceTriggerLabel(source)}${item.parentDispatchId ? " · 接续上游派发" : ""}`],
      ["交给谁", <span key="to"><RoleName projectId={projectId} roleId={item.recipientRoleId} />{item.requestedBy ? ` · 由 ${actorText(item.requestedBy)} 发起` : ""}</span>],
      ["结果", intentGap ? "已确认运行结束，还没有署名提交或决定，不能视作交付。" : readableOutcome(item, submission, detail)],
      ["当时的下一步", later ? storyNextAction(inbox, item, submission, true) : intentGap ? "缺口已保留；原因与后续处理见关联的工作记录。" : storyNextAction(inbox, item, submission, false)],
      [decisionHeading(!!decision), decision ? `${dispositionLabel(decision.kind)} · ${actorText(decision.actorId)}` : inbox?.acknowledgedBy ? `${dispositionLabel(inbox.disposition)} · ${actorText(inbox.acknowledgedBy)}` : "尚未读回派发决定"],
    ]} />
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-label">
      {revisionId ? <a className={link} href={taskSectionHref(projectId, item.taskId, { revisionId })}>派发请求时的任务（第 {item.taskVersion} 版）</a>
        : <span className="text-text-secondary">派发请求时的任务第 {item.taskVersion} 版暂不可核实；<a className={link} href={taskSectionHref(projectId, item.taskId)}>查看现在的任务</a></span>}
      {item.runtimeRunId && <a className={link} href={`${taskSectionHref(projectId, item.taskId, { tab: "runtime" })}&run=${encodeURIComponent(item.runtimeRunId)}`}>所属任务的这次运行</a>}
      {submission?.deliveryId && <a className={link} href={taskSectionHref(projectId, item.taskId, { tab: "delivery" })}>所属任务的交付与使用</a>}
      {item.parentDispatchId && <span className="text-text-secondary">上游派发见下方记录</span>}
    </p>
    <details>
      <summary className="w-fit cursor-pointer text-caption text-primary hover:underline">完整理由与核对</summary>
      <div className="mt-2 flex flex-col gap-1 text-label text-text-secondary [overflow-wrap:anywhere]">
        <p>派发理由：{item.reason || purposeLabel(item.purpose)}</p>
        {inbox?.reason && <p>入站处理理由：{inbox.reason}</p>}
        {decision?.reason && <p>署名决定理由：{decision.reason}</p>}
        {title && item.purpose === "cognition" && <p>完整目标与阶段：{title}</p>}
        {detail?.task.title && item.purpose === "cognition" && <p>原任务现名称：{detail.task.title}</p>}
        {detail?.task.content && <details><summary className="w-fit cursor-pointer text-caption text-primary hover:underline">任务现在的正文</summary>
          <p className="mt-1 max-h-[9em] overflow-auto whitespace-pre-wrap">{detail.task.content}</p></details>}
        <FullIdentifiers rows={rows} />
      </div>
    </details>
  </article>;
}

function RecordList({ title, count, more, empty, button, note, children }: {
  title: string; count: number; more: boolean; empty: string; button: ReactNode; note?: string; children: ReactNode;
}) {
  return <section aria-label={title} className="flex min-w-0 flex-col gap-2">
    <h4 className="text-label font-semibold text-foreground">{title} <span className="font-normal text-muted-foreground">{count}{more ? "+" : ""}</span></h4>
    {note && <p className={mutedText}>{note}</p>}
    {count === 0 && <p className="text-label text-text-secondary">{empty}</p>}
    <ul className="flex flex-col">{children}</ul>
    {button}
  </section>;
}

function RecordItem({ title, state, rows, children }: { title: ReactNode; state: string; rows: IdentifierRow[]; children: ReactNode }) {
  return <li className="flex min-w-0 flex-col gap-1 border-t border-border py-2.5 text-label text-text-secondary first:border-t-0 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="min-w-0 font-medium text-foreground">{title}</span>
      <span className="text-caption text-muted-foreground">{state}</span>
    </div>
    {children}
    <FullIdentifiers rows={rows} />
  </li>;
}
