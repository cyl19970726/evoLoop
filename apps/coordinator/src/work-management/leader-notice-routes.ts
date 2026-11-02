import type { FastifyInstance } from "fastify";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";

export interface LeaderNoticeReader {
  list(projectId: string, query: { taskId?: string; limit: number; cursor?: string }): Promise<unknown>;
}

/** The notice read is a project fact, not a permit to dispatch a managed Leader. */
export function registerLeaderNoticeRoutes(app: FastifyInstance,
  service: { getProject(principal: Principal, projectId: string): Promise<unknown> },
  notices: LeaderNoticeReader): void {
  app.get("/api/projects/:projectId/work-management/notices", async request => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const { projectId } = z.object({ projectId: z.uuid() }).parse(request.params);
    const query = z.object({ taskId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(512).optional() }).parse(request.query);
    await service.getProject(request.principal, projectId);
    return notices.list(projectId, { limit: query.limit,
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}) });
  });
}
