// 对账摘要 and 阶段与验收容量 under the table view (tasks.md 表格视图): phase counts with the next responsibility,
// the project-wide list of open work, and which agents can still take acceptance work.
import { useQueries } from "@tanstack/react-query";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { AcceptanceOverviewView } from "@evoloop/contracts/acceptance-relay";
import { Badge, CollapsibleRow, StatusTag } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import { leaderSessionDisplayName, leaderWorkItemPresentation, loadLeaderWorkStatuses } from "../../shared/leaderWorkLoad";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { readAgent } from "./agentRead";
import { phaseOrder, phaseStatus } from "../../shared/taskStatus";
import { timingDate, timingDuration, timingStageLabel } from "../../shared/taskTiming";
import { href } from "../../shared/ui/shared";
import type { WorkTaskStatus } from "../../shared/workStatusPresentation";
import { sessionHref } from "../sessions";
import { nameOnly, workNextStep, type NameRead } from "../../shared/workPresentation";

/** Phase counts across the project's open work, in the order that needs a decision first. */
export function PhaseCounts({ counts, label = "对账阶段计数" }: { counts: Record<string, number> | undefined; label?: string }) {
  if (!counts) return null;
  const shown = phaseOrder.filter(phase => counts[phase]);
  return <div className="flex flex-wrap items-center gap-1.5" aria-label={label}>
    {shown.map(phase => <StatusTag key={phase} tone={phaseStatus[phase].tone} label={phaseStatus[phase].label} detail={String(counts[phase])} />)}
    {!!counts.review_acknowledged && <Badge>统筹已核对 {counts.review_acknowledged}</Badge>}
    {!!counts.review_deferred && <Badge>统筹已暂缓 {counts.review_deferred}</Badge>}
    {!shown.length && <span className="text-label text-muted-foreground">当前没有未关闭的工作。</span>}
  </div>;
}

/** Display names of the agents named by rows: only a registered profile name counts; failures stay visible. */
export function useAgentNames(projectId: string, keys: readonly string[]) {
  const unique = [...new Set(keys)];
  const reads = useQueries({ queries: unique.map(key => ({
    queryKey: queryKeys.project(projectId, "session-names", key),
    queryFn: ({ signal }: { signal: AbortSignal }) => readAgent(projectId, key, signal),
    retry: false,
  })) });
  return Object.fromEntries(unique.map((key, index) => {
    const read = reads[index]!;
    return [key, read.error ? { name: null, problem: errorText(read.error) } : read.data
      ? { name: leaderSessionDisplayName(read.data), problem: leaderSessionDisplayName(read.data) ? null : "未登记名称" } : { name: null, problem: null }];
  })) as Record<string, { name: string | null; problem: string | null }>;
}

/** The project-wide reconciliation list: every open task in phase order, with its next action. */
export function LeaderOverview({ projectId, page, statuses, roleNames }: {
  projectId: string; page: LeaderWorkPage<LeaderWorkTask>; statuses: Record<string, WorkTaskStatus>; roleNames: Record<string, string | undefined>;
}) {
  // Rows the ordinary list has not loaded still need their source status before their title is trusted.
  const missing = page.items.map(item => item.taskId).filter(id => !statuses[id]);
  const extra = useProjectQuery(projectId, ["tasks", "leader-row-status", missing.join(",")], () =>
    loadLeaderWorkStatuses(missing, async ids => (await api().workStatuses(projectId, ids)).items), { enabled: missing.length > 0 });
  const allStatuses = { ...statuses, ...Object.fromEntries((extra.data?.statuses ?? []).map(status => [status.taskId, status])) };
  const keys = page.items.map(item => item.responsible.kind === "session" && item.responsible.id
    ? `${item.assignment?.targetKind === "external" ? "external" : "owned"}:${item.responsible.id}` : null).filter((key): key is string => !!key);
  const names = useAgentNames(projectId, keys);
  const visible = [...page.items].sort((a, b) => phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase));
  const unnamed = Object.values(names).filter(value => value.problem && value.problem !== "未登记名称").length;
  return <section aria-label="全项目统筹对账" data-leader-overview="" className="flex flex-col gap-3">
    <p className="text-caption text-muted-foreground">{page.observedAt ? `读于 ${new Date(page.observedAt).toLocaleString("zh-CN")}` : "尚未读回"} · 变更序号 {page.changeSequence}
      {page.partial ? " · 服务只返回了部分工作，结果不完整" : ""}{page.nextCursor ? ` · 只读到前 ${page.items.length} 项（共 ${page.total} 项）` : ""}</p>
    {extra.isFetching && <p role="status" className="text-caption text-muted-foreground">正在核对统筹行的来源与责任名称…</p>}
    {extra.error && <p role="status" className="text-caption text-muted-foreground">统筹行来源状态暂不可读：{errorText(extra.error)}。未读回的行只显示待核对。</p>}
    {!!extra.data?.missing.length && <p role="status" className="text-caption text-muted-foreground">统筹行来源状态仅读回 {extra.data.statuses.length}/{missing.length} 项；未读回的行不用原始标题推定来源。</p>}
    {unnamed > 0 && <p role="status" className="text-caption text-muted-foreground">{unnamed} 个智能体的名称暂不可读；名称待核对，入口仍保留。</p>}
    {visible.length ? <ol className="flex flex-col divide-y divide-border">{visible.map(item => {
      const key = item.responsible.kind === "session" && item.responsible.id
        ? `${item.assignment?.targetKind === "external" ? "external" : "owned"}:${item.responsible.id}` : null;
      const presentation = leaderWorkItemPresentation(item, allStatuses[item.taskId],
        item.responsible.kind === "role" ? roleNames[item.responsible.id ?? ""] : undefined,
        key ? names[key]?.name ?? (names[key]?.problem === "未登记名称" ? "未登记名称" : undefined) : undefined);
      const status = phaseStatus[item.phase];
      return <li key={item.taskId} className="flex flex-col gap-1 py-2.5">
        <div className="flex flex-wrap items-center gap-2"><StatusTag tone={status.tone} label={status.label} />
          <a className="font-medium text-foreground hover:underline" href={href(projectId, "task", item.taskId)}>{presentation.title}</a>
          <span className="ml-auto text-caption text-muted-foreground">第 {item.version} 版</span></div>
        <p className="text-label text-text-secondary">{workNextStep(item.phase)}</p>
        <p className="text-caption text-muted-foreground">{presentation.responsibility}
          {key && <> · <a className="text-primary hover:underline" href={sessionHref(projectId, key)}>打开智能体</a></>}
          {item.plan?.priority ? ` · P${item.plan.priority}` : ""}{item.dependencies.length ? ` · ${item.dependencies.length} 项依赖` : ""}
          {item.plan?.dueAt ? ` · 截止 ${new Date(item.plan.dueAt).toLocaleString("zh-CN")}` : " · 截止未设置"}</p>
        <p className="text-caption text-muted-foreground">创建 {timingDate(item.timing?.createdAt)} · 当前阶段 {item.timing ? timingStageLabel[item.timing.current.stage] : "未知"} · 已历时 {timingDuration(item.timing?.current.elapsedMs)}</p>
        {item.review && <p className="text-caption text-muted-foreground">统筹{item.review.decision === "deferred" ? "已暂缓" : "已核对"}：{item.review.reason} · {new Date(item.review.at).toLocaleString("zh-CN")}</p>}
      </li>;
    })}</ol> : <p className="text-label text-muted-foreground">当前没有未关闭的工作。</p>}
    <p className="text-caption text-muted-foreground">按当前任务版本、分派、运行、交付、使用记录、依据复核和依赖得出；运行结束不等于验收。</p>
  </section>;
}

/** Which agents can still take acceptance work. Idle is not the same as able to accept. */
export function CapacitySummary({ projectId, overview, error }: { projectId: string; overview: AcceptanceOverviewView | null | undefined; error: string }) {
  const capacity = Array.isArray(overview?.capacity) ? overview!.capacity : [];
  const names = useAgentNames(projectId, capacity.map(item => `owned:${item.sessionId}`));
  if (error) return <p role="status" className="text-label text-muted-foreground">容量暂未读回：{error}</p>;
  if (!overview) return <p role="status" className="text-label text-muted-foreground">正在读取阶段与容量…</p>;
  const ready = capacity.filter(item => item.readyForAcceptance).length;
  const idle = capacity.filter(item => item.persistedWorkIdle).length;
  const missing = capacity.filter(item => item.missingCapabilities.length > 0).length;
  return <section aria-label="阶段与验收容量" data-capacity="" className="flex flex-col gap-3">
    <h3 className="text-label font-semibold text-foreground">哪些阶段可以并行，谁还能接工作</h3>
    <PhaseCounts counts={overview.work?.counts} label="阶段计数" />
    <p className="text-label text-text-secondary">{capacity.length} 个智能体 · {ready} 个可接新验收 · {idle} 个已登记工作已清 · {missing} 个有能力缺项</p>
    {capacity.length ? <ul className="flex flex-col divide-y divide-border">{capacity.map(item => {
      const read = names[`owned:${item.sessionId}`];
      // While the name is being read nothing is concluded; an agent without a registered name shows its account.
      const nameRead: NameRead = read?.name ? { state: "named", name: read.name } : read?.problem === "未登记名称" ? { state: "unnamed" }
        : read?.problem ? { state: "failed" } : { state: "reading" };
      const name = nameOnly("智能体", nameRead);
      return <li key={item.sessionId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-label">
        <a className="font-medium text-foreground hover:underline" href={sessionHref(projectId, `owned:${item.sessionId}`)}>{item.isLeader ? "统筹" : name}</a>
        <span className="text-caption text-muted-foreground">{item.tenure === "temporary" ? "临时" : "常驻"} · {item.persistedWorkIdle ? "已登记工作已清" : "仍在工作"} · 验收 {item.openAcceptance} · 消息 {item.pendingMessages} · 队列 {item.queueEntries}</span>
        <span className="text-caption">{item.readyForAcceptance ? "可接验收" : item.missingCapabilities.length ? `缺：${item.missingCapabilities.join("、")}` : "不可接验收"}</span>
      </li>;
    })}</ul> : <p className="text-label text-muted-foreground">当前没有可读取的智能体。</p>}
    <p className="text-caption text-muted-foreground">容量只说明已登记的工作已清；执行配置和消息授权仍按缺项单独核对。这里不会自动创建授权。</p>
  </section>;
}

export function ReconciliationDetails({ projectId, page, statuses, roleNames, error }: {
  projectId: string; page: LeaderWorkPage<LeaderWorkTask> | null; statuses: Record<string, WorkTaskStatus>; roleNames: Record<string, string | undefined>; error: string;
}) {
  const overview = useProjectQuery(projectId, ["tasks", "acceptance-overview"], () => api().acceptanceOverview(projectId));
  return <div className="flex flex-col gap-4">
    <CapacitySummary projectId={projectId} overview={overview.data} error={overview.error ? errorText(overview.error) : ""} />
    {page ? <CollapsibleRow summary={`查看全项目统筹对账 · ${page.items.length} 项未关闭工作`}>
      <LeaderOverview projectId={projectId} page={page} statuses={statuses} roleNames={roleNames} />
    </CollapsibleRow> : error ? <p role="status" className="text-label text-muted-foreground">统筹对账暂未读回：{error}</p> : null}
  </div>;
}
