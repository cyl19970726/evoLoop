import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { isProjectMember, type Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { jumpBatchLimit } from "@evoloop/contracts/object-jump";
import { findJumpObjects, findJumpObjectsBatch } from "@evoloop/adapter-postgres/object-jump";

/** `GET /api/projects/:projectId/jump?q=` (Task 5eb93990): read only, project members only, the caller's project only. */
export function registerObjectJumpRoutes(app: FastifyInstance, service: WorkflowService, pool: Pool): void {
  app.get("/api/projects/:projectId/jump", async request => {
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    const { q } = z.strictObject({ q: z.string().max(200) }).parse(request.query);
    const principal: Principal | null = request.principal;
    if (!principal || !isProjectMember(principal, projectId)) throw new DomainError("FORBIDDEN", "Jumping to an object requires project membership");
    await service.getProject(principal, projectId);
    return findJumpObjects(pool, projectId, q);
  });
  /** `GET /api/projects/:projectId/jump/refs?q=a,b,c` (Task a910ee96): up to 50 candidates found in body text, answered one by one. */
  app.get("/api/projects/:projectId/jump/refs", async request => {
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    const { q } = z.strictObject({ q: z.string().min(1).max(jumpBatchLimit * 41) }).parse(request.query);
    const candidates = z.array(z.string().min(1).max(40)).min(1).max(jumpBatchLimit).parse(q.split(",").map(text => text.trim()).filter(Boolean));
    const principal: Principal | null = request.principal;
    if (!principal || !isProjectMember(principal, projectId)) throw new DomainError("FORBIDDEN", "Jumping to an object requires project membership");
    await service.getProject(principal, projectId);
    return findJumpObjectsBatch(pool, projectId, candidates);
  });
}
