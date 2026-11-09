import type { Document, Page } from "@evoloop/contracts";
import type { LeaderWorkDocument } from "@evoloop/contracts/work-index";

export function validDocumentPage(page: Page<Document>, projectId: string, cursor?: string): void {
  if (page.items.length > 50 || page.items.some(item => item.projectId !== projectId))
    throw new Error("文档列表分页响应与当前项目不符");
  if (page.nextCursor && page.nextCursor === cursor)
    throw new Error("文档分页游标重复，无法确认后续结果");
}

export function mergeDocumentPage(current: Page<Document>, next: Page<Document>): Page<Document> {
  const ids = new Set(current.items.map(item => item.id));
  return { items: [...current.items, ...next.items.filter(item => !ids.has(item.id))], nextCursor: next.nextCursor };
}

/**
 * Read the list from its first page until at least `minimumItems` are loaded, the pages run out, or `maxPages` pages
 * were read. A refresh reads the whole range again before any visible row is replaced.
 */
export async function readDocumentRange(read: (cursor?: string) => Promise<Page<Document>>, projectId: string, minimumItems: number,
  maxPages = Number.POSITIVE_INFINITY) {
  let page = await read();
  validDocumentPage(page, projectId);
  const cursors = new Set<string>();
  let pages = 1;
  while (page.nextCursor && page.items.length < minimumItems && pages < maxPages) {
    const cursor = page.nextCursor;
    if (cursors.has(cursor)) throw new Error("文档分页游标重复，无法确认后续结果");
    cursors.add(cursor);
    const next = await read(cursor);
    validDocumentPage(next, projectId, cursor);
    if (next.nextCursor && cursors.has(next.nextCursor)) throw new Error("文档分页游标重复，无法确认后续结果");
    page = mergeDocumentPage(page, next);
    pages++;
  }
  return { page, pages, cursors };
}

export function documentLifecycleMatches(document: Document, projection: LeaderWorkDocument): boolean {
  return projection.documentId === document.id && projection.version === document.version &&
    projection.currentRevisionId === document.currentRevisionId &&
    projection.adoptedRevisionId === document.adoptedRevisionId && projection.status === document.status;
}
