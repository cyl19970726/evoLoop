// What the 阶段 block (总览) and the 目标与阶段 table say, in the words of docs/frontend/milestones-design.md §4 and §5. Pure: the stage projection and
// the verification ladder go in, rows and sentences come out. Statuses are the service's `statusLabel`; nothing here derives a status, and a missing
// value is said as missing ("未定", "未登记", "还没有任务"), never as 0 or a verdict.
import type { StatusTone } from "@evoloop/ui";
import type { StageReview } from "@evoloop/contracts";
import type { LadderView } from "@evoloop/contracts/milestones";
import { taskBucket, type StageProjection, type StageProjectionStage, type StageProjectionTasks, type StageStatus } from "@evoloop/contracts/stage-projection";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";

export const NOT_SET = "未定";
export const NOT_REGISTERED = "未登记";
export const NO_REVIEW = "暂无回看";
export const NO_TASKS = "还没有任务";
export const NO_STAGES = "这个项目还没有阶段";
export const LADDER_UNREADABLE = "阶梯读不到";

/** The status table's tone for each of the seven words (and the one record-missing case). Reached words only ever come with a review. */
export const statusTone: Record<StageStatus, StatusTone> = {
  accepted_no_tasks: "idle", in_progress: "progress", overdue_awaiting_review: "waiting", achieved: "done",
  partially_achieved: "waiting", not_achieved: "blocked", not_accepted: "history", review_missing: "unknown",
};

/** 任务格: 进行 a · 卡住 b; 未开始 c; 已关闭 d; 还没有任务. */
export function taskCell(tasks: StageProjectionTasks): string {
  if (!tasks.total) return NO_TASKS;
  if (tasks.inProgress || tasks.blocked) return `进行 ${tasks.inProgress} · 卡住 ${tasks.blocked}`;
  if (tasks.notStarted) return `未开始 ${tasks.notStarted}`;
  return `已关闭 ${tasks.closed}`;
}

/** 到期日格: MM-DD (the full date is the title), 未定 when none. */
export function dueCell(dueOn: string | null): { text: string; title: string } {
  return dueOn ? { text: dueOn.slice(5), title: dueOn } : { text: NOT_SET, title: "这个阶段没有登记到期日" };
}

/** 怎样算到了: the registered text, or 未登记. */
export const checkCell = (checkMethod: string | null): string => checkMethod?.trim() ? checkMethod.trim() : NOT_REGISTERED;

/** The first non-empty line of a stage's text, without a leading "名称：" label (old stages wrote their name that way). */
export const firstLine = (text: string): string => (text.split("\n").map(line => line.trim()).find(Boolean) ?? "").replace(/^名称\s*[:：]\s*/, "");

/** The name in a row: the short name; an old stage without one falls back to the first line of its text, then to its id. */
export function stageName(stage: Pick<StageProjectionStage, "id" | "shortName">, deliverable?: string): string {
  return stage.shortName?.trim() || (deliverable ? firstLine(deliverable) : "") || stage.id.slice(0, 8);
}

/** A stage in a left-column list: its name and, always, its due date (the projection's own 未定 when none; nothing before the projection is read). */
export function stageLabel(known: Pick<StageProjectionStage, "id" | "shortName" | "dueOn"> | undefined, stage: { id: string; deliverable: string }): { name: string; due: { text: string; title: string } | null } {
  return { name: stageName(known ?? { id: stage.id, shortName: null }, stage.deliverable), due: known ? dueCell(known.dueOn) : null };
}

const byDue = (a: StageProjectionStage, b: StageProjectionStage) => a.dueOn && b.dueOn ? (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0) : a.dueOn ? -1 : b.dueOn ? 1 : 0;
export interface StageRows { main: StageProjectionStage[]; folded: StageProjectionStage[] }
/** Main table: the stages the service puts there, due date first (no due date after the ones that have one). The rest is the folded 已回看的阶段. */
export function stageRows(projection: StageProjection): StageRows {
  const main = projection.stages.filter(stage => stage.inMainTable).sort(byDue);
  return { main, folded: projection.stages.filter(stage => !stage.inMainTable) };
}

/** Only the stage the service names is current; the page never picks another from dates, statuses or position. */
export const isCurrent = (projection: StageProjection, stage: Pick<StageProjectionStage, "id">): boolean => projection.currentStageId === stage.id;

/** "已到期待回看" says which day it counted: "按 Asia/Tashkent 的 2026-12-03 算". */
export const overdueNote = (projection: Pick<StageProjection, "today" | "timeZone">): string => `按 ${projection.timeZone} 的 ${projection.today} 算`;

/** The line under the table: unassigned open Tasks (never shown as 0 when there are some), and the part of them that was read. */
export function unownedLine(unowned: number, read: { items: number; complete: boolean } | null): string {
  if (unowned > 0 && read && !read.complete) return `${unowned} 项未关闭任务未归属阶段（已读 ${read.items} 项，未读全）`;
  return unowned > 0 ? `${unowned} 项未关闭任务未归属阶段` : "没有未归属阶段的未关闭任务";
}

export interface LadderLine { key: string; name: string; status: string }
/** One line per level for the folded ladder row: the level's name and its status sentence; a level the roadmap has no status for says 未登记. */
export function ladderLines(ladder: LadderView): LadderLine[] {
  return ladder.levels.map(level => ({ key: level.key, name: level.name, status: level.status?.trim() || NOT_REGISTERED }));
}
/** The short mark of a level's status sentence for the folded row. Only the sentence's own first words are read; a sentence that says none of these is 见全文, never a guess. */
export interface LadderMark { key: string; tone: StatusTone; label: string; full: string }
export function ladderMark(status: string | null | undefined): { tone: StatusTone; label: string } {
  const text = status?.trim();
  if (!text) return { tone: "unknown", label: NOT_REGISTERED };
  if (/^(已完成|已有|已通过|已达成|已满足|已退出|完成|通过)/.test(text)) return { tone: "done", label: "已有" };
  if (/^(部分|有限|基本)/.test(text)) return { tone: "waiting", label: "部分" };
  if (/^(进行中|在做|试行)/.test(text)) return { tone: "progress", label: "进行中" };
  if (/^(未|没有|尚未|还没|暂无|待)/.test(text)) return { tone: "idle", label: "未有" };
  return { tone: "unknown", label: "见全文" };
}
export const ladderMarks = (ladder: LadderView): LadderMark[] => ladderLines(ladder).map(line => ({ key: line.key, ...ladderMark(line.status === NOT_REGISTERED ? null : line.status), full: line.status }));
/** "验证阶梯 · 6 级": the words at the left of the folded row. */
export const ladderHeading = (ladder: LadderView): string => `验证阶梯 · ${ladder.levels.length} 级`;

export type Bucket = ReturnType<typeof taskBucket>;
export const bucketLabel: Record<Bucket, string> = { inProgress: "进行", blocked: "卡住", notStarted: "未开始", closed: "已关闭" };
export const bucketOrder: Bucket[] = ["inProgress", "blocked", "notStarted", "closed"];
/** A stage's tasks from the work index, grouped as the task cell counts them. */
export function groupTasks<T extends Pick<LeaderWorkTask, "phase" | "taskState">>(tasks: readonly T[]): Array<{ bucket: Bucket; label: string; tasks: T[] }> {
  return bucketOrder.map(bucket => ({ bucket, label: bucketLabel[bucket], tasks: tasks.filter(task => taskBucket({ phase: task.phase, state: task.taskState }) === bucket) })).filter(group => group.tasks.length);
}

/** Open Tasks with no ownership record: the ones the unassigned area lists. A service older than the field gives none (nothing is guessed). */
export const isUnowned = (task: Pick<LeaderWorkTask, "taskState" | "stageOwnership">): boolean =>
  (task.taskState === "todo" || task.taskState === "in_progress") && task.stageOwnership?.state === "unassigned";

/** The four next choices a review records. */
export const nextChoiceLabel: Record<StageReview["nextChoice"], string> = {
  continue: "继续当前工作", newTask: "提出后续任务", research: "补证再判断", stop: "停止并保留理由",
};
