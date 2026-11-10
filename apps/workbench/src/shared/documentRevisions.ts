// A document's revisions, newest first, as the revision list gives them (contracts.md, GET /documents/:id/revisions):
// metadata only, numbered per document (第 N 版), with the document head of the same read. The state of a revision
// (当前版, 已发布) holds only for the head that came with its page, so after another page is loaded every loaded item is
// judged again by the newest page's head. When the newest page counts more revisions than the first did, newer ones
// sit above the first page and the reader is offered to go back to it; a head that changed without a new revision (it
// was published, archived or restored) only means the states were judged again. Used by 过程文档 (all versions,
// 第 N 版 / 共 M 版), 评价 (choosing a fixed document version) and 仓库规范 (choosing a process revision). Pure; the reads
// are in useDocumentRevisions.ts.
import type { DocumentRevisionPage, DocumentRevisionSummary, DocumentStatus } from "@evoloop/contracts";
import { errorCode } from "./errorPresentation";
import { revisionOrigin } from "./revisionPresentation";

export type RevisionHead = DocumentRevisionPage["document"];

export interface RevisionListModel {
  /** Every loaded revision once, newest first, its state judged by `head`. */
  items: DocumentRevisionSummary[];
  /** The document head of the page read last. */
  head: RevisionHead;
  /** 共 M 版: the revision count the page read last gave. */
  count: number;
  /** More revisions now than when the first page was read: the newer ones are above the first page. */
  newer: boolean;
  /** The head changed since the first page (published, archived, restored or revised): the states were judged again. */
  restated: boolean;
}

/**
 * What went wrong reading further pages, if anything: the server refused the cursor (INVALID_CURSOR: start again from
 * the first page), a cursor came back that was seen before (the list stops; what follows was not read), or the next
 * page failed otherwise.
 */
export function revisionPageProblem(state: { pageFailed: boolean; error: unknown; repeatedCursor: boolean }):
  "cursor_refused" | "repeated_cursor" | "page_failed" | null {
  if (state.pageFailed) return errorCode(state.error) === "INVALID_CURSOR" ? "cursor_refused" : "page_failed";
  return state.repeatedCursor ? "repeated_cursor" : null;
}

/** A revision's state against one document head. */
export function judgedRevision<T extends { id: string }>(item: T, head: Pick<RevisionHead, "currentRevisionId" | "adoptedRevisionId">) {
  const current = item.id === head.currentRevisionId, published = item.id === head.adoptedRevisionId;
  return { ...item, current, published, state: current ? "current" as const : published ? "published" as const : "historical" as const };
}

/** The loaded pages as one list (pure, so the pages that use it and their tests agree). Null before the first page. */
export function revisionListModel(pages: readonly DocumentRevisionPage[]): RevisionListModel | null {
  const first = pages[0], last = pages.at(-1);
  if (!first || !last) return null;
  const byId = new Map<string, DocumentRevisionSummary>();
  for (const page of pages) for (const item of page.items) byId.set(item.id, item);
  const items = [...byId.values()].sort((a, b) => b.revisionNumber - a.revisionNumber).map(item => judgedRevision(item, last.document));
  return { items, head: last.document, count: last.revisionCount, newer: last.revisionCount > first.revisionCount,
    restated: last.document.version !== first.document.version };
}

/**
 * How a revision stands, in words. An archived document keeps its publish pointer, so the version published before
 * it was archived is not called 已发布.
 */
export function revisionStateText(item: { current: boolean; published: boolean }, status: DocumentStatus): string {
  const published = item.published ? status === "archived" ? "归档前发布的版本" : "已发布" : "";
  if (item.current) return published ? `当前版 · ${published}` : "当前版";
  return published || "历史版";
}

/**
 * 第 N 版 / 共 M 版. M is the list's count, not N of the current revision: an older document numbered by time may not
 * end at its count before its next revision. Null without a number; only 第 N 版 while the count is not known.
 */
export function revisionNumberText(number: number | null | undefined, count: number | null | undefined): string | null {
  if (!number) return null;
  return count ? `第 ${number} 版 / 共 ${count} 版` : `第 ${number} 版`;
}

/** A revision's reason on one line, cut for a list row; the whole reason stays on the revision itself. */
export function shortReason(text: string, max = 40): string {
  const one = text.trim().replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * When, by whom and why, for a list row: the author and reason as the page says them (revisionPresentation: a
 * schedule's or the service's own wording in Chinese, never its identifiers), the reason cut to one line.
 */
export function revisionLine(item: { createdAt: string; author: string; reason: string }, when?: (iso: string) => string, max?: number): string {
  const origin = revisionOrigin({ actorId: item.author, reason: item.reason });
  return [when?.(item.createdAt), origin.author, shortReason(origin.reason, max)].filter(Boolean).join(" · ");
}
