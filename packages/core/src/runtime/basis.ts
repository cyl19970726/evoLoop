import type { BasisRetention, BasisSet, DocumentBasis } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { Reader } from "@evoloop/contracts/ports";

type BasisReader = Pick<Reader, "getDocument" | "getDocumentRevision" | "hasDocumentAdoption" |
  "listImpacts" | "listBasisDecisions">;

/** New revisions carry only checkpoints still matching their fixed member and current published head. */
export async function currentRetentions(tx: Pick<Reader, "getDocument">, basis: BasisSet,
  members: DocumentBasis[] = basis.members): Promise<BasisRetention[] | undefined> {
  const kept: BasisRetention[] = [];
  for (const retention of basis.retentions ?? []) {
    if (!members.some(member => member.documentId === retention.documentId && member.revisionId === retention.revisionId)) continue;
    const document = await tx.getDocument(retention.documentId);
    if (document?.adoptedRevisionId === retention.observedAdoptedRevisionId)
      kept.push({ ...retention });
  }
  return kept.length ? kept : undefined;
}

/** Both task.update reselection and task.start check the same selected external sources. */
export async function validateSelectedExternalBasis(tx: BasisReader,
  projectId: string, taskId: string, taskRevisionId: string, primaryDocumentId: string,
  linked: Set<string>, extras: DocumentBasis[],
  retentions: BasisRetention[]): Promise<void> {
  if (extras.length > 19) throw new DomainError("BASIS_LIMIT", "Select at most 19 extra sources alongside the primary content");
  if (new Set(extras.map(item => item.documentId)).size !== extras.length ||
      extras.some(item => item.documentId === primaryDocumentId))
    throw new DomainError("DUPLICATE_DOCUMENT", "Basis must use distinct linked documents; primary is automatic");
  for (const item of extras) {
    if (!linked.has(item.documentId)) throw new DomainError("UNLINKED_DOCUMENT", "Basis document must be linked to the Task");
    const doc = await tx.getDocument(item.documentId);
    if (!doc) throw new DomainError("NOT_FOUND", "Basis document was not found");
    if (doc.projectId !== projectId) throw new DomainError("BASIS_UNAVAILABLE", "Basis document is outside this project");
    if (!doc.adoptedRevisionId)
      throw new DomainError("UNPUBLISHED_BASIS", "Basis must pin a published document revision");
    const revision = await tx.getDocumentRevision(doc.id, item.revisionId);
    if (!revision) throw new DomainError("NOT_FOUND", "Basis revision was not found");
    if (revision.projectId !== projectId) throw new DomainError("BASIS_UNAVAILABLE", "Basis revision is outside this project");
  }
  if (retentions.some(item => item.documentId === primaryDocumentId || !linked.has(item.documentId)))
    throw new DomainError("INVALID_RETENTION", "Only selected linked external documents may be retained");
  await validateDispatchBasis(tx, taskId, { projectId, taskId, taskRevisionId, id: primaryDocumentId,
    members: extras, sealed: true, ...(retentions.length ? { retentions } : {}) });
}

/** A new input choice checks inline bytes or registered Blob metadata; actual Blob bytes are read at original GET. */
export async function validateReselectedOriginals(tx: Pick<Reader, "getDocument" | "getDocumentRevision" | "getRegisteredBlob">,
  projectId: string, extras: DocumentBasis[], hash: (body: string) => string): Promise<void> {
  for (const item of extras) {
    const doc = await tx.getDocument(item.documentId);
    const revision = await tx.getDocumentRevision(item.documentId, item.revisionId);
    if (!doc || doc.projectId !== projectId || doc.status !== "published" || !revision || revision.projectId !== projectId)
      throw new DomainError("BASIS_UNAVAILABLE", "Selected source original is unavailable");
    if (revision.body !== null) {
      if (revision.payloadRef || revision.assetsManifest.length || hash(revision.body) !== revision.contentHash)
        throw new DomainError("BASIS_UNAVAILABLE", "Selected source original does not match its fixed hash");
      continue;
    }
    if (!revision.payloadRef) throw new DomainError("BASIS_UNAVAILABLE", "Selected source original is missing");
    const resources = [{ id: revision.payloadRef, role: "main" as const, path: null, size: null,
      contentHash: revision.contentHash, mediaType: revision.mediaType },
    ...revision.assetsManifest.map(asset => ({ id: asset.blobId, role: "asset" as const,
      path: asset.path, size: asset.size, contentHash: asset.contentHash, mediaType: asset.mediaType }))];
    for (const resource of resources) {
      const blob = await tx.getRegisteredBlob(resource.id);
      if (!blob || blob.projectId !== projectId || blob.documentId !== doc.id ||
          blob.revisionId !== revision.id || blob.role !== resource.role ||
          blob.relativePath !== resource.path || blob.contentHash !== resource.contentHash ||
          blob.mediaType !== resource.mediaType || resource.size !== null && blob.size !== resource.size)
        throw new DomainError("BASIS_UNAVAILABLE", "Selected source original resource is unavailable");
    }
  }
}

/** A retained older basis remains valid only against the currently adopted replacement. */
export async function validateDispatchBasis(tx: BasisReader, taskId: string, basis: BasisSet): Promise<void> {
  const impacts = await tx.listImpacts(taskId);
  const decisions = await tx.listBasisDecisions(taskId);
  const retentions = basis.retentions ?? [];
  if (new Set(retentions.map(item => item.documentId)).size !== retentions.length)
    throw new DomainError("INVALID_RETENTION", "A source can be retained only once in one sealed basis");
  for (const retention of retentions) {
    const member = basis.members.find(item => item.documentId === retention.documentId);
    if (!member || member.revisionId !== retention.revisionId ||
      !retention.reason.trim() || !retention.actorId || !retention.createdAt ||
      retention.observedAdoptedRevisionId === retention.revisionId)
      throw new DomainError("INVALID_RETENTION", "Retention must name the selected older source and a reviewer reason");
  }
  for (const member of basis.members) {
    const document = await tx.getDocument(member.documentId);
    const revision = await tx.getDocumentRevision(member.documentId, member.revisionId);
    if (!document || !revision || !document.adoptedRevisionId) {
      throw new DomainError("BASIS_UNAVAILABLE", "sealed basis source is missing or unadopted");
    }
    const checkpoint = retentions.find(item => item.documentId === member.documentId);
    if (checkpoint && checkpoint.observedAdoptedRevisionId !== document.adoptedRevisionId)
      throw new DomainError("BASIS_CHANGED", "Retained source observation is no longer current");
    if (document.adoptedRevisionId === member.revisionId) {
      if (checkpoint) throw new DomainError("INVALID_RETENTION", "Current source does not need a retention");
      continue;
    }
    if (!await tx.hasDocumentAdoption(member.documentId, member.revisionId))
      throw new DomainError("BASIS_UNAVAILABLE", "Older fixed basis revision was never adopted");
    const retained = impacts.some(impact =>
      impact.documentId === member.documentId && impact.fromRevisionId === member.revisionId &&
      impact.toRevisionId === document.adoptedRevisionId && impact.state === "resolved" &&
      decisions.some(decision => decision.impactId === impact.id && decision.decision === "retain"));
    if (checkpoint && retained)
      throw new DomainError("INVALID_RETENTION", "A resolved impact already records retention of this source");
    if (!retained && !checkpoint) {
      throw new DomainError("BASIS_CHANGED", "adopted document changed without an explicit retained-basis decision");
    }
  }
}
