import { z } from "zod";

/** A roadmap phase key as written in docs/roadmap.md: M0, M0.5, M1, … */
export const phaseKeySchema = z.string().regex(/^M[0-9]+(?:\.[0-9]+)?$/, "phase key looks like M1 or M0.5");

export type MilestoneStatus = "not_started" | "in_progress" | "partial" | "exited" | "reviewed";

export const milestoneStatusLabel: Record<MilestoneStatus, string> = {
  not_started: "未开始", in_progress: "进行中", partial: "部分成立", exited: "已退出", reviewed: "已回看（结论见阶段页）",
};

export interface MilestoneReview { adopted: string; rejected: string; gap: string; createdAt: string }

/**
 * `stage.review` / `stage.correct` require text in adopted, rejected and gap, so "nothing" can only be written as a word. A field that is just
 * one of these markers (alone, ignoring spaces and a closing full stop) counts as empty; a sentence that merely contains one does not.
 */
const NONE_MARKERS = new Set(["无", "没有", "暂无", "无缺口", "无拒绝", "无遗漏", "none", "nil", "n/a", "na", "-", "—", "–"]);
export function isNoneMarker(value: string): boolean {
  const text = value.trim().replace(/[。.]+$/, "").trim().toLowerCase();
  return text.length === 0 || NONE_MARKERS.has(text);
}

/**
 * A linked stage's milestone status, from the same fields the goals-and-stages page shows (its state and latest review).
 * `exited`: reviewed, something adopted, and neither a gap nor a rejection left. `partial`: something adopted and a gap or a rejection
 * remains. Any other reviewed stage is only 已回看: the conclusion is on the stage page, nothing is inferred from it.
 */
export function milestoneStatus(stage: { state: "proposed" | "active" | "reviewed" }, review: MilestoneReview | null): MilestoneStatus {
  if (stage.state === "proposed") return "not_started";
  if (stage.state === "active") return "in_progress";
  const filled = (value: string | undefined) => !!value && !isNoneMarker(value);
  if (review && filled(review.adopted)) return filled(review.gap) || filled(review.rejected) ? "partial" : "exited";
  return "reviewed";
}

/** What the server knows about a stage linked to a roadmap phase. */
export interface StagePhaseLink {
  stageId: string; goalId: string; phaseKey: string; state: "proposed" | "active" | "reviewed";
  review: MilestoneReview | null;
}

export interface MilestonePhase {
  id: string; title: string; deliver: string; exit: string;
  /** The linked stage's status; null when no stage is linked (or more than one is: then `linkedStages` says so and nothing is guessed). */
  status: MilestoneStatus | null; statusLabel: string | null;
  stage: { id: string; goalId: string } | null;
  linkedStages: number;
  /** The date of the linked stage's latest review (UTC); null when there is none. */
  reviewedAt: string | null;
}
export interface MilestonesView {
  source: { commit: string | null; roadmap: "read" | "unavailable" };
  phases: MilestonePhase[];
  /** The phase of the one linked stage that is active; null when none or more than one is (nothing is guessed). */
  currentPhaseId: string | null;
  currentNote: string | null;
}

export interface VersionInfo { commit: string | null; builtAt: string | null; startedAt: string }
