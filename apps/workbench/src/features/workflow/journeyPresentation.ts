// 目标与阶段 (docs/frontend/pages/journey.md) in the page's own words: stage states, what a stage needs next, review
// choices, and which tasks belong to which stage. Pure, so the page and its tests agree. Task rows come from the work
// index, which names each task's stage from its latest proposal (the same fact the old page read task by task).
import type { Goal, Stage, StageReview } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { phaseOrder, type StatusPresentation } from "../../shared/taskStatus";

export const stageStatus: Record<Stage["state"], StatusPresentation> = {
  proposed: { tone: "waiting", label: "待接受" },
  active: { tone: "progress", label: "推进中" },
  reviewed: { tone: "done", label: "已回看" },
};

export const nextChoiceLabel: Record<StageReview["nextChoice"], string> = {
  continue: "继续当前工作", newTask: "提出后续任务", research: "补证再判断", stop: "停止并保留理由",
};

type StageTask = Pick<LeaderWorkTask, "phase" | "taskState">;
const isOpen = (task: Pick<LeaderWorkTask, "taskState">) => task.taskState === "todo" || task.taskState === "in_progress";

/**
 * What the stage needs next. `tasks` is null while the stage's tasks are unread; `complete` is false when the work index
 * was only partly read, so "no tasks yet" is never concluded from a partial read.
 */
export function stageNextStep(stage: Pick<Stage, "state">, tasks: readonly StageTask[] | null, complete = true): string {
  if (stage.state === "proposed") return "先判断是否接受这个阶段，接受后再建立所属任务。";
  if (stage.state === "reviewed") return "阶段已回看：阅读最新回看和后续选择；有新证据时追加纠正。";
  if (tasks === null || !tasks.length && !complete) return "所属任务尚未读全，暂不能判断下一步。";
  if (!tasks.length) return "明确交付与学习问题后，建立首项所属任务。";
  const open = tasks.filter(isOpen);
  const has = (...phases: LeaderWorkTask["phase"][]) => open.some(task => phases.includes(task.phase));
  if (has("unknown")) return "有任务上次执行的结果未知：先核对，不要重复派发。";
  if (has("awaiting_acceptance")) return "核对交付与实际使用，按验收条件决定能否关闭。";
  if (has("rework", "blocked")) return "先处理待返工或受阻的任务，再推进其他工作。";
  if (has("running", "awaiting_delivery")) return "继续执行，并登记可核对的交付。";
  if (open.length) return "核对任务正文与来源，安排承接后开始。";
  return "所属任务都已结束：核对交付与使用结果，再记录阶段回看。";
}

/** Open work first, in the order that needs a decision first; then closed, then cancelled. */
export function orderStageTasks<T extends Pick<LeaderWorkTask, "phase" | "taskState" | "dates">>(tasks: readonly T[]): T[] {
  const rank = (task: T) => isOpen(task) ? Math.max(0, phaseOrder.indexOf(task.phase)) : task.taskState === "done" ? 100 : 101;
  return [...tasks].sort((a, b) => rank(a) - rank(b) || Date.parse(b.dates.businessChangedAt) - Date.parse(a.dates.businessChangedAt));
}

export interface StageGroups<T> {
  byStage: Map<string, T[]>;
  /** Tasks with no stage, or a stage that is not among the stages read. */
  outside: T[];
}

/** Each read task under its stage. A task naming a stage that was not read counts as outside, never as that stage's. */
export function groupByStage<T extends Pick<LeaderWorkTask, "stage">>(tasks: readonly T[], stages: readonly Pick<Stage, "id">[]): StageGroups<T> {
  const known = new Set(stages.map(stage => stage.id));
  const byStage = new Map<string, T[]>();
  const outside: T[] = [];
  for (const task of tasks) {
    const id = task.stage?.stageId;
    if (id && known.has(id)) byStage.set(id, [...byStage.get(id) ?? [], task]);
    else outside.push(task);
  }
  return { byStage, outside };
}

/** "运行中 1 · 待验收 2 · 已关闭 3": the phases of a stage's tasks, in the order of the status table. */
export function phaseCounts(tasks: readonly StageTask[], label: (phase: LeaderWorkTask["phase"]) => string): string {
  const counts = new Map<LeaderWorkTask["phase"], number>();
  for (const task of tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
  const order: LeaderWorkTask["phase"][] = [...phaseOrder, "closed", "cancelled"];
  return order.filter(phase => counts.has(phase)).map(phase => `${label(phase)} ${counts.get(phase)}`).join(" · ");
}

/** Reviews oldest first, as the service records them; the last one is the current judgement. */
export function orderReviews(reviews: readonly StageReview[]): StageReview[] {
  return [...reviews].sort((a, b) => a.stageVersion - b.stageVersion || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** How one review stands: the latest is current only on a fresh read; earlier ones were replaced by later reviews. */
export function reviewStanding(review: Pick<StageReview, "id">, latestId: string | undefined, fresh: boolean): string {
  if (review.id !== latestId) return "已被后续回看替代";
  return fresh ? "当前判断" : "上次读回的判断";
}

/** The default selection: the first stage being worked on, else the first stage, else the first goal. */
export function defaultSelection(goals: readonly Pick<Goal, "id">[], stages: readonly Pick<Stage, "id" | "goalId" | "state">[]):
  { stageId: string } | { goalId: string } | null {
  const stage = stages.find(item => item.state === "active") ?? stages[0];
  if (stage) return { stageId: stage.id };
  return goals[0] ? { goalId: goals[0].id } : null;
}

/** Goals and their stages for the rail; stages whose goal was not read are listed apart. */
export function goalTree<G extends Pick<Goal, "id">, S extends Pick<Stage, "goalId">>(goals: readonly G[], stages: readonly S[]):
  { items: { goal: G; stages: S[] }[]; orphans: S[] } {
  const ids = new Set(goals.map(goal => goal.id));
  return {
    items: goals.map(goal => ({ goal, stages: stages.filter(stage => stage.goalId === goal.id) })),
    orphans: stages.filter(stage => !ids.has(stage.goalId)),
  };
}
