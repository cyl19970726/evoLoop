import test from "node:test";
import assert from "node:assert/strict";
import type { Document, DocumentRevision, OrganizationReview } from "@evoloop/contracts";
import { validatePreviousReview } from "../src/documents/organization-review.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const currentDocumentId = "22222222-2222-4222-8222-222222222222";
const previousDocumentId = "33333333-3333-4333-8333-333333333333";
const previousRevisionId = "44444444-4444-4444-8444-444444444444";
const missingDocumentId = "55555555-5555-4555-8555-555555555555";
const missingRevisionId = "66666666-6666-4666-8666-666666666666";
const otherMissingDocumentId = "77777777-7777-4777-8777-777777777777";
const otherMissingRevisionId = "88888888-8888-4888-8888-888888888888";
const period = {
  observedFrom: "2026-11-01T00:00:00Z",
  observedTo: "2026-11-02T00:00:00Z",
  timeZone: "Asia/Taipei",
};
const document = (kind: Document["kind"] = "organization_review") =>
  ({ projectId, kind } as Document);
const revision = (organizationReview: OrganizationReview | undefined) =>
  ({ projectId, organizationReview } as Pick<DocumentRevision, "projectId" | "organizationReview">);
const rejectsPrevious = (promise: Promise<void>) =>
  assert.rejects(promise, error => error instanceof Error && "code" in error && error.code === "INVALID_PREVIOUS_REVIEW");

test("a previous review with its native observation period can be linked", async () => {
  await validatePreviousReview(
    { ...period, previous: { documentId: previousDocumentId, revisionId: previousRevisionId } },
    projectId,
    currentDocumentId,
    async () => document(),
    async () => revision(period),
  );
});

test("a retained link to a document outside the selective migration is tolerated", async () => {
  const retained = {
    ...period,
    previous: { documentId: missingDocumentId, revisionId: missingRevisionId },
  };
  await validatePreviousReview(
    retained,
    projectId,
    currentDocumentId,
    async () => null,
    async () => null,
    retained,
  );
});

test("a newly chosen link to a missing document is rejected", async () => {
  await rejectsPrevious(validatePreviousReview(
    { ...period, previous: { documentId: missingDocumentId, revisionId: missingRevisionId } },
    projectId,
    currentDocumentId,
    async () => null,
    async () => null,
  ));
});

test("replacing a retained missing link is rejected", async () => {
  const retained = {
    ...period,
    previous: { documentId: missingDocumentId, revisionId: missingRevisionId },
  };
  await rejectsPrevious(validatePreviousReview(
    { ...period, previous: { documentId: otherMissingDocumentId, revisionId: otherMissingRevisionId } },
    projectId,
    currentDocumentId,
    async () => null,
    async () => null,
    retained,
  ));
});

test("a previous Document that exists but is not an organization review is rejected", async () => {
  await rejectsPrevious(validatePreviousReview(
    { ...period, previous: { documentId: previousDocumentId, revisionId: previousRevisionId } },
    projectId,
    currentDocumentId,
    async () => document("report"),
    async () => revision(period),
  ));
});

test("a previous review revision without its own period is rejected", async () => {
  await rejectsPrevious(validatePreviousReview(
    { ...period, previous: { documentId: previousDocumentId, revisionId: previousRevisionId } },
    projectId,
    currentDocumentId,
    async () => document(),
    async () => revision(undefined),
  ));
});
