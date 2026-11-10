// 执行队列: the order in which a project's own agents take tasks, with what currently occupies each agent, what is
// next (which is not the same as startable), what is held and why, and each entry's attempts. Adopting the order,
// moving an entry forward, holding and releasing a hold are written from here. Used by the task's 运行与关联 (one
// task's queues) and by the team's 分工与运行 (all queues, or one agent's).
import React from "react";
import { useQueries } from "@tanstack/react-query";
import type { Task, TaskDetail } from "@evoloop/contracts";
import type { QueueHoldCode, ResidentQueue, ResidentQueueEntry } from "@evoloop/contracts/queues";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { Button, StatusTag, type StatusTone } from "@evoloop/ui";
import { ApiError, request } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { queueClient } from "../../shared/queueClient";
import { hereOrigin, withReturn } from "../../shared/returnLink";
import { taskOrigin } from "./taskOrigin";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { date, href } from "../../shared/ui/shared";
import { CommandForm } from "../../shared/command";
import { readAgent } from "./agentRead";
import { queueAdoptCommand, queueAmendCommand, queueHoldCommand, queueReorderCommand, queueUnholdCommand } from "./taskCommands";
import { runStateName } from "./taskExperience";
import { ActionRow, Fine, ReadNote, reasonField } from "./TaskForms";

const maxNamedEntries = 24;
const key = encodeURIComponent;
export const holdLabel: Record<QueueHoldCode, string> = {
  not_adopted: "队列尚未采纳", task_changed: "任务修订已变化", task_unavailable: "任务不可承接",
  dependency: "依赖尚未放行", session_unready: "智能体尚未就绪", binding_changed: "职责绑定已变化",
  grant_revoked: "授权已撤销", occupied: "智能体已被占用", run_in_flight: "运行仍在进行",
  unknown: "运行结果未知", awaiting_acceptance: "等待验收者使用与验收", budget_exhausted: "累计尝试达到上限",
  manual_review: "等待人工复核",
};
const agentState: Record<RuntimeSessionRecord["state"], string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "状态待核对", closed: "已关闭",
};

/** Where one entry stands. A queued entry behind an unreleased one waits; the first waiting one is only next in line. */
export function entryStanding(entry: Pick<ResidentQueueEntry, "state">, adopted: boolean, priorReleased: boolean): { tone: StatusTone; label: string } {
  switch (entry.state) {
    case "released": return { tone: "done", label: "已放行" };
    case "held": return { tone: "blocked", label: "暂停" };
    case "claimed": return { tone: "progress", label: "已领取／占用" };
    default: return !adopted ? { tone: "idle", label: "未采纳，不能派发" } : priorReleased ? { tone: "waiting", label: "后续顺位，等调度核对" } : { tone: "idle", label: "等待前项放行" };
  }
}

/** `titled={false}` where the page already heads the section (the task's 运行与关联). */
export function ResidentQueuePanel({ context, task, sessionId, runs, sessions, titled = true }: {
  context: MutationContext; task?: Pick<Task, "id" | "title" | "currentRevisionId"> | undefined; sessionId?: string | undefined;
  runs: RuntimeRunRecord[]; sessions: RuntimeSessionRecord[]; titled?: boolean;
}) {
  const projectId = context.projectId;
  const list = useProjectQuery(projectId, ["resident-queues"], async signal => {
    const items = await queueClient("", projectId).list(signal);
    if (!Array.isArray(items) || items.some(item => item.projectId !== projectId)) throw new Error("队列响应与当前项目不符");
    return items;
  });
  const queues = list.data ?? [];
  // “重新读取队列” reads the list and, in every open queue, its detail, attempts and the names it shows.
  const [round, setRound] = React.useState(0);
  const visible = task || sessionId ? queues.filter(queue => queue.entries.some(entry => (!task || entry.taskId === task.id) && (!sessionId || entry.sessionId === sessionId))) : queues;
  return <section data-ui="" data-queue-panel="" aria-label="执行队列" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {titled && <h3 className="text-small font-semibold text-foreground">执行队列</h3>}
      <span className="text-caption text-muted-foreground">{list.isFetching ? "正在核对队列…" : list.dataUpdatedAt ? `读于 ${date(new Date(list.dataUpdatedAt).toISOString())}` : "尚未读回"}</span>
      <Button size="compact" variant="ghost" className="ml-auto" disabled={list.isFetching} onClick={() => { void list.refetch(); setRound(value => value + 1); }}>重新读取队列</Button>
    </div>
    <Fine>项目自己的智能体按这里的顺序承接任务。排在前面不等于可以启动：每次还要核对任务修订、依赖、授权和占用。</Fine>
    <ReadNote read={list} what="执行队列" />
    {list.data && !list.error && !visible.length && <p className="text-label text-text-secondary">{sessionId ? "这个智能体还不在已登记的执行队列里。" : task ? "这项任务还不在已登记的执行队列里。" : "还没有登记执行队列。"}</p>}
    {visible.map(queue => <QueueCard key={`${projectId}:${queue.id}`} context={context} queue={queue} task={task} sessionId={sessionId} runs={runs} sessions={sessions} round={round} />)}
  </section>;
}

function QueueCard({ context, queue, task, sessionId, runs, sessions, round }: {
  context: MutationContext; queue: ResidentQueue; round: number; task?: Pick<Task, "id" | "title" | "currentRevisionId"> | undefined; sessionId?: string | undefined;
  runs: RuntimeRunRecord[]; sessions: RuntimeSessionRecord[];
}) {
  const projectId = context.projectId;
  const [open, setOpen] = React.useState(!!sessionId || !!task);
  // Once opened, the content (and any draft in it) stays until the page goes away.
  const [opened, setOpened] = React.useState(!!sessionId || !!task);
  const detail = useProjectQuery(projectId, ["resident-queues", queue.id, "detail"], async () => {
    const value = await queueClient("", projectId).detail(queue.id);
    if (value.projectId !== projectId || value.id !== queue.id) throw new Error("队列详情不属于当前项目");
    return value;
  }, { enabled: opened });
  const attemptRead = useProjectQuery(projectId, ["resident-queues", queue.id, "attempts"], async () => {
    const rows = await queueClient("", projectId).attempts(queue.id);
    if (!Array.isArray(rows) || rows.some(row => row.attempts.some(attempt => attempt.projectId !== projectId))) throw new Error("尝试记录不属于当前项目");
    return rows;
  }, { enabled: opened });
  const shown = detail.data ?? queue;
  const ordered = shown.entries.filter(entry => !sessionId || entry.sessionId === sessionId).sort((a, b) => a.position - b.position);
  const groups = new Map<string, ResidentQueueEntry[]>();
  for (const entry of ordered) groups.set(entry.sessionId, [...groups.get(entry.sessionId) ?? [], entry]);
  // Names are read for at most 24 entries: first what occupies each agent and what is next for it. A name that comes
  // into this set (a reread moved the order: a new next in line) is read again, not taken from an earlier read.
  const priority = [...groups.values()].flatMap(entries => [entries.find(entry => entry.state === "claimed"), entries.find(entry => entry.state === "queued")]
    .filter((entry): entry is ResidentQueueEntry => !!entry));
  const named = [...new Map([...priority, ...ordered].map(entry => [entry.id, entry])).values()].slice(0, maxNamedEntries);
  const taskIds = [...new Set(named.map(entry => entry.taskId))].filter(id => id !== task?.id);
  const roleIds = [...new Set(named.map(entry => entry.roleId))];
  const taskReads = useQueries({ queries: taskIds.map(id => ({ queryKey: queryKeys.project(projectId, "task", id, "detail"), enabled: opened, retry: false, refetchOnMount: "always" as const,
    queryFn: async () => {
      const value = await request<TaskDetail>("", `/api/projects/${key(projectId)}/tasks/${key(id)}`, 15000);
      if (value.task.projectId !== projectId || value.task.id !== id) throw new Error("名称响应与当前项目或任务不符");
      return value;
    } })) });
  const roleReads = useQueries({ queries: roleIds.map(id => ({ queryKey: queryKeys.project(projectId, "roles", id), enabled: opened, retry: false, refetchOnMount: "always" as const,
    queryFn: async () => {
      const value = await request<RoleRecord>("", `/api/projects/${key(projectId)}/roles/${key(id)}`, 15000);
      if (value.projectId !== projectId || value.id !== id) throw new Error("名称响应与当前项目或职责不符");
      return value;
    } })) });
  // The queue list's own summary (version, adoption) and an entry's state can change without the version; whenever
  // the list or a reread brings anything new, the open card reads its detail, attempts and names again.
  const listKey = JSON.stringify([queue.version, queue.adoptedVersion, queue.entries.map(entry => `${entry.id}:${entry.state}:${entry.version}`)]);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (!opened) return;
    void detail.refetch(); void attemptRead.refetch();
    for (const read of [...taskReads, ...roleReads]) void read.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, listKey]);
  // A name whose reread failed is not shown from before: the entry says so in the shared wording (nameText), a record
  // that is not there (404) as 未找到 (full ID in 完整标识).
  const unnamed = (kind: string, error: unknown) => !error ? `${kind}（名称待读取）`
    : error instanceof ApiError && error.status === 404 ? `${kind}（未找到）` : `${kind}（名称暂不可读）`;
  const taskTitle = (id: string) => {
    if (id === task?.id) return task.title;
    const read = taskReads[taskIds.indexOf(id)];
    return !read?.error && read?.data?.task?.title?.trim() || unnamed("任务", read?.error);
  };
  const roleTitle = (id: string) => {
    const read = roleReads[roleIds.indexOf(id)];
    return !read?.error && read?.data?.proposal?.title?.trim() || unnamed("职责", read?.error);
  };
  const failedNames = [...taskReads, ...roleReads].some(read => read.error);
  const attempts = new Map(attemptRead.data?.map(row => [row.entryId, row.attempts]) ?? []);
  const total = attemptRead.data?.reduce((sum, row) => sum + row.attempts.length, 0);
  const waiting = shown.entries.filter(entry => entry.state === "queued" || entry.state === "held");
  const staleEntry = task ? shown.entries.find(entry => entry.taskId === task.id && entry.taskRevisionId !== task.currentRevisionId && entry.state === "queued") : undefined;
  const canReview = context.principal.permissions.includes("review");
  const reading = detail.isFetching || attemptRead.isFetching;
  const readable = !!detail.data && !detail.error && !attemptRead.error;
  return <details open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setOpened(true); }} data-queue={queue.id} className="group rounded-lg bg-muted px-4 py-3">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <span className="text-label font-medium text-foreground">队列 · 第 {queue.version} 版</span>
      <StatusTag tone={queue.adoptedVersion === null ? "waiting" : queue.adoptedVersion === queue.version ? "done" : "waiting"}
        label={queue.adoptedVersion === null ? "未采纳" : queue.adoptedVersion === queue.version ? "已采纳" : `已采纳第 ${queue.adoptedVersion} 版`} />
      <span className="text-caption text-muted-foreground">{queue.entries.length} 项</span>
    </summary>
    {opened && <div className="mt-3 flex flex-col gap-3">
      <div data-queue-meta="" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span className="min-w-0 flex-1 basis-56 [overflow-wrap:anywhere]">排序理由：{shown.reason}</span>
        <span>总运行上限 {shown.maxRuns}；累计尝试 {total ?? "待读回"}</span>
        <span>{reading ? "正在核对详情…" : detail.dataUpdatedAt ? `详情读于 ${date(new Date(detail.dataUpdatedAt).toISOString())}` : "详情尚未读回"}</span>
        <Button size="compact" variant="ghost" disabled={reading} onClick={() => { void detail.refetch(); void attemptRead.refetch(); }}>回读详情与尝试</Button>
      </div>
      <ReadNote read={detail} what="队列详情" />
      {attemptRead.error && <ReadNote read={attemptRead} what="尝试记录" />}
      {ordered.length > maxNamedEntries && <Fine>这一轮先核对当前占用和各智能体的下一顺位，最多读 {maxNamedEntries} 项名称；其余条目打开任务核对。</Fine>}
      {failedNames && <Fine>部分名称未读回，已保留对象编号供核对。</Fine>}
      {readable && canReview && <div className="flex flex-col">
        {shown.adoptedVersion !== shown.version && <ActionRow title="采纳当前顺序" description="采纳后调度才按这个顺序派发。">
          <CommandForm context={context} submitLabel="采纳当前顺序" baseline={{ queueVersion: shown.version }} fields={[]}
            build={(_values, seen) => queueAdoptCommand(shown.id, seen)} /></ActionRow>}
        {waiting.length > 1 && <ActionRow title="调整顺序" description="把一项等待中的任务往前移一位。">
          <CommandForm context={context} submitLabel="保存顺序" baseline={{ queueVersion: shown.version }} fields={[
            { name: "entryId", label: "要提前的任务", kind: "select", options: waiting.map(entry => ({ value: entry.id, label: `${taskTitle(entry.taskId)} · 现在第 ${entry.position + 1} 项` })) },
            reasonField()]}
            build={(values, seen) => queueReorderCommand(shown, seen, { entryId: values.entryId ?? "", reason: values.reason ?? "" })} /></ActionRow>}
        {staleEntry && task && <ActionRow title="按当前任务修订更新队列项" description="队列里固定的是任务的旧修订。">
          <CommandForm context={context} submitLabel="更新队列项" baseline={{ queueVersion: shown.version, entryId: staleEntry.id, taskRevisionId: task.currentRevisionId }}
            fields={[reasonField()]} build={(values, seen) => queueAmendCommand(shown.id, seen, { reason: values.reason ?? "" })} /></ActionRow>}
      </div>}
      {[...groups].map(([agentId, entries]) => <AgentQueue key={agentId} context={context} queue={shown} agentId={agentId} entries={entries}
        session={sessions.find(value => value.id === agentId)} runs={runs} attempts={attempts} attemptsRead={!!attemptRead.data} task={task}
        taskTitle={taskTitle} roleTitle={roleTitle} canWrite={readable && canReview} />)}
      <FullIdentifiers rows={[{ label: "队列", value: queue.id }, { label: "排序者", value: shown.actorId }]} />
    </div>}
  </details>;
}

function AgentQueue({ context, queue, agentId, entries, session, runs, attempts, attemptsRead, task, taskTitle, roleTitle, canWrite }: {
  context: MutationContext; queue: ResidentQueue; agentId: string; entries: ResidentQueueEntry[]; session?: RuntimeSessionRecord | undefined;
  runs: RuntimeRunRecord[]; attempts: Map<string, import("@evoloop/contracts/queues").QueueAttempt[]>; attemptsRead: boolean;
  task?: Pick<Task, "id" | "title"> | undefined; taskTitle(id: string): string; roleTitle(id: string): string; canWrite: boolean;
}) {
  const projectId = context.projectId;
  const agentKey = `owned:${agentId}`;
  const agent = useProjectQuery(projectId, ["session-names", agentKey], signal => readAgent(projectId, agentKey, signal));
  const name = agent.data?.profile?.displayName?.trim() || agent.data?.title || (agent.error ? "智能体（名称暂不可读）" : "智能体（名称待读取）");
  const current = entries.find(entry => entry.state === "claimed");
  const next = entries.find(entry => entry.state === "queued");
  let priorReleased = true;
  return <div className="flex min-w-0 flex-col gap-2" data-queue-agent={agentId}>
    <h4 className="flex flex-wrap items-center gap-2 text-label font-semibold text-foreground">
      <a className="text-primary hover:underline" href={withReturn(`${href(projectId, "sessions")}?session=${key(agentKey)}`, task ? taskOrigin(projectId, task, context.principal.actorId) : hereOrigin(context.principal.actorId))}>{name}</a>
      <span className="text-caption font-normal text-muted-foreground">{session ? agentState[session.state] ?? "状态待核对" : "状态未在这里读到"}</span>
    </h4>
    <p className="text-label text-text-secondary">当前占用：{current ? taskTitle(current.taskId) : "没有已确认的占用"}；后续顺位：{next ? `${taskTitle(next.taskId)}（不代表可以启动）` : "没有"}</p>
    <ol className="flex flex-col gap-2">{entries.map(entry => {
      const before = priorReleased;
      const standing = entryStanding(entry, queue.adoptedVersion !== null, before);
      if (entry.state !== "released") priorReleased = false;
      const tried = attempts.get(entry.id) ?? [];
      const last = tried.at(-1);
      const run = last ? runs.find(value => value.id === last.runId && value.taskId === entry.taskId) : undefined;
      const entryHref = `${href(projectId, "task", entry.taskId)}?tab=runtime${last ? `&run=${key(last.runId)}` : ""}`;
      const dependencies = entry.dependsOn.map(id => queue.entries.find(item => item.id === id)).filter((item): item is ResidentQueueEntry => !!item);
      return <li key={entry.id} data-queue-entry={entry.id} data-current-task={task?.id === entry.taskId ? "" : undefined}
        className={`flex min-w-0 flex-col gap-1 rounded-md bg-raised px-3 py-2.5 ${task?.id === entry.taskId ? "shadow-[inset_3px_0_0_var(--accent)]" : ""}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label font-medium text-foreground">第 {entry.position + 1} 项</span>
          <StatusTag tone={standing.tone} label={standing.label} />
          <a className="min-w-0 text-label text-primary hover:underline [overflow-wrap:anywhere]" href={entryHref}>{taskTitle(entry.taskId)}</a>
        </div>
        <Fine>承接职责 <a className="text-primary hover:underline" href={`${href(projectId, "roles")}?role=${key(entry.roleId)}`}>{roleTitle(entry.roleId)}</a> · 验收者 {entry.consumerId} · 放行规则 {entry.releaseRule === "accepted" ? entry.useRequired ? "验收者实际使用并验收" : "验收者验收" : "有界的人工决定"}</Fine>
        {dependencies.length > 0 && <Fine>要先放行：{dependencies.map(item => taskTitle(item.taskId)).join("、")}</Fine>}
        {entry.holdCode && <p className="text-caption text-warning [overflow-wrap:anywhere]">{holdLabel[entry.holdCode]}{entry.holdReason ? `：${entry.holdReason}` : ""}</p>}
        {entry.state === "claimed" && <Fine>这一项占用着这个智能体；后面的项即使有序号也不表示已经启动。</Fine>}
        {entry.state === "claimed" && run && ["completed", "failed", "interrupted"].includes(run.state) && <Fine>本轮运行已结束，仍占用这个智能体；等待交付／验收或明确接续，不代表后面的项已经运行。</Fine>}
        {entry.state === "queued" && before && queue.adoptedVersion !== null && <Fine>还要核对任务修订、依赖、授权、智能体和占用；这里只表示顺位。</Fine>}
        <Fine>{last ? <>累计尝试 {tried.length} 次 · <a className="text-primary hover:underline" href={entryHref}>最近一次运行</a> · {run ? `运行状态：${runStateName[run.state] ?? "未识别"}` : "运行状态没有在这里读到"}</>
          : `累计尝试 ${attemptsRead ? 0 : "待读回"} 次；没有读到运行。`}</Fine>
        {canWrite && entry.state === "queued" && <ActionRow title="暂停这一项" description="暂停后调度不再派发这一项，直到解除。">
          <CommandForm context={context} submitLabel="暂停" baseline={{ entryId: entry.id, entryState: entry.state }} fields={[reasonField()]}
            build={values => queueHoldCommand(queue.id, entry, { reason: values.reason ?? "" })} /></ActionRow>}
        {canWrite && entry.state === "held" && <ActionRow title="解除暂停" description="解除后仍按顺位与核对条件派发。">
          <CommandForm context={context} submitLabel="解除暂停" baseline={{ entryId: entry.id, entryVersion: entry.version }} fields={[reasonField()]}
            build={(values, seen) => queueUnholdCommand(queue.id, seen, { reason: values.reason ?? "" })} /></ActionRow>}
        <FullIdentifiers rows={[{ label: "任务", value: entry.taskId }, { label: "固定修订", value: entry.taskRevisionId }, { label: "职责", value: entry.roleId },
          { label: "智能体", value: entry.sessionId }, { label: "队列项", value: entry.id }, { label: "最近一次运行", value: last?.runId }, { label: "暂停原因代码", value: entry.holdCode }]} />
      </li>;
    })}</ol>
  </div>;
}
