import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idSchema, type Principal, type BasisSet, type TaskRevision } from "@evoloop/contracts";
import type { DocumentPayloadRevision, DocumentPayloadUnitOfWork } from "@evoloop/contracts/process-documents";
import type { ReferenceUnitOfWork } from "@evoloop/contracts/references";
import { DomainError } from "@evoloop/contracts/ports";

interface Options {
  workflow: {
    getTaskRevision(principal: Principal, projectId: string, taskId: string, revisionId: string): Promise<{ revision: TaskRevision; basis: BasisSet | null }>;
    getDocumentPayloadRevision(principal: Principal, projectId: string, documentId: string, revisionId: string): Promise<DocumentPayloadRevision>;
  };
  documents: DocumentPayloadUnitOfWork;
  references?: ReferenceUnitOfWork;
}

/** A small manifest. Neither Task content nor document bodies nor asset bytes enter this response. */
export function registerTaskMaterialRoutes(app: FastifyInstance, options: Options): void {
  app.get("/api/projects/:projectId/tasks/:id/revisions/:revisionId/materials", async request => {
    const { projectId, id: taskId, revisionId } = z.strictObject({ projectId: idSchema, id: idSchema,
      revisionId: idSchema }).parse(request.params);
    const principal = request.principal;
    if (!principal || !principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN", "Project read permission is required");
    const { revision, basis } = await options.workflow.getTaskRevision(principal, projectId, taskId, revisionId);
    if (revision.projectId !== projectId || revision.taskId !== taskId || revision.id !== revisionId ||
      (revision.basisSetId === null) !== (basis === null) || basis &&
      (basis.projectId !== projectId || basis.taskId !== taskId || basis.taskRevisionId !== revisionId ||
       basis.id !== revision.basisSetId || basis.sealed !== true || basis.members.length > 20))
      throw new DomainError("BASIS_UNAVAILABLE", "Fixed Task revision or basis scope is invalid");
    const members = [{ documentId: revision.contentDocumentId, revisionId: revision.contentRevisionId },
      ...(basis?.members ?? []).filter(item => item.documentId !== revision.contentDocumentId)];
    if (members.length > 21 || new Set(members.map(item => item.documentId)).size !== members.length ||
      basis?.members.some(item => item.documentId === revision.contentDocumentId && item.revisionId !== revision.contentRevisionId))
      throw new DomainError("BASIS_UNAVAILABLE", "Fixed Task basis conflicts with primary content");
    const documents = [];
    for (const [index, member] of members.entries()) {
      const fixed = await options.workflow.getDocumentPayloadRevision(principal, projectId, member.documentId, member.revisionId);
      if (fixed.projectId !== projectId || fixed.documentId !== member.documentId || fixed.id !== member.revisionId ||
          fixed.assetsManifest.length > 50 || !/^[0-9a-f]{64}$/i.test(fixed.contentHash))
        throw new DomainError("ORIGINAL_UNAVAILABLE", "Fixed document metadata is invalid");
      const registered = fixed.payloadRef ? await options.documents.read(projectId, reader => reader.getRegisteredBlob(fixed.payloadRef!)) : null;
      if (fixed.body === null && (!registered || registered.projectId !== projectId ||
          registered.documentId !== member.documentId || registered.revisionId !== member.revisionId ||
          registered.role !== "main" || registered.contentHash !== fixed.contentHash))
        throw new DomainError("ORIGINAL_UNAVAILABLE", "Fixed document size metadata is unavailable");
      const root = `evoloop`;
      const common = `--project ${projectId} --revision ${fixed.id} --hash ${fixed.contentHash}`;
      documents.push({ purpose: index === 0 ? "task_content" : "sealed_basis", required: true,
        background: index !== 0, documentId: fixed.documentId, revisionId: fixed.id,
        contentHash: fixed.contentHash, sizeBytes: registered?.size ?? Buffer.byteLength(fixed.body ?? "", "utf8"),
        format: fixed.format, mediaType: fixed.mediaType, originalName: fixed.originalName,
        bodyCommand: `${root} body ${fixed.documentId} ${common}`,
        assets: fixed.assetsManifest.map(asset => ({ blobId: asset.blobId, path: asset.path,
          sizeBytes: asset.size, mediaType: asset.mediaType, contentHash: asset.contentHash,
          readCommand: `${root} asset ${fixed.documentId} ${common} --id ${asset.blobId} --asset-hash ${asset.contentHash}` })) });
    }
    const snapshots = options.references ? await options.references.read(projectId, reader => reader.listTaskExternalSnapshot(taskId, revisionId)) : [];
    if (snapshots.length > 100 || snapshots.some(item => item.projectId !== projectId || item.taskId !== taskId || item.taskRevisionId !== revisionId))
      throw new DomainError("BASIS_UNAVAILABLE", "Fixed external snapshot scope is invalid");
    const externalReferences = snapshots.map(item => ({ kind: item.kind, slotId: item.slotId,
      referenceId: item.referenceId, revision: item.revision, contentHash: item.contentHash,
      decision: item.decision, readCommand: item.kind === "git" ? `evoloop read git ${item.referenceId} --project ${projectId}` :
        item.kind === "wiki" ? `evoloop knowledge ${item.referenceId} --project ${projectId} --revision ${item.revision}` :
        `evoloop read run ${item.referenceId} --project ${projectId} --trace` }));
    return { projectId, taskId, taskRevisionId: revisionId, basisSetId: basis?.id ?? null,
      title: revision.title, acceptanceBytes: Buffer.byteLength(revision.acceptance, "utf8"),
      taskRevisionCommand: `evoloop task ${taskId} --project ${projectId} --revision ${revisionId}`,
      documents, externalReferences };
  });
}
