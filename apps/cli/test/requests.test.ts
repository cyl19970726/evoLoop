import assert from "node:assert/strict";
import test from "node:test";
import { prepareRequest, requestSchema, requestTypes, RequestInputError } from "../src/requests.ts";

const project = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const operation = "00000000-0000-4000-8000-000000000003";
const target = "00000000-0000-4000-8000-000000000004";
const receipt = "00000000-0000-4000-8000-000000000005";
const revision = "00000000-0000-4000-8000-000000000006";
const sha = "a".repeat(64);

test("registry exposes every bounded named route and target/body requirements", () => {
  const names = (requestTypes() as Array<{ name: string; requiredBodyKeys: string[]; targetId: string | null }>);
  assert.deepEqual(names.map(item => item.name), [
    "document.import", "knowledge.ingest", "knowledge.propose", "knowledge.review", "knowledge.publish", "knowledge.reconcile", "knowledge.retract-source",
    "reference.git-register", "reference.formal-decide", "reference.task-decide", "runtime.reconcile", "runtime.recover",
  ]);
  assert.ok(names.find(item => item.name === "document.import")?.requiredBodyKeys.includes("command.operationId"));
  assert.equal(names.find(item => item.name === "knowledge.reconcile")?.targetId, "original publish operationId");
  assert.ok(names.find(item => item.name === "reference.task-decide")?.requiredBodyKeys.includes("expectedHeadVersion"));
});

test("request schema exposes exact enums and nested required fields from shared contracts", () => {
  const candidate = requestSchema("knowledge.propose") as any;
  const ingest = requestSchema("knowledge.ingest") as any;
  assert.deepEqual(ingest.required, ["operationId", "documentId", "revisionId"]);
  assert.ok(candidate.required.includes("sources"));
  assert.deepEqual(candidate.properties.pageType.enum, ["topic", "concept", "analysis", "decision"]);
  assert.deepEqual(candidate.properties.epistemicStatus.enum, ["observation", "inference", "hypothesis", "adopted", "disputed", "superseded"]);
  assert.ok(candidate.properties.sources.items.required.includes("documentId"));
  assert.ok(candidate.properties.sources.items.required.includes("revisionId"));
  const review = requestSchema("knowledge.review") as any;
  assert.deepEqual(review.properties.decision.enum, ["accept", "reject"]);
  const imported = requestSchema("document.import") as any;
  assert.ok(imported.required.includes("command"));
  assert.ok(imported.properties.command.properties.source.anyOf || imported.properties.command.properties.source.oneOf);
  const reference = requestSchema("reference.task-decide") as any;
  assert.ok(reference.required.includes("expectedHeadVersion"));
  assert.ok(!reference.required.includes("projectId"));
  assert.ok(!reference.required.includes("actorId"));
  assert.ok(!reference.required.includes("taskId"));
  const runtime = requestSchema("runtime.reconcile") as any;
  assert.deepEqual(runtime.required, ["expectedVersion", "reason"]);
});

test("local request validation emits specific INVALID_INPUT instead of generic errors", () => {
  for (const check of [
    () => requestSchema("absent"),
    () => prepareRequest("knowledge.propose", project, { operationId: operation }),
    () => prepareRequest("knowledge.review", project, { candidateRevision: revision, contentHash: sha,
      expectedRevision: null, decision: "maybe", reason: "Checked" }, target, receipt),
  ]) assert.throws(check, error => error instanceof RequestInputError && error.code === "INVALID_INPUT" && error.message.length > 10);
});

test("project and route IDs cannot be changed by the body", () => {
  assert.throws(() => prepareRequest("unknown", project, {}), /Unsupported request/);
  assert.throws(() => prepareRequest("knowledge.publish", project, { projectId: other, operationId: operation }, target), /differs/);
  assert.throws(() => prepareRequest("document.import", project, { command: { projectId: other }, uploads: [] }), /differs/);
  assert.throws(() => prepareRequest("reference.task-decide", project, { operationId: operation, taskId: other }, target), /differs/);
  assert.throws(() => prepareRequest("runtime.reconcile", project, { expectedVersion: 1, reason: "Check", operationId: operation }, target, receipt), /no server operationId/);
});

test("journal-backed requests carry the exact server operation and core recovery path", () => {
  const body = { command: { projectId: project, operationId: operation, documentId: target, revisionId: revision,
    mode: "create", title: "Imported", format: "markdown", mediaType: "text/markdown", originalName: "sample.md",
    author: "requesting-actor", reason: "Import", source: { storage: "inline", body: "Fixed text" } }, uploads: [] };
  const imported = prepareRequest("document.import", project, body);
  assert.equal(imported.body, body, "the registry does not silently rewrite upload data");
  assert.equal(imported.path, `/api/projects/${project}/documents/import`);
  assert.deepEqual({ id: imported.id, operationId: imported.operationId, recovery: imported.recovery, confirmation: imported.confirmation },
    { id: operation, operationId: operation, recovery: { kind: "core", path: `/api/projects/${project}/operations/${operation}` }, confirmation: "command" });
  const git = prepareRequest("reference.git-register", project, { operationId: operation, referenceId: target,
    repositoryId: "source-repo", path: "docs/accepted.md", commit: "a".repeat(40), contentHash: sha });
  assert.equal(git.path, `/api/projects/${project}/references/git`);
  assert.equal(git.operationId, operation);
  assert.throws(() => prepareRequest("knowledge.publish", project, { operationId: operation }, target, receipt), /not --receipt/);
});

test("knowledge routes distinguish candidate, publish and manual decision recovery", () => {
  const ingested = prepareRequest("knowledge.ingest", project, { operationId: operation, documentId: target, revisionId: revision });
  assert.equal(ingested.path, `/api/projects/${project}/knowledge/ingestions`);
  assert.deepEqual(ingested.recovery, { kind: "ingestion", path: `/api/projects/${project}/knowledge/ingestions/${operation}` });
  assert.equal(ingested.confirmation, "ingestion");
  assert.throws(() => prepareRequest("knowledge.ingest", project, { operationId: operation, documentId: target, revisionId: revision, extra: true }), /invalid/);
  assert.throws(() => prepareRequest("knowledge.ingest", project, { operationId: operation, documentId: target, revisionId: "latest" }), /invalid/);
  const candidateBody = { operationId: operation, knowledgeId: target, candidateId: receipt,
    candidateRevision: revision, expectedRevision: null, title: "Finding", body: "Claim with source",
    pageType: "analysis", epistemicStatus: "inference", sources: [{ documentId: target, revisionId: revision, fragment: null }] };
  const proposed = prepareRequest("knowledge.propose", project, candidateBody);
  assert.equal(proposed.confirmation, "candidate");
  assert.deepEqual(proposed.recovery, { kind: "candidate", path: `/api/projects/${project}/knowledge/candidates/${receipt}` });
  const review = prepareRequest("knowledge.review", project, { candidateRevision: revision, contentHash: sha,
    expectedRevision: null, decision: "accept", reason: "Checked" }, target, receipt);
  assert.equal(review.id, receipt);
  assert.equal(review.operationId, null);
  assert.equal(review.targetId, target);
  assert.equal(review.confirmation, "review");
  assert.equal(review.recovery.kind, "manual", "candidate state cannot prove the lost review reply");
  const published = prepareRequest("knowledge.publish", project, { operationId: operation }, target);
  assert.deepEqual(published.recovery, { kind: "publish", path: `/api/projects/${project}/knowledge/operations/${operation}/reconcile` });
  const reconciled = prepareRequest("knowledge.reconcile", project, {}, operation, receipt);
  assert.equal(reconciled.id, receipt);
  assert.equal(reconciled.operationId, operation, "the target is the existing publish ID, not a new server operation");
  assert.equal(reconciled.path, `/api/projects/${project}/knowledge/operations/${operation}/reconcile`);
  assert.equal(reconciled.confirmation, "publish-reconcile");
  assert.throws(() => prepareRequest("knowledge.reconcile", project, {}, operation), /--receipt/);
  const retracted = prepareRequest("knowledge.retract-source", project, { operationId: operation }, target);
  assert.equal(retracted.path, `/api/projects/${project}/knowledge/sources/${target}/retract`);
  assert.equal(retracted.recovery.kind, "manual");
});

test("runtime observation requests need local receipts and never invent server operation IDs", () => {
  const run = prepareRequest("runtime.reconcile", project, { expectedVersion: 2, reason: "Read same native Turn" }, target, receipt);
  assert.equal(run.id, receipt);
  assert.equal(run.operationId, null);
  assert.equal(run.targetId, target);
  assert.equal(run.confirmation, "runtime-reconcile");
  assert.deepEqual(run.recovery, { kind: "manual", path: `/api/projects/${project}/runtime/runs/${target}/events` });
  const recover = prepareRequest("runtime.recover", project, {}, undefined, receipt);
  assert.equal(recover.operationId, null);
  assert.equal(recover.path, `/api/projects/${project}/runtime/recover`);
  assert.equal(recover.confirmation, "runtime-recover");
  assert.throws(() => prepareRequest("runtime.recover", project, {}), /--receipt/);
  assert.throws(() => prepareRequest("runtime.recover", project, { operationId: operation }, undefined, receipt), /no server operationId/);
});
