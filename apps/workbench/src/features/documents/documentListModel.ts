import type { Document, Page } from "@evoloop/contracts";
import type { LeaderWorkDocument } from "@evoloop/contracts/work-index";

/**
 * One page of the document list, checked before it joins the loaded pages (shared/query.ts useProjectList reads one
 * page at a time and stops at a cursor it has seen before).
 */
export function validDocumentPage(page: Page<Document>, projectId: string, cursor?: string): void {
  if (page.items.length > 50 || page.items.some(item => item.projectId !== projectId))
    throw new Error("文档列表分页响应与当前项目不符");
  if (page.nextCursor && page.nextCursor === cursor)
    throw new Error("文档分页游标重复，无法确认后续结果");
}

export function documentLifecycleMatches(document: Document, projection: LeaderWorkDocument): boolean {
  return projection.documentId === document.id && projection.version === document.version &&
    projection.currentRevisionId === document.currentRevisionId &&
    projection.adoptedRevisionId === document.adoptedRevisionId && projection.status === document.status;
}
