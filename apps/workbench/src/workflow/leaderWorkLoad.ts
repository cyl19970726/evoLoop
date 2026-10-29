import type {
  LeaderWorkDocument, LeaderWorkPage, LeaderWorkPhase, LeaderWorkTask,
} from "@evoloop/contracts/work-index";

export const leaderPhaseLabel: Record<LeaderWorkPhase, string> = {
  unknown: "结果未知", rework: "待返工", blocked: "受阻", awaiting_delivery: "待结果交付",
  awaiting_acceptance: "待验收", awaiting_assignment: "待接手", ready: "可开始",
  running: "运行中", unassigned: "未分派", closed: "已关闭", cancelled: "已取消",
};

export interface LeaderDocumentLoad {
  items: Map<string, LeaderWorkDocument>;
  complete: boolean;
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
