import assert from "node:assert/strict";
import { test } from "node:test";
import type { Document } from "@evoloop/contracts";
import type { LeaderWorkDocument } from "@evoloop/contracts/work-index";
import { documentLifecycleMatches, mergeDocumentPage, validDocumentPage } from "../src/documents/documentListModel.ts";

const document: Document = { projectId: "project-a", id: "document-a", title: "原件", version: 2,
  currentRevisionId: "revision-2", adoptedRevisionId: "revision-1", kind: "report", status: "published" };
const lifecycle: LeaderWorkDocument = { kind: "document", documentId: document.id, version: 2, title: document.title,
  documentKind: "report", status: "published", currentRevisionId: "revision-2", adoptedRevisionId: "revision-1",
  nextAction: "核对使用", dates: { createdAt: "2026-10-01", currentRevisionAt: "2026-10-02", adoptedAt: "2026-10-01",
    changedAt: "2026-10-02", observedAt: "2026-10-02" }, references: [], actionKey: "review" };

test("Document paging rejects cross-project and repeating-cursor responses", () => {
  assert.throws(() => validDocumentPage({ items: [{ ...document, projectId: "project-b" }], nextCursor: null }, "project-a"), /当前项目/);
  assert.throws(() => validDocumentPage({ items: [document], nextCursor: "same" }, "project-a", "same"), /游标重复/);
  assert.doesNotThrow(() => validDocumentPage({ items: [document], nextCursor: "next" }, "project-a", "current"));
});

test("Document pagination keeps existing rows and adds new IDs once", () => {
  const next = mergeDocumentPage({ items: [document], nextCursor: "cursor" },
    { items: [{ ...document, title: "重复" }, { ...document, id: "document-b" }], nextCursor: null });
  assert.deepEqual(next.items.map(item => item.title), ["原件", "原件"]);
  assert.equal(next.nextCursor, null);
});

test("lifecycle text is shown only for the exact Document version and publication state", () => {
  assert.equal(documentLifecycleMatches(document, lifecycle), true);
  assert.equal(documentLifecycleMatches(document, { ...lifecycle, version: 3 }), false);
  assert.equal(documentLifecycleMatches(document, { ...lifecycle, adoptedRevisionId: "revision-2" }), false);
  assert.equal(documentLifecycleMatches(document, { ...lifecycle, documentId: "document-b" }), false);
});
