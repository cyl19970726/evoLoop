// A cursor list read page by page under one key (shared/query.ts useProjectPages): 载入更多 reads only the next page,
// a failed next page keeps the loaded ones, a failed reread keeps them as 上次读回, and the coverage line claims 已读完
// only for a list just read. Kept out of query.ts so the first-load bundle (sign-in, project list) does not carry it.
import { useCallback, useEffect, useMemo } from "react";
import type { ListCoverage } from "./listCoverage";
import { useProjectPages } from "./query";

/** Items of the loaded pages in order, each once (a later page's copy replaces an earlier one in place). */
export function pagedItems<T>(pages: readonly { items: readonly T[] }[], identity: (item: T) => string): T[] {
  const items = new Map<string, T>();
  for (const page of pages) for (const item of page.items) items.set(identity(item), item);
  return [...items.values()];
}

export interface ProjectListState {
  /** Pages loaded. */
  pages: number;
  /** More pages exist after the loaded ones. */
  more: boolean;
  /** The first page is on its way and nothing is shown yet. */
  reading: boolean;
  /** The loaded pages are read again; what is shown is the previous answer. */
  checking: boolean;
  /** The next page is on its way. */
  loadingMore: boolean;
  /** The latest failure: the first page (`failed`), a reread (`stale`) or the next page (`pageFailed`). */
  error: Error | null;
  /** Nothing was ever read: the first page failed. Never shown as 上次读回. */
  failed: boolean;
  /** A reread of the loaded pages failed; the items are 上次读回，当前待核对. */
  stale: boolean;
  /** The next page failed (这一页没读到); the loaded items are still what was read. `loadMore` retries that page only. */
  pageFailed: boolean;
  /** A cursor came back that was seen before; the list stops there. */
  repeatedCursor: boolean;
  coverage: ListCoverage;
  observedAt: number;
}

export interface ProjectList<T> extends ProjectListState {
  /** The loaded pages' items, each once; undefined until the first page is read. */
  items: T[] | undefined;
  /** Read the next page, and only that page. Two components asking at once share one request. */
  loadMore(): void;
}

/** The part of an infinite query result a list's state is decided from. */
export interface PagedResult {
  data: { pages: readonly { nextCursor: string | null }[] } | undefined;
  error: Error | null; isPending: boolean; isFetching: boolean; isFetchingNextPage: boolean; isError: boolean;
  isFetchNextPageError: boolean; isRefetchError: boolean; hasNextPage: boolean; dataUpdatedAt: number;
}

/** A list's flags from its query result, as one pure decision (tested without React). */
export function projectListState(result: PagedResult): ProjectListState {
  const loaded = result.data?.pages;
  const last = loaded?.at(-1);
  const more = !!result.hasNextPage;
  const reading = result.isPending && result.isFetching;
  const failed = result.isError && result.data === undefined;
  const pageFailed = result.isFetchNextPageError;
  const stale = result.isRefetchError;
  const checking = result.isFetching && !result.isFetchingNextPage && result.data !== undefined;
  return {
    pages: loaded?.length ?? 0, more, reading, checking, loadingMore: result.isFetchingNextPage,
    error: result.error, failed, stale, pageFailed, repeatedCursor: !!last?.nextCursor && !more,
    coverage: failed ? "failed" : result.data === undefined ? "reading" : stale ? "stale" : checking ? "checking" : "current",
    observedAt: result.dataUpdatedAt,
  };
}

/**
 * A cursor list read page by page under one key: 载入更多 reads one more page instead of the whole range again (the
 * old way sent 210 requests to reach page 20). With `target`, it keeps reading pages until that many items are loaded,
 * the pages run out, `maxPages` are loaded, or a page fails (then it waits for loadMore). Only a component on screen
 * (`active`) reads further by itself. Another filter is another key: it starts from its own first page.
 */
export function useProjectList<T, P extends { items: T[]; nextCursor: string | null }>(projectId: string, key: readonly unknown[],
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<P>, identity: (item: T) => string,
  options: { enabled?: boolean; target?: number; maxPages?: number; active?: boolean } = {}): ProjectList<T> {
  const query = useProjectPages<P>(projectId, key, read, { enabled: options.enabled });
  const state = projectListState(query);
  const loaded = query.data?.pages;
  const items = useMemo(() => loaded ? pagedItems(loaded, identity) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded]);
  const { fetchNextPage } = query;
  const loadMore = useCallback(() => { void fetchNextPage({ cancelRefetch: false }); }, [fetchNextPage]);
  const wantMore = !!items && state.more && options.active !== false && options.target !== undefined
    && items.length < options.target && state.pages < (options.maxPages ?? Number.POSITIVE_INFINITY)
    && !query.isFetching && !query.isError;
  useEffect(() => { if (wantMore) loadMore(); }, [wantMore, state.pages, loadMore]);
  return { ...state, items, loadMore };
}

