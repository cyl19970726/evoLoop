import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";
import {
  PgLeaderWorkWriter, readLeaderWorkChanges, readLeaderWorkIndex, type LeaderWorkQuery,
} from "@evoloop/adapter-postgres/work-index";
import type { LeaderWorkDependenciesCommand, LeaderWorkPlanCommand, LeaderWorkReviewCommand } from "@evoloop/contracts/work-index";

export interface LeaderWorkIndexReader {
  index(principal: Principal, projectId: string, query: LeaderWorkQuery): Promise<unknown>;
  changes(principal: Principal, projectId: string, limit: number, cursor?: string): Promise<unknown>;
  setPlan(principal: Principal, projectId: string, command: LeaderWorkPlanCommand): Promise<unknown>;
  setDependencies(principal: Principal, projectId: string, command: LeaderWorkDependenciesCommand): Promise<unknown>;
  setReview(principal: Principal, projectId: string, command: LeaderWorkReviewCommand): Promise<unknown>;
}

/** Read-only work discovery. Project and object authorization happens in the route. */
export function createLeaderWorkIndexReader(pool: Pool): LeaderWorkIndexReader {
  const writer = new PgLeaderWorkWriter(pool);
  return {
    index: (_principal, projectId, query) => readLeaderWorkIndex(pool, projectId, query),
    changes: (_principal, projectId, limit, cursor) => readLeaderWorkChanges(pool, projectId, limit, cursor),
    setPlan: (principal, projectId, command) => writer.setTaskPlan(principal, projectId, command),
    setDependencies: (principal, projectId, command) => writer.setTaskDependencies(principal, projectId, command),
    setReview: (principal, projectId, command) => writer.setTaskReview(principal, projectId, command),
  };
}
