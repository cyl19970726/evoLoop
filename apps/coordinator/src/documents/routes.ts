import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import { idSchema } from "@evoloop/contracts";
import { documentImportSchema } from "@evoloop/contracts/process-documents";
import type { DocumentPayloadRevision, DocumentPayloadUnitOfWork } from "@evoloop/contracts/process-documents";
import type { BlobStore } from "@evoloop/contracts/sources";
import { DomainError } from "@evoloop/contracts/ports";
import { importDocumentPayload } from "@evoloop/core/documents";
import { readDocumentOriginal } from "./read-original.js";
import { bodyPage, fixedPart, FixedBodyCache } from "./fixed-reads.js";

const maxBundleBytes = 16 * 1024 * 1024;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const paramsSchema = z.strictObject({ projectId: idSchema, id: idSchema, revisionId: idSchema });
const scoped = (principal: Principal | null, projectId: string, permission: "read" | "write"): Principal => {
  if (!principal || !principal.projectIds.includes(projectId) || !principal.permissions.includes(permission))
    throw new DomainError("FORBIDDEN", "Project permission is required");
  return principal;
};
const decodeBase64 = (encoded: string): Buffer => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new DomainError("INVALID_COMMAND", "Upload must use canonical base64");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new DomainError("INVALID_COMMAND", "Upload has noncanonical base64 bits");
  return bytes;
};

export interface DocumentRouteOptions {
  workflow: {
    getDocumentPayloadRevision(principal: Principal, projectId: string, documentId: string, revisionId: string): Promise<DocumentPayloadRevision>;
  };
  uow: DocumentPayloadUnitOfWork;
  blobsForPrincipal(principal: Principal): BlobStore | Promise<BlobStore>;
}

export function registerDocumentRoutes(app: FastifyInstance, options: DocumentRouteOptions): void {
  const verifiedBodies = new FixedBodyCache();
  const fixedRevision = async (principal: Principal, projectId: string, id: string, revisionId: string) => {
    const revision = await options.workflow.getDocumentPayloadRevision(principal, projectId, id, revisionId);
    if (revision.projectId !== projectId || revision.documentId !== id || revision.id !== revisionId)
      throw new DomainError("NOT_FOUND", "Document revision was not found");
    return revision;
  };
  app.post("/api/projects/:projectId/documents/import", { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => {
    const { projectId } = z.strictObject({ projectId: idSchema }).parse(request.params);
    const principal = scoped(request.principal, projectId, "write");
    const parsed = documentImportSchema.parse(request.body);
    if (parsed.command.projectId !== projectId) throw new DomainError("INVALID_COMMAND", "Project path and command differ");
    // The authenticated actor is the only author of the new revision.
    const command = { ...parsed.command, author: principal.actorId };
    const required = new Set<string>(command.source.storage === "blob"
      ? [command.source.payloadRef, ...command.source.assets.map((asset) => asset.blobId)] : []);
    const uploads = new Map<string, Uint8Array>();
    let total = 0;
    for (const item of parsed.uploads) {
      if (!required.has(item.blobId) || uploads.has(item.blobId))
        throw new DomainError("INVALID_COMMAND", "Unexpected or duplicate upload resource");
      const bytes = decodeBase64(item.base64);
      total += bytes.length;
      if (total > maxBundleBytes) throw new DomainError("INVALID_COMMAND", "Document bundle exceeds 16 MiB");
      uploads.set(item.blobId, bytes);
    }
    const result = await importDocumentPayload({ uow: options.uow, blobs: await options.blobsForPrincipal(principal),
      hashText: hash, nextId: randomUUID, now: () => new Date().toISOString() }, principal, command, uploads);
    return reply.code(result.status === "applied" ? 200 : 409).send(result);
  });

  app.get("/api/projects/:projectId/documents/:id/revisions/:revisionId/original", async (request) => {
    const { projectId, id, revisionId } = paramsSchema.parse(request.params);
    const principal = scoped(request.principal, projectId, "read");
    const revision = await fixedRevision(principal, projectId, id, revisionId);
    return { ...await readDocumentOriginal(options, principal, revision), revision };
  });
  app.get("/api/projects/:projectId/documents/:id/revisions/:revisionId/body", async request => {
    const { projectId, id, revisionId } = paramsSchema.parse(request.params);
    const { cursor, limit } = z.strictObject({ cursor: z.coerce.number().int().safe().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(8192).optional() }).parse(request.query);
    const principal = scoped(request.principal, projectId, "read");
    const revision = await fixedRevision(principal, projectId, id, revisionId);
    const bytes = await fixedPart(options, principal, revision, undefined, verifiedBodies);
    return { projectId, documentId: id, revisionId, contentHash: revision.contentHash,
      format: revision.format, mediaType: revision.mediaType, ...bodyPage(bytes, cursor ?? 0, limit ?? 4096) };
  });
  app.get("/api/projects/:projectId/documents/:id/revisions/:revisionId/assets/:blobId", async request => {
    const { projectId, id, revisionId, blobId } = paramsSchema.extend({ blobId: idSchema }).parse(request.params);
    const principal = scoped(request.principal, projectId, "read");
    const revision = await fixedRevision(principal, projectId, id, revisionId);
    const asset = revision.assetsManifest.find(item => item.blobId === blobId);
    if (!asset) throw new DomainError("NOT_FOUND", "Asset is not in the fixed manifest");
    const bytes = await fixedPart(options, principal, revision, blobId);
    return { projectId, documentId: id, revisionId, documentContentHash: revision.contentHash,
      blobId, path: asset.path, mediaType: asset.mediaType,
      contentHash: asset.contentHash, size: asset.size, base64: bytes.toString("base64") };
  });
}
