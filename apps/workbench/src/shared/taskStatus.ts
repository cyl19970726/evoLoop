// Task states and reconciliation phases mapped onto the status tones of docs/frontend/foundations.md (状态的视觉表达).
// One mapping for every page: the task list, the task facts in the right column and the table view.
import type { TaskState } from "@evoloop/contracts";
import type { LeaderWorkPhase } from "@evoloop/contracts/work-index";
import type { StatusTone } from "@evoloop/ui";

export interface StatusPresentation { tone: StatusTone; label: string }

/** The four task states. */
export const taskStateStatus: Record<TaskState, StatusPresentation> = {
  todo: { tone: "idle", label: "待办" },
  in_progress: { tone: "progress", label: "进行中" },
  done: { tone: "done", label: "已完成" },
  cancelled: { tone: "history", label: "已取消" },
};

/** Reconciliation phases (对账阶段), two to four characters each. */
export const phaseStatus: Record<LeaderWorkPhase, StatusPresentation> = {
  unknown: { tone: "unknown", label: "结果未知" },
  rework: { tone: "blocked", label: "待返工" },
  blocked: { tone: "blocked", label: "受阻" },
  awaiting_delivery: { tone: "waiting", label: "待交付" },
  awaiting_acceptance: { tone: "waiting", label: "待验收" },
  awaiting_assignment: { tone: "waiting", label: "待接手" },
  ready: { tone: "idle", label: "可开始" },
  running: { tone: "progress", label: "运行中" },
  unassigned: { tone: "waiting", label: "未分派" },
  closed: { tone: "done", label: "已关闭" },
  cancelled: { tone: "history", label: "已取消" },
};

/** The order the reconciliation summary counts phases in: what needs a decision first. */
export const phaseOrder: readonly LeaderWorkPhase[] = [
  "unknown", "rework", "blocked", "awaiting_delivery", "awaiting_acceptance", "awaiting_assignment", "ready", "running", "unassigned",
];

/**
 * The one status a compact row shows: an open task with a current projection shows its phase (what happens next),
 * everything else its task state. A closed task never shows an old phase.
 */
export function rowStatus(state: TaskState, phase: LeaderWorkPhase | null | undefined): StatusPresentation {
  if (phase && (state === "todo" || state === "in_progress")) return phaseStatus[phase];
  return taskStateStatus[state];
}
