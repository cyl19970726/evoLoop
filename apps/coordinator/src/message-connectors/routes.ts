import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import { connectorRouteSchema, versionedConnectorRouteSchema,
  type ConnectorRoute, type ConnectorRoutePage, type ConnectorRouteRecord,
  type VersionedConnectorRoute } from "@evoloop/contracts/message-connectors";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";

export interface ConnectorRouteReader {
  get(projectId: string, bindingId: string): Promise<ConnectorRouteRecord | null>;
  list(projectId: string, limit: number, cursor?: string): Promise<ConnectorRoutePage>;
  create(input: ConnectorRoute, operationId: string, actorId: string): Promise<ConnectorRouteRecord>;
  update(input: VersionedConnectorRoute, expectedVersion: number, operationId: string, actorId: string): Promise<ConnectorRouteRecord>;
  operation(projectId: string, operationId: string): Promise<{
    projectId: string; id: string; actorId: string; requestHash: string; kind: "create" | "update";
    bindingId: string; result: ConnectorRouteRecord; createdAt: string;
  } | null>;
}

/** Reads the saved route and its actual receiver. No route is enabled by this API. */
export function registerConnectorRouteReads(app: FastifyInstance, workflow: WorkflowService,
  routes: ConnectorRouteReader, canWrite: () => boolean): void {
  const identity = async (principal: Principal | null, projectId: string, write = false) => {
    if (!principal || !principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN", "Connector routes require project read permission");
    if (write && (!principal.permissions.includes("write") || !principal.permissions.includes("review")))
      throw new DomainError("FORBIDDEN", "Connector route configuration requires project review authority");
    await workflow.getProject(principal, projectId);
    if (write && !canWrite()) throw new DomainError("COORDINATOR_READ_ONLY", "Coordinator lease is read only");
  };
  app.get("/api/projects/:projectId/message-connectors/routes", async request => {
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    await identity(request.principal, projectId);
    const query = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).default(50),
      cursor: z.uuid().optional() }).parse(request.query);
    return routes.list(projectId, query.limit, query.cursor);
  });
  app.get("/api/projects/:projectId/message-connectors/routes/:bindingId", async request => {
    const { projectId, bindingId } = z.strictObject({ projectId: z.uuid(), bindingId: z.uuid() }).parse(request.params);
    await identity(request.principal, projectId);
    const route = await routes.get(projectId, bindingId);
    if (!route) throw new DomainError("NOT_FOUND", "Connector route not found in this project");
    return route;
  });
  app.get("/api/projects/:projectId/message-connectors/operations/:operationId", async request => {
    const { projectId, operationId } = z.strictObject({ projectId: z.uuid(), operationId: z.uuid() }).parse(request.params);
    await identity(request.principal, projectId);
    const operation = await routes.operation(projectId, operationId);
    if (!operation) throw new DomainError("CONNECTOR_OPERATION_UNCONFIRMED",
      "No committed connector operation is visible yet. Keep the original operation ID and intent; an absent read does not prove the write failed.");
    return operation;
  });
  app.post("/api/projects/:projectId/message-connectors/routes", async request => {
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    await identity(request.principal, projectId, true);
    const { operationId, route } = z.strictObject({ operationId: z.uuid(), route: connectorRouteSchema }).parse(request.body);
    if (route.projectId !== projectId) throw new DomainError("CONNECTOR_PROJECT_MISMATCH", "Route project differs from path");
    return { operationId, route: await routes.create(route, operationId, request.principal!.actorId) };
  });
  app.put("/api/projects/:projectId/message-connectors/routes/:bindingId", async request => {
    const { projectId, bindingId } = z.strictObject({ projectId: z.uuid(), bindingId: z.uuid() }).parse(request.params);
    await identity(request.principal, projectId, true);
    const input = z.strictObject({ operationId: z.uuid(), expectedVersion: z.number().int().positive(),
      route: versionedConnectorRouteSchema }).parse(request.body);
    if (input.route.projectId !== projectId || input.route.bindingId !== bindingId)
      throw new DomainError("CONNECTOR_ROUTE_IDENTITY", "Route identity differs from path");
    return { operationId: input.operationId,
      route: await routes.update(input.route, input.expectedVersion, input.operationId, request.principal!.actorId) };
  });
}
