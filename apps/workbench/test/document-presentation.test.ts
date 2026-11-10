import assert from "node:assert/strict";
import { test } from "node:test";
import type { Document, DocumentDetail, DocumentRevision } from "@evoloop/contracts";
import {
  coverageText, documentReturnPlace, emptyListText, kindText, markdownSource, publicationText, readingStanding, referenceText,
} from "../src/features/documents/documentPresentation.ts";
import { returnText } from "../src/shared/returnLink.ts";
import type { Original } from "../src/shared/ui/OriginalDocumentReader.tsx";
import {
  automaticItemLimit, initialListState, isFiltered, loadMoreTarget, nextListState, pageSize, pagesFor,
} from "../src/features/documents/documentListState.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const revision = (id: string): DocumentRevision => ({ projectId, documentId: "doc", id, body: "正文", format: "markdown",
  mediaType: "text/markdown", originalName: "a.md", payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "a".repeat(64),
  author: "writer", createdAt: "2026-11-01T00:00:00.000Z", previousRevisionId: null, reason: "修订" });
const detail = (current: string, adopted: string | null): Pick<DocumentDetail, "current" | "adopted"> =>
  ({ current: revision(current), adopted: adopted ? revision(adopted) : null });
const document = (patch: Partial<Document>): Document => ({ projectId, id: "doc-a", title: "方案", version: 1, currentRevisionId: "r2",
  adoptedRevisionId: "r2", kind: "spec", status: "published", ...patch });

test("the reader always knows which version is on screen and whether a newer one exists", () => {
  assert.deepEqual(readingStanding("r2", detail("r2", "r2")), { label: "当前版 · 已发布", historical: false, note: null });
  const unpublished = readingStanding("r2", detail("r2", "r1"));
  assert.equal(unpublished.label, "当前版 · 尚未发布");
  assert.equal(unpublished.historical, false);
  assert.match(unpublished.note ?? "", /已发布的是较早一版/);
  assert.equal(readingStanding("r2", detail("r2", null)).note, null, "a never published document has nothing older to warn about");
  const published = readingStanding("r1", detail("r2", "r1"));
  assert.equal(published.label, "已发布版 · 不是当前版");
  assert.equal(published.historical, true);
  const historical = readingStanding("r0", detail("r2", "r1"));
  assert.equal(historical.label, "固定历史版");
  assert.equal(historical.historical, true);
  assert.match(historical.note ?? "", /当前版已更新/);
  for (const standing of [unpublished, published, historical]) assert.doesNotMatch(`${standing.label}${standing.note}`, /r[0-9]/, "no raw revision IDs in reading text");
});

test("list words keep lifecycle, publication and references apart", () => {
  assert.equal(publicationText(document({ status: "draft" })), "尚未发布");
  assert.equal(publicationText(document({ adoptedRevisionId: null })), "尚未发布");
  assert.equal(publicationText(document({})), "当前与发布版一致");
  assert.equal(publicationText(document({ adoptedRevisionId: "r1" })), "有未发布的修订");
  assert.equal(referenceText(["link", "basis"]), "固定依据");
  assert.equal(referenceText(["content"]), "任务正文");
  assert.equal(referenceText(["link"]), "已关联");
  assert.equal(kindText(null), "未分类");
  assert.equal(kindText("report"), "报告");
});

test("the return link names where it goes back to", () => {
  const label = (path: string, name?: string) => returnText(documentReturnPlace(path, projectId).place, name);
  assert.equal(label(`/p/${projectId}/documents`), "返回文档列表");
  assert.equal(label(`/p/${projectId}/tasks/${projectId}?tab=runtime`, "任务甲"), "返回任务：任务甲", "the task's name, read by the link");
  assert.equal(label(`/p/${projectId}/tasks/${projectId}?tab=runtime`), "返回任务");
  assert.equal(label(`/p/${projectId}/sessions?session=owned:${projectId}&tab=results`), "返回智能体");
  assert.equal(label(`/p/${projectId}/runtime?session=owned:${projectId}`), "返回智能体", "an older agent link opens the conversation");
  assert.equal(label(`/p/${projectId}/runtime?session=${projectId}`), "返回分工与运行");
  assert.equal(label(`/p/${projectId}/runtime`), "返回分工与运行");
  assert.equal(label(`/p/${projectId}/work`), "返回任务列表");
  assert.equal(label(`/p/${projectId}/overview`), "返回总览");
  assert.equal(documentReturnPlace("/", projectId).href, `/p/${projectId}/documents`, "outside the project: back to the list");
});

test("the coverage line says what was read and the empty list says why it is empty", () => {
  assert.equal(coverageText({ loaded: 50, matched: 3, filtered: true, more: true }), "已载入 50 项 · 匹配 3 项 · 后续页面未读");
  assert.equal(coverageText({ loaded: 12, matched: 12, filtered: false, more: false }), "已载入 12 项 · 已读完");
  assert.match(emptyListText({ filtered: true, more: true }).reason, /载入更多/);
  assert.equal(emptyListText({ filtered: false, more: false }).title, "还没有过程文档");
});

test("list conditions widen the range once for a search and keep it after the search is cleared", () => {
  assert.equal(isFiltered(initialListState), false);
  const searching = nextListState(initialListState, { query: "方案" });
  assert.equal(searching.target, automaticItemLimit);
  assert.equal(pagesFor(searching), automaticItemLimit / pageSize);
  assert.equal(isFiltered(searching), true);
  const typing = nextListState({ ...searching, target: 700 }, { query: "方案二" });
  assert.equal(typing.target, 700, "typing more does not shrink a range loaded by hand");
  const cleared = nextListState(searching, { query: "" });
  assert.equal(cleared.target, automaticItemLimit, "clearing the search keeps the loaded range");
  assert.equal(nextListState(initialListState, { kind: "report" }).target, pageSize);
  assert.equal(loadMoreTarget({ target: pageSize }, 50), 100);
  assert.equal(loadMoreTarget({ target: 500 }, 120), 550);
  assert.equal(pagesFor({ target: 1 }), 1);
});

test("Markdown kept only as its original is read from the original, and each way that read can fail is kept apart", () => {
  const stored = { ...revision("r3"), body: null, payloadRef: "blob-r3" };
  const original = (patch: object) => ({ revision: stored, ...patch }) as Original;
  assert.deepEqual(markdownSource("内联正文", { error: null }), { state: "ready", text: "内联正文" }, "an inline body needs no original");
  assert.deepEqual(markdownSource(null, { data: undefined, error: null }), { state: "reading" });
  assert.deepEqual(markdownSource(null, { data: original({ status: "available", body: "# 上传的正文\n\n## 第一节", assets: [] }), error: null }),
    { state: "ready", text: "# 上传的正文\n\n## 第一节" });
  const failure = new Error("连接中断");
  assert.deepEqual(markdownSource(null, { data: undefined, error: failure }), { state: "failed", error: failure });
  assert.deepEqual(markdownSource(null, { data: original({ status: "available", body: "上次读到的原件", assets: [] }), error: failure }),
    { state: "ready", text: "上次读到的原件" }, "an original already read stays when a later read fails");
  assert.deepEqual(markdownSource(null, { data: original({ status: "unavailable", reason: "hash mismatch" }), error: null }),
    { state: "unavailable", reason: "hash mismatch" });
});
