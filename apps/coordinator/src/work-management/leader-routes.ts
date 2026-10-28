import type { FastifyInstance } from "fastify";
import type { Principal } from "@evoloop/contracts";
import {
  leaderWorkDependenciesCommandSchema, leaderWorkPlanCommandSchema, leaderWorkReviewCommandSchema,
} from "@evoloop/contracts/work-index";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";
import type { LeaderWorkIndexReader } from "./work-index.js";

export interface LeaderProjectReader {
  getProject(principal: Principal, projectId: string): Promise<unknown>;
}

export function registerLeaderWorkRoutes(app: FastifyInstance, service: LeaderProjectReader, workIndex: LeaderWorkIndexReader): void {
  const principal = (request: { principal: Principal | null }) => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    return request.principal;
  };
  const project = (value: unknown) => z.object({ projectId: z.uuid() }).parse(value);
  const task = (value: unknown) => z.object({ projectId: z.uuid(), taskId: z.uuid() }).parse(value);

  app.get("/api/projects/:projectId/work-management/index", async request => {
    const p = project(request.params), who = principal(request);
    const q = z.object({
      view: z.enum(["tasks", "documents"]).default("tasks"),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(500).optional(),
      includeClosed: z.enum(["true", "false"]).default("false"),
    }).parse(request.query);
    await service.getProject(who, p.projectId);
    return workIndex.index(who, p.projectId, {
      view: q.view, limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}), includeClosed: q.includeClosed === "true",
    });
  });

  app.get("/api/projects/:projectId/work-management/changes", async request => {
    const p = project(request.params), who = principal(request);
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(500).optional(),
    }).parse(request.query);
    await service.getProject(who, p.projectId);
    return workIndex.changes(who, p.projectId, q.limit, q.cursor);
  });

  app.get("/api/projects/:projectId/work-management/tasks/:taskId", async request => {
    const p = task(request.params), who = principal(request);
    await service.getProject(who, p.projectId);
    const item = await workIndex.task(who, p.projectId, p.taskId);
    if (!item) throw new DomainError("NOT_FOUND", "Task work projection is not available");
    return item;
  });

  app.put("/api/projects/:projectId/work-management/tasks/:taskId/plan", async request => {
    const p = task(request.params), who = principal(request);
    if (!who.permissions.includes("write") || !who.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "Project review permission is required for Leader planning");
    await service.getProject(who, p.projectId);
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    if ((body.projectId !== undefined && body.projectId !== p.projectId) ||
      (body.taskId !== undefined && body.taskId !== p.taskId))
      throw new DomainError("INVALID_COMMAND", "Body Task identity differs from the route");
    const command = leaderWorkPlanCommandSchema.parse({ ...body, projectId: p.projectId, taskId: p.taskId });
    return workIndex.setPlan(who, p.projectId, command);
  });

  app.put("/api/projects/:projectId/work-management/tasks/:taskId/dependencies", async request => {
    const p = task(request.params), who = principal(request);
    if (!who.permissions.includes("write") || !who.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "Project review permission is required for Leader planning");
    await service.getProject(who, p.projectId);
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    if ((body.projectId !== undefined && body.projectId !== p.projectId) ||
      (body.taskId !== undefined && body.taskId !== p.taskId))
      throw new DomainError("INVALID_COMMAND", "Body Task identity differs from the route");
    const command = leaderWorkDependenciesCommandSchema.parse({ ...body, projectId: p.projectId, taskId: p.taskId });
    return workIndex.setDependencies(who, p.projectId, command);
  });

  app.put("/api/projects/:projectId/work-management/tasks/:taskId/review", async request => {
    const p = task(request.params), who = principal(request);
    if (!who.permissions.includes("write") || !who.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "Project review permission is required for Leader review decisions");
    await service.getProject(who, p.projectId);
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    if ((body.projectId !== undefined && body.projectId !== p.projectId) ||
      (body.taskId !== undefined && body.taskId !== p.taskId))
      throw new DomainError("INVALID_COMMAND", "Body Task identity differs from the route");
    const command = leaderWorkReviewCommandSchema.parse({ ...body, projectId: p.projectId, taskId: p.taskId });
    return workIndex.setReview(who, p.projectId, command);
  });
}
