// 运行与关联 (tasks.md: 已分派 ≠ 已接受 ≠ 正在运行): who the task is assigned to and whether they took it, the
// execution queues it is in, its runs (each one linkable, with its answer, receipts and the writes a run allows),
// the automatic loop it belongs to, where its collaboration lives, and the fixed Git and other sources registered
// for it. A run's state is never the task's acceptance, and an agent being busy never means it runs this task.
import React from "react";
import { useQueries } from "@tanstack/react-query";
import type { Task, TaskDetail } from "@evoloop/contracts";
import type { RuntimeReconcilePartial, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import { AgentAvatar, Button, Notice, StatusTag, Textarea, Field } from "@evoloop/ui";
import { ApiError, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { activeFullExecution } from "../../shared/fullExecution";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { runtimeClient, type NativeResult } from "../../shared/runtimeClient";
import { sessionClient } from "../../shared/sessionClient";
import { currentPath, onNavigate } from "../../shared/navigation";
import { taskRunFromHash, taskSectionHref } from "../../shared/taskNavigation";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { date } from "../../shared/ui/shared";
import { OrchestrationPanel } from "../orchestration";
import { ReferencePanel } from "../references";
import { eligibleOwnedSessions, sessionHref } from "../sessions";
import { preflightPresentation, preflightView } from "../../shared/preflightPresentation";
import { CommandForm, overLimitText } from "../../shared/command";
import { readAgent } from "./agentRead";
import { BindAgentForm } from "./TaskAgentBlock";
import { assignmentAcknowledgeCommand, assignmentObserveCommand, assignmentReleaseCommand, handoffRecordCommand, queueCreateCommand,
  runAbandonCommand, runInterruptCommand, runReserveCommand } from "./taskCommands";
import { runStateName } from "./taskExperience";
import { assignmentKey } from "./taskFactsPresentation";
import { ActionRow, Fine, ReadNote, TabSection, readCurrent, reasonField } from "./TaskForms";
import { ResidentQueuePanel } from "./ResidentQueuePanel";
import { taskOrigin } from "./taskOrigin";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inFlight = ["requested", "dispatching", "running", "unknown"];
const terminal = ["completed", "failed", "interrupted"];

/** The task's current assignment (same key as the right column). */
export function useAssignment(projectId: string, taskId: string) {
  return useProjectQuery(projectId, ["task", taskId, "assignment"], async signal => {
    const value = await sessionClient("", projectId).assignment(taskId, signal);
    if (value && (value.projectId !== projectId || value.taskId !== taskId)) throw new Error("分派响应与当前任务不符");
    return value;
  });
}

export function TaskRuntimeTab({ context, detail, active, overviewHref }: { context: MutationContext; detail: TaskDetail; active: boolean; overviewHref: string }) {
  const projectId = context.projectId;
  const task = detail.task;
  const assignment = useAssignment(projectId, task.id);
  // Runs and agents are read again every five seconds while this tab is on screen.
  const poll = active ? 5000 : false;
  const sessionsRead = useProjectQuery(projectId, ["runtime", "sessions"], async () => (await runtimeClient("", projectId).sessions()).filter(session => session.projectId === projectId), { refetchInterval: poll, enabled: active });
  const runsRead = useProjectQuery(projectId, ["runtime", "runs", task.id], async () => {
    const value = await runtimeClient("", projectId).runs(task.id);
    if (!Array.isArray(value)) throw new Error("运行列表响应格式不符");
    return value;
  }, { refetchInterval: poll, enabled: active });
  const status = useProjectQuery(projectId, ["runtime", "status"], () => runtimeClient("", projectId).status(), { enabled: active });
  const [targetRunId, setTargetRunId] = React.useState(() => taskRunFromHash(currentPath(), projectId, task.id));
  React.useEffect(() => { const read = () => setTargetRunId(taskRunFromHash(currentPath(), projectId, task.id)); read(); return onNavigate(read); }, [projectId, task.id]);
  const listed = (runsRead.data ?? []).filter(run => run.projectId === projectId && run.taskId === task.id);
  const targetRead = useProjectQuery(projectId, ["runtime", "run", targetRunId ?? ""], async () => {
    const run = await runtimeClient("", projectId).run(targetRunId!);
    if (run.id !== targetRunId || run.projectId !== projectId || run.taskId !== task.id) throw new Error("目标运行与当前任务不符");
    return run;
  }, { enabled: active && !!targetRunId && uuid.test(targetRunId), refetchInterval: poll });
  const runs = targetRead.data ? [...listed.filter(run => run.id !== targetRead.data!.id), targetRead.data] : listed;
  const sessions = sessionsRead.data ?? [];
  const [pollCount, setPollCount] = React.useState(0);
  React.useEffect(() => { if (runsRead.dataUpdatedAt) setPollCount(count => count + 1); }, [runsRead.dataUpdatedAt]);
  const targetProblem = targetRunId ? !uuid.test(targetRunId) ? "链接中的运行编号无效" : targetRead.error ? errorText(targetRead.error) : null : null;
  return <div className="flex flex-col gap-8">
    <TabSection title="分派与确认">
      <AssignmentSection context={context} task={task} read={assignment} />
    </TabSection>
    <TabSection title="执行队列">
      <ResidentQueuePanel context={context} task={task} runs={runs} sessions={sessions} titled={false} />
    </TabSection>
    <TabSection title="运行记录" meta={runsRead.data ? `${runs.length} 次` : undefined}
      action={<Button size="compact" variant="ghost" disabled={runsRead.isFetching} onClick={() => { void runsRead.refetch(); void sessionsRead.refetch(); void status.refetch(); }}>读取运行状态</Button>}>
      <RunsSection context={context} detail={detail} assignment={assignment} runs={runs} runsRead={runsRead} sessionsRead={sessionsRead} status={status}
        targetRunId={targetRunId && uuid.test(targetRunId) ? targetRunId : null} targetProblem={targetProblem} />
    </TabSection>
    <TabSection title="自动循环">
      <Fine>只列与这项任务同来源或父子派发的、已读回的循环记录。</Fine>
      <OrchestrationPanel key={`${projectId}:${context.principal.actorId}:${task.id}`} projectId={projectId} refresh={pollCount}
        taskId={task.id} verifiedRuns={runsRead.data && !runsRead.error ? runs : null} />
    </TabSection>
    <TabSection title="协作与待答问题">
      <p className="text-label text-text-secondary">这项任务的协作频道、提问与答复在“当前工作 › 进展与讨论”里。<a className="text-primary hover:underline" href={overviewHref}>打开进展与讨论</a></p>
    </TabSection>
    <TabSection title="Git 与外部来源登记">
      <Fine>为这一版任务登记固定的 Git 文件、知识页或运行来源，并对已登记的来源作采用、保留或替换决定。</Fine>
      <ReferencePanel key={`refs:${task.currentRevisionId}`} context={context} taskId={task.id} taskRevisionId={task.currentRevisionId} taskVersion={task.version} />
    </TabSection>
  </div>;
}

type AssignmentRead = { data: TaskSessionAssignment | null | undefined; error: unknown; isPending: boolean; isFetching: boolean; refetch(): unknown };

function AssignmentSection({ context, task, read }: { context: MutationContext; task: Task; read: AssignmentRead }) {
  const projectId = context.projectId;
  const assignment = read.data ?? null;
  const key = assignment ? assignmentKey(assignment) : null;
  const agent = useProjectQuery(projectId, ["session-names", key], signal => readAgent(projectId, key!, signal), { enabled: !!key });
  const name = agent.data?.profile?.displayName?.trim() || agent.data?.title || (agent.error ? "智能体名称暂不可读" : "正在读取名称…");
  const history = useProjectQuery(projectId, ["task", task.id, "assignment-history"], async signal => {
    const value = await sessionClient("", projectId).assignmentHistory(task.id, undefined, signal);
    if (!Array.isArray(value?.items)) throw new Error("分派记录响应格式不符");
    return value;
  });
  const [binding, setBinding] = React.useState(false);
  // A failed reread keeps the last answer on screen (marked by ReadNote); nothing is written from it.
  const known = read.data !== undefined;
  const ready = known && !read.error;
  const valid = !!assignment && assignment.state !== "released" && assignment.taskRevisionId === task.currentRevisionId;
  const closed = task.state === "done" || task.state === "cancelled";
  const permissions = context.principal.permissions;
  const seen = { taskVersion: task.version, assignmentVersion: assignment?.version ?? 0 };
  const state = !assignment ? null : assignment.state === "released" ? { tone: "history" as const, label: "分派已释放" }
    : closed ? { tone: "history" as const, label: assignment.state === "accepted" ? "历史承接 · 当时已接手" : "历史分派" }
      : assignment.state === "accepted" ? valid ? { tone: "done" as const, label: "已接手" } : { tone: "waiting" as const, label: "接手属于旧修订" }
        : valid ? { tone: "waiting" as const, label: "已分派，待确认接手" } : { tone: "waiting" as const, label: "分派属于旧修订" };
  return <div className="flex flex-col gap-3" data-assignment="">
    <ReadNote read={read} what="分派" />
    {read.error !== null && read.error !== undefined && read.data === undefined && <Fine>读到分派之前，不能说这项任务没有人承接。</Fine>}
    {known && (assignment ? <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <AgentAvatar seed={key!} roleSeed={agent.data?.roles[0]?.id ?? task.owner} size={30} />
        <span className="text-small font-medium text-foreground">{name}</span>
        {state && <StatusTag tone={state.tone} label={state.label} />}
        <a className="text-label text-primary hover:underline" href={sessionHref(projectId, key!, taskOrigin(projectId, task, context.principal.actorId))}>进入对话</a>
      </div>
      <Fine>{assignment.target.kind === "owned" ? "项目内智能体" : "外部接入的智能体"} · 更新于 {date(assignment.updatedAt)} · 分派人 {assignment.actorId}{assignment.recipientActorId ? ` · 指定执行者 ${assignment.recipientActorId}` : ""}</Fine>
      <p className="text-label text-text-secondary [overflow-wrap:anywhere]">分派依据：{assignment.reason}</p>
      {assignment.ack && <p className="text-label text-text-secondary [overflow-wrap:anywhere]">{assignment.ack.method === "direct" ? "执行者本人确认接手" : "负责人观察到接手"} · {date(assignment.ack.at)} · {assignment.ack.evidence}</p>}
      {!valid && assignment.state !== "released" && !closed && <Notice tone="waiting">任务的当前修订和分派固定的修订不同。旧的接手记录保留，但不能当作新修订已经接手。</Notice>}
      <FullIdentifiers rows={[{ label: "承接对象", value: key }, { label: "分派固定的任务修订", value: assignment.taskRevisionId },
        { label: "确认来源", value: assignment.ack?.sourceRef }, { label: "确认人", value: assignment.ack?.actorId ?? assignment.ack?.observerActorId }]} />
    </div> : <p className="text-label text-text-secondary">还没有指定具体的智能体。负责职责仍在任务上，但不能据此推定哪个智能体已经接手。</p>)}
    {task.state === "todo" && <Fine>建议先开始任务再指定智能体：开始会产生新的固定修订，之前的分派和接手不会沿用。</Fine>}
    {ready && task.state === "in_progress" && permissions.includes("review") && (binding
      ? <BindAgentForm context={context} task={task} currentVersion={assignment?.version ?? 0} currentKey={assignment && assignment.state !== "released" ? key : null} onDone={() => setBinding(false)} />
      : <div><Button size="compact" onClick={() => setBinding(true)}>{assignment && assignment.state !== "released" ? "更换智能体" : assignment ? "重新指定智能体" : "指定智能体"}</Button></div>)}
    {ready && assignment && <div className="flex flex-col">
      {assignment.state === "assigned" && valid && assignment.recipientActorId === context.principal.actorId && permissions.includes("write") &&
        <ActionRow title="本人确认接手" description="你是这次分派指定的执行者。">
          <CommandForm context={context} submitLabel="确认接手" baseline={seen} fields={[{ name: "evidence", label: "实际接手的证据", kind: "textarea", maxLength: 4000 },
            { name: "sourceRef", label: "来源引用", optional: true, maxLength: 4000 }]}
            build={(values, recorded) => assignmentAcknowledgeCommand(task.id, recorded, { evidence: values.evidence ?? "", sourceRef: values.sourceRef ?? "" })} /></ActionRow>}
      {assignment.state === "assigned" && valid && permissions.includes("review") &&
        <ActionRow title="记录负责人观察到接手" description="由负责人写明实际看到的接手证据。">
          <CommandForm context={context} submitLabel="记录观察" baseline={seen} fields={[{ name: "evidence", label: "实际观察与证据", kind: "textarea", maxLength: 4000 },
            { name: "sourceRef", label: "来源引用", optional: true, maxLength: 4000 }]}
            build={(values, recorded) => assignmentObserveCommand(task.id, recorded, { evidence: values.evidence ?? "", sourceRef: values.sourceRef ?? "" })} /></ActionRow>}
      {assignment.state !== "released" && permissions.includes("review") &&
        <ActionRow title="释放具体分派" description="释放后这项任务回到只有负责职责、没有具体承接的状态。">
          <CommandForm context={context} submitLabel="释放分派" danger baseline={seen} fields={[reasonField("释放原因")]}
            build={(values, recorded) => assignmentReleaseCommand(task.id, recorded, { reason: values.reason ?? "" })} /></ActionRow>}
    </div>}
    {history.data && history.data.items.length > 1 && <details>
      <summary className="w-fit cursor-pointer text-label text-primary hover:underline">分派记录（{history.data.items.length}{history.data.nextCursor ? "+" : ""}）</summary>
      <ol className="mt-2 flex flex-col gap-1">{history.data.items.map(item => <li key={`${item.version}:${item.updatedAt}`} className="text-caption text-text-secondary">
        第 {item.version} 版 · {item.state === "accepted" ? "已接手" : item.state === "assigned" ? "已分派" : "已释放"} · {date(item.updatedAt)} · {item.actorId} · {item.reason}
      </li>)}</ol>
    </details>}
  </div>;
}

type Read<T> = { data: T | undefined; error: unknown; isPending: boolean; isFetching: boolean; refetch(): unknown };

function RunsSection({ context, detail, assignment, runs, runsRead, sessionsRead, status, targetRunId, targetProblem }: {
  context: MutationContext; detail: TaskDetail; assignment: AssignmentRead; runs: RuntimeRunRecord[];
  runsRead: Read<RuntimeRunRecord[]>; sessionsRead: Read<RuntimeSessionRecord[]>; status: Read<Awaited<ReturnType<ReturnType<typeof runtimeClient>["status"]>>>;
  targetRunId: string | null; targetProblem: string | null;
}) {
  const projectId = context.projectId;
  const task = detail.task;
  const permissions = context.principal.permissions;
  const sessions = sessionsRead.data ?? [];
  const assigned = assignment.data && assignment.data.state !== "released" ? assignment.data : null;
  const stale = !!assigned && assigned.taskRevisionId !== task.currentRevisionId;
  // Only current reads decide who may take the task: a failed reread of the agents or the assignment offers nothing.
  const agentsKnown = readCurrent(sessionsRead) && readCurrent(assignment);
  const eligible = agentsKnown ? eligibleOwnedSessions(task, sessions.filter(activeFullExecution), assignment.data ?? null) : [];
  const names = useQueries({ queries: eligible.map(session => ({ queryKey: queryKeys.project(projectId, "session-names", `owned:${session.id}`),
    queryFn: ({ signal }: { signal: AbortSignal }) => readAgent(projectId, `owned:${session.id}`, signal), retry: false })) });
  const roleName = (session: RuntimeSessionRecord) => {
    const agent = names[eligible.indexOf(session)]?.data;
    return `${agent?.profile?.displayName?.trim() || agent?.title || "智能体（名称待读取）"} · 创建于 ${date(session.createdAt)}`;
  };
  const arrange = { taskVersion: task.version, revisionId: task.currentRevisionId, owner: task.owner,
    assignmentVersion: assigned?.version ?? 0, assignmentState: assigned?.state ?? "none", assignmentTarget: assigned ? assignmentKey(assigned) : "",
    agents: eligible.map(session => `${session.id}@${session.version}`).join(",") };
  const recover = useRecover(context);
  return <div className="flex flex-col gap-3" ref={useRevealRun(task.id, projectId, runs, targetRunId)}>
    {!!runsRead.error && <Notice tone="error">运行列表暂不可读取：{errorText(runsRead.error)}。{targetRunId && runs.some(run => run.id === targetRunId) ? "链接指向的运行已单独核对；" : ""}其他运行不能据此推断。</Notice>}
    {!!sessionsRead.error && <Notice tone="error">智能体列表暂不可读取：{errorText(sessionsRead.error)}。参与的智能体范围不能据此推断。</Notice>}
    {targetProblem && <Notice tone="error">链接指向的运行暂不可核对：{targetProblem}。没有定位到其他运行。</Notice>}
    {status.data && !status.data.available && <Notice tone="waiting" title="执行服务尚未接通"
      action={permissions.includes("review") ? <Button size="compact" disabled={recover.busy} onClick={() => void recover.run()}>{recover.busy ? "正在核对…" : "受控恢复执行连接"}</Button> : undefined}>
      已有运行记录仍保留；不会自动重发结果未知的启动。{recover.message}</Notice>}
    {runsRead.isPending && !runsRead.error ? <ReadNote read={runsRead} what="运行记录" />
      : readCurrent(runsRead) && !runs.length && <p className="text-label text-text-secondary">这项任务还没有登记运行。</p>}
    <div className="flex flex-col">{[...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(run => <RunRecord key={`${run.id}:${run.version}`}
      context={context} run={run} taskTitle={run.taskId === task.id ? task.title : null} anchor={`runtime-run-${task.id}-${run.id}`} readOnlyAgent={sessions.some(session => session.id === run.sessionId && session.sandbox === "read-only")} />)}</div>
    <Fine>收到通知、读取材料、采用判断和真实效果分别留证。运行结束不会自动关闭任务。</Fine>
    {task.state === "in_progress" && <div className="flex flex-col gap-2">
      <h3 className="text-small font-semibold text-foreground">安排执行</h3>
      {assignment.error ? <Notice tone="error">具体分派暂不可核对：{errorText(assignment.error)}。先重新读取分派，暂不创建队列或预留新的运行。</Notice>
        : stale ? <Notice tone="waiting">任务修订已变化，原分派固定在旧修订。先核对并重新指定或释放分派。</Notice>
          : assigned?.target.kind === "external" ? <Fine>这项任务分派给了外部接入的智能体，不能改由项目内的智能体排队或运行；要先正式释放或重新分派。</Fine>
            : !agentsKnown ? <Fine>{sessionsRead.isPending ? "正在读取智能体列表…" : "智能体列表没有读回，暂不能排队或派发；先重新读取运行状态。"}</Fine>
              : !eligible.length ? <Fine>没有就绪、完整执行配置已激活且职责匹配的项目内智能体；请核对分派和智能体状态。</Fine>
                : null}
      {eligible.length > 0 && permissions.includes("review") && <ActionRow title="把任务排进具体智能体的队列" description="创建只有这一项的执行队列；还要有权者采纳，登记不表示已经开始。">
        <CommandForm context={context} submitLabel="创建队列" baseline={arrange} fields={[
          { name: "sessionId", label: "承接的智能体", kind: "select", options: eligible.map(session => ({ value: session.id, label: roleName(session) })) },
          { name: "consumerId", label: "验收责任者", kind: "select", initial: detail.proposal?.consumer || context.principal.actorId,
            options: [{ value: detail.proposal?.consumer || context.principal.actorId, label: detail.proposal?.consumer || "当前身份" }] },
          reasonField("为什么安排给这个智能体")]}
          notes={<Fine>每次创建一个任务项，最多 3 次有界运行；要跨任务排序，在队列里调整后重新采纳。</Fine>}
          build={(values, seen) => queueCreateCommand(detail, seen, { sessionId: values.sessionId ?? "", consumerId: values.consumerId ?? "", reason: values.reason ?? "" })} /></ActionRow>}
      {eligible.length > 0 && status.data?.available && permissions.includes("write") && <ActionRow title="派发这一次运行" description="系统附上任务的固定依据；运行结束后还要交付和使用验收。">
        <CommandForm context={context} submitLabel="派发运行" baseline={arrange} fields={[
          { name: "sessionId", label: "承接的智能体", kind: "select", options: eligible.map(session => ({ value: session.id, label: roleName(session) })) },
          { name: "input", label: "这一次的有界工作与停止条件", kind: "textarea", rows: 4, maxLength: 4000 }]}
          build={(values, seen) => runReserveCommand(task.id, seen, { sessionId: values.sessionId ?? "", input: values.input ?? "" })} /></ActionRow>}
    </div>}
  </div>;
}

function useRecover(context: MutationContext) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  async function run() {
    setBusy(true); setMessage("");
    try { await runtimeClient("", context.projectId).recover(); context.onChanged(); }
    catch (cause) { setMessage(`恢复核对失败：${errorText(cause)}`); }
    finally { setBusy(false); }
  }
  return { busy, message, run };
}

/** A link to one run (`?tab=runtime&run=…`) opens that run and brings it into view once; polling never scrolls again. */
function useRevealRun(taskId: string, projectId: string, runs: RuntimeRunRecord[], targetRunId: string | null) {
  const root = React.useRef<HTMLDivElement | null>(null);
  const revealed = React.useRef<string | null>(null);
  React.useEffect(() => {
    const reveal = () => {
      const requested = taskRunFromHash(currentPath(), projectId, taskId);
      if (!requested || !uuid.test(requested)) { revealed.current = null; return; }
      const target = root.current?.querySelector(`#runtime-run-${taskId}-${requested}`);
      if (!(target instanceof HTMLDetailsElement) || !target.getClientRects().length || revealed.current === currentPath()) return;
      revealed.current = currentPath();
      target.open = true;
      target.scrollIntoView({ block: "start" });
      target.querySelector("summary")?.focus({ preventScroll: true });
    };
    const frame = requestAnimationFrame(reveal);
    const stop = onNavigate(reveal);
    return () => { cancelAnimationFrame(frame); stop(); };
  }, [taskId, projectId, runs, targetRunId]);
  return root;
}

function RunRecord({ context, run, taskTitle, anchor, readOnlyAgent }: {
  context: MutationContext; run: RuntimeRunRecord; taskTitle: string | null; anchor: string; readOnlyAgent: boolean;
}) {
  const projectId = context.projectId;
  const permissions = context.principal.permissions;
  const preflight = run.resultSummary ? preflightPresentation(run.resultSummary) : null;
  const refused = preflight ? preflightView(preflight) : null;
  const [answer, setAnswer] = React.useState<{ value?: NativeResult; error?: string } | null>(null);
  const [events, setEvents] = React.useState<{ value?: Awaited<ReturnType<ReturnType<typeof runtimeClient>["events"]>>; error?: string } | null>(null);
  const tone = run.state === "running" || run.state === "dispatching" ? "progress" : run.state === "unknown" ? "unknown" : run.state === "failed" ? "blocked" : run.state === "requested" ? "waiting" : "idle";
  return <details id={anchor} className="group scroll-mt-20 border-t border-border first:border-t-0" data-run={run.id}>
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 py-3 outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <span className="text-small font-medium text-foreground">运行 · 开始于 {date(run.createdAt)}</span>
      <StatusTag tone={tone} label={runStateName[run.state] ?? "状态未识别"} />
      {run.interruptRequested && <StatusTag tone="waiting" label="已请求中断" />}
    </summary>
    <div className="flex flex-col gap-3 pb-4 pl-1">
      <p className="flex flex-wrap gap-x-4 text-label">
        <a className="text-primary hover:underline" href={taskSectionHref(projectId, run.taskId, { revisionId: run.taskRevisionId })}>执行时的任务修订</a>
        {run.projectId === projectId && uuid.test(run.sessionId) && <a className="text-primary hover:underline" href={sessionHref(projectId, `owned:${run.sessionId}`, taskOrigin(projectId, { id: run.taskId, title: taskTitle }, context.principal.actorId))}>查看这次运行的智能体</a>}
      </p>
      <Fine>运行的状态不代表任务已验收，也不代表那个智能体现在仍在做这项任务。</Fine>
      {run.state === "unknown" && <Notice tone="error">派发或状态仍然未知，要沿已绑定的线程回查；不会自动再发一次。</Notice>}
      {refused && <Notice tone="error" title={`派发前检查没有通过：${refused.title}`}>模型没有开始。{[refused.source, refused.size].filter(Boolean).join("；")}{refused.source || refused.size ? "。" : ""}{refused.next}</Notice>}
      {run.resultSummary && !preflight && <div className="flex flex-col gap-1"><p className="text-caption text-muted-foreground">保存的结果摘要（可能截断，不能代替完整答复）</p>
        <p className="whitespace-pre-wrap text-label text-foreground [overflow-wrap:anywhere]">{run.resultSummary}</p></div>}
      {run.nativeTurnId && <div className="flex flex-col gap-2">
        <div><Button size="compact" onClick={async () => {
          try { setAnswer({ value: await runtimeClient("", projectId).result(run.id) }); }
          catch (cause) { setAnswer({ error: cause instanceof ApiError && (cause.status === 0 || cause.status >= 500) ? "完整答复读取失败或超时。已保存的运行记录仍可查看；检查执行连接后重试读取，不要重发运行。" : errorText(cause) }); }
        }}>读取完整答复</Button></div>
        {answer?.error && <Notice tone="error">{answer.error}</Notice>}
        {answer?.value && <div className="flex flex-col gap-2">
          <Fine>来源：智能体自己的线程记录 · 读回于 {date(answer.value.observedAt)} · {answer.value.finalPhaseConfirmed ? "已确认是最终答复" : "记录没有标记最终答复，以下内容要复核"}</Fine>
          {!answer.value.messages.length && <p className="text-label text-text-secondary">记录里没有可以显示的答复。</p>}
          {answer.value.messages.map((text, index) => <pre key={index} className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-caption [overflow-wrap:anywhere]">{text}</pre>)}
        </div>}
      </div>}
      <div className="flex flex-col gap-2">
        <div><Button size="compact" variant="ghost" onClick={async () => {
          try { setEvents({ value: await runtimeClient("", projectId).events(run.id) }); } catch (cause) { setEvents({ error: errorText(cause) }); }
        }}>阅读运行、交接与审批回执</Button></div>
        {events?.error && <Notice tone="error">{events.error}</Notice>}
        {events?.value && (events.value.length ? <ol className="flex flex-col gap-1.5">{events.value.map(event => <li key={event.id} className="flex flex-col">
          <span className="text-label text-foreground [overflow-wrap:anywhere]">{event.detail}</span>
          <Fine>{event.actorId} · {date(event.createdAt)}</Fine>
        </li>)}</ol> : <p className="text-label text-text-secondary">没有回执记录。</p>)}
      </div>
      <div className="flex flex-col">
        {inFlight.includes(run.state) && run.nativeTurnId && !run.interruptRequested && permissions.includes("review") && <ActionRow title="请求中断这次运行" description="是否停下以运行的最终状态为准。">
          <CommandForm context={context} submitLabel="请求中断" danger baseline={{ runVersion: run.version }} fields={[reasonField()]}
            build={values => runInterruptCommand(run.id, { reason: values.reason ?? "" })} /></ActionRow>}
        {run.state === "completed" && permissions.includes("write") && <ActionRow title="记录这次交接的使用" description="按本身份逐步记录；这是署名观察，不自动代表验收或真人使用。">
          <CommandForm context={context} submitLabel="记录" baseline={{ runVersion: run.version }} fields={[
            { name: "stage", label: "本身份的交接阶段", kind: "select", options: [{ value: "received", label: "收到材料" }, { value: "read", label: "实际阅读" },
              { value: "adopted", label: "已采用到行动" }, { value: "effect", label: "观察到实际后果" }] },
            { name: "evidence", label: "实际路径、采用动作或后果的证据", kind: "textarea", maxLength: 4000 }]}
            build={values => handoffRecordCommand(run.id, { stage: values.stage ?? "", evidence: values.evidence ?? "" })} /></ActionRow>}
        {readOnlyAgent && run.state === "unknown" && !run.nativeTurnId && permissions.includes("review") && <ActionRow title="复核只读派发并保留失败记录"
          description="只适用于没有绑定线程轮次的只读运行。放弃会关闭旧派发，不证明外部没有执行，也不自动重发。">
          <CommandForm context={context} submitLabel="复核并放弃" danger baseline={{ runVersion: run.version }} fields={[reasonField(),
            { name: "evidence", label: "线程历史与失败原因的核对证据", kind: "textarea", maxLength: 4000 }]}
            build={(values, seen) => runAbandonCommand(run.id, seen, { reason: values.reason ?? "", evidence: values.evidence ?? "" })} /></ActionRow>}
        {run.nativeTurnId && terminal.includes(run.state) && permissions.includes("review") && <ActionRow title="核对已绑定运行的最终状态"
          description="只回读同一轮次；保留旧观察并登记修正，不再启动工作，也不自动关闭任务。"><ReconcileRun context={context} run={run} /></ActionRow>}
      </div>
      <FullIdentifiers rows={[{ label: "运行", value: run.id }, { label: "执行的任务修订", value: run.taskRevisionId }, { label: "依据集合", value: run.basisSetId },
        { label: "智能体", value: run.sessionId }, { label: "线程轮次", value: run.nativeTurnId },
        ...(refused?.ids ?? []).map(([label, value]) => ({ label: `派发前${label}`, value })),
        { label: "处理建议原文", value: preflight?.nextAction, text: true }]} />
    </div>
  </details>;
}

/** Rereads one bound native turn's final state; a partial page keeps the same version, reason and cursor. */
function ReconcileRun({ context, run }: { context: MutationContext; run: RuntimeRunRecord }) {
  const [reason, setReason] = React.useState("");
  const [attempted, setAttempted] = React.useState(false);
  const [partial, setPartial] = React.useState<RuntimeReconcilePartial | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!reason.trim() || overLimitText(reason, 4000) || busy || attempted || context.blocked) return;
    setBusy(true);
    try {
      const requestedReason = partial?.reason ?? reason.trim();
      const result = await runtimeClient("", context.projectId).reconcile(run.id, run.version, requestedReason, partial?.nextTurnCursor);
      if ("status" in result && result.status === "partial") {
        if (result.changed !== false || result.projectId !== context.projectId || result.runId !== run.id
          || result.nativeTurnId !== run.nativeTurnId || result.expectedVersion !== run.version
          || result.reason !== requestedReason || !result.nextTurnCursor || result.nextTurnCursor === partial?.nextTurnCursor)
          throw new Error("续页响应与当前运行或上次游标不符");
        setPartial(result);
        setMessage("还没有定位到这次运行，运行记录没有修改。可以沿同一版本、理由和游标继续核对。");
      } else {
        if ("status" in result || result.projectId !== context.projectId || result.id !== run.id
          || result.sessionId !== run.sessionId || result.nativeTurnId !== run.nativeTurnId || result.version <= run.version)
          throw new Error("核对响应与当前运行不符");
        setAttempted(true); setMessage("最终状态已核对，请在回执里阅读新记录。"); context.onChanged();
      }
    } catch (cause) { setAttempted(true); setMessage(`${errorText(cause)}。请先回读当前状态和运行回执，确认结果后再操作。`); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-label="核对已绑定运行的最终状态" className="flex flex-col gap-3 rounded-lg bg-muted p-4">
    <Field label="复核理由" error={overLimitText(reason, 4000) ?? undefined}>{control => <Textarea {...control} required readOnly={!!partial || attempted} value={reason} onChange={event => setReason(event.target.value)} rows={3} />}</Field>
    <div><Button type="submit" variant="primary" size="compact" disabled={busy || attempted || context.blocked || !reason.trim()}>{busy ? "正在核对…" : partial ? "继续核对" : "回读最终状态并登记观察"}</Button></div>
    {message && <Notice>{message}</Notice>}
  </form>;
}
