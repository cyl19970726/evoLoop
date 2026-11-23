// Under a task's title: one "现在" line (where it is stuck, whom it waits on, for how long, why; the latest acceptance)
// and one relation bar (阶段、来源、承接、交付、依据). Both only say what the existing judgments already say
// (currentStageText, workItemNextStep, timingDuration, the delivery and observation records); a fact that is not
// registered is said as not registered, never left out.
import { Fragment } from "react";
import type React from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { api } from "../../shared/api";
import { agentDisplayName } from "../../shared/agentNamePresentation";
import { readAgent } from "../../shared/agentRead";
import { actorText } from "../../shared/actorPresentation";
import { currentStageText } from "../../shared/leaderWorkLoad";
import { useProjectQuery } from "../../shared/query";
import { timingDuration, timingStageLabel, waitingParty } from "../../shared/taskTiming";
import { taskSectionHref } from "../../shared/taskNavigation";
import { date, href } from "../../shared/ui/shared";
import { workItemNextStep } from "../../shared/workPresentation";
import { sessionHref } from "../sessions";
import type { ReadState } from "./taskFactsPresentation";
import { assignmentKey } from "./taskFactsPresentation";
import { observationResultLabel } from "./observationPresentation";
import { taskOrigin } from "./taskOrigin";
import { useAssignment } from "./TaskRuntimeTab";
import { useTaskTiming } from "./TaskScheduleSection";

const link = "text-primary hover:underline";
const unregistered = "未登记";
/** The stored reason may already start with 不属于阶段 (a schedule's 例行 reason does): then it is the whole text, never wrapped a second time. */
const noStageText = (reason: string | null | undefined): string => {
  const text = reason?.trim();
  return !text ? "不属于阶段" : text.startsWith("不属于阶段") ? text : `不属于阶段（${text}）`;
};

type Props = {
  projectId: string; token: string; detail: TaskDetail; leader: LeaderWorkTask | null; leaderState: ReadState;
  actorId: string; linkForTab(tab: "basis" | "delivery"): string; openTab(tab: "basis" | "delivery"): void;
};

/** "现在" and the latest acceptance. A closed or cancelled task has no "now": it says when it ended. */
export function TaskNowLine({ detail, leader, leaderState, linkForTab, openTab }: Pick<Props, "detail" | "leader" | "leaderState" | "linkForTab" | "openTab">) {
  const state = detail.task.state;
  if (state === "done" || state === "cancelled")
    return <p className="text-body text-foreground" data-task-now="closed">{state === "done" ? "已关闭" : "已取消"} · {date(detail.revision.createdAt)}</p>;
  // The latest acceptance of the current (latest) delivery only: an older delivery's verdict says nothing about the one now waiting.
  const current = [...(detail.deliveries ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const observation = current ? [...(detail.observations ?? [])].filter(item => item.deliveryId === current.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) : undefined;
  const timing = leader?.timing;
  const now = leaderState === "loading" || leaderState === "checking" ? "正在核对…"
    : leaderState === "failed" ? "暂无法判断"
      : !leader || !timing ? "当前工作安排未登记"
        : <>
          {currentStageText(timing.current.stage, leader.phase, timingStageLabel[timing.current.stage] ?? "阶段未知")}
          {" · "}等{waitingParty(timing.current.waitingFor)}
          {" · "}已 {timingDuration(timing.current.elapsedMs)}
          {" · "}{workItemNextStep(leader)}
        </>;
  return <p className="text-body leading-(--leading-body) text-foreground [overflow-wrap:anywhere]" data-task-now="open">
    <span data-task-now-text="">现在：{now}</span>
    <span className="text-text-secondary"> · </span>
    <span data-task-latest-acceptance={observation?.result ?? "none"}>
      {observation
        ? <a className={link} href={linkForTab("delivery")} onClick={event => { event.preventDefault(); openTab("delivery"); }}>
          最新验收：{observationResultLabel[observation.result]} · {actorText(observation.observer)} · {date(observation.createdAt)}</a>
        : <>最新验收：还没有验收结论</>}
    </span>
  </p>;
}

/** 阶段 · 来源 · 承接 · 交付 · 依据 — always these five, in this order, each a name and a link or its absence. */
export function TaskRelationBar({ projectId, token, detail, leader, actorId, linkForTab, openTab }: Props) {
  const task = detail.task;
  const originRead = useProjectQuery(projectId, ["tasks", "origin", task.id], () => api(token).taskOrigin(projectId, task.id));
  const origin = { ...originRead, data: typeof originRead.data?.scheduleId === "string" ? originRead.data : null };
  const timing = useTaskTiming(projectId, task.id);
  const assignment = useAssignment(projectId, task.id);
  // A read that is not the shape of an assignment says nothing (never a thrown render).
  const key = assignment.data && assignment.data.state !== "released" ? assignmentKey(assignment.data) : null;
  const agent = useProjectQuery(projectId, ["session-names", key], signal => readAgent(projectId, key!, signal), { enabled: !!key });
  const from = taskOrigin(projectId, task, actorId);

  const ownership = leader?.stageOwnership;
  const stage = ownership?.state === "stage" && leader?.stage
    ? <a className={link} href={`${href(projectId, "journey")}?stage=${encodeURIComponent(leader.stage.stageId)}`}>{leader.stage.shortName}</a>
    : ownership?.state === "none" ? <span title={ownership.reason ?? undefined}>{noStageText(ownership.reason)}</span>
      : ownership ? "未归属" : unregistered;

  const previous = typeof timing.data?.previousTaskId === "string" ? timing.data.previousTaskId : null;
  const source = origin.data
    ? <>日程 <a className={link} href={`${href(projectId, "schedules")}?${new URLSearchParams({ schedule: origin.data.scheduleId })}`}>{origin.data.scheduleName || "（未命名日程）"}</a></>
    : previous ? <a className={link} href={taskSectionHref(projectId, previous)}>系列的上一份</a>
      : origin.error ? "来源暂无法读取" : unregistered;

  const taking = key
    ? <a className={link} href={sessionHref(projectId, key, from)}>{agent.data ? agentDisplayName(agent.data) : agent.error ? "智能体（名称暂不可读）" : "智能体（读取名称…）"}</a>
    : assignment.error ? "承接暂无法读取" : unregistered;

  const deliveries = detail.deliveries ?? [];
  const latest = [...deliveries].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const result = latest ? (detail.observations ?? []).filter(item => item.deliveryId === latest.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) : undefined;
  const delivery = latest
    ? <a className={link} href={linkForTab("delivery")} onClick={event => { event.preventDefault(); openTab("delivery"); }}>
      第 {deliveries.length} 份交付 · {date(latest.createdAt)} · {result ? observationResultLabel[result.result] : "待验收"}</a>
    : "还没有交付";

  const members = detail.basis?.members.length ?? 0;
  const basis = members > 0
    ? <a className={link} href={linkForTab("basis")} onClick={event => { event.preventDefault(); openTab("basis"); }}>固定依据 {members} 份</a>
    : unregistered;

  const items: [string, string, React.ReactNode][] = [["stage", "阶段", stage], ["source", "来源", source], ["agent", "承接", taking], ["delivery", "交付", delivery], ["basis", "依据", basis]];
  return <p className="text-label leading-(--leading-body) text-text-secondary [overflow-wrap:anywhere]" data-task-relations="">
    {items.map(([id, label, value], index) => <Fragment key={id}>
      {index > 0 && " · "}<span data-relation={id}>{label} {value}</span>
    </Fragment>)}
  </p>;
}
