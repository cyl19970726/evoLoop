// Read-only project configuration: repositories, capabilities and members of one project, for its readers.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type {
  ProjectCapabilitiesView, ProjectCapability, ProjectCapabilityJudgment, ProjectConfigurationUnavailable,
  ProjectIdentityFileState, ProjectMember, ProjectMemberSourceKind, ProjectMembersView, ProjectRepositoriesView,
  ProjectRepository,
} from "@evoloop/contracts/project-configuration";

/**
 * Where the views come from. Each part may be absent: a host without it answers `unavailable`, never an empty list.
 * The local coordinator supplies all three from its own configuration and identity file (local.ts); a Hub would
 * supply members from its accounts.
 */
export interface ProjectConfigurationSource {
  /** `accepted`: the Git source accepts the service's repository list as a whole, so these entries are readable. */
  repositories?(projectId: string): Promise<{ accepted: boolean; items: ProjectRepository[] }>;
  /** Judged for this project and, for capabilities granted per actor, for the caller. */
  capabilities?(principal: Principal, projectId: string): Promise<ProjectCapability[]>;
  members?: { kind: ProjectMemberSourceKind;
    list(projectId: string): Promise<{ identityFile: ProjectIdentityFileState | null; items: ProjectMember[] }> };
}

const judgment = (value: ProjectCapabilityJudgment): ProjectCapabilityJudgment => ({ state: value.state, reason: value.reason,
  ...(value.callerGranted === undefined ? {} : { callerGranted: value.callerGranted, callerReason: value.callerReason ?? null }) });

/** Every route needs the caller's read permission on this existing project, as other project reads do. */
export function registerProjectConfigurationRoutes(app: FastifyInstance,
  service: { getProject(principal: Principal, projectId: string): Promise<unknown> },
  source: ProjectConfigurationSource = {}): void {
  const readable = async (request: FastifyRequest): Promise<{ principal: Principal; projectId: string }> => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    await service.getProject(request.principal, projectId);
    return { principal: request.principal, projectId };
  };
  const unavailable = (projectId: string, reason: ProjectConfigurationUnavailable["reason"]): ProjectConfigurationUnavailable =>
    ({ projectId, status: "unavailable", reason });
  const read = async <T>(projectId: string, produce: (() => Promise<T>) | undefined, view: (value: T) => object): Promise<object> => {
    if (!produce) return unavailable(projectId, "not_provided");
    let value: T;
    try { value = await produce(); }
    catch { return unavailable(projectId, "read_failed"); }
    return view(value);
  };
  // Each view copies only its contract fields, so a source carrying more (a checkout root, a token) cannot leak it.
  app.get("/api/projects/:projectId/repositories", async request => {
    const { projectId } = await readable(request);
    const repositories = source.repositories;
    return read(projectId, repositories && (() => repositories.call(source, projectId)), (value): ProjectRepositoriesView => {
      const items = value.items.map(item => ({ repositoryId: item.repositoryId, allowedPaths: [...item.allowedPaths] }));
      return value.accepted ? { projectId, status: "available", items }
        : { projectId, status: "unavailable", reason: "registration_invalid", items };
    });
  });
  app.get("/api/projects/:projectId/capabilities", async request => {
    const { principal, projectId } = await readable(request);
    const capabilities = source.capabilities;
    return read(projectId, capabilities && (() => capabilities.call(source, principal, projectId)), (items): ProjectCapabilitiesView => ({
      projectId, status: "available",
      items: items.map(item => ({ key: item.key, scope: item.scope, readAt: item.readAt, ...judgment(item),
        pending: item.pending ? judgment(item.pending) : null })) }));
  });
  app.get("/api/projects/:projectId/members", async request => {
    const { projectId } = await readable(request);
    const members = source.members;
    return read(projectId, members && (() => members.list(projectId)), (value): ProjectMembersView => ({ projectId,
      status: "available", source: members!.kind, identityFile: value.identityFile,
      items: value.items.map(item => ({ actorId: item.actorId, identityKind: item.identityKind, canRead: item.canRead,
        canWrite: item.canWrite, canReview: item.canReview,
        pending: item.pending ? { identityKind: item.pending.identityKind, canRead: item.pending.canRead,
          canWrite: item.pending.canWrite, canReview: item.pending.canReview } : null })) }));
  });
}
