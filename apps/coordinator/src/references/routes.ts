import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Principal, RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import type { ExternalReferenceKind, ReferenceUnitOfWork } from "@evoloop/contracts/references";
import type { DocumentSource } from "@evoloop/contracts/sources";
import type { KnowledgeRepository } from "@evoloop/contracts/knowledge";
import { DomainError } from "@evoloop/contracts/ports";
import { decideTaskExternalReference, fixedRunMatches, recordFormalSourceDecision, registerFixedGitReference } from "@evoloop/core/references";
import type { ExternalReferenceObservation } from "@evoloop/core/references";

const id = z.uuid();
const scoped = (principal: Principal | null, projectId: string, permission: "read" | "write" | "review"): Principal => {
  if (!principal || !principal.projectIds.includes(projectId) || !principal.permissions.includes(permission))
    throw new DomainError("FORBIDDEN", "Project reference permission is required");
  return principal;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface ReferenceRouteOptions {
  uow: ReferenceUnitOfWork;
  gitForPrincipal(principal: Principal): DocumentSource | Promise<DocumentSource>;
  knowledgeForPrincipal(principal: Principal, projectId: string): KnowledgeRepository | Promise<KnowledgeRepository>;
  runSessionAvailable?(projectId: string, run: RuntimeRunRecord, session: RuntimeSessionRecord): Promise<boolean>;
}
export function registerReferenceRoutes(app: FastifyInstance, options: ReferenceRouteOptions): void {
  async function deps(principal: Principal) {
    const git = await options.gitForPrincipal(principal);
    return { uow: options.uow, git, hashText: hash, nextId: randomUUID, now: () => new Date().toISOString(),
      observeExternal: async (actor: Principal, projectId: string, kind: ExternalReferenceKind, referenceId: string,
        revision: string, contentHash: string): Promise<ExternalReferenceObservation> => {
        if (kind === "run") {
          const run = await options.uow.read(projectId, reader => reader.getRuntimeRun(referenceId));
          const session = run ? await options.uow.read(projectId, reader => reader.getRuntimeSession(run.sessionId)) : null;
          const available = fixedRunMatches(projectId, run, session, referenceId, revision, contentHash) &&
            !!options.runSessionAvailable && await options.runSessionAvailable(projectId, run!, session!);
          return { status: available ? "reachable" : "unavailable", revision, contentHash,
            currentRevision: run?.taskRevisionId ?? revision, currentHash: run?.inputHash ?? contentHash,
            currentValidity: available ? "valid" : "unavailable" };
        }
        if (kind === "git") {
          const registered = await options.uow.read(projectId, reader => reader.getGitSourceRef(referenceId));
          if (!registered || registered.ref.commit !== revision || registered.ref.contentHash !== contentHash)
            return { status: "unavailable", revision, contentHash, currentRevision: revision,
              currentHash: contentHash, currentValidity: "unavailable" };
          const read = await git.read(registered.ref);
          return { status: read.status === "available" ? "reachable" : "unavailable", revision, contentHash,
            currentRevision: revision, currentHash: contentHash,
            currentValidity: read.status === "available" ? "valid" : "unavailable" };
        }
        const knowledge = await options.knowledgeForPrincipal(actor, projectId);
        const page = await knowledge.get(projectId, referenceId, revision);
        const current = await knowledge.get(projectId, referenceId);
        if (!page || !current) return { status: "unavailable", revision, contentHash,
          currentRevision: revision, currentHash: contentHash, currentValidity: "unavailable" };
        const status = page.validity === "withdrawn" || page.observedValidity === "withdrawn" ? "withdrawn" :
          page.validity === "needs_review" || page.observedValidity === "needs_review" ? "needs_review" : "reachable";
        const currentValidity = current.validity === "withdrawn" || current.observedValidity === "withdrawn" ? "withdrawn" :
          current.validity === "needs_review" || current.observedValidity === "needs_review" ? "needs_review" : "valid";
        return { status, revision: page.revision, contentHash: page.contentHash,
          currentRevision: current.revision, currentHash: current.contentHash, currentValidity };
      } };
  }
  app.post("/api/projects/:projectId/references/git", async request => {
    const { projectId } = z.object({ projectId: id }).parse(request.params);
    const principal = scoped(request.principal, projectId, "write");
    return registerFixedGitReference(await deps(principal), principal,
      { ...z.record(z.string(), z.unknown()).parse(request.body), projectId, actorId: principal.actorId });
  });
  app.get("/api/projects/:projectId/references/git/:referenceId", async request => {
    const { projectId, referenceId } = z.object({ projectId: id, referenceId: id }).parse(request.params);
    const principal = scoped(request.principal, projectId, "read");
    const registered = await options.uow.read(projectId, reader => reader.getGitSourceRef(referenceId));
    if (!registered) throw new DomainError("NOT_FOUND", "Fixed Git reference was not found");
    const read = await (await options.gitForPrincipal(principal)).read(registered.ref);
    return read.status === "available"
      ? { status: "available", referenceId, ref: read.ref, base64: Buffer.from(read.bytes).toString("base64"), observedAt: read.observedAt }
      : { status: "unavailable", referenceId, ref: read.ref, reason: read.reason, observedAt: read.observedAt };
  });
  app.post("/api/projects/:projectId/references/formal-decisions", async request => {
    const { projectId } = z.object({ projectId: id }).parse(request.params);
    const principal = scoped(request.principal, projectId, "review");
    return recordFormalSourceDecision(await deps(principal), principal,
      { ...z.record(z.string(), z.unknown()).parse(request.body), projectId, actorId: principal.actorId });
  });
  app.get("/api/projects/:projectId/references/git/:referenceId/formal-decisions", async request => {
    const { projectId, referenceId } = z.object({ projectId: id, referenceId: id }).parse(request.params);
    scoped(request.principal, projectId, "read");
    return options.uow.read(projectId, reader => reader.listFormalSourceDecisions(referenceId));
  });
  app.post("/api/projects/:projectId/references/tasks/:taskId/decisions", async request => {
    const { projectId, taskId } = z.object({ projectId: id, taskId: id }).parse(request.params);
    const principal = scoped(request.principal, projectId, "review");
    return decideTaskExternalReference(await deps(principal), principal,
      { ...z.record(z.string(), z.unknown()).parse(request.body), projectId, taskId, actorId: principal.actorId });
  });
  app.get("/api/projects/:projectId/references/tasks/:taskId", async request => {
    const { projectId, taskId } = z.object({ projectId: id, taskId: id }).parse(request.params);
    scoped(request.principal, projectId, "read");
    return options.uow.read(projectId, reader => reader.listTaskExternalReferences(taskId));
  });
  app.get("/api/projects/:projectId/references/tasks/:taskId/revisions/:revisionId", async request => {
    const { projectId, taskId, revisionId } = z.object({ projectId: id, taskId: id, revisionId: id }).parse(request.params);
    scoped(request.principal, projectId, "read");
    return options.uow.read(projectId, reader => reader.listTaskExternalSnapshot(taskId, revisionId));
  });
}
