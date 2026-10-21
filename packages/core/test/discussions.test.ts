import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Document, DocumentRevision, Principal } from "@evoloop/contracts";
import { discussionCommands, type DiscussionEvent, type DiscussionRecord } from "@evoloop/contracts/discussions";
import type { Transaction } from "@evoloop/contracts/ports";
import { applyDiscussion } from "../src/discussions.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), discussionId = id(2), documentId = id(3), oldRevisionId = id(4), editedRevisionId = id(5);
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const principal: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };

function fixture() {
  const oldBody = "# Prepared discussion\nOriginal fixed handoff";
  const editedBody = "# Independently edited discussion\nOwner's actual change";
  let document: Document = { projectId, id: documentId, title: "Discussion", version: 5,
    currentRevisionId: editedRevisionId, adoptedRevisionId: oldRevisionId, kind: "discussion", status: "published" };
  let discussion: DiscussionRecord = { projectId, id: discussionId, version: 5, kind: "direction", status: "decided",
    documentId, preparedDocumentRevisionId: oldRevisionId, currentDocumentRevisionId: oldRevisionId,
    latestDecisionEventId: id(6), goal: { id: id(7), version: 1 }, stage: null, task: null,
    adoptedDocuments: [], question: "Next?", options: ["Continue"], authorizationBoundary: "Local review",
    targetSessionLabel: "Owner", targetSessionRef: null, actorId: principal.actorId,
    createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z" };
  const revisions = new Map<string, DocumentRevision>([
    [oldRevisionId, { projectId, documentId, id: oldRevisionId, body: oldBody, contentHash: hash(oldBody),
      format: "markdown", mediaType: "text/markdown", originalName: "discussion.md", payloadRef: null,
      entrypoint: null, assetsManifest: [], author: "owner", createdAt: "2026-10-21T00:00:00.000Z",
      previousRevisionId: null, reason: "Prepared" }],
    [editedRevisionId, { projectId, documentId, id: editedRevisionId, body: editedBody, contentHash: hash(editedBody),
      format: "markdown", mediaType: "text/markdown", originalName: "discussion.md", payloadRef: null,
      entrypoint: null, assetsManifest: [], author: "owner", createdAt: "2026-10-21T01:00:00.000Z",
      previousRevisionId: oldRevisionId, reason: "Independent edit" }],
  ]);
  const events: DiscussionEvent[] = [];
  const tx = {
    getDiscussion: async () => discussion,
    getDocument: async () => document,
    getDocumentRevision: async (_documentId: string, revisionId: string) => revisions.get(revisionId) ?? null,
    insertDocumentRevision: async (revision: DocumentRevision) => { revisions.set(revision.id, revision); },
    updateDocument: async (next: Document, expected: number) => {
      assert.equal(document.version, expected); document = next;
    },
    updateDiscussion: async (next: DiscussionRecord, expected: number, event: DiscussionEvent) => {
      assert.equal(discussion.version, expected); discussion = next; events.push(event);
    },
  } as unknown as Transaction;
  const command = { type: "discussion.decision.record" as const, projectId, operationId: id(8),
    discussionId, expectedVersion: 5, documentRevisionId: editedRevisionId,
    choice: "Continue with owner edit", reason: "Reviewer accepted the updated context",
    unresolved: "Trial result", relookCondition: "After trial", evidence: "Owner edited the document",
    supersedesDecisionEventId: id(6) };
  let next = 10;
  const apply = (overrides: Partial<typeof command> & { documentRecovery?: { expectedDocumentVersion: number; reason: string } } = {}) =>
    applyDiscussion({ tx, command: { ...command, ...overrides }, principal, now: "2026-10-21T02:00:00.000Z",
      nextId: () => id(next++), hasher: { hash } });
  return { apply, command, revisions, events, get document() { return document; },
    get discussion() { return discussion; }, setDocument(next: Document) { document = next; } };
}

test("explicit recovery appends provenance and a corrected decision from the actual edited head", async () => {
  const f = fixture();
  assert.equal(discussionCommands[2]!.safeParse({ ...f.command, documentRecovery: {
    expectedDocumentVersion: 5, reason: "Reviewed external edit" } }).success, true);
  await assert.rejects(f.apply(), error => (error as { code?: string }).code === "DOCUMENT_CHANGED");
  assert.equal(f.document.version, 5); assert.equal(f.events.length, 0);
  const outcome = await f.apply({ documentRecovery: { expectedDocumentVersion: 5,
    reason: "Reviewed external edit\n## Forged heading" } });
  assert.equal(outcome.result.status, "applied");
  assert.equal(f.document.version, 6);
  assert.equal(f.discussion.version, 6);
  assert.equal(f.discussion.preparedDocumentRevisionId, oldRevisionId);
  assert.equal(f.document.adoptedRevisionId, oldRevisionId);
  const revision = f.revisions.get(f.document.currentRevisionId)!;
  assert.equal(revision.previousRevisionId, editedRevisionId);
  assert.ok(revision.body!.startsWith("# Independently edited discussion\nOwner's actual change"));
  assert.match(revision.body!, new RegExp(`原讨论持有修订：${oldRevisionId}`));
  assert.match(revision.body!, new RegExp(`读入文档修订：${editedRevisionId}`));
  assert.match(revision.body!, /读入文档版本：v5/);
  assert.match(revision.body!, /重接理由："Reviewed external edit\\n## Forged heading"/);
  assert.match(revision.body!, /## 讨论决定/);
  assert.equal(revision.contentHash, hash(revision.body!));
  assert.equal(f.events[0]?.documentRevisionId, revision.id);
  assert.equal(f.events[0]?.supersedesDecisionEventId, id(6));
});

test("recovery fails closed on unchanged, stale, archived, malformed or mismatched Document", async () => {
  const cases: Array<{ mutate?: (f: ReturnType<typeof fixture>) => void; recoveryVersion?: number;
    documentRevisionId?: string; code: string }> = [
    { recoveryVersion: 4, code: "VERSION_CONFLICT" },
    { documentRevisionId: oldRevisionId, code: "DOCUMENT_CHANGED" },
    { mutate: f => f.setDocument({ ...f.document, currentRevisionId: oldRevisionId }), code: "RECOVERY_NOT_NEEDED" },
    { mutate: f => f.setDocument({ ...f.document, status: "archived" }), code: "DOCUMENT_ARCHIVED" },
    { mutate: f => f.setDocument({ ...f.document, projectId: id(99) }), code: "DOCUMENT_SCOPE" },
    { mutate: f => { f.revisions.get(editedRevisionId)!.contentHash = "0".repeat(64); }, code: "DOCUMENT_HASH_MISMATCH" },
    { mutate: f => { f.revisions.get(editedRevisionId)!.format = "html"; }, code: "DOCUMENT_FORMAT" },
  ];
  for (const item of cases) {
    const f = fixture(); item.mutate?.(f);
    await assert.rejects(f.apply({ documentRevisionId: item.documentRevisionId ?? editedRevisionId,
      documentRecovery: { expectedDocumentVersion: item.recoveryVersion ?? 5, reason: "Review" } }), error =>
      (error as { code?: string }).code === item.code, item.code);
    assert.equal(f.events.length, 0, `no decision may be appended after ${item.code}`);
  }
});
