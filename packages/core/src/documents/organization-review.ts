import type { Document, DocumentRevision, OrganizationReview } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";

export function reviewMetadata(kind: Document["kind"], next?: OrganizationReview, retained?: OrganizationReview): OrganizationReview | undefined {
  if (kind !== "organization_review") {
    if (next) throw new DomainError("INVALID_REVIEW_METADATA", "Observation metadata belongs to an organization review Document");
    return undefined;
  }
  const value = next ?? retained;
  if (!value) throw new DomainError("REVIEW_PERIOD_REQUIRED", "Organization reviews need their observation period");
  return value;
}

export async function validatePreviousReview(
  value: OrganizationReview | undefined, projectId: string, documentId: string,
  getDocument: (id: string) => Promise<Document | null>,
  getRevision: (id: string, revision: string) => Promise<Pick<DocumentRevision, "projectId" | "organizationReview"> | null>,
): Promise<void> {
  const previous = value?.previous;
  if (!previous) return;
  if (previous.documentId === documentId) throw new DomainError("INVALID_PREVIOUS_REVIEW", "A round references a different review Document");
  const document = await getDocument(previous.documentId);
  const revision = await getRevision(previous.documentId, previous.revisionId);
  if (!document || document.projectId !== projectId || document.kind !== "organization_review" ||
      !revision || revision.projectId !== projectId || !revision.organizationReview)
    throw new DomainError("INVALID_PREVIOUS_REVIEW", "Previous review must be a readable fixed organization review in this project");
}
