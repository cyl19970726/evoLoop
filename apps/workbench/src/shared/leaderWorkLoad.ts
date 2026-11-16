import type {
  LeaderWorkDocument, LeaderWorkPage, LeaderWorkPhase, LeaderWorkTask,
} from "@evoloop/contracts/work-index";
import { cognitionSummary, type WorkTaskStatus } from "./workStatusPresentation.js";
import { responsibleText } from "./workPresentation.js";

export const leaderPhaseLabel: Record<LeaderWorkPhase, string> = {
  unknown: "结果未知", rework: "待返工", blocked: "受阻", awaiting_delivery: "待结果交付",
  awaiting_acceptance: "待验收", awaiting_prerequisite: "等前置", awaiting_release: "等发布", awaiting_close: "等关闭", awaiting_assignment: "待接手", ready: "可开始",
  running: "运行中", unassigned: "未分派", closed: "已关闭", cancelled: "已取消",
};

export interface LeaderDocumentLoad {
  items: Map<string, LeaderWorkDocument>;
  complete: boolean;
}

export const leaderWorkStatusBatchSize = 50;

export async function loadLeaderWorkStatuses(
  taskIds: readonly string[],
  read: (ids: string[]) => Promise<WorkTaskStatus[]>,
): Promise<{ statuses: WorkTaskStatus[]; missing: string[] }> {
  const ids = [...new Set(taskIds)];
  const found = new Map<string, WorkTaskStatus>();
  for (let offset = 0; offset < ids.length; offset += leaderWorkStatusBatchSize) {
    const batch = ids.slice(offset, offset + leaderWorkStatusBatchSize);
    const allowed = new Set(batch);
    for (const status of await read(batch)) {
      if (!allowed.has(status.taskId)) throw new Error("Leader 行状态响应包含未请求的 Task");
      if (found.has(status.taskId)) throw new Error("Leader 行状态响应重复包含同一 Task");
      found.set(status.taskId, status);
    }
  }
  return { statuses: [...found.values()], missing: ids.filter(id => !found.has(id)) };
}

/**
 * A row's agent as “外部智能体 · 前端小王”. `name` is the agent pages' name (agentDisplayName); one made from a generated
 * title already says its role and kind (“功能开发 · 外部接入的智能体”, `describesKind`) and stands alone.
 */
function sessionText(item: LeaderWorkTask, name: string | undefined, describesKind: boolean): string {
  const shown = name?.trim();
  if (shown && describesKind) return shown;
  return `${item.assignment?.targetKind === "external" ? "外部智能体" : "智能体"} · ${shown || "名称待核对"}`;
}

const waitingTaskState: Record<string, string> = { todo: "待开始", in_progress: "进行中", done: "已完成", cancelled: "已取消" };
/**
 * Who a Task that already has a used conclusion waits for (defect b1f5d4c7): the Task to close first, the publisher, or whoever closes it. Said with the
 * concrete party the service named, never as an acceptance owed.
 */
export function usedWaitResponsibility(item: Pick<LeaderWorkTask, "phase" | "responsible" | "waitingTask">): string | null {
  if (item.phase === "awaiting_prerequisite")
    return item.waitingTask ? `前置任务 ${item.waitingTask.taskId.slice(0, 8)} · 当前${waitingTaskState[item.waitingTask.state] ?? "状态未读到"}` : "前置任务未登记";
  if (item.phase === "awaiting_release") return item.responsible.id ? `发布维护者 ${item.responsible.id}` : "发布责任者未登记";
  if (item.phase === "awaiting_close") return item.responsible.id ? `负责关闭 · ${item.responsible.id}` : "项目统筹 · 负责关闭";
  return null;
}

/**
 * The Task's current stage clock, in words. Its interval is still the one that began with the Delivery (the timing history is not rewritten), but once the declared
 * consumer has signed used, "等待验收" would contradict the phase on the same row, so it reads as the wait that is left.
 */
export function currentStageText(stage: string | undefined, phase: LeaderWorkPhase | null | undefined, plain: string): string {
  return stage === "awaiting_acceptance" && (phase === "awaiting_close" || phase === "awaiting_release" || phase === "awaiting_prerequisite")
    ? `验收已有结论，${leaderPhaseLabel[phase]}` : plain;
}

export function leaderWorkItemPresentation(
  item: LeaderWorkTask, status?: WorkTaskStatus, resolvedRoleTitle?: string, resolvedSessionTitle?: string, sessionNameDescribesKind = false,
): { title: string; responsibility: string } {
  if (status?.cognition)
    return {
      title: cognitionSummary(status).title,
      responsibility: "历史判断记录 · 原任务责任见原任务",
    };
  if (!status)
    return {
      title: "任务记录 · 来源状态待核对",
      responsibility: item.responsible.kind === "session" ? sessionText(item, resolvedSessionTitle, sessionNameDescribesKind) : "责任与来源待核对",
    };
  const roleTitle = item.responsible.kind === "role" && item.responsible.id ? resolvedRoleTitle?.trim() : null;
  const waiting = usedWaitResponsibility(item);
  return {
    title: item.title,
    responsibility: waiting ? waiting : item.responsible.kind === "session"
      ? sessionText(item, resolvedSessionTitle, sessionNameDescribesKind)
      : roleTitle ? `负责 ${roleTitle}` : responsibleText(item.responsible, item.assignment, { state: "reading" }),
  };
}

export function appendLeaderWorkPage<T extends { taskId: string }>(
  current: LeaderWorkPage<T>,
  next: LeaderWorkPage<T>,
): LeaderWorkPage<T> {
  if (next.changeSequence !== current.changeSequence)
    throw new Error("Leader 对账快照已变化，请从第一页重新读取");
  const seen = new Set(current.items.map(item => item.taskId));
  return { ...next, items: [...current.items, ...next.items.filter(item => !seen.has(item.taskId))] };
}

export function leaderProjectionMatchesTask(
  candidate: Pick<LeaderWorkTask, "taskId" | "version" | "currentRevisionId">,
  task: { id: string; version: number; currentRevisionId: string },
): boolean {
  return candidate.taskId === task.id && candidate.version === task.version &&
    candidate.currentRevisionId === task.currentRevisionId;
}

export function visibleLeaderDocuments<T extends {
  id: string; title: string; kind: string | null; status: "draft" | "published" | "archived";
}>(items: readonly T[], status: string, kind: string, query: string): T[] {
  const needle = query.toLowerCase();
  return items.filter(item => (status === "all" || (status === "active" ? item.status !== "archived" : item.status === status)) &&
    (kind === "all" || item.kind === kind) && `${item.title} ${item.id}`.toLowerCase().includes(needle));
}

/** Continue the lifecycle index until every currently rendered Document is covered. */
export async function loadLeaderDocumentsForIds(
  read: (cursor?: string) => Promise<LeaderWorkPage<LeaderWorkTask | LeaderWorkDocument>>,
  wantedIds: readonly string[],
): Promise<LeaderDocumentLoad> {
  const wanted = new Set(wantedIds), found = new Map<string, LeaderWorkDocument>(), seen = new Set<string>();
  if (!wanted.size) return { items: found, complete: true };
  let cursor: string | undefined;
  while (true) {
    const result = await read(cursor);
    for (const item of result.items) if (item.kind === "document") found.set(item.documentId, item);
    if ([...wanted].every(id => found.has(id))) return { items: found, complete: true };
    if (!result.nextCursor) return { items: found, complete: false };
    if (seen.has(result.nextCursor)) throw new Error("文档生命周期分页游标重复，无法确认覆盖完整性");
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}
