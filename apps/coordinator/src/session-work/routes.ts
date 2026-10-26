import type { FastifyInstance } from "fastify";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";
import type { SessionObservationService } from "@evoloop/core/session-observation";
import type { ObservedSession } from "@evoloop/contracts/session-observation";

const id = z.uuid();
const key = z.string().min(1).max(128).regex(/^(owned|external):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const cursor = z.string().min(1).max(4096);
const limit50 = z.coerce.number().int().min(1).max(50).default(50);
const limit100 = z.coerce.number().int().min(1).max(100).default(100);
const versionCursor = z.string().regex(/^[1-9][0-9]{0,9}$/);
const principalOf = (request: { principal: Principal | null }): Principal => {
  if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
  return request.principal;
};

/** Read-only routes; the service enforces the same project and principal fence on each request. */
export function registerSessionWorkRoutes(app: FastifyInstance, service: SessionObservationService,
  present: (principal: Principal, session: ObservedSession) => ObservedSession = (_principal, session) => session,
  presentSnapshot: (principal: Principal, projectId: string, session: ObservedSession) => Promise<ObservedSession> = async (_principal, _projectId, session) => session): void {
  app.get("/api/projects/:projectId/session-work", async request => {
    const { projectId } = z.strictObject({ projectId: id }).parse(request.params);
    const options = z.strictObject({ limit: limit50, cursor: cursor.optional(), search: z.string().trim().max(240).optional(),
      membership: z.enum(["current", "historical", "unclassified", "all"]).optional() }).parse(request.query);
    const principal = principalOf(request);
    const page = await service.directory(principal, projectId, { limit: options.limit,
      ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.search ? { search: options.search } : {}),
      ...(options.membership ? { membership: options.membership } : {}) });
    return { ...page, items: page.items.map(session => present(principal, session)) };
  });
  app.get("/api/projects/:projectId/session-work/changes", request => {
    const { projectId } = z.strictObject({ projectId: id }).parse(request.params);
    const options = z.strictObject({ cursor, limit: limit100, key: key.optional() }).parse(request.query);
    return service.changes(principalOf(request), projectId, { cursor: options.cursor, limit: options.limit,
      ...(options.key ? { key: options.key } : {}) });
  });
  app.get("/api/projects/:projectId/session-work/:key/activities", request => {
    const { projectId, key: sessionKey } = z.strictObject({ projectId: id, key }).parse(request.params);
    const options = z.strictObject({ limit: limit50, cursor: cursor.optional(), taskId: id.optional(),
      importance: z.enum(["important", "all"]).optional() }).parse(request.query);
    return service.history(principalOf(request), projectId, sessionKey, { limit: options.limit,
      ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.importance ? { importance: options.importance } : {}) });
  });
  app.get("/api/projects/:projectId/session-work/:key/profile/history", request => {
    const { projectId, key: sessionKey } = z.strictObject({ projectId: id, key }).parse(request.params);
    const { limit, cursor: after } = z.strictObject({ limit: limit50, cursor: versionCursor.optional() }).parse(request.query);
    return service.profileHistory(principalOf(request), projectId, sessionKey, limit, after);
  });
  app.get("/api/projects/:projectId/session-work/:key/profile", request => {
    const { projectId, key: sessionKey } = z.strictObject({ projectId: id, key }).parse(request.params);
    return service.profile(principalOf(request), projectId, sessionKey);
  });
  app.get("/api/projects/:projectId/session-work/:key", async request => {
    const { projectId, key: sessionKey } = z.strictObject({ projectId: id, key }).parse(request.params);
    const principal = principalOf(request);
    const snapshot = await service.snapshot(principal, projectId, sessionKey);
    // Execution configuration is read only for the selected snapshot, never once per directory row.
    return { ...snapshot, session: await presentSnapshot(principal, projectId, present(principal, snapshot.session)) };
  });
  app.get("/api/projects/:projectId/tasks/:id/assignment/history", request => {
    const { projectId, id: taskId } = z.strictObject({ projectId: id, id }).parse(request.params);
    const { limit, cursor: after } = z.strictObject({ limit: limit50, cursor: versionCursor.optional() }).parse(request.query);
    return service.assignmentHistory(principalOf(request), projectId, taskId, limit, after);
  });
  app.get("/api/projects/:projectId/tasks/:id/assignment", request => {
    const { projectId, id: taskId } = z.strictObject({ projectId: id, id }).parse(request.params);
    return service.assignment(principalOf(request), projectId, taskId);
  });
}
