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
