import type { FastifyInstance } from "fastify";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";
import { initialRoleTemplates } from "@evoloop/contracts/roles";

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
  app.get("/api/projects/:projectId/roles/:id", request => { const p = params(request.params); return service.getRole(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/roles/:id/revisions/:revisionId", request => {
    const p=z.strictObject({projectId:z.uuid(),id:z.uuid(),revisionId:z.uuid()}).parse(request.params);
    return service.getRoleRevision(principal(request),p.projectId,p.id,p.revisionId);
  });
  app.get("/api/projects/:projectId/role-templates", request => {
    const p = params(request.params);
    return service.listRoles(principal(request), p.projectId, 100).then(roles => ({
      templates: initialRoleTemplates.map(template => {
        const matches = roles.items.filter(role => role.proposal.templateKey === template.key &&
          role.proposal.roleClass === template.roleClass && ["trial","active"].includes(role.state));
        return { ...template, state: matches.length ? "established" as const : roles.nextCursor ? "unknown" as const : "not-established" as const,
          roleIds: matches.map(role => role.id) };
      }),
      roles: roles.items, nextCursor: roles.nextCursor,
    }));
  });
  app.get("/api/projects/:projectId/domains", request => service.listBusinessDomains(principal(request), params(request.params).projectId));
  app.get("/api/projects/:projectId/domains/:id", request => { const p = params(request.params); return service.getBusinessDomain(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/domains/:id/revisions", request => { const p = params(request.params); return service.listBusinessDomainRevisions(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/domains/:id/route", request => { const p = params(request.params); return service.getDomainRoute(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/roles/:id/hosts", request => { const p = params(request.params); return service.listHostLinks(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/hosts/:id", request => { const p = params(request.params); return service.getHostLink(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/hosts/:id/revisions", request => { const p = params(request.params); return service.listHostLinkRevisions(principal(request), p.projectId, p.id!); });
  const roleQueries = { revisions: service.listRoleRevisions.bind(service), reviews: service.listRoleReviews.bind(service),
    handoffs: service.listRoleHandoffs.bind(service), bindings: service.listRoleSessionBindings.bind(service) };
  for (const [path, query] of Object.entries(roleQueries)) {
    app.get(`/api/projects/:projectId/roles/:id/${path}`, request => { const p = params(request.params); return query(principal(request), p.projectId, p.id!); });
  }
  app.get("/api/projects/:projectId/schedules", request => service.listSchedules(principal(request), params(request.params).projectId));
  app.get("/api/projects/:projectId/resident-queues", request => service.listResidentQueues(principal(request),params(request.params).projectId));
  app.get("/api/projects/:projectId/resident-queues/:id", request => {const p=params(request.params);return service.getResidentQueue(principal(request),p.projectId,p.id!);});
  app.get("/api/projects/:projectId/resident-queues/:id/attempts", async request => {
    const p=params(request.params),who=principal(request);
    const queue=await service.getResidentQueue(who,p.projectId,p.id!);
    return Promise.all(queue.entries.map(async entry=>({entryId:entry.id,claimId:entry.claimId,
      attempts:entry.claimId?await service.listResidentQueueAttempts(who,p.projectId,entry.claimId):[]})));
  });
  app.get("/api/projects/:projectId/schedules/:id/revisions", request => { const p = params(request.params); return service.listScheduleRevisions(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/schedules/:id/occurrences", request => { const p = params(request.params); return service.listScheduleOccurrences(principal(request), p.projectId, p.id!); });
  app.get("/api/projects/:projectId/documents/:id/tasks", request => {
    const p = params(request.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.uuid().optional() }).parse(request.query);
    return service.listDocumentTaskReferences(principal(request), p.projectId, p.id!, q.limit, q.cursor);
  });
}
