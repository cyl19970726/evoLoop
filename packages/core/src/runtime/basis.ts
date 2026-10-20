import type { BasisSet } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { Transaction } from "@evoloop/contracts/ports";

/** A retained older basis remains valid only against the currently adopted replacement. */
export async function validateDispatchBasis(tx: Transaction, taskId: string, basis: BasisSet): Promise<void> {
  const impacts = await tx.listImpacts(taskId);
  const decisions = await tx.listBasisDecisions(taskId);
  for (const member of basis.members) {
    const document = await tx.getDocument(member.documentId);
    const revision = await tx.getDocumentRevision(member.documentId, member.revisionId);
    if (!document || !revision || !document.adoptedRevisionId) {
      throw new DomainError("BASIS_UNAVAILABLE", "sealed basis source is missing or unadopted");
    }
    if (document.adoptedRevisionId === member.revisionId) continue;
    const retained = impacts.some(impact =>
      impact.documentId === member.documentId && impact.fromRevisionId === member.revisionId &&
      impact.toRevisionId === document.adoptedRevisionId && impact.state === "resolved" &&
      decisions.some(decision => decision.impactId === impact.id && decision.decision === "retain"));
    if (!retained) {
      throw new DomainError("BASIS_CHANGED", "adopted document changed without an explicit retained-basis decision");
    }
  }
}
