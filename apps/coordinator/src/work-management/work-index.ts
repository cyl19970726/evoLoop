import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";
import {
  PgLeaderWorkWriter, readLeaderWorkChanges, readLeaderWorkIndex, readLeaderWorkTask, type LeaderWorkQuery,
} from "@evoloop/adapter-postgres/work-index";
import type { LeaderWorkDependenciesCommand, LeaderWorkPlanCommand, LeaderWorkReviewCommand } from "@evoloop/contracts/work-index";

export interface LeaderWorkIndexReader {
  index(principal: Principal, projectId: string, query: LeaderWorkQuery): Promise<unknown>;
  /** Notice packets that stopped behind a closed recovery gate and wait for the Leader's `leader.notice.recover`. */
  blockedNoticePackets?(projectId: string): Promise<BlockedNoticePacket[]>;
  task(principal: Principal, projectId: string, taskId: string): Promise<unknown>;
  changes(principal: Principal, projectId: string, limit: number, cursor?: string): Promise<unknown>;
  setPlan(principal: Principal, projectId: string, command: LeaderWorkPlanCommand): Promise<unknown>;
  setDependencies(principal: Principal, projectId: string, command: LeaderWorkDependenciesCommand): Promise<unknown>;
  setReview(principal: Principal, projectId: string, command: LeaderWorkReviewCommand): Promise<unknown>;
}

export interface BlockedNoticePacket { packetId: string; sessionId: string; itemCount: number; blockedAt: string | null; hint: string }
export const BLOCKED_PACKET_HINT = "这包通知读到的那一轮失败，恢复门已关闭，包里的项被保留。先按 Session 恢复流程恢复恢复门，再执行 request leader.notice.recover --id <packetId> 恢复这一包；之后其中的项进入下一包，带“上一轮已读到过”标记。";

/** Read-only work discovery. Project and object authorization happens in the route. */
export function createLeaderWorkIndexReader(pool: Pool): LeaderWorkIndexReader {
  const writer = new PgLeaderWorkWriter(pool);
  return {
    index: (_principal, projectId, query) => readLeaderWorkIndex(pool, projectId, query),
    blockedNoticePackets: async projectId => (await pool.query(
      "SELECT packet_id,session_id,item_count,ended_at FROM leader_notice_packet WHERE project_id=$1 AND state='blocked' ORDER BY created_at LIMIT 50", [projectId])).rows
      .map(row => ({ packetId: row.packet_id, sessionId: row.session_id, itemCount: row.item_count, blockedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null, hint: BLOCKED_PACKET_HINT })),
    task: (_principal, projectId, taskId) => readLeaderWorkTask(pool, projectId, taskId),
    changes: (_principal, projectId, limit, cursor) => readLeaderWorkChanges(pool, projectId, limit, cursor),
    setPlan: (principal, projectId, command) => writer.setTaskPlan(principal, projectId, command),
    setDependencies: (principal, projectId, command) => writer.setTaskDependencies(principal, projectId, command),
    setReview: (principal, projectId, command) => writer.setTaskReview(principal, projectId, command),
  };
}
