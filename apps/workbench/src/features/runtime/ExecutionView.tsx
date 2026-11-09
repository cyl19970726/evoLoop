// 分工与运行 (docs/frontend/pages/team.md): the inner rail lists the project's managed agents (受管 Session); the
// center shows the selected one, or with none selected the execution service, every agent, creating a new one, the
// orchestration loop, queues and recorded runs. The right column holds the service facts and the selected agent's
// identity. `/runtime?session={uuid}` selects an agent; that is also where the old deep link lands.
import { useContext, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { Button, ListRow, LoadingState, Notice, StatusTag, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { runtimeClient } from "../../shared/runtimeClient";
import { ContextPanelContent, PageActive } from "../../shared/ui/ContextPanel";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { FactList, Legacy, PageSection, PanelSection, mutedText } from "../../shared/ui/PageParts";
import { SectionBoundary } from "../../shared/ui/SectionBoundary";
import { href } from "../../shared/ui/shared";
import { OrchestrationPanel } from "../orchestration";
import { ResidentQueuePanel } from "../queues";
import { ManagedSessionCreate } from "./ManagedSessionCreate";
import { ManagedSessionDetail, RoleLabel } from "./ManagedSessionDetail";
import { RunList } from "./RunList";
import { executionHref, fullGrants, permissionsText, sessionGroups, sessionStateText, sessionStateTone, uuidPattern } from "./executionPresentation";
import { useRoleNames } from "./useRoleNames";

const stamp = (value: number) => new Date(value).toLocaleString("zh-CN", { hour12: false });

export function ExecutionView({ context, refresh, sessionId }: { context: MutationContext; refresh: number; sessionId?: string }) {
  const { projectId } = context;
  const active = useContext(PageActive);
  const client = useQueryClient();
  const poll = { refetchInterval: active ? 5000 : false as const };
  const status = useProjectQuery(projectId, ["runtime", "status"], () => runtimeClient("", projectId).status(), poll);
  const sessionsRead = useProjectQuery(projectId, ["runtime", "sessions"], async () => {
    const items = await runtimeClient("", projectId).sessions();
    if (!Array.isArray(items)) throw new Error("智能体列表响应不完整");
    return items.filter(item => item.projectId === projectId);
  }, poll);
  const runsRead = useProjectQuery(projectId, ["runtime", "runs"], async () => {
    const items = await runtimeClient("", projectId).runs();
    if (!Array.isArray(items)) throw new Error("运行列表响应不完整");
    return items.filter(item => item.projectId === projectId);
  }, poll);
  // Panels that still read on their own (queues, orchestration) reread when this counter moves.
  const [epoch, setEpoch] = useState(0);
  const [creating, setCreating] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState("");
  const sessions: RuntimeSessionRecord[] = sessionsRead.data ?? [];
  const runs: RuntimeRunRecord[] = runsRead.data ?? [];
  const nameOf = useRoleNames(projectId, [...sessions.map(item => item.roleId), ...(status.data?.grants ?? []).map(grant => grant.roleId)]);
  const sessionsError = sessionsRead.error ? errorText(sessionsRead.error) : "";
  const runsError = runsRead.error ? errorText(runsRead.error) : "";
  const statusError = status.error ? errorText(status.error) : "";
  const runsCurrent = !!runsRead.data && !runsError;
  const validTarget = !!sessionId && uuidPattern.test(sessionId);
  const selected = validTarget ? sessions.find(item => item.id === sessionId) : undefined;
  const grants = fullGrants(status.data?.grants ?? []);
  const reread = () => {
    void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "runtime") });
    void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "roles") });
    setEpoch(value => value + 1);
  };
  async function recover() {
    setRecovering(true); setRecoverError("");
    try { await runtimeClient("", projectId).recover(); reread(); }
    catch (cause) { setRecoverError(errorText(cause)); }
    finally { setRecovering(false); }
  }
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    const frame = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[id="runtime-session-${selected.id}"]`)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [selected?.id]);
  const groups = sessionGroups(sessions);
  const readOnly = new Set(sessions.filter(item => item.sandbox === "read-only").map(item => item.id));
  const readLine = sessionsRead.data
    ? `智能体与运行读于 ${stamp(Math.min(sessionsRead.dataUpdatedAt, runsRead.dataUpdatedAt || sessionsRead.dataUpdatedAt))}；每 5 秒核对一次。${sessionsError || runsError ? "本次核对未完成，下列是上次读回，当前待核对。" : ""}`
    : sessionsRead.isPending ? "正在读取受管智能体与运行…" : "受管智能体尚未读回。";
  const serviceFacts = status.data
    ? <FactList rows={[
      ["执行服务", status.data.available ? "已接通" : `未接通${status.data.error ? `：${status.data.error}` : ""}`],
      ["可创建智能体的完整权限授权", status.data.grants.length ? `${grants.length} 项（共 ${status.data.grants.length} 项授权）` : "当前身份在本项目没有执行授权"],
      ["读取时间", `${stamp(status.dataUpdatedAt)}${statusError ? "（本次核对失败，上次读回）" : ""}`],
    ]} />
    : <p className={mutedText}>{status.isPending ? "正在读取执行服务…" : `执行服务状态未读回${statusError ? `：${statusError}` : ""}，无法判断是否接通。`}</p>;
  return <div data-ui="" ref={rootRef} className="team-execution mx-auto flex w-full max-w-[980px] flex-col gap-6 px-4 py-5 compact:px-8 compact:py-7">
    <ContextRailContent>
      <nav aria-label="受管智能体" className="flex flex-col gap-0.5 pt-1">
        <a href={href(projectId, "runtime")} aria-current={!sessionId ? "page" : undefined}
          className={cn("rounded-lg px-3 py-1.5 text-small outline-none focus-visible:shadow-[var(--focus-ring)]", !sessionId ? "bg-raised font-medium text-foreground shadow-sm" : "text-text-secondary hover:bg-selected")}>运行总览与新建</a>
        {sessionsRead.isPending && <span className="px-3 py-2 text-caption text-muted-foreground">正在读取受管智能体…</span>}
        {sessionsError && <span className="px-3 py-2 text-caption text-destructive">{sessions.length ? "本次核对失败，下列是上次读回" : "受管智能体暂不可读"}；原因见中间页首。</span>}
        {groups.map(group => <div key={group.key} className="flex flex-col gap-0.5">
          <span className="px-3 pb-1 pt-3 text-caption text-muted-foreground">{group.label} · {group.items.length}</span>
          {group.items.map(item => {
            const name = nameOf(item.roleId);
            return <a key={item.id} href={executionHref(projectId, item.id)} aria-current={sessionId === item.id ? "page" : undefined}
              className={cn("flex flex-col rounded-lg px-3 py-1.5 outline-none focus-visible:shadow-[var(--focus-ring)]", sessionId === item.id ? "bg-raised shadow-sm" : "hover:bg-selected")}>
              <span className="truncate text-small text-foreground">{name.title ?? name.fallback}</span>
              <span className="truncate text-caption text-muted-foreground">{sessionStateText[item.state]} · 智能体 {item.id.slice(0, 8)}</span>
            </a>;
          })}
        </div>)}
      </nav>
    </ContextRailContent>
    {sessionsError && <Notice tone="error" title="受管智能体未读完整">智能体列表暂不可读取：{sessionsError}。范围不能据此推断。</Notice>}
    {runsError && <Notice tone="error" title="运行未读完整">运行列表暂不可读取：{runsError}。其他运行不能据此推断。</Notice>}
    {sessionId !== undefined && !selected && <Notice tone="error" title="没有定位到目标智能体">
      {!validTarget ? "链接中的智能体 ID 无效，无法定位。"
        : sessionsRead.isPending ? `正在核对目标智能体 ${sessionId}…`
          : sessionsError ? `目标智能体暂不可核对：${sessionsError}；没有定位到其他智能体。`
            : `当前项目未读到目标智能体 ${sessionId}；没有定位到其他智能体。`}</Notice>}
    {selected
      ? <SectionBoundary label="受管智能体"><ManagedSessionDetail key={selected.id} context={context} session={selected} name={nameOf(selected.roleId)}
        runs={runs} runsRead={runsCurrent} sessions={sessions} refresh={refresh + epoch} onReread={reread} /></SectionBoundary>
      : sessionId !== undefined ? <a href={href(projectId, "runtime")} className="w-fit text-small text-primary hover:underline">查看全部受管智能体</a>
      : <>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-title font-semibold text-foreground" tabIndex={-1}>分工与运行</h1>
            <p className="mt-1 text-small text-text-secondary">本项目授权并由 evoLoop 创建的受管智能体、它们的队列与运行。对话与活动在“智能体”空间。</p>
            <p className={cn(mutedText, "mt-1")} role="status">{readLine}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {status.data?.available && grants.length > 0 && <Button onClick={() => setCreating(value => !value)} aria-pressed={creating}><Plus aria-hidden="true" />新建受管智能体</Button>}
            <Button variant="ghost" onClick={reread}><RefreshCw aria-hidden="true" />读取运行状态</Button>
          </div>
        </header>
        <PageSection title="执行服务">
          {status.isPending && <LoadingState lines={1} label="正在读取执行服务" />}
          {status.data && (status.data.available
            ? <p className="text-small text-text-secondary">执行服务已接通。{grants.length ? `当前身份有 ${grants.length} 项可创建智能体的完整权限授权。` : status.data.grants.length
              ? "当前没有同时允许完整本机权限、无需逐次审批和联网的精确授权；请核对项目执行配置后再创建新智能体。" : "当前身份在本项目没有执行授权，不能创建新智能体。"}</p>
            : <Notice tone="waiting" title="执行服务尚未接通">{status.data.error || "已有运行记录仍保留；不自动重发结果未知的启动。"}</Notice>)}
          {statusError && <Notice tone="error">执行服务状态{status.data ? "本次核对失败，上面是上次读回" : "暂不可读"}：{statusError}</Notice>}
          {status.data && !status.data.available && context.principal.permissions.includes("review") && <Button className="w-fit" disabled={recovering} onClick={() => void recover()}>{recovering ? "恢复核对中…" : "受控恢复执行连接"}</Button>}
          {recoverError && <Notice tone="error">恢复未完成：{recoverError}。请先读取运行状态，不要重复发起。</Notice>}
        </PageSection>
        {creating && status.data?.available && grants.length > 0 && <PageSection title="新建受管智能体">
          <ManagedSessionCreate key={epoch} context={context} grants={grants} roleName={roleId => { const name = nameOf(roleId); return name.title ?? name.fallback; }} />
        </PageSection>}
        <PageSection title="受管智能体" description="只列出在本项目明确授权并由 evoLoop 创建的智能体。外部聊天的接入在职责页登记。">
          {sessionsRead.isPending && <LoadingState lines={3} label="正在读取受管智能体" />}
          {sessionsRead.data && sessions.length === 0 && !sessionsError && <p className="text-small text-text-secondary">还没有受管智能体。</p>}
          {groups.map(group => <div key={group.key} className="flex flex-col gap-1">
            <h3 className={cn(mutedText, "px-3")}>{group.label} · {group.items.length}</h3>
            <ul aria-label={group.label} className="flex flex-col">{group.items.map(item => {
              const name = nameOf(item.roleId);
              return <li key={item.id} data-session-id={item.id}>
                <ListRow href={executionHref(projectId, item.id)} title={`${name.title ?? name.fallback}${name.note ? ` · ${name.note}` : ""}`}
                  meta={`智能体 ${item.id.slice(0, 8)} · ${permissionsText(item.sandbox, item.approvalPolicy)} · ${item.authorizationScope}`}
                  trailing={<StatusTag tone={sessionStateTone(item.state)} label={sessionStateText[item.state]} />} />
              </li>;
            })}</ul>
          </div>)}
        </PageSection>
        <PageSection title="编排与队列">
          <SectionBoundary label="编排"><Legacy><OrchestrationPanel key={`${projectId}:${context.principal.actorId}`} token={context.token} projectId={projectId}
            refresh={refresh + epoch} verifiedRuns={runsCurrent ? runs : null} runtimePoll={0} /></Legacy></SectionBoundary>
          <SectionBoundary label="队列"><Legacy><ResidentQueuePanel context={context} token={context.token} projectId={projectId} refresh={refresh + epoch} runs={runs} sessions={sessions} /></Legacy></SectionBoundary>
        </PageSection>
        <PageSection title="运行记录" description="收到通知、读取材料、采用判断与真实效果分别留证；原生完成状态不会自动关闭任务。">
          {runsRead.isPending ? <LoadingState lines={2} label="正在读取运行" />
            : <RunList context={context} runs={runs} readOnlySessions={readOnly} empty={runsCurrent ? "没有已登记运行。" : "运行列表未读回，无法判断。"} />}
        </PageSection>
      </>}
    <ContextPanelContent>
      <div className="flex flex-col gap-4">
        {selected && <PanelSection title="受管智能体">
          <FactList rows={[
            ["状态", sessionStateText[selected.state]],
            ["职责", <RoleLabel key="role" projectId={projectId} roleId={selected.roleId} name={nameOf(selected.roleId)} />],
            ["模型", selected.model ?? "未显式指定"],
            ["权限", permissionsText(selected.sandbox, selected.approvalPolicy)],
            ["所在机器", "未知（多机器方案落地前不记录）"],
            ["运行", runsCurrent ? `${runs.filter(run => run.sessionId === selected.id).length} 项已登记` : "运行列表未读回，无法判断"],
          ]} />
        </PanelSection>}
        <PanelSection title="执行服务">{serviceFacts}</PanelSection>
      </div>
    </ContextPanelContent>
  </div>;
}
