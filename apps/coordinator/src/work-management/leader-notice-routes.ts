import type { FastifyInstance } from "fastify";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";
import { leaderNoticeRecoverySchema } from "@evoloop/contracts/leader-notices";

export interface LeaderNoticeReader {
  list(projectId: string, query: { taskId?: string; limit: number; cursor?: string }): Promise<unknown>;
  get?(projectId: string, noticeId: string): Promise<unknown>;
  /** One packet with its attempts and every item's state and version (the version a decision must name). */
  packet?(projectId: string, packetId: string): Promise<unknown>;
  recover?(projectId: string, noticeId: string, input: z.infer<typeof leaderNoticeRecoverySchema>, actorId: string): Promise<unknown>;
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
  if (notices.get) app.get("/api/projects/:projectId/work-management/notices/:noticeId", async request => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const {projectId,noticeId}=z.strictObject({projectId:z.uuid(),noticeId:z.uuid()}).parse(request.params);
    await service.getProject(request.principal,projectId);
    return notices.get!(projectId,noticeId);
  });
  if (notices.packet) app.get("/api/projects/:projectId/leader-notice-packets/:packetId", async request => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const { projectId, packetId } = z.strictObject({ projectId: z.uuid(), packetId: z.uuid() }).parse(request.params);
    await service.getProject(request.principal, projectId);
    return notices.packet!(projectId, packetId);
  });
  if (notices.recover) app.post("/api/projects/:projectId/work-management/notices/:noticeId/recover", async request => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const { projectId, noticeId } = z.strictObject({projectId:z.uuid(),noticeId:z.uuid()}).parse(request.params);
    const who=request.principal;
    if (!who.permissions.includes("write") || !who.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "Project review permission is required for Leader notice recovery");
    await service.getProject(who, projectId);
    const input=leaderNoticeRecoverySchema.parse(request.body);
    return notices.recover!(projectId, noticeId, input, who.actorId);
  });
}
