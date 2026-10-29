import { useEffect, useRef, useState } from "react";
import type { Task, TaskDetail } from "@evoloop/contracts";
import type { RuntimeRecordEvent, RuntimeReconcilePartial, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import { ApiError, errorText } from "../api";
import { href } from "../ui/shared";
import { ActionForm, Notice, option, reasonField, type MutationContext } from "../workflow/ActionForm";
import { isRoleOwnerId, readOwnerRole } from "../workflow/ownerRole";
import { runtimeClient, type NativeResult, type RuntimeStatus } from "./client";
import { activeFullExecution } from "./fullExecution";
import { OrchestrationPanel } from "../orchestration/OrchestrationPanel";
import { ResidentQueuePanel } from "../queues/ResidentQueuePanel";
import { TaskCollaborationThread } from "../discussions/TaskCollaborationThread";
import { RoleTemplateSummary } from "../roles/RoleTemplateSummary";
import { sessionClient } from "../sessions/client";
import { sessionHref } from "../sessions/SessionNavigation";
import { recoveryActivationLabel } from "../sessions/recoveryPresentation";
import { eligibleOwnedSessions } from "../sessions/assignmentEligibility";
import { taskRunFromHash } from "../orchestration/navigation";
import { preflightPresentation } from "./preflightPresentation";
import { SessionCreation } from "./SessionCreation";
import "./session-focus.css";

function readErrorText(cause: unknown): string {
  if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500))
    return "原生历史读取失败或超时。已保存的运行记录仍可查看；请检查执行连接后重试读取，不要重发运行。";
  return errorText(cause);
}

const pending = ["requested", "dispatching", "running", "unknown"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionState: Record<RuntimeSessionRecord["state"], string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "状态未知", closed: "已关闭",
};
type RoleName = { title?: string; error?: string };
export function RuntimePanel({ context, refresh, task, taskDetail, targetSessionId }: { context: MutationContext; refresh: number; task?: Task; taskDetail?: TaskDetail; targetSessionId?: string }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [sessions, setSessions] = useState<RuntimeSessionRecord[]>([]);
  const [runs, setRuns] = useState<RuntimeRunRecord[]>([]);
  const [runsForTask, setRunsForTask] = useState<string | undefined>(undefined);
  const [runtimePoll, setRuntimePoll] = useState<{taskId: string | undefined; sequence: number} | null>(null);
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [targetRunId, setTargetRunId] = useState(() => task ? taskRunFromHash(window.location.hash, context.projectId, task.id) : null);
  const [targetRunProblem, setTargetRunProblem] = useState("");
  const runtimePanelRef = useRef<HTMLElement | null>(null);
  const revealedRunHref = useRef<string | null>(null);
  const revealedRunElement = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => { revealedRunHref.current = null; revealedRunElement.current = null; }, [targetRunId]);
  const [roleNames, setRoleNames] = useState<{scope:string; values:Record<string,RoleName>}>({scope:"",values:{}});
  const [assignmentRead, setAssignmentRead] = useState<{scope:string; value:TaskSessionAssignment|null; error:string}|null>(null);
  const sessionScope = JSON.stringify([context.token, context.projectId, task?.id ?? "", targetSessionId ?? "", targetRunId ?? ""]);
  useEffect(() => {
    const onHash = () => setTargetRunId(task ? taskRunFromHash(window.location.hash, context.projectId, task.id) : null);
    onHash(); window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [context.projectId, task?.id]);
  useEffect(() => {
    let active = true, fetching = false, sequence = 0;
    const client = runtimeClient(context.token, context.projectId);
    setLoadedScope(null); setAssignmentRead(null); setError(""); setTargetRunProblem("");
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const [s, sessionsRead, workRead, assignment, targetRun] = await Promise.all([client.status(), client.sessions()
          .then(value => ({value,error:""})).catch(cause => ({value:[] as RuntimeSessionRecord[],error:errorText(cause)})), client.runs(task?.id)
          .then(value => ({value,error:""})).catch(cause => ({value:[] as RuntimeRunRecord[],error:errorText(cause)})),
          task ? sessionClient(context.token, context.projectId).assignment(task.id).then(value => {
            if (value && (value.projectId !== context.projectId || value.taskId !== task.id)) throw new Error("分派响应与当前任务不符");
            return {value,error:""};
          })
            .catch(cause => ({value:null,error:errorText(cause)})) : Promise.resolve({value:null,error:""}),
          targetRunId && uuid.test(targetRunId) ? client.run(targetRunId).then(value => ({value,error:""}))
            .catch(cause => ({value:null,error:errorText(cause)})) : Promise.resolve({value:null,error:targetRunId ? "链接中的 Run ID 无效" : ""})]);
        const scopedSessions = sessionsRead.value.filter(session => session.projectId === context.projectId);
        if (active) { const verified = targetRun.value && targetRun.value.id === targetRunId && targetRun.value.projectId === context.projectId && targetRun.value.taskId === task?.id ? targetRun.value : null;
          const work = workRead.value;
          setStatus(s); setSessions(scopedSessions); setRuns(verified ? [...work.filter(run => run.id !== verified.id),verified] : work);
          setTargetRunProblem(targetRunId && !verified ? targetRun.error || "目标 Run 与当前任务不符" : "");
          setRunsForTask(workRead.error ? undefined : task?.id); setLoadedScope(sessionScope); setAssignmentRead({scope:sessionScope,...assignment});
          setError([
            sessionsRead.error && `会话列表暂不可读取：${sessionsRead.error}。会话范围不能据此推断。`,
            workRead.error && `运行列表暂不可读取：${workRead.error}。${verified ? "目标 Run 已单独核对；" : ""}其他运行不能据此推断。`,
          ].filter(Boolean).join(" "));
          sequence += 1; if (sequence > 1) setRuntimePoll({taskId:task?.id,sequence}); }
      } catch (cause) { if (active) setError(errorText(cause)); }
      finally { fetching = false; }
    }
    void load();
    const timer = setInterval(() => { void load(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [context.token, context.projectId, task?.id, targetSessionId, targetRunId, refresh, epoch]);
  async function recover() {
    setRecovering(true);
    try { await runtimeClient(context.token, context.projectId).recover(); setEpoch(e => e + 1); }
    catch (cause) { setError(errorText(cause)); }
    finally { setRecovering(false); }
  }
  const grants = (status?.grants ?? []).filter(grant => grant.sandbox === "danger-full-access"
    && grant.approvalPolicy === "never" && grant.networkAccess === true && (!task || grant.roleId === task.owner));
  const visibleSessions = loadedScope === sessionScope ? task ? sessions.filter(session => runs.some(run => run.sessionId === session.id)) : sessions : [];
  const hasTarget = !task && !!targetSessionId;
  const validTarget = !!targetSessionId && uuid.test(targetSessionId);
  const focusedSession = hasTarget && validTarget && loadedScope === sessionScope ? visibleSessions.find(session => session.id === targetSessionId && session.projectId === context.projectId) : undefined;
  const roleIds = [...new Set(visibleSessions.map(session => session.roleId).filter(isRoleOwnerId))];
  const roleSignature = roleIds.join(",");
  const roleScope = JSON.stringify([context.token, context.projectId, refresh, epoch, roleSignature]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setRoleNames({scope:roleScope,values:{}});
    const queue = roleSignature ? roleSignature.split(",") : [];
    const read = async () => {
      while (active && queue.length) {
        const roleId = queue.shift()!;
        let value:RoleName;
        try { value = {title:(await readOwnerRole(context.token,context.projectId,roleId,controller.signal)).proposal.title.trim()}; }
        catch (cause) {
          if (!active) return;
          value = {error:cause instanceof ApiError && cause.status===404 ? "未找到已登记职责" : `职责暂不可核对：${errorText(cause)}`};
        }
        if (active) setRoleNames(current => current.scope===roleScope
          ? {scope:roleScope,values:{...current.values,[roleId]:value}} : current);
      }
    };
    void Promise.all(Array.from({length:Math.min(4,queue.length)},()=>read()));
    return () => {active=false;controller.abort();};
  }, [context.token,context.projectId,refresh,epoch,roleSignature,roleScope]);
  const resolvedRoles = roleNames.scope===roleScope ? roleNames.values : {};
  const focusedRole = focusedSession ? resolvedRoles[focusedSession.roleId] : undefined;
  const taskAssignment = assignmentRead?.scope === sessionScope ? assignmentRead : null;
  const assigned = taskAssignment?.value?.state !== "released" ? taskAssignment?.value : null;
  const assignmentStale = !!assigned && assigned.taskRevisionId !== task?.currentRevisionId;
  const eligibleSessions = task && taskAssignment && !taskAssignment.error
    ? eligibleOwnedSessions(task, sessions.filter(activeFullExecution), taskAssignment.value) : [];
  const taskActionContext = task ? { ...context, draftScope: `runtime-task:${task.id}`,
    draftBaseline: `${task.currentRevisionId}:${assigned?.version ?? 0}:${assigned?.state ?? "none"}:${assigned ? JSON.stringify(assigned.target) : ""}` } : context;
  useEffect(() => {
    const reveal = () => {
      const requestedRun = task ? taskRunFromHash(window.location.hash, context.projectId, task.id) : null;
      const id = requestedRun && task ? `runtime-run-${task.id}-${requestedRun}` : null;
      const targetId = id;
      if (!targetId) { revealedRunHref.current = null; revealedRunElement.current = null; return; }
      if (!/^[a-z0-9-]+$/i.test(targetId)) return;
      const target = runtimePanelRef.current?.querySelector(`#${targetId}`);
      if (target instanceof HTMLDetailsElement && target.getClientRects().length) {
        const firstReveal = revealedRunHref.current !== window.location.hash;
        if (target !== revealedRunElement.current) { target.open = true; revealedRunElement.current = target; }
        if (firstReveal) {
          revealedRunHref.current = window.location.hash;
          target.scrollIntoView({ block: "start" });
          target.querySelector("summary")?.focus({ preventScroll: true });
        }
      }
    };
    const frame = requestAnimationFrame(reveal);
    window.addEventListener("hashchange", reveal);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("hashchange", reveal); };
  }, [context.projectId, task?.id, runs, targetRunId]);
  return <><RoleTemplateSummary token={context.token} projectId={context.projectId} refresh={refresh + epoch} /><section ref={runtimePanelRef} className="panel"><div className="panel-head"><h2>受管执行会话</h2><button onClick={() => setEpoch(e => e + 1)}>读取运行状态</button></div>
    {error && <Notice error>{error}</Notice>}
    {targetRunProblem && <Notice error>指定的 Run 暂不可核对：{targetRunProblem}。没有定位到其他运行。</Notice>}
    {!status ? <p>正在读取执行服务…</p> : !status.available && <Notice>{status.error || "Codex 执行服务尚未接通。已有运行记录仍保留；不自动重发未知启动。"}</Notice>}
    {status && !status.available && context.principal.permissions.includes("review") && <button disabled={recovering} onClick={recover}>{recovering ? "恢复核对中…" : "受控恢复执行连接"}</button>}
    {hasTarget && <section className="runtime-session-focus" aria-label="目标 Session">
      {!validTarget ? <Notice error>链接中的 Session ID 无效，无法定位会话。</Notice> : loadedScope !== sessionScope ? error ? <Notice error>目标 Session 暂不可核对：{error}；没有定位到其他会话。</Notice> : <p>正在核对目标 Session {targetSessionId}…</p> :
        !focusedSession ? <Notice error>当前项目未读到目标 Session {targetSessionId}；没有定位到其他会话。</Notice> : <>
          <h3>目标 Session · <SessionRoleLabel projectId={context.projectId} roleId={focusedSession.roleId} role={focusedRole} /> · {sessionState[focusedSession.state]}</h3>
          <p className="runtime-session-focus-key">Session ID <code>{focusedSession.id}</code> · 授权范围 {focusedSession.authorizationScope}</p>
          {focusedRole?.error && <Notice error>{focusedRole.error}；当前仅显示登记 ID。</Notice>}
          <p className="muted">会话与职责的登记不表示任何任务正在此处运行；请核对队列与具体 Run。</p>
          <ResidentQueuePanel context={context} token={context.token} projectId={context.projectId} refresh={refresh + epoch} sessionId={focusedSession.id} runs={runs} sessions={sessions} />
          <SessionCard context={context} session={focusedSession} focused anchor role={focusedRole} />
        </>}
    </section>}
    <OrchestrationPanel key={`${context.projectId}:${context.principal.actorId}:${task?.id ?? "project"}`} token={context.token} projectId={context.projectId} refresh={refresh + epoch} taskId={task?.id} verifiedRuns={!error && runsForTask === task?.id ? runs : null} runtimePoll={runtimePoll && runtimePoll.taskId === task?.id ? runtimePoll.sequence : 0} />
    {!hasTarget && <ResidentQueuePanel context={context} token={context.token} projectId={context.projectId} refresh={refresh + epoch} task={task} runs={runs} sessions={sessions} />}
    {task && <TaskCollaborationThread token={context.token} projectId={context.projectId} taskId={task.id} refresh={refresh + epoch} />}
    {loadedScope === sessionScope && visibleSessions.length === 0 && !hasTarget && <p className="empty">{task ? "本任务还没有关联的受管会话。" : "还没有受管会话。仅管理在本项目明确授权并由 evoLoop 创建的会话。"}</p>}
    {visibleSessions.filter(session => !focusedSession || session.id !== focusedSession.id).map(session => <SessionCard key={session.id} context={context} session={session} focused={false} anchor={!task} role={resolvedRoles[session.roleId]} />)}
    {status?.available && status.grants.length > 0 && grants.length === 0 && <Notice>当前没有同时允许完整本机权限、无需逐次审批和联网的精确授权；请核对项目执行配置后再创建新会话。</Notice>}
    {status?.available && grants.length > 0 && <SessionCreation context={context} grants={grants} refresh={refresh + epoch} />}
    {task && task.state === "in_progress" && taskAssignment?.error && <Notice error>具体分派暂不可核对：{taskAssignment.error}。请先回读任务分派记录，暂不创建队列或预留新运行。</Notice>}
    {task && task.state === "in_progress" && assignmentStale && <Notice error>任务修订已变化，原具体分派固定在旧修订。请先核对并重新指定或释放分派。</Notice>}
    {task && task.state === "in_progress" && assigned?.target.kind === "external" && <Notice>本任务已分派给外部人工会话，不能改由其他受管 Session 创建队列或预留运行；请先正式释放或重新分派。</Notice>}
    {task && task.state === "in_progress" && assigned?.target.kind === "owned" && !assignmentStale && !eligibleSessions.length && !taskAssignment?.error && <Notice>指定的受管 Session 当前未就绪、完整执行配置尚未激活或职责不匹配；请核对原分派与会话状态。</Notice>}
    {task && taskDetail && task.state === "in_progress" && eligibleSessions.length > 0 && <details className="workflow-detail"><summary>把任务安排给具体受管 Session</summary>
      <p>先核对当前固定任务输入，再选择一位同职责的就绪会话。队列创建后仍须由有权者采纳；登记不表示会话已开始执行。外部人工承接走任务具体分派与接手记录。</p>
      <ActionForm context={taskActionContext} review title="创建单任务队列" fields={[
        { name: "sessionId", label: "具体承接会话", kind: "select", options: eligibleSessions.map(session => option(session.id, `${resolvedRoles[session.roleId]?.title ?? "职责待核对"} · Session ${session.id.slice(0,8)}`)) },
        { name: "consumerId", label: "验收责任者", kind: "select", options: [option(taskDetail.proposal?.consumer || context.principal.actorId, taskDetail.proposal?.consumer || "当前身份")] },
        { name: "reason", label: "为何安排在此会话", kind: "textarea" },
      ]} build={v => ({ type: "queue.create", queueId: crypto.randomUUID(), maxRuns: 3, reason: v.reason,
        entries: [{ id: crypto.randomUUID(), taskId: task.id, taskRevisionId: task.currentRevisionId,
          sessionId: v.sessionId, roleId: task.owner, dependsOn: [], consumerId: v.consumerId,
          useRequired: taskDetail.proposal?.useRequired ?? false, releaseRule: "accepted" }] })} />
      <details><summary>运行上限与规则</summary><p>此入口每次创建一个任务项，当前上限为 3 次有界运行；执行者和验收者通过任务与队列记录追溯。需要跨任务排序时在队列详情调整并重新采纳。</p></details>
    </details>}
    {task && status?.available && task.state === "in_progress" && eligibleSessions.length > 0 && <ActionForm key={`${task.id}:${task.version}`} context={taskActionContext} title="派发本次任务运行" fields={[
      { name: "sessionId", label: "承接会话", kind: "select", options: eligibleSessions.map(s => option(s.id, `${resolvedRoles[s.roleId]?.title ?? "职责待核对"} · ${s.authorizationScope} · ${s.id.slice(0,8)}`)) },
      { name: "input", label: "本次有界工作与停止条件", kind: "textarea", hint: "系统会附带任务的固定依据；原生运行结束后还需交付与使用验收。" },
    ]} build={v => ({ type: "runtime.run.reserve", runId: crypto.randomUUID(), taskId: task.id, expectedVersion: task.version, ...v })} />}
    <h3>运行记录</h3>{runs.length === 0 && <p className="empty">没有已登记运行。</p>}
    {runs.map(run => <RunCard key={`${run.id}:${run.version}`} context={context} run={run} anchorId={task?.id === run.taskId ? `runtime-run-${task.id}-${run.id}` : undefined} mayAbandon={sessions.some(s=>s.id===run.sessionId && s.sandbox==="read-only")} />)}
    <p className="muted">收到通知、读取材料、采用判断与真实效果分别留证。原生完成状态不会自动关闭任务。</p>
  </section></>;
}
function SessionRoleLabel({projectId,roleId,role}:{projectId:string;roleId:string;role?:RoleName}) {
  return role?.title ? <span className="runtime-session-role"><a href={href(projectId,"roles")} onClick={event=>event.stopPropagation()}>{role.title}</a> <code title={roleId}>{roleId.slice(0,8)}</code></span>
    : <span className="runtime-session-role">职责 <code>{roleId}</code>{isRoleOwnerId(roleId) && <small>{role?.error ? " · 名称暂不可核对" : " · 正在核对名称"}</small>}</span>;
}
function SessionCard({context,session,focused,anchor,role}:{context:MutationContext;session:RuntimeSessionRecord;focused:boolean;anchor:boolean;role?:RoleName}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (focused && ref.current) ref.current.open = true; }, [focused,session.id]);
  const profile = session.executionProfile;
  const activeProfile = profile?.activationState === "active" && profile.activeRevisionId === profile.revision.revisionId;
  const activationLabel = profile?.activationState === "active" && !activeProfile
    ? profile.activeRevisionId ? "当前激活的是其他修订" : "激活记录待核对"
    : profile ? recoveryActivationLabel(profile.activationState) : "";
  const legacyProfile = profile && (profile.revision.sandbox !== "danger-full-access" || profile.revision.approvalPolicy !== "never");
  return <details ref={ref} className="workflow-detail runtime-session-card" id={anchor ? `runtime-session-${session.id}` : undefined}>
    <summary><SessionRoleLabel projectId={context.projectId} roleId={session.roleId} role={role} /> · {sessionState[session.state]} · Session {session.id.slice(0, 8)}</summary>
    <dl><div><dt>职责 ID</dt><dd>{session.roleId}</dd></div><div><dt>授权工作范围</dt><dd>{session.authorizationScope}</dd></div><div><dt>工作区</dt><dd>{session.cwd}</dd></div><div><dt>当前登记权限</dt><dd>{session.sandbox} · {session.approvalPolicy}</dd></div><div><dt>稳定会话 ID</dt><dd>{session.id}</dd></div><div><dt>原生线程</dt><dd>{session.nativeThreadId ?? "尚未确认"}</dd></div></dl>
    <p>创建时配置模型：<code>{session.model ?? "未显式指定"}</code>；原生创建回执：模型 <code>{session.observedModel ?? "未知"}</code>，provider <code>{session.observedProvider ?? "未知"}</code>。此回执不代表某个 Turn 已成功。</p>
    {profile ? <p>目标执行配置 v{profile.revision.version}：<code>{profile.revision.sandbox}</code> · <code>{profile.revision.approvalPolicy}</code> · 模型 <code>{profile.revision.model ?? "未显式指定"}</code> · {activationLabel}。{activeProfile ? "此修订已登记激活。" : profile.activeRevisionId ? "目标修订尚未确认激活；原已激活修订继续单独保留。" : "尚无已确认的原生配置修订。"}</p>
      : <p className="muted">未读到执行配置修订；不能从创建时权限推断当前原生配置。</p>}
    {legacyProfile && session.state === "ready" && !["attempting", "unknown"].includes(profile.activationState) && context.principal.permissions.includes("write") && context.principal.permissions.includes("review") && <details className="workflow-detail"><summary>将原会话登记为完整权限</summary>
      <Notice>填写为原 Session 创建者配置的精确授权模型；服务端将按原创建者、职责、工作目录及范围核验。此处会在原 Session 与原生 Thread 上登记新配置修订；提交后仍须核对激活，历史运行不会改写。</Notice>
      <ActionForm key={profile.revision.revisionId} context={context} review title="升级原会话执行配置" fields={[
        { name: "targetModel", label: "原创建者精确授权的目标模型" },
        { name: "evidenceRef", label: "本次授权依据" }, reasonField,
      ]} build={v => {
        const model = v.targetModel.trim();
        if (!model) throw new Error("需要原创建者精确授权的目标模型");
        return { type: "runtime.session.executionProfile.revise", sessionId: session.id, expectedVersion: session.version,
          expectedExecutionProfileRevisionId: profile.revision.revisionId, model,
          sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: v.evidenceRef, reason: v.reason };
      }} />
    </details>}
    {session.projectId === context.projectId && uuid.test(session.id) && <p><a href={sessionHref(context.projectId, `owned:${session.id}`)}>查看此 Session 工作区</a></p>}
    {role?.error && <Notice error>{role.error}；当前仅显示登记 ID。</Notice>}
    {session.state === "unknown" && <Notice error>创建结果未知，不能用新 ID 重复创建来代替核对。</Notice>}
    {session.state === "ready" && <details className="workflow-detail"><summary>关闭本项目受管会话</summary><Notice>先核对在途运行、队列占用和未确认结果。关闭请求与原生线程实际归档分别留证；不能把请求成功当成已经关闭。</Notice>
      <ActionForm context={context} review title="请求关闭受管会话" fields={[reasonField]}
        build={v => ({ type: "runtime.session.close", sessionId: session.id, expectedVersion: session.version, reason: v.reason })} />
    </details>}
    <SessionHistory context={context} sessionId={session.id} />
    <RuntimeEvidence load={() => runtimeClient(context.token, context.projectId).sessionEvents(session.id)} label="阅读会话与审批回执" />
  </details>;
}
function RuntimeEvidence({ load, label }: { load(): Promise<RuntimeRecordEvent[]>; label: string }) {
  const [events,setEvents] = useState<RuntimeRecordEvent[]>([]);
  const [error,setError] = useState("");
  return <div><button onClick={async () => { try { setEvents(await load()); setError(""); } catch (cause) { setError(errorText(cause)); } }}>{label}</button>
    {error && <Notice error>{error}</Notice>}{events.map(event => <div className="decision" key={event.id}><strong>{event.kind}</strong><p>{event.detail}</p><small>{event.actorId} · {event.createdAt}</small></div>)}
  </div>;
}
function RunCard({ context, run, mayAbandon, anchorId }: { context: MutationContext; run: RuntimeRunRecord; mayAbandon: boolean; anchorId?: string }) {
  const [nativeResult, setNativeResult] = useState<NativeResult | null>(null);
  const [error,setError] = useState("");
  const preflight = run.resultSummary ? preflightPresentation(run.resultSummary) : null;
  return <details className="workflow-detail runtime-run-card" id={anchorId}><summary>运行 {run.id.slice(0,8)} · {run.state}</summary>
    <p>任务修订 <code>{run.taskRevisionId}</code></p><p>依据集合 <code>{run.basisSetId}</code></p>
    <p>登记的 Session <code>{run.sessionId}</code>{run.projectId === context.projectId && uuid.test(run.sessionId) && <> · <a href={sessionHref(context.projectId, `owned:${run.sessionId}`)}>查看此 Run 登记的 Session 工作区</a></>}</p>
    <p className="muted">此链接只定位来源会话；Run 的状态不代表任务验收或当前接手。</p>
    {run.state === "unknown" && <Notice error>派发或状态仍未知，须沿已绑定线程回查；不会自动再发一次。</Notice>}
    {mayAbandon && run.state === "unknown" && !run.nativeTurnId && <details className="workflow-detail"><summary>复核只读派发并保留失败记录</summary><p>仅适用于没有绑定 Turn 的只读运行。放弃会关闭旧会话的后续派发；不证明外部未执行，也不自动重发。</p><ActionForm context={context} review title="复核并放弃未知只读派发" fields={[reasonField,{name:"evidence",label:"所属线程历史与失败原因核对证据",kind:"textarea"}]} build={v=>({type:"runtime.run.abandonReadOnly",runId:run.id,expectedVersion:run.version,...v})} /></details>}
    {preflight && <Notice error><strong>派发前检查未通过 · {preflight.code}</strong><br />模型尚未开始。
      {preflight.source && <> 来源：{preflight.source.kind} {preflight.source.id}{preflight.source.revisionId ? ` · 修订 ${preflight.source.revisionId}` : ""}。</>}
      {preflight.actualBytes !== null && preflight.limitBytes !== null && <> 大小：{preflight.actualBytes} / {preflight.limitBytes} 字节。</>}
      <br />下一步：{preflight.nextAction}</Notice>}
    {run.resultSummary && !preflight && <p className="history-body">已保存的结果摘要（可能截断，不能代替原生全文）：{run.resultSummary}</p>}
    {run.nativeTurnId && <button onClick={async () => { try { setNativeResult(await runtimeClient(context.token,context.projectId).result(run.id)); setError(""); } catch(cause) { setError(readErrorText(cause)); } }}>读取原生答复</button>}
    {error && <Notice error>{error}</Notice>}{nativeResult && <><p>来源：自有原生线程历史 · 读回时间 {nativeResult.observedAt} · {nativeResult.finalPhaseConfirmed ? "已确认最终答复阶段" : "原生记录未标记最终答复阶段，以下内容需复核"}</p>{nativeResult.messages.length === 0 && <p className="empty">当前原生记录没有可显示的答复。</p>}{nativeResult.messages.map((text,index)=><pre className="runtime-result" key={index}>{text}</pre>)}</>}
    {run.nativeTurnId && ["completed","failed","interrupted"].includes(run.state) && context.principal.permissions.includes("review") && <ReconcileRun context={context} run={run} />}
    <RuntimeEvidence label="阅读运行、交接与审批回执" load={() => runtimeClient(context.token,context.projectId).events(run.id)} />
    {pending.includes(run.state) && run.nativeTurnId && !run.interruptRequested && <ActionForm context={context} review title="请求中断本次运行" fields={[reasonField]} build={v=>({type:"runtime.run.interrupt",runId:run.id,...v})} />}
    {run.state === "completed" && <ActionForm context={context} title="记录本次交接使用" fields={[
      {name:"stage",label:"本身份的交接阶段",kind:"select",options:[option("received","收到材料"),option("read","实际阅读"),option("adopted","已采用到行动"),option("effect","观察到实际后果")]},
      {name:"evidence",label:"实际路径、采用动作或后果的证据",kind:"textarea",hint:"按本身份逐步记录；这是署名观察，不自动代表消费者验收或真人使用。"},
    ]} build={v=>({type:"runtime.handoff.record",runId:run.id,...v})} />}
    {run.interruptRequested && <Notice>已登记中断请求；是否停止以原生运行终态为准。</Notice>}
  </details>;
}

function ReconcileRun({ context, run }: { context: MutationContext; run: RuntimeRunRecord }) {
  const [reason,setReason] = useState("");
  const [attempted,setAttempted] = useState(false);
  const [partial,setPartial] = useState<RuntimeReconcilePartial | null>(null);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  return <details className="workflow-detail"><summary>核对已绑定运行的终态观察</summary>
    <p>仅回读同一原生 Turn；保留旧观察并登记修正，不再启动工作，也不自动关闭任务。</p>
    <form className="workflow-form" onSubmit={async event => {
      event.preventDefault(); if (!reason.trim() || busy || attempted || context.blocked) return;
      setBusy(true);
      try {
        const requestedReason = partial?.reason ?? reason.trim();
        const result = await runtimeClient(context.token,context.projectId).reconcile(run.id,run.version,requestedReason,partial?.nextTurnCursor);
        if ("status" in result && result.status === "partial") {
          if (result.changed !== false || result.projectId !== context.projectId || result.runId !== run.id
            || result.nativeTurnId !== run.nativeTurnId || result.expectedVersion !== run.version
            || result.reason !== requestedReason || !result.nextTurnCursor
            || result.nextTurnCursor === partial?.nextTurnCursor)
            throw new Error("续页响应与当前运行或上次游标不符");
          setPartial(result);
          setMessage("尚未定位该运行，运行记录没有修改。可沿同一版本、理由和游标继续核对。");
        } else {
          if ("status" in result || result.projectId !== context.projectId || result.id !== run.id
            || result.sessionId !== run.sessionId || result.nativeTurnId !== run.nativeTurnId || result.version <= run.version)
            throw new Error("核对响应与当前运行不符");
          setAttempted(true); setMessage("终态观察已核对，请阅读运行回执中的新记录。"); context.onChanged();
        }
      }
      catch (cause) { setAttempted(true); setMessage(`${errorText(cause)}。请先回读当前状态与运行回执，确认结果后再操作。`); }
      finally { setBusy(false); }
    }}><label>复核理由<textarea required readOnly={!!partial || attempted} value={reason} onChange={event=>setReason(event.target.value)} /></label>
      <button disabled={busy || attempted || context.blocked || !reason.trim()}>{busy?"核对中…":partial?"继续核对":"回读原生终态并登记观察"}</button>
      {message && <Notice>{message}</Notice>}
    </form>
  </details>;
}

function SessionHistory({context,sessionId}:{context:MutationContext;sessionId:string}) {
  const [history,setHistory]=useState<Awaited<ReturnType<ReturnType<typeof runtimeClient>["history"]>>|null>(null);
  const [error,setError]=useState("");
  return <div><button onClick={async()=>{try{setHistory(await runtimeClient(context.token,context.projectId).history(sessionId));setError("");}catch(cause){setError(readErrorText(cause));}}}>读取所属线程历史</button>{error&&<Notice error>{error}</Notice>}{history&&<><p>读回 {history.turns.length} 个 Turn · {history.observedAt} · {history.truncated?"有更多历史未读，不代表完整":"当前范围读取完成"}</p>{history.turns.map(turn=><details key={turn.id}><summary>{turn.id} · {turn.status}</summary>{turn.messages.map((m,i)=><pre className="runtime-result" key={i}>{m.type}: {m.text}</pre>)}</details>)}</>}</div>;
}
