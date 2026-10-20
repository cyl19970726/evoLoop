import type { FastifyInstance } from "fastify";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";

export async function registerWorkManagementRoutes(app: FastifyInstance, service: WorkflowService) {
  const params = (value: unknown) => z.object({ projectId: z.uuid(), id: z.uuid().optional() }).parse(value);
  const principal = (request: { principal: import("@evoloop/contracts").Principal | null }) => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    return request.principal;
  };
  app.get("/api/projects/:projectId/roles", request => {
    const p = params(request.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.uuid().optional() }).parse(request.query);
    return service.listRoles(principal(request), p.projectId, q.limit, q.cursor);
  });
  const roleQueries = { revisions: service.listRoleRevisions.bind(service), reviews: service.listRoleReviews.bind(service),
    handoffs: service.listRoleHandoffs.bind(service), bindings: service.listRoleSessionBindings.bind(service) };
  for (const [path, query] of Object.entries(roleQueries)) {
    app.get(`/api/projects/:projectId/roles/:id/${path}`, request => { const p = params(request.params); return query(principal(request), p.projectId, p.id!); });
  }
  app.get("/api/projects/:projectId/schedules", request => service.listSchedules(principal(request), params(request.params).projectId));
  app.get("/api/projects/:projectId/schedules/:id/revisions", request => { const p = params(request.params); return service.listScheduleRevisions(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/schedules/:id/occurrences", request => { const p = params(request.params); return service.listScheduleOccurrences(principal(request), p.projectId, p.id!); });
}
