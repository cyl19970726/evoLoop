// The relation bar under a chosen stage's title (docs/frontend/pages/journey.md 关系条): 目标 · 到期 · 任务 · 交付 · 验证阶梯, always these five.
// Stages have no owner field, so there is no 负责人 item. Counts come from the stage projection (the same numbers the stage table shows).
import type { Goal } from "@evoloop/contracts";
import type { StageProjection } from "@evoloop/contracts/stage-projection";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { RelationBar, cut, link, readFailed, unregistered } from "../../shared/ui/RelationBar";
import { stageHref } from "../../shared/routes";
import { deliveryCounts, dueText } from "./stageRelationsModel";

export const stageTasksId = "stage-tasks";
export const ladderLevelId = (key: string) => `ladder-level-${key}`;

/** The same-page jump: the target is on this page, so the link scrolls to it and the address keeps naming the stage. */
const jump = (id: string) => (event: React.MouseEvent) => {
  const target = window.document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  target.scrollIntoView({ block: "start" });
};

export function StageRelations({ projectId, stageId, goal, projection, projectionState, tasks, workState }: {
  projectId: string; stageId: string; goal: Goal | undefined;
  projection: StageProjection | undefined; projectionState: "loading" | "failed" | "ready";
  tasks: LeaderWorkTask[] | null; workState: "loading" | "failed" | "ready";
}) {
  const own = projection?.stages.find(item => item.id === stageId);
  const waiting = "正在读取…";
  const projected = projectionState === "failed" && !projection ? readFailed : !projection ? waiting : !own ? unregistered : null;
  const goalItem = goal ? <a className={link} href={`/p/${projectId}/journey?goal=${encodeURIComponent(goal.id)}`}>{cut(goal.outcome, 20)}</a> : unregistered;
  const due = projected ?? (dueText(own!.dueOn, projection!.today) ?? unregistered);
  const counts = own?.tasks;
  const taskItem = projected ?? <a className={link} href={`${stageHref(projectId, stageId)}#${stageTasksId}`} onClick={jump(stageTasksId)}>
    进行中 {counts!.inProgress} · 受阻 {counts!.blocked} · 未开始 {counts!.notStarted} · 已关闭 {counts!.closed}</a>;
  const open = tasks && workState !== "failed" ? deliveryCounts(tasks) : null;
  const delivery = workState === "failed" && !tasks ? readFailed : !tasks || !open ? waiting
    : open.waiting + open.failed === 0 ? "没有等验收的交付"
      : [open.waiting ? `待验收 ${open.waiting} 项` : "", open.failed ? `使用失败 ${open.failed} 项` : ""].filter(Boolean).join(" · ");
  const keys = own?.ladderKeys ?? [];
  const ladder = projected ?? (keys.length
    ? <>补 {keys.map((key, index) => <span key={key}>{index > 0 && "、"}<a className={link} href={`${stageHref(projectId, stageId)}#${ladderLevelId(key)}`} onClick={jump(ladderLevelId(key))}>{key}</a></span>)}</>
    : unregistered);
  return <RelationBar kind="stage" label="这个阶段连着什么" items={[
    { id: "goal", label: "目标", value: goalItem }, { id: "due", label: "到期", value: due }, { id: "tasks", label: "任务", value: taskItem },
    { id: "delivery", label: "交付", value: delivery }, { id: "ladder", label: "验证阶梯", value: ladder },
  ]} />;
}
