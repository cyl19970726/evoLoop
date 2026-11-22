// The read-only projection of a project's stages as milestones (`GET /api/projects/:id/stages/milestones`; design: docs/frontend/milestones-design.md §2 and §5).
// Pure: the stages, their milestone fields and reviews, and each Task's phase and stage ownership go in; the states, counts and the current stage come out.
// Nothing here reads the clock or the database, so the derivation can be checked on plain samples.
import { z } from "zod";
import { isNoneMarker } from "./milestones.js";
import type { Stage, StageMilestone, StageReview } from "./workflow.js";

/** The seven words of design §5, plus `review_missing` for a reviewed stage whose review record cannot be read (never guessed into a verdict). */
export type StageStatus =
  | "accepted_no_tasks" | "in_progress" | "overdue_awaiting_review" | "achieved" | "partially_achieved" | "not_achieved" | "not_accepted" | "review_missing";

export const stageStatusLabel: Record<StageStatus, string> = {
  accepted_no_tasks: "已接受还没有任务", in_progress: "进行中", overdue_awaiting_review: "已到期待回看", achieved: "达成",
  partially_achieved: "部分达成", not_achieved: "未达成", not_accepted: "未接受", review_missing: "已回看，记录缺失",
};

export function isValidTimeZone(name: string): boolean {
  try { new Intl.DateTimeFormat("en-CA", { timeZone: name }); return true; } catch { return false; }
}

/** `timeZone` is an IANA name; omitted means UTC. A name the runtime does not know is refused at the entrance. */
export const stageProjectionQuerySchema = z.object({
  timeZone: z.string().min(1).max(64).refine(isValidTimeZone, "timeZone is not an IANA time zone name").optional(),
}).strict();

/** The calendar day of an instant in a time zone, `YYYY-MM-DD`. */
export function dayIn(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

export interface StageProjectionReview { id: string; adopted: string; rejected: string; gap: string; nextChoice: StageReview["nextChoice"]; createdAt: string }
export interface StageProjectionTasks { inProgress: number; blocked: number; notStarted: number; closed: number; total: number }
export interface StageProjectionStage {
  id: string; goalId: string; shortName: string | null; dueOn: string | null; checkMethod: string | null; ladderKeys: string[];
  state: Stage["state"]; status: StageStatus; statusLabel: string; latestReview: StageProjectionReview | null; tasks: StageProjectionTasks;
  /** Main table: a short name is registered, and the stage is not reviewed (or was reviewed within 14 days). Others belong to the folded "已回看的阶段" area. */
  inMainTable: boolean;
}
export interface StageProjection {
  asOf: string; today: string; timeZone: string; stages: StageProjectionStage[];
  /** Open Tasks only: `unowned` has no ownership record; `declared` is explicitly "not part of any stage". Closed Tasks are in neither. */
  tasksNoStage: { unowned: number; declared: number };
  currentStageId: string | null; currentNote: string | null;
}

/** One Task as the projection needs it: its work-index phase and state, and its ownership row (undefined/null: no row). */
export interface StageProjectionTask { taskId: string; phase: string; state: string; link: { stageId: string | null } | null }
export interface StageProjectionInput {
  asOf: string; timeZone: string; stages: Stage[]; milestones: Map<string, StageMilestone>; reviews: Map<string, StageReview[]>; tasks: StageProjectionTask[];
}

const RECENT_REVIEW_DAYS = 14;
type Bucket = "inProgress" | "blocked" | "notStarted" | "closed";

/** Closed or cancelled work is `closed`; the work index's `blocked` phase is the Task page's 受阻; a todo Task has not started; the rest is under way. */
export function taskBucket(task: Pick<StageProjectionTask, "phase" | "state">): Bucket {
  if (task.phase === "closed" || task.phase === "cancelled" || task.state === "done" || task.state === "cancelled") return "closed";
  if (task.phase === "blocked") return "blocked";
  if (task.state === "todo") return "notStarted";
  return "inProgress";
}

/** The newest review that no later review corrects (`supersedesReviewId`). */
export function latestReviewOf(reviews: StageReview[]): StageReview | null {
  const corrected = new Set(reviews.map(review => review.supersedesReviewId).filter((id): id is string => !!id));
  const live = reviews.filter(review => !corrected.has(review.id));
  live.sort((a, b) => a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1);
  return live.at(-1) ?? null;
}

function statusOf(stage: Stage, review: StageReview | null, tasks: number, dueOn: string | null, today: string): StageStatus {
  if (stage.state === "proposed") return "not_accepted";
  if (stage.state === "reviewed") {
    if (!review) return "review_missing";
    const filled = (value: string) => !isNoneMarker(value);
    if (!filled(review.adopted)) return "not_achieved";
    return filled(review.gap) || filled(review.rejected) ? "partially_achieved" : "achieved";
  }
  if (tasks === 0) return "accepted_no_tasks";
  if (dueOn !== null && dueOn < today) return "overdue_awaiting_review";
  return "in_progress";
}

export function deriveStageProjection(input: StageProjectionInput): StageProjection {
  const today = dayIn(input.asOf, input.timeZone);
  const counts = new Map<string, StageProjectionTasks>();
  let unowned = 0, declared = 0;
  for (const task of input.tasks) {
    const bucket = taskBucket(task);
    if (task.link?.stageId) {
      const own = counts.get(task.link.stageId) ?? { inProgress: 0, blocked: 0, notStarted: 0, closed: 0, total: 0 };
      own[bucket] += 1; own.total += 1; counts.set(task.link.stageId, own);
    } else if (bucket !== "closed") {
      if (task.link) declared += 1; else unowned += 1;
    }
  }
  const recentSince = Date.parse(input.asOf) - RECENT_REVIEW_DAYS * 86_400_000;
  const rows = input.stages.map(stage => {
    const milestone = input.milestones.get(stage.id) ?? null;
    const review = latestReviewOf(input.reviews.get(stage.id) ?? []);
    const tasks = counts.get(stage.id) ?? { inProgress: 0, blocked: 0, notStarted: 0, closed: 0, total: 0 };
    const dueOn = milestone?.dueOn ?? null;
    const status = statusOf(stage, review, tasks.total, dueOn, today);
    const shortName = milestone?.shortName ?? null;
    const projected: StageProjectionStage = {
      id: stage.id, goalId: stage.goalId, shortName, dueOn, checkMethod: milestone?.checkMethod ?? null, ladderKeys: milestone?.ladderKeys ?? [],
      state: stage.state, status, statusLabel: stageStatusLabel[status],
      latestReview: review ? { id: review.id, adopted: review.adopted, rejected: review.rejected, gap: review.gap, nextChoice: review.nextChoice, createdAt: review.createdAt } : null,
      tasks,
      inMainTable: shortName !== null && (stage.state !== "reviewed" || (!!review && Date.parse(review.createdAt) >= recentSince)),
    };
    return { projected, createdAt: stage.createdAt };
  });
  // The current stage: accepted, not reviewed, earliest due date; the same date takes the stage created first. It does not look at today: an overdue stage
  // with no review stays current. A stage with no due date does not take part in the comparison.
  const open = rows.filter(row => row.projected.state === "active");
  const dated = open.filter(row => row.projected.dueOn !== null)
    .sort((a, b) => a.projected.dueOn! < b.projected.dueOn! ? -1 : a.projected.dueOn! > b.projected.dueOn! ? 1
      : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.projected.id < b.projected.id ? -1 : 1);
  const currentStageId = dated[0]?.projected.id ?? null;
  const currentNote = currentStageId ? null : open.length ? "当前阶段未登记" : "没有已接受且未回看的阶段";
  rows.sort((a, b) => (a.projected.dueOn ?? "9999-12-31") < (b.projected.dueOn ?? "9999-12-31") ? -1 : (a.projected.dueOn ?? "9999-12-31") > (b.projected.dueOn ?? "9999-12-31") ? 1
    : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.projected.id < b.projected.id ? -1 : 1);
  return { asOf: input.asOf, today, timeZone: input.timeZone, stages: rows.map(row => row.projected), tasksNoStage: { unowned, declared }, currentStageId, currentNote };
}
