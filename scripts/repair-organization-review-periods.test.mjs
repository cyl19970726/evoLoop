import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  commandHashForPlan,
  parseDocumentRevisionCopy,
  planOrganizationReviewRepair,
} from "./repair-organization-review-periods.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const firstRevisionId = "33333333-3333-4333-8333-333333333333";
const secondRevisionId = "44444444-4444-4444-8444-444444444444";
const previousDocumentId = "55555555-5555-4555-8555-555555555555";
const previousRevisionId = "66666666-6666-4666-8666-666666666666";
const period = {
  observedFrom: "2026-11-01T00:00:00Z",
  observedTo: "2026-11-02T00:00:00Z",
  timeZone: "Asia/Taipei",
  previous: { documentId: previousDocumentId, revisionId: previousRevisionId },
};
const hash = value => createHash("sha256").update(value).digest("hex");
const sourceRow = (revisionId, body, organizationReview, index = 1) => ({
  project_id: projectId,
  document_id: documentId,
  revision_id: revisionId,
  body,
  format: "markdown",
  content_hash: hash(body),
  author: "acceptance-owner",
  created_at: `2026-11-0${index}T00:00:00.000Z`,
  previous_revision_id: index === 1 ? null : firstRevisionId,
  reason: `reason ${index}`,
  media_type: "text/markdown",
  original_name: "report.md",
  payload_ref: null,
  entrypoint: null,
  assets_manifest: "[]",
  organization_review: organizationReview === null ? null : JSON.stringify(organizationReview),
});
const targetRow = (revisionId, body, organizationReview, index = 1) => ({
  project_id: projectId,
  document_id: documentId,
  revision_id: revisionId,
  body,
  format: "markdown",
  content_hash: hash(body),
  author: "acceptance-owner",
  created_at: `2026-11-0${index}T00:00:00.000Z`,
  previous_revision_id: index === 1 ? null : firstRevisionId,
  reason: `reason ${index}`,
  media_type: "text/markdown",
  original_name: "report.md",
  payload_ref: null,
  entrypoint: null,
  assets_manifest: [],
  organization_review: organizationReview,
  revision_number: index,
});
const documents = new Map([[documentId, {
  document_id: documentId,
  kind: "organization_review",
  current_revision_id: secondRevisionId,
}]]);

test("the document_revision COPY block keeps tabs, newlines, backslashes, nulls and Chinese text", () => {
  const columns = ["project_id", "document_id", "revision_id", "body", "format", "content_hash", "author",
    "created_at", "previous_revision_id", "reason", "media_type", "original_name", "payload_ref", "entrypoint",
    "assets_manifest", "organization_review"];
  const body = "第一行\t制表\n第二行\\路径";
  const encoded = body.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");
  const fields = [projectId, documentId, firstRevisionId, encoded, "markdown", "a".repeat(64),
    "acceptance-owner", "2026-11-01 00:00:00+05", "\\N", "理由", "text/markdown", "report.md",
    "\\N", "\\N", "[]", JSON.stringify(period)];
  const sql = `-- data\nCOPY public.document_revision (${columns.join(", ")}) FROM stdin;\n${fields.join("\t")}\n\\.\n`;
  const parsed = parseDocumentRevisionCopy(sql);
  assert.deepEqual(parsed.columns, columns);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].body, body);
  assert.equal(parsed.rows[0].previous_revision_id, null);
  assert.deepEqual(JSON.parse(parsed.rows[0].organization_review), period);
});

test("a COPY row with the wrong field count is refused", () => {
  const columns = ["project_id", "document_id", "revision_id", "body", "format", "content_hash", "author",
    "created_at", "previous_revision_id", "reason", "media_type", "original_name", "payload_ref", "entrypoint",
    "assets_manifest", "organization_review"];
  const sql = `COPY public.document_revision (${columns.join(", ")}) FROM stdin;\nonly-one-field\n\\.\n`;
  assert.throws(() => parseDocumentRevisionCopy(sql), /instead of 16/);
});

test("the plan changes only null organizationReview values and leaves matching rows alone", () => {
  const source = [sourceRow(firstRevisionId, "one", period, 1), sourceRow(secondRevisionId, "two", period, 2)];
  const target = [targetRow(firstRevisionId, "one", period, 1), targetRow(secondRevisionId, "two", null, 2)];
  const plan = planOrganizationReviewRepair({
    projectId, documentIds: [documentId], sourceRows: source, targetRows: target, documents,
  });
  assert.equal(plan.status, "planned");
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(plan.changes.map(change => change.revisionId), [secondRevisionId]);
  assert.deepEqual(plan.already.map(change => change.revisionId), [firstRevisionId]);
});

test("a non-organizationReview difference blocks the plan", () => {
  const source = [sourceRow(firstRevisionId, "one", period, 1)];
  const target = [targetRow(firstRevisionId, "changed", null, 1)];
  const plan = planOrganizationReviewRepair({
    projectId, documentIds: [documentId], sourceRows: source, targetRows: target, documents,
  });
  assert.equal(plan.status, "blocked");
  assert.deepEqual(plan.blocked[0].fields, ["body", "content_hash"]);
});

test("a target with a different native period is a conflict, not an overwrite", () => {
  const source = [sourceRow(firstRevisionId, "one", period, 1)];
  const target = [targetRow(firstRevisionId, "one", { ...period, observedTo: "2026-11-03T00:00:00Z" }, 1)];
  const plan = planOrganizationReviewRepair({
    projectId, documentIds: [documentId], sourceRows: source, targetRows: target, documents,
  });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.blocked[0].code, "TARGET_PERIOD_DIFFERS");
});

test("a missing target revision or a current revision without a period blocks the plan", () => {
  const source = [sourceRow(firstRevisionId, "one", period, 1)];
  const target = [targetRow(secondRevisionId, "two", null, 2)];
  const plan = planOrganizationReviewRepair({
    projectId, documentIds: [documentId], sourceRows: source, targetRows: target, documents,
  });
  assert.equal(plan.status, "blocked");
  assert.ok(plan.blocked.some(item => item.code === "TARGET_REVISION_NOT_FOUND"));
  assert.ok(plan.blocked.some(item => item.code === "CURRENT_REVISION_WITHOUT_PERIOD"));
});

test("the command hash is stable across object key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  const change = {
    documentId,
    revisionId: secondRevisionId,
    before: { organization_review: null },
    after: period,
  };
  const first = commandHashForPlan({ projectId, actorId: "author", sourceDumpSha256: "a".repeat(64), changes: [change] });
  const second = commandHashForPlan({ projectId, actorId: "author", sourceDumpSha256: "a".repeat(64), changes: [change] });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});
