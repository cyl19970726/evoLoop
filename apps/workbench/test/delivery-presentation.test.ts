import assert from "node:assert/strict";
import { test } from "node:test";
import type { Document, DocumentRevision } from "@evoloop/contracts";
import { deliveryTarget, verifiedDocumentTitle } from "../src/workflow/deliveryPresentation.ts";

const projectId = "044d070e-d191-4844-883b-6c782984de73";
const otherProject = "c868a7c4-ec96-4902-a9dc-4c659a6e24a4";
const documentId = "cab939b9-65f6-4fdf-96c4-19fe05553891";
const oldRevision = "57b32f9d-6f8e-4b56-a4f3-22f2d5ab53b7";
const newRevision = "12063894-eab6-4b00-a5bb-4faa6223ce14";
const hash = "ec685fb8637d724d7e98c94c1641fb4775c69920da5e6a858dcda02bbb3226e5";
const input = { artifactRef: `http://127.0.0.1:55421/#/p/${projectId}/documents/${documentId}?revision=${oldRevision}`, artifactRevision: oldRevision, contentHash: hash };
const document = { projectId, id: documentId, title: "两条历史待办的处置清单", currentRevisionId: newRevision, adoptedRevisionId: newRevision } as Document;
const revision = { projectId, documentId, id: oldRevision, contentHash: hash } as DocumentRevision;

test("same-project fixed Document link resolves to the old revision, not today's adopted revision", () => {
  const target = deliveryTarget(input, projectId);
  assert.equal(target.kind, "document");
  if (target.kind !== "document") return;
  assert.equal(target.href, `#/p/${projectId}/documents/${documentId}?revision=${oldRevision}`);
  assert.equal(target.revisionId, oldRevision);
  assert.equal(verifiedDocumentTitle(input, target, projectId, document, revision), document.title);
  assert.equal(verifiedDocumentTitle(input, target, projectId, document, { ...revision, id: newRevision }), null);
  assert.equal(verifiedDocumentTitle(input, target, projectId, document, { ...revision, contentHash: "0".repeat(64) }), null);
  assert.equal(verifiedDocumentTitle(input, target, projectId, { ...document, projectId: otherProject }, revision), null);
});

test("a mismatched version, foreign project, external URL or unsafe scheme never earns a document title", () => {
  assert.deepEqual(deliveryTarget({ ...input, artifactRevision: newRevision }, projectId), { kind: "fallback", label: "链接与交付固定修订不一致", href: null });
  assert.equal(deliveryTarget({ ...input, artifactRef: `#/p/${otherProject}/documents/${documentId}?revision=${oldRevision}` }, projectId).kind, "fallback");
  assert.deepEqual(deliveryTarget({ ...input, artifactRef: `http://127.0.0.1:55421/#/p/${otherProject}/documents/${documentId}?revision=${oldRevision}` }, projectId), { kind: "fallback", label: "其他项目或无法核实的本机链接", href: null });
  const external = deliveryTarget({ ...input, artifactRef: "https://example.test/report?revision=old" }, projectId);
  assert.deepEqual(external, { kind: "fallback", label: "外部产物 · example.test", href: "https://example.test/report?revision=old" });
  assert.deepEqual(deliveryTarget({ ...input, artifactRef: "javascript:alert(1)" }, projectId), { kind: "fallback", label: "无法安全打开的产物引用", href: null });
});

test("an unreadable UUID title is not presented as a human-friendly name", () => {
  const target = deliveryTarget(input, projectId);
  if (target.kind !== "document") throw new Error("Expected fixed document");
  assert.equal(verifiedDocumentTitle(input, target, projectId, { ...document, title: `${documentId}.md` }, revision), null);
});

test("real fixed knowledge delivery opens the actual version while keeping the separate declared build version", () => {
  const knowledgeId = "2b026d3e-8cfd-4989-9809-1b0f97d0064b";
  const knowledgeRevision = "66fce895-291e-4940-87c9-3ac31c249c5e";
  const declared = "knowledge-reader PR21 merge e5732277 + 390px patch PR23 cea2529; deployed isolated 55421";
  const ref = `#/p/${projectId}/knowledge?knowledgeId=${knowledgeId}&knowledgeRevision=${knowledgeRevision}`;
  assert.deepEqual(deliveryTarget({ ...input, artifactRef: `http://127.0.0.1:55421/${ref}`, artifactRevision: declared }, projectId),
    { kind: "knowledge", revisionId: knowledgeRevision, href: ref, label: "知识固定版本入口" });
  for (const bad of [
    `#/p/${otherProject}/knowledge?knowledgeId=${knowledgeId}&knowledgeRevision=${knowledgeRevision}`,
    `${ref}&review=1`, `${ref}&knowledgeId=${knowledgeId}`, `${ref}&knowledgeRevision=${knowledgeRevision}`,
    `#/p/${projectId}/knowledge?knowledgeId=${knowledgeId}&knowledgeRevision=bad`,
  ]) assert.equal(deliveryTarget({ ...input, artifactRef: `http://127.0.0.1:55421/${bad}` }, projectId).href, null, bad);
});

test("evaluation delivery opens only this project's exact definition revision", () => {
  const evaluationId = "2b026d3e-8cfd-4989-9809-1b0f97d0064b";
  const ref = `#/p/${projectId}/evaluations/${evaluationId}?revision=${oldRevision}`;
  assert.deepEqual(deliveryTarget({ ...input, artifactRef: `http://127.0.0.1:55421/${ref}`, artifactRevision: "deployed build 123" }, projectId),
    { kind: "evaluation", revisionId: oldRevision, href: ref, label: "评价固定定义入口" });
  for (const bad of [
    `#/p/${otherProject}/evaluations/${evaluationId}?revision=${oldRevision}`,
    `${ref}&revision=${oldRevision}`, `${ref}&action=run`,
    `#/p/${projectId}/evaluations/${evaluationId}?revision=bad`,
  ]) assert.equal(deliveryTarget({ ...input, artifactRef: `http://127.0.0.1:55421/${bad}` }, projectId).href, null, bad);
});
