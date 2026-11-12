import type { FastifyInstance } from "fastify";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";
import { leaderNoticeRecoverySchema, type LeaderEventRecordKind } from "@evoloop/contracts/leader-notices";
import { leaderNoticePacketRecoverySchema } from "@evoloop/contracts/leader-notice-packets";

export interface LeaderNoticeReader {
  list(projectId: string, query: { taskId?: string; limit: number; cursor?: string }): Promise<unknown>;
  get?(projectId: string, noticeId: string): Promise<unknown>;
  /** One packet with its attempts and every item's state and version (the version a decision must name). */
  packet?(projectId: string, packetId: string): Promise<unknown>;
  /** Recover one blocked packet (the Leader's decision, needs review authority); its items return to the next packet. */
  recoverPacket?(principal: Principal, projectId: string, packetId: string, reason: string): Promise<unknown>;
  recover?(projectId: string, noticeId: string, input: z.infer<typeof leaderNoticeRecoverySchema>, actorId: string): Promise<unknown>;
  /** Events that are only recorded (W5 level "record only"): a Run stopped on request, a resolved attention item, a withdrawn notice. Oldest first. */
  records?(projectId: string, query: { taskId?: string; kind?: LeaderEventRecordKind; limit: number; cursor?: string }): Promise<unknown>;
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
  if (notices.records) app.get("/api/projects/:projectId/leader-records", async request => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const { projectId } = z.object({ projectId: z.uuid() }).parse(request.params);
    const query = z.strictObject({ taskId: z.uuid().optional(), kind: z.enum(["run_stopped", "attention_resolved", "notice_withdrawn"]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().min(1).max(512).optional() }).parse(request.query);
    await service.getProject(request.principal, projectId);
    return notices.records!(projectId, { limit: query.limit, ...(query.taskId ? { taskId: query.taskId } : {}), ...(query.kind ? { kind: query.kind } : {}),
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
  if (notices.recoverPacket) app.post("/api/projects/:projectId/leader-notice-packets/:packetId/recover", async request => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const { projectId, packetId } = z.strictObject({ projectId: z.uuid(), packetId: z.uuid() }).parse(request.params);
    const who = request.principal;
    if (!who.permissions.includes("write") || !who.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "Project review permission is required for Leader notice packet recovery");
    await service.getProject(who, projectId);
    return notices.recoverPacket!(who, projectId, packetId, leaderNoticePacketRecoverySchema.parse(request.body).reason);
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
