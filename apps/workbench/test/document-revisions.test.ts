// A document's revision list (GET /documents/:id/revisions) as 过程文档, 评价 and 仓库规范 use it: pages joined newest
// first, every loaded item judged again by the newest page's head, newer revisions offered back on the first page (a
// head that changed without one only restates), the problems of later pages, 第 N 版 / 共 M 版 with M from the list's
// count, and a revision's who and why in the page's words.
import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentRevisionPage, DocumentRevisionSummary } from "@evoloop/contracts";
import { ApiError } from "../src/shared/api.ts";
import { judgedRevision, revisionLine, revisionListModel, revisionNumberText, revisionPageProblem, revisionStateText } from "../src/shared/documentRevisions.ts";

const id = (n: number) => `7000000${n}-0000-4000-8000-00000000000${n}`;
const documentId = id(9);
const summary = (n: number, head: { currentRevisionId: string; adoptedRevisionId: string | null }): DocumentRevisionSummary =>
  judgedRevision({ projectId: "p", documentId, id: id(n), revisionNumber: n, format: "markdown", mediaType: "text/markdown", originalName: "a.md",
    payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "a".repeat(64), author: "lead", createdAt: `2026-11-0${n}T01:00:00.000Z`,
    previousRevisionId: n > 1 ? id(n - 1) : null, reason: `第 ${n} 次修订`, state: "historical", current: false, published: false }, head);
const head = (version: number, current: number, adopted: number | null) =>
  ({ id: documentId, title: "接口说明", kind: "spec" as const, version, currentRevisionId: id(current), adoptedRevisionId: adopted ? id(adopted) : null, status: "published" as const });
const page = (items: number[], document: ReturnType<typeof head>, count: number, nextCursor: string | null = null): DocumentRevisionPage =>
  ({ items: items.map(n => summary(n, document)), nextCursor, document, revisionCount: count });

test("pages are joined newest first, and every loaded item is judged by the newest page's head", () => {
  // The first page was read when 第 4 版 was current and 第 3 版 published; by the second page 第 5 版 is current and published.
  const first = page([4, 3], head(6, 4, 3), 4, "c1");
  const second = page([2, 1], head(8, 5, 5), 5);
  const model = revisionListModel([first, second])!;
  assert.deepEqual(model.items.map(item => [item.revisionNumber, item.state]), [[4, "historical"], [3, "historical"], [2, "historical"], [1, "historical"]]);
  assert.equal(model.count, 5, "共 M 版 comes from the newest page");
  assert.deepEqual([model.newer, model.restated], [true, true], "a revision was saved since the first page: offer to go back");
  assert.equal(model.head.version, 8);
  const steady = revisionListModel([page([4, 3], head(6, 4, 3), 4, "c1"), page([2, 1], head(6, 4, 3), 4)])!;
  assert.deepEqual([steady.newer, steady.restated], [false, false]);
  assert.deepEqual(steady.items.map(item => item.state), ["current", "published", "historical", "historical"]);
  assert.equal(revisionListModel([]), null, "nothing read yet");
});

test("published, archived or restored between pages: states judged again, no newer revision claimed", () => {
  // Publishing advances the document's version but saves no revision: the count stays.
  const model = revisionListModel([page([2], head(2, 2, null), 2, "c"), page([1], head(3, 2, 2), 2)])!;
  assert.deepEqual([model.newer, model.restated, model.count], [false, true, 2]);
  assert.deepEqual(model.items.map(item => item.state), ["current", "historical"], "the newest head decides: 第 2 版 is current (and now published)");
  assert.equal(model.items[0]!.published, true);
});

test("what went wrong reading further pages: a refused cursor, a repeated one, or a failed page", () => {
  const refused = new ApiError(409, "读取位置无效", { code: "INVALID_CURSOR", message: "读取位置无效" });
  assert.equal(revisionPageProblem({ pageFailed: true, error: refused, repeatedCursor: false }), "cursor_refused", "start again from the first page");
  assert.equal(revisionPageProblem({ pageFailed: true, error: new ApiError(503, "暂不可用"), repeatedCursor: false }), "page_failed");
  assert.equal(revisionPageProblem({ pageFailed: false, error: null, repeatedCursor: true }), "repeated_cursor", "the list stops: what follows was not read");
  assert.equal(revisionPageProblem({ pageFailed: false, error: null, repeatedCursor: false }), null);
  // A first page that failed is not a later page's problem.
  assert.equal(revisionPageProblem({ pageFailed: false, error: refused, repeatedCursor: false }), null);
});

test("an item read on two pages appears once", () => {
  const model = revisionListModel([page([3, 2], head(5, 3, null), 3, "c"), page([2, 1], head(5, 3, null), 3)])!;
  assert.deepEqual(model.items.map(item => item.revisionNumber), [3, 2, 1]);
});

test("how a revision stands, in words; an archived document's published version is not called 已发布", () => {
  assert.equal(revisionStateText({ current: true, published: true }, "published"), "当前版 · 已发布");
  assert.equal(revisionStateText({ current: true, published: false }, "draft"), "当前版");
  assert.equal(revisionStateText({ current: false, published: true }, "published"), "已发布");
  assert.equal(revisionStateText({ current: false, published: true }, "archived"), "归档前发布的版本");
  assert.equal(revisionStateText({ current: false, published: false }, "published"), "历史版");
});

test("第 N 版 / 共 M 版 takes M from the list, and says only what is known", () => {
  assert.equal(revisionNumberText(3, 5), "第 3 版 / 共 5 版", "an older document numbered by time: N need not be M");
  assert.equal(revisionNumberText(3, undefined), "第 3 版", "the count is still being read");
  assert.equal(revisionNumberText(undefined, 5), null, "a revision without a number says nothing");
});

test("who and why are said in the page's words, never with the service's identifiers", () => {
  const when = (iso: string) => iso.slice(0, 10);
  assert.equal(revisionLine({ createdAt: "2026-11-03T01:00:00.000Z", author: "lead", reason: "补充\n接口说明" }, when), "2026-11-03 · lead · 补充 接口说明");
  assert.equal(revisionLine({ createdAt: "2026-11-03T01:00:00.000Z", author: "lead", reason: "Initial draft" }), "lead · 初稿");
  assert.match(revisionLine({ createdAt: "2026-11-03T01:00:00.000Z", author: "lead", reason: "很".repeat(60) }), /很{40}…$/);
});
