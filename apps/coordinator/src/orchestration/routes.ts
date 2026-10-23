import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Principal, TaskDetail } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { orchestrationCommandSchema, type OrchestrationResult } from "@evoloop/contracts/orchestration";
import type { OrchestrationService } from "@evoloop/core/orchestration";

export interface OrchestrationRouteOptions {
  service: OrchestrationService;
  status?(): unknown;
  listTasks?(principal: Principal, projectId: string, loopId: string, limit: number, cursor?: string): Promise<{items: TaskDetail[]; nextCursor: string | null}>;
  taskContext?(principal: Principal, projectId: string, taskId: string, limit: number, cursor?: string): Promise<unknown>;
}
const params = z.record(z.string(), z.uuid());
const page = z.object({limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(200).optional()});
const principal = (value: Principal | null) => {
  if (!value) throw new DomainError("FORBIDDEN", "Authentication required");
  return value;
};
export const orchestrationApplied = (operationId: string, result: OrchestrationResult) => ({
  status: "applied" as const, operationId, entityId: result.entityId, version: result.version, replayed: result.replayed,
});
export function registerOrchestrationRoutes(app: FastifyInstance, options: OrchestrationRouteOptions): void {
  const service = options.service;
  app.post("/api/orchestration/commands", async request => {
    const command = orchestrationCommandSchema.parse(request.body);
    return orchestrationApplied(command.operationId, await service.execute(principal(request.principal), command));
  });
  app.get("/api/projects/:projectId/orchestration/status", async request => {
    const p = params.parse(request.params), who = principal(request.principal);
    await service.listLoops(who, p.projectId!, 1);
    return options.status?.() ?? {state: "disabled"};
  });
  app.get("/api/projects/:projectId/orchestration/loops", async request => {
    const p = params.parse(request.params), q = page.parse(request.query);
    return service.listLoops(principal(request.principal), p.projectId!, q.limit, q.cursor);
  });
  app.get("/api/projects/:projectId/orchestration/loops/:id", async (request, reply) => {
    const p = params.parse(request.params);
    return await service.getLoop(principal(request.principal), p.projectId!, p.id!) ?? reply.code(404).send({code: "NOT_FOUND"});
  });
  for (const kind of ["inbox", "dispatches", "submissions", "events", "sources"] as const) {
    app.get(`/api/projects/:projectId/orchestration/loops/:id/${kind}`, async request => {
      const p = params.parse(request.params), q = page.parse(request.query), who = principal(request.principal);
      const loop = await service.getLoop(who, p.projectId!, p.id!);
      if (!loop) throw new DomainError("NOT_FOUND", "Loop not found");
      if (kind === "inbox") return service.listInbox(who, p.projectId!, p.id!, q.limit, q.cursor);
      if (kind === "dispatches") return service.listDispatches(who, p.projectId!, p.id!, q.limit, q.cursor);
      if (kind === "submissions") return service.listSubmissions(who, p.projectId!, p.id!, q.limit, q.cursor);
      if (kind === "events") return service.listEvents(who, p.projectId!, p.id!, q.limit, q.cursor);
      return service.listSourceFacts(who, p.projectId!, p.id!, q.limit, q.cursor);
    });
  }
  if (options.listTasks) app.get("/api/projects/:projectId/orchestration/loops/:id/tasks", async request => {
    const p = params.parse(request.params), q = page.parse(request.query), who = principal(request.principal);
    if (!await service.getLoop(who, p.projectId!, p.id!)) throw new DomainError("NOT_FOUND", "Loop not found");
    return options.listTasks!(who, p.projectId!, p.id!, q.limit, q.cursor);
  });
  if (options.taskContext) app.get("/api/projects/:projectId/orchestration/tasks/:id/context", async request => {
    const p = params.parse(request.params), q = page.parse(request.query);
    return options.taskContext!(principal(request.principal), p.projectId!, p.id!, q.limit, q.cursor);
  });
  app.get("/api/projects/:projectId/orchestration/decisions/:id", async (request, reply) => {
    const p = params.parse(request.params);
    return await service.getDecision(principal(request.principal), p.projectId!, p.id!) ?? reply.code(404).send({code: "NOT_FOUND"});
  });
  for (const kind of ["inbox", "dispatches", "submissions"] as const) {
    app.get(`/api/projects/:projectId/orchestration/${kind}/:id`, async (request, reply) => {
      const p = params.parse(request.params), who = principal(request.principal);
      const result = kind === "inbox" ? await service.getInbox(who, p.projectId!, p.id!) : kind === "dispatches" ?
        await service.getDispatch(who, p.projectId!, p.id!) : await service.getSubmission(who, p.projectId!, p.id!);
      return result ?? reply.code(404).send({code: "NOT_FOUND"});
    });
  }
  app.get("/api/projects/:projectId/orchestration/operations/:id", async (request, reply) => {
    const p = params.parse(request.params), who = principal(request.principal);
    const operation = await service.getOperation(who, p.projectId!, p.id!);
    if (!operation) return reply.code(404).send({code: "OPERATION_NOT_FOUND", message: "No confirmed record yet; preserve the original intent."});
    return {...operation, result: orchestrationApplied(operation.id, operation.result)};
  });
}
