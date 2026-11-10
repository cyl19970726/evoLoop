// Read-only project configuration: repositories, capabilities and members of one project, for its readers.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type {
  ProjectCapabilitiesView, ProjectCapability, ProjectConfigurationUnavailable, ProjectMember, ProjectMemberSourceKind,
  ProjectMembersView, ProjectRepositoriesView, ProjectRepository,
} from "@evoloop/contracts/project-configuration";

/**
 * Where the views come from. Each part may be absent: a host without it answers `unavailable`, never an empty list.
 * The local coordinator supplies all three from its own configuration (local.ts); a Hub supplies members from its
 * accounts.
 */
export interface ProjectConfigurationSource {
  repositories?(projectId: string): Promise<ProjectRepository[]>;
  capabilities?(projectId: string): Promise<ProjectCapability[]>;
  members?: { kind: ProjectMemberSourceKind; list(projectId: string): Promise<ProjectMember[]> };
}

/** Every route needs the caller's read permission on this existing project, as other project reads do. */
export function registerProjectConfigurationRoutes(app: FastifyInstance,
  service: { getProject(principal: Principal, projectId: string): Promise<unknown> },
  source: ProjectConfigurationSource = {}): void {
  const readable = async (request: FastifyRequest): Promise<string> => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    await service.getProject(request.principal, projectId);
    return projectId;
  };
  const unavailable = (projectId: string, reason: ProjectConfigurationUnavailable["reason"]): ProjectConfigurationUnavailable =>
    ({ projectId, status: "unavailable", reason });
  const read = async <T>(projectId: string, produce: ((projectId: string) => Promise<T>) | undefined,
    view: (value: T) => object): Promise<object> => {
    if (!produce) return unavailable(projectId, "not_provided");
    let value: T;
    try { value = await produce(projectId); }
    catch { return unavailable(projectId, "read_failed"); }
    return view(value);
  };
  // Each view copies only its contract fields, so a source carrying more (a checkout root, a token) cannot leak it.
  app.get("/api/projects/:projectId/repositories", async request => {
    const projectId = await readable(request);
    return read(projectId, source.repositories && (id => source.repositories!(id)), (items): ProjectRepositoriesView => ({
      projectId, status: "available",
      items: items.map(item => ({ repositoryId: item.repositoryId, allowedPaths: [...item.allowedPaths] })) }));
  });
  app.get("/api/projects/:projectId/capabilities", async request => {
    const projectId = await readable(request);
    return read(projectId, source.capabilities && (id => source.capabilities!(id)), (items): ProjectCapabilitiesView => ({
      projectId, status: "available",
      items: items.map(item => ({ key: item.key, scope: item.scope, state: item.state, reason: item.reason })) }));
  });
  app.get("/api/projects/:projectId/members", async request => {
    const projectId = await readable(request);
    const members = source.members;
    return read(projectId, members && (id => members.list(id)), (items): ProjectMembersView => ({ projectId,
      status: "available", source: members!.kind,
      items: items.map(item => ({ actorId: item.actorId, identityKind: item.identityKind, permissions: [...item.permissions] })) }));
  });
}
