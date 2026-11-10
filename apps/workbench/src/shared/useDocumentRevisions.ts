// Reading a document's revision list (shared/documentRevisions.ts says what it is): one page checked against the
// document asked for, the head alone (to name a document without reading its text), and the list page by page.
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DocumentRevisionPage } from "@evoloop/contracts";
import { api } from "./api";
import { revisionListModel, type RevisionHead } from "./documentRevisions";
import { errorCode } from "./errorPresentation";
import { queryKeys, useProjectPages } from "./query";

/** The key the revision list of one document is read under (a reread of the document rereads it too). */
export const revisionListKey = (documentId: string) => ["document", documentId, "revisions"] as const;

/** One page, checked to be about this document of this project. */
export async function readRevisionPage(projectId: string, documentId: string, cursor: string | undefined, signal: AbortSignal, limit = 50): Promise<DocumentRevisionPage> {
  const page = await api().documentRevisions(projectId, documentId, { cursor, limit }, signal);
  if (!page || !Array.isArray(page.items) || page.document?.id !== documentId || typeof page.revisionCount !== "number"
    || page.items.some(item => item.projectId !== projectId || item.documentId !== documentId || typeof item.revisionNumber !== "number"))
    throw new Error("修订列表与所选文档不符");
  return page;
}

/** The document's head (title, current and published revision) without reading any text: the first revision of the list. */
export async function readRevisionHead(projectId: string, documentId: string, signal?: AbortSignal): Promise<RevisionHead & { count: number }> {
  const page = await readRevisionPage(projectId, documentId, undefined, signal ?? new AbortController().signal, 1);
  return { ...page.document, count: page.revisionCount };
}

/** The revision list of one document, page by page, with the way back to the first page. */
export function useDocumentRevisions(projectId: string, documentId: string, options: { enabled?: boolean } = {}) {
  const client = useQueryClient();
  const key = revisionListKey(documentId);
  const query = useProjectPages<DocumentRevisionPage>(projectId, key, (cursor, signal) => readRevisionPage(projectId, documentId, cursor, signal),
    { enabled: (options.enabled ?? true) && !!documentId });
  const model = query.data ? revisionListModel(query.data.pages) : null;
  // The cursor no longer fits (another document, another project, or one the server cannot read): start again.
  const cursorRefused = query.pageFailed && errorCode(query.error) === "INVALID_CURSOR";
  const fromFirst = useCallback(() => { void client.resetQueries({ queryKey: queryKeys.project(projectId, ...revisionListKey(documentId)) }); },
    [client, projectId, documentId]);
  return {
    model, reading: query.isPending && query.isFetching, failed: query.isError && !query.data, stale: query.stale,
    pageFailed: query.pageFailed, cursorRefused, error: query.error, checking: query.checking,
    more: query.hasNextPage, loadingMore: query.isFetchingNextPage, loadMore: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    fromFirst, reread: () => { void query.refetch(); },
  };
}
export type DocumentRevisionList = ReturnType<typeof useDocumentRevisions>;
