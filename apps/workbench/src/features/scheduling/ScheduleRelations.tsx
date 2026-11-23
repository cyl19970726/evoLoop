// The relation bar under a schedule's title (docs/frontend/pages/schedules.md 关系条): 职责 · 承接 · 上一次 · 下次 · 健康, always these five.
// 职责 replaces the old "责任 〈职责名〉" sentence. 上一次, 下次 and 健康 are what 例行健康 says for this schedule (the page's own read);
// 承接 is the dispatch policy and the log the page already reads for 派发方式.
import type { RoutineHealthItem } from "@evoloop/contracts/routine-health";
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import { agentDisplayName } from "../../shared/agentNamePresentation";
import { readAgent } from "../../shared/agentRead";
import { useProjectQuery } from "../../shared/query";
import { RelationBar, cut, link, readFailed, unregistered } from "../../shared/ui/RelationBar";
import { RoleName } from "../../shared/ui/RecordName";
import { href, roleHref } from "../../shared/routes";
import { sessionHref } from "../sessions";
import { taskStateLabel } from "../workflow";
import type { ScheduleDispatchRead } from "./ScheduleDispatch";
import { lastTriggerView, nextText } from "./routineHealth";

export type HealthRead = { status: "loading" } | { status: "failed" } | { status: "ready"; item: RoutineHealthItem | null };

export function ScheduleRelations({ projectId, definition, health, dispatch, taskHref, onHealth }: {
  projectId: string; definition: ScheduleDefinition; health: HealthRead;
  dispatch: { data?: ScheduleDispatchRead; isPending: boolean; isError: boolean };
  taskHref(taskId: string): string; onHealth(): void;
}) {
  const owner = definition.revision.template.owner;
  const logged = [...(dispatch.data?.logs ?? [])].filter(item => item.sessionId).sort((a, b) => a.plannedAtUtc.localeCompare(b.plannedAtUtc)).at(-1);
  const key = logged?.sessionId ? `owned:${logged.sessionId}` : null;
  const agent = useProjectQuery(projectId, ["session-names", key], signal => readAgent(projectId, key!, signal), { enabled: !!key && dispatch.data?.policy?.mode === "direct" });

  const role = <a className={link} href={roleHref(projectId, owner)}><RoleName projectId={projectId} roleId={owner} /></a>;
  const policy = dispatch.data?.policy;
  const taking = !dispatch.data ? (dispatch.isError ? readFailed : "正在读取…")
    : policy?.mode === "direct"
      ? <>直派 {key ? <a className={link} href={sessionHref(projectId, key)}>{agent.data ? agentDisplayName(agent.data) : agent.isError ? "智能体（名称暂不可读）" : "智能体（读取名称…）"}</a> : "（还没有派出过）"}</>
      : "由 Leader 分派";

  const item = health.status === "ready" ? health.item : null;
  const absent = health.status === "failed" ? readFailed : health.status === "loading" ? "正在读取…" : !item ? unregistered : null;
  const last = item ? lastTriggerView(item) : null;
  const previous = absent ?? (!last ? unregistered : last.kind === "none" ? last.text
    : last.kind === "skipped" ? `${last.at} · 跳过`
      : <>{last.at} · <a className={link} href={taskHref(last.task.taskId)}>{cut(last.task.title, 20)}</a> · {last.queued ? "排队中" : taskStateLabel[last.task.state as keyof typeof taskStateLabel] ?? last.task.state}</>);
  const next = absent ?? (item!.state === "stopped" ? "已停用" : item!.state === "paused" ? "已暂停" : nextText(item!));
  const failures = policy?.consecutiveFailures ?? 0;
  const healthy = absent ?? (item!.consecutiveSkips > 0 ? `连续跳过 ${item!.consecutiveSkips} 次` : failures > 0 ? `连续失败 ${failures} 次` : item!.overdue ? "应触发而没有记录" : "正常");
  return <RelationBar kind="schedule" label="这条日程连着什么" items={[
    { id: "role", label: "职责", value: role }, { id: "taking", label: "承接", value: taking },
    { id: "last", label: "上一次", value: previous }, { id: "next", label: "下次", value: next },
    { id: "health", label: "健康", value: absent ? healthy : <a className={link} href={href(projectId, "schedules")} onClick={event => { event.preventDefault(); onHealth(); }}>{healthy}</a> },
  ]} />;
}
