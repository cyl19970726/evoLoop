// One managed agent (受管 Session) in 分工与运行: identity and permissions, its queue and runs, the old full-access
// upgrade, and closing it. A close is offered only when nothing in what was read blocks it, and every blocker is
// named; the service checks again when the request is sent.
import { useState } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { Button, Notice, StatusTag } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { ActionForm, reasonField, type MutationContext } from "../../shared/ActionForm";
import { queueClient } from "../../shared/queueClient";
import { useProjectQuery } from "../../shared/query";
import { runtimeClient } from "../../shared/runtimeClient";
import { FactList, Legacy, PageSection, mutedText } from "../../shared/ui/PageParts";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { href } from "../../shared/ui/shared";
import { ResidentQueuePanel } from "../workflow";
import { recoveryActivationLabel, sessionHref } from "../sessions";
import { closeBlockers, messageKindText, needsFullAccessUpgrade, permissionsText, profileText, sessionStateText, sessionStateTone, turnStatusText } from "./executionPresentation";
import { nativeReadError, Receipts, RunList } from "./RunList";
import type { RoleName } from "./useRoleNames";

export function RoleLabel({ projectId, roleId, name }: { projectId: string; roleId: string; name: RoleName }) {
  if (name.title) return <a href={`${href(projectId, "roles")}?role=${encodeURIComponent(roleId)}`} className="text-primary hover:underline">{name.title}</a>;
  return <span>{name.fallback}{name.note && <span className={mutedText}> · {name.note}</span>}</span>;
}

export function ManagedSessionDetail({ context, session, name, runs, runsRead, sessions, onReread }: {
  context: MutationContext; session: RuntimeSessionRecord; name: RoleName; runs: RuntimeRunRecord[]; runsRead: boolean;
  sessions: RuntimeSessionRecord[]; onReread(): void;
}) {
  const { projectId } = context;
  const queues = useProjectQuery(projectId, ["runtime", "queues"], async () => {
    const items = await queueClient("", projectId).list();
    if (!Array.isArray(items) || items.some(queue => queue.projectId !== projectId)) throw new Error("队列响应与当前项目不符");
    return items;
  });
  const blockers = closeBlockers(session, { runsRead, runs, queues: queues.error || !queues.data ? null : queues.data });
  const queueReading = queues.isPending;
  const permissions = context.principal.permissions;
  const own = runs.filter(run => run.sessionId === session.id);
  const readOnly = new Set(sessions.filter(item => item.sandbox === "read-only").map(item => item.id));
  const short = session.id.slice(0, 8);
  return <article id={`runtime-session-${session.id}`} tabIndex={-1} aria-label={`受管智能体 ${short}`} className="flex min-w-0 scroll-mt-20 flex-col gap-6 outline-none">
    <header className="flex flex-col gap-2">
      <a href={href(projectId, "runtime")} className="flex w-fit items-center gap-1 text-small text-text-secondary hover:text-foreground"><ChevronLeft size={14} aria-hidden="true" />全部受管智能体</a>
      <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>{name.title ?? name.fallback} · 智能体 {short}</h1>
      <div className="flex flex-wrap items-center gap-2">
        <StatusTag tone={sessionStateTone(session.state)} label={sessionStateText[session.state]} />
        <span className={mutedText}>登记版本 {session.version}</span>
        <a href={sessionHref(projectId, `owned:${session.id}`)} className="text-small text-primary hover:underline">在智能体空间打开对话与活动</a>
        <Button size="compact" variant="ghost" onClick={onReread}><RefreshCw aria-hidden="true" />读取运行状态</Button>
      </div>
    </header>
    {session.state === "unknown" && <Notice tone="error">创建结果未知，不能用新 ID 重复创建来代替核对。</Notice>}
    {name.error && <Notice tone="error">{name.error}；当前仅显示登记的职责标识。</Notice>}
    <PageSection title="身份与权限">
      <FactList columns rows={[
        ["职责", <RoleLabel key="role" projectId={projectId} roleId={session.roleId} name={name} />],
        ["授权工作范围", session.authorizationScope], ["工作区", session.cwd],
        ["当前登记权限", permissionsText(session.sandbox, session.approvalPolicy)],
        ["创建时配置的模型", session.model ?? "未显式指定"],
        ["原生创建回执", `模型 ${session.observedModel ?? "未知"} · 提供方 ${session.observedProvider ?? "未知"}；不代表某一轮已成功`],
        ["原生线程", session.nativeThreadId ? "已绑定" : "尚未确认"],
      ]} />
      <p className="text-small text-text-secondary" data-profile="">{profileText(session, recoveryActivationLabel)}</p>
      <p className={mutedText}>智能体与职责的登记不表示任何任务正在此处运行；请核对队列与具体运行。</p>
    </PageSection>
    {needsFullAccessUpgrade(session) && permissions.includes("write") && permissions.includes("review") && <PageSection title="登记为完整权限"
      description="填写为原智能体创建者配置的精确授权模型；服务端按原创建者、职责、工作目录及范围核验。提交后会在原智能体与原生线程上登记新配置修订，仍须核对激活；历史运行不会改写。">
      <Legacy><ActionForm key={session.executionProfile!.revision.revisionId} context={context} review embedded title="升级原智能体执行配置" fields={[
        { name: "targetModel", label: "原创建者精确授权的目标模型" }, { name: "evidenceRef", label: "本次授权依据" }, reasonField,
      ]} build={v => {
        const model = v.targetModel!.trim();
        if (!model) throw new Error("需要原创建者精确授权的目标模型");
        return { type: "runtime.session.executionProfile.revise", sessionId: session.id, expectedVersion: session.version,
          expectedExecutionProfileRevisionId: session.executionProfile!.revision.revisionId, model,
          sandbox: "danger-full-access", approvalPolicy: "never", evidenceRef: v.evidenceRef, reason: v.reason };
      }} /></Legacy>
    </PageSection>}
    <PageSection title="队列">
      <SectionBoundary label="队列"><ResidentQueuePanel context={context} sessionId={session.id} runs={runs} sessions={sessions} /></SectionBoundary>
    </PageSection>
    <PageSection title="此智能体的运行">
      {!runsRead && <Notice tone="error">运行列表未读回；下面只有上次读到的运行，不能据此判断没有其他运行。</Notice>}
      <RunList context={context} runs={own} readOnlySessions={readOnly} empty={runsRead ? "没有登记在此智能体的运行。" : "运行列表未读回，无法判断。"} />
    </PageSection>
    <PageSection title="关闭" description="关闭请求与原生线程的实际归档分别留证；请求成功不等于已经关闭。职责撤回在职责页单独办理。">
      {queueReading && <p role="status" className="text-small text-text-secondary">正在读取关闭条件…</p>}
      {!queueReading && blockers.length > 0 && <Notice tone="waiting" title="当前不能请求关闭" data-close-blockers="">
        <ul className="list-disc pl-5">{blockers.map(item => <li key={item}>{item}</li>)}</ul>
      </Notice>}
      {queues.error && <p className="text-small text-destructive">队列读取失败：{errorText(queues.error)}</p>}
      {!queueReading && blockers.length === 0 && <>
        <p className="text-small text-text-secondary">在本次读到的运行与队列中没有发现在途运行或占用。消息与具体分派的完整核对在<a className="text-primary hover:underline" href={`${sessionHref(projectId, `owned:${session.id}`)}`}>智能体空间的关闭面板</a>；提交时服务端会再次检查。</p>
        <Legacy><ActionForm key={`${session.id}:${session.version}`} context={{ ...context, draftScope: `runtime-close:${session.id}`, draftBaseline: String(session.version) }}
          review embedded title="请求关闭受管智能体" fields={[{ ...reasonField, label: "关闭理由与核对依据" }]}
          build={v => ({ type: "runtime.session.close", sessionId: session.id, expectedVersion: session.version, reason: v.reason })} /></Legacy>
      </>}
    </PageSection>
    <PageSection title="线程历史与回执">
      <ThreadHistory projectId={projectId} sessionId={session.id} />
      <Receipts label="阅读智能体与审批回执" load={() => runtimeClient("", projectId).sessionEvents(session.id)} />
      <details className="text-caption text-muted-foreground">
        <summary className="cursor-pointer">来源与完整标识</summary>
        <FactList rows={[["受管智能体", session.id], ["职责", session.roleId], ["原生线程", session.nativeThreadId ?? "尚未确认"],
          ["原生会话", session.nativeSessionId ?? "尚未确认"], ["原操作", session.operationId]]} />
      </details>
    </PageSection>
  </article>;
}

function ThreadHistory({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [history, setHistory] = useState<Awaited<ReturnType<ReturnType<typeof runtimeClient>["history"]>> | null>(null);
  const [error, setError] = useState("");
  return <div className="flex flex-col gap-2">
    <Button size="compact" variant="ghost" className="w-fit" onClick={async () => {
      try { setHistory(await runtimeClient("", projectId).history(sessionId)); setError(""); } catch (cause) { setError(nativeReadError(cause)); }
    }}>读取所属线程历史</Button>
    {error && <Notice tone="error">{error}</Notice>}
    {history && <>
      <p className={mutedText}>读回 {history.turns.length} 轮 · {history.observedAt} · {history.truncated ? "有更多历史未读，不代表完整" : "当前范围读取完成"}</p>
      {history.turns.map((turn, index) => <details key={turn.id} className="text-small">
        <summary className="cursor-pointer text-foreground">第 {index + 1} 轮 · {turnStatusText(turn.status)}</summary>
        {turn.messages.map((message, i) => <div key={i} className="mt-1 flex flex-col gap-0.5"><span className="text-caption text-muted-foreground">{messageKindText(message.type)}</span>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-sunken p-3 font-mono text-caption">{message.text}</pre></div>)}
      </details>)}
    </>}
  </div>;
}
