import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idSchema, type Document, type DocumentDetail, type Principal, type Page } from "@evoloop/contracts";
import type { DocumentPayloadRevision } from "@evoloop/contracts/process-documents";
import type { RegisteredDocumentBlob } from "@evoloop/contracts/process-documents";
import type { BlobStore } from "@evoloop/contracts/sources";
import { knowledgeCandidateInputSchema, knowledgeReviewInputSchema, knowledgeOperationInputSchema, type CandidateDecision, type KnowledgeCandidate, type KnowledgeRepository, type KnowledgeSourceRef } from "@evoloop/contracts/knowledge";
import { DomainError } from "@evoloop/contracts/ports";

const uuid = idSchema;
const sourceKey = (documentId: string) => `document:${documentId}`;
const sourceId = (key: string): string => {
  if (!key.startsWith("document:") || !uuid.safeParse(key.slice(9)).success)
    throw new DomainError("INVALID_COMMAND", "Only registered process-document sources are available");
  return key.slice(9);
};
const sha = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");
const params = (raw: unknown) => z.record(z.string(), uuid).parse(raw);
const pageQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() });
const permission = (principal: Principal | null, projectId: string, kind: "read" | "write" | "review"): Principal => {
  if (!principal || !principal.projectIds.includes(projectId) || !principal.permissions.includes(kind))
    throw new DomainError("FORBIDDEN", `Project ${kind} permission is required`);
  return principal;
};
function sameSource(actual: KnowledgeSourceRef, expected: KnowledgeSourceRef): boolean {
  return actual.sourceKey === expected.sourceKey && actual.originRevision === expected.originRevision &&
    actual.contentHash === expected.contentHash && actual.fragment === expected.fragment && actual.state === "reachable";
}

export interface KnowledgeRouteOptions {
  workflow: {
    listDocuments(principal: Principal, projectId: string, limit?: number, cursor?: string): Promise<Page<Document>>;
    getDocument(principal: Principal, projectId: string, documentId: string): Promise<DocumentDetail>;
    getDocumentPayloadRevision(principal: Principal, projectId: string, documentId: string, revisionId: string): Promise<DocumentPayloadRevision>;
    getRegisteredBlob(principal: Principal, projectId: string, blobId: string): Promise<RegisteredDocumentBlob>;
  };
  repositoryForPrincipal(principal: Principal, projectId: string): KnowledgeRepository | Promise<KnowledgeRepository>;
  blobsForPrincipal(principal: Principal): BlobStore | Promise<BlobStore>;
}

export function registerKnowledgeRoutes(app: FastifyInstance, options: KnowledgeRouteOptions): void {
  const repository = (principal: Principal, projectId: string) => options.repositoryForPrincipal(principal, projectId);
  const verifySource = async (principal: Principal, projectId: string, documentId: string, revisionId: string,
    fragment: string | null): Promise<KnowledgeSourceRef> => {
    const detail = await options.workflow.getDocument(principal, projectId, documentId);
    if (detail.document.projectId !== projectId || detail.document.adoptedRevisionId !== revisionId)
      throw new DomainError("SOURCE_UNAVAILABLE", "Source revision is not the adopted document revision");
    const fixed = await options.workflow.getDocumentPayloadRevision(principal, projectId, documentId, revisionId);
    if (fixed.projectId !== projectId || fixed.documentId !== documentId || fixed.id !== revisionId ||
      !/^[a-f0-9]{64}$/.test(fixed.contentHash))
      throw new DomainError("SOURCE_UNAVAILABLE", "Fixed document revision is unavailable");
    if (fixed.body !== null) {
      if (fixed.payloadRef !== null || fixed.assetsManifest.length || sha(fixed.body) !== fixed.contentHash)
        throw new DomainError("SOURCE_UNAVAILABLE", "Inline source body failed verification");
    } else {
      if (!fixed.payloadRef) throw new DomainError("SOURCE_UNAVAILABLE", "External source reference is missing");
      const blobs = await options.blobsForPrincipal(principal);
      const parts = [{ id: fixed.payloadRef, hash: fixed.contentHash, mediaType: fixed.mediaType,
        role: "main" as const, path: null, size: null as number | null },
        ...fixed.assetsManifest.map(asset => ({ id: asset.blobId, hash: asset.contentHash,
          mediaType: asset.mediaType, role: "asset" as const, path: asset.path, size: asset.size }))];
      let total = 0;
      for (const part of parts) {
        let registered: RegisteredDocumentBlob;
        try { registered = await options.workflow.getRegisteredBlob(principal, projectId, part.id); }
        catch { throw new DomainError("SOURCE_UNAVAILABLE", "Source resource is not registered"); }
        if (registered.projectId !== projectId || registered.documentId !== documentId || registered.revisionId !== revisionId ||
          registered.role !== part.role || registered.relativePath !== part.path || registered.contentHash !== part.hash ||
          registered.mediaType !== part.mediaType || (part.size !== null && registered.size !== part.size))
          throw new DomainError("SOURCE_UNAVAILABLE", "Source resource registry does not match fixed revision");
        total += registered.size;
        if (total > 16 * 1024 * 1024) throw new DomainError("SOURCE_UNAVAILABLE", "Source bundle exceeds read bound");
        const read = await blobs.read({ id: registered.id, projectId, contentHash: registered.contentHash,
          size: registered.size, mediaType: registered.mediaType });
        if (read.status !== "available" || read.bytes.length !== registered.size ||
          createHash("sha256").update(read.bytes).digest("hex") !== registered.contentHash)
          throw new DomainError("SOURCE_UNAVAILABLE", "Source bytes are unavailable or changed");
        if (part.role === "main") {
          try { new TextDecoder("utf-8", { fatal: true }).decode(read.bytes); }
          catch { throw new DomainError("SOURCE_UNAVAILABLE", "Source text is not valid UTF-8"); }
        }
      }
    }
    if (await (await repository(principal, projectId)).sourceState(projectId, sourceKey(documentId)) === "withdrawn")
      throw new DomainError("SOURCE_WITHDRAWN", "Source was withdrawn from the knowledge space");
    return { sourceKey: sourceKey(documentId), originRevision: revisionId,
      contentHash: fixed.contentHash, fragment, state: "reachable" };
  };
  const verifyCandidateSources = async (principal: Principal, projectId: string, candidate: KnowledgeCandidate) => {
    if (!candidate.sources.length) throw new DomainError("SOURCE_UNAVAILABLE", "Candidate needs a verified source");
    for (const source of candidate.sources) {
      if (source.state !== "reachable") throw new DomainError("SOURCE_UNAVAILABLE", "Candidate source is unavailable");
      const actual = await verifySource(principal, projectId, sourceId(source.sourceKey), source.originRevision, source.fragment);
      if (!sameSource(actual, source)) throw new DomainError("SOURCE_UNAVAILABLE", "Candidate source changed");
    }
  };
  app.get("/api/projects/:projectId/knowledge/capabilities", async request => {
    const projectId = params(request.params).projectId!;
    const principal = permission(request.principal, projectId, "read");
    return (await repository(principal, projectId)).capabilities();
  });
  app.get("/api/projects/:projectId/knowledge/sources/documents", async request => {
    const projectId = params(request.params).projectId!;
    const principal = permission(request.principal, projectId, "read");
    const query = pageQuery.parse(request.query);
    const listed = await options.workflow.listDocuments(principal, projectId, query.limit, query.cursor);
    const items = [];
    for (const document of listed.items) {
      if (!document.adoptedRevisionId) continue;
      try {
        const fixed = await options.workflow.getDocumentPayloadRevision(principal, projectId, document.id, document.adoptedRevisionId);
        const state = await (await repository(principal, projectId)).sourceState(projectId, sourceKey(document.id));
        items.push({ documentId: document.id, title: document.title, revisionId: fixed.id, contentHash: fixed.contentHash,
          sourceKey: sourceKey(document.id), state });
      } catch { items.push({ documentId: document.id, title: document.title,
        revisionId: document.adoptedRevisionId, sourceKey: sourceKey(document.id), state: "unavailable" as const }); }
    }
    return { items, nextCursor: listed.nextCursor };
  });
  app.get("/api/projects/:projectId/knowledge/pages", async request => {
    const projectId = params(request.params).projectId!;
    const principal = permission(request.principal, projectId, "read");
    const query = pageQuery.parse(request.query);
    return (await repository(principal, projectId)).list(projectId, query.limit, query.cursor);
  });
  app.get("/api/projects/:projectId/knowledge/candidates", async request => {
    const projectId = params(request.params).projectId!;
    const principal = permission(request.principal, projectId, "read");
    const query = pageQuery.parse(request.query);
    return (await repository(principal, projectId)).listCandidates(projectId, query.limit, query.cursor);
  });
  app.get("/api/projects/:projectId/knowledge/candidates/:id", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "read");
    const candidate = await (await repository(principal, p.projectId!)).getCandidate(p.projectId!, p.id!);
    if (!candidate) throw new DomainError("NOT_FOUND", "Knowledge candidate was not found");
    return candidate;
  });
  app.get("/api/projects/:projectId/knowledge/pages/:id", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "read");
    const query = z.strictObject({ revision: uuid.optional() }).parse(request.query);
    const page = await (await repository(principal, p.projectId!)).get(p.projectId!, p.id!, query.revision);
    if (!page) throw new DomainError("NOT_FOUND", "Knowledge page was not found");
    return page;
  });
  app.get("/api/projects/:projectId/knowledge/pages/:id/history", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "read");
    const query = pageQuery.parse(request.query);
    return (await repository(principal, p.projectId!)).history(p.projectId!, p.id!, query.limit, query.cursor);
  });
  app.get("/api/projects/:projectId/knowledge/pages/:id/graph", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "read");
    const query = z.strictObject({ limit: z.coerce.number().int().min(1).max(80).default(40) }).parse(request.query);
    return (await repository(principal, p.projectId!)).graph(p.projectId!, p.id!, query.limit);
  });
  app.post("/api/projects/:projectId/knowledge/candidates", { bodyLimit: 2 * 1024 * 1024 }, async request => {
    const projectId = params(request.params).projectId!;
    const principal = permission(request.principal, projectId, "write");
    const input = knowledgeCandidateInputSchema.parse(request.body);
    if (Buffer.byteLength(input.body, "utf8") > 1024 * 1024) throw new DomainError("INVALID_COMMAND", "Candidate body exceeds 1 MiB");
    const repo = await repository(principal, projectId);
    const current = await repo.get(projectId, input.knowledgeId);
    if ((current?.revision ?? null) !== input.expectedRevision)
      throw new DomainError("VERSION_CONFLICT", "Knowledge baseline changed");
    const sources: KnowledgeSourceRef[] = [];
    const seen = new Set<string>();
    for (const source of input.sources) {
      const fixed = await verifySource(principal, projectId, source.documentId, source.revisionId, source.fragment);
      if (seen.has(fixed.sourceKey)) throw new DomainError("INVALID_COMMAND", "Duplicate source document");
      seen.add(fixed.sourceKey); sources.push(fixed);
    }
    const relations = [];
    for (const [index, item] of input.relations.entries()) {
      const target = await repo.get(projectId, item.toKnowledgeId, item.toRevision);
      if (!target) throw new DomainError("INVALID_COMMAND", "Relation target revision is unavailable");
      if (item.sourceKeys.some(key => !seen.has(key))) throw new DomainError("INVALID_COMMAND", "Relation cites an unverified source");
      relations.push({ edgeId: `e_${sha(`${input.candidateId}:${index}`).slice(0, 32)}`,
        fromKnowledgeId: input.knowledgeId, fromRevision: input.candidateRevision,
        toKnowledgeId: item.toKnowledgeId, toRevision: item.toRevision, type: item.type,
        sourceKeys: item.sourceKeys, state: "active" as const });
    }
    const candidate: KnowledgeCandidate = { projectId, knowledgeId: input.knowledgeId,
      candidateId: input.candidateId, candidateRevision: input.candidateRevision,
      expectedRevision: input.expectedRevision, contentHash: sha(input.body), title: input.title,
      body: input.body, pageType: input.pageType, epistemicStatus: input.epistemicStatus,
      sources, relations, operationId: input.operationId, actorId: principal.actorId };
    return repo.propose(candidate);
  });
  app.post("/api/projects/:projectId/knowledge/candidates/:id/review", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "review");
    const input = knowledgeReviewInputSchema.parse(request.body);
    const repo = await repository(principal, p.projectId!);
    const candidate = await repo.getCandidate(p.projectId!, p.id!);
    if (!candidate) throw new DomainError("NOT_FOUND", "Candidate was not found");
    if (candidate.candidateRevision !== input.candidateRevision || candidate.contentHash !== input.contentHash ||
      candidate.expectedRevision !== input.expectedRevision) throw new DomainError("VERSION_CONFLICT", "Candidate changed");
    if (input.decision === "accept") await verifyCandidateSources(principal, p.projectId!, candidate);
    const decision: CandidateDecision = { ...input, candidateId: p.id!, reviewerId: principal.actorId };
    await repo.review(p.projectId!, decision);
    return { status: "recorded", decision };
  });
  app.post("/api/projects/:projectId/knowledge/candidates/:id/publish", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "review");
    const input = knowledgeOperationInputSchema.parse(request.body);
    const repo = await repository(principal, p.projectId!);
    const candidate = await repo.getCandidate(p.projectId!, p.id!);
    if (!candidate) throw new DomainError("NOT_FOUND", "Candidate was not found");
    if (candidate.status !== "accepted" && candidate.status !== "published")
      throw new DomainError("NOT_REVIEWED", "Candidate lacks accepted review");
    if (candidate.status !== "published") await verifyCandidateSources(principal, p.projectId!, candidate);
    return repo.publish(p.projectId!, p.id!, input.operationId, principal.actorId);
  });
  app.post("/api/projects/:projectId/knowledge/operations/:id/reconcile", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "review");
    return { result: await (await repository(principal, p.projectId!)).reconcile(p.projectId!, p.id!, principal.actorId) };
  });
  app.post("/api/projects/:projectId/knowledge/sources/:id/retract", async request => {
    const p = params(request.params);
    const principal = permission(request.principal, p.projectId!, "review");
    const input = knowledgeOperationInputSchema.parse(request.body);
    await options.workflow.getDocument(principal, p.projectId!, p.id!);
    const affected = await (await repository(principal, p.projectId!)).retractSource(p.projectId!, sourceKey(p.id!), input.operationId, principal.actorId);
    return { status: "recorded", operationId: input.operationId, affected };
  });
}
