// Server reads go through TanStack Query. Every key starts with the scope it belongs to (an identity or a
// project), so switching project or identity can cancel and drop exactly that scope. A reread keeps what is
// on screen and reports `checking` until the answer arrives; the cache only speeds up reads and never decides
// which version is current. A read that fails after an answer was shown keeps that answer, marked `stale`
// (上次读回，当前待核对); a list reads one more page at a time instead of the whole range again.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { QueryClient, useInfiniteQuery, useQuery, type InfiniteData, type QueryClient as Client, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryKeys = {
  /** Reads that belong to the signed-in identity rather than one project (the project list). */
  identity: (actorId: string, ...rest: readonly unknown[]) => ["identity", actorId, ...rest] as const,
  /** Everything read inside one project. */
  project: (projectId: string, ...rest: readonly unknown[]) => ["project", projectId, ...rest] as const,
};

/** 4xx answers are decisions (missing, forbidden, invalid), not hiccups: they are not retried. */
export function shouldRetry(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failures < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 10_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: shouldRetry },
      mutations: { retry: false },
    },
  });
}

/** Leaving a project: stop its requests and forget its answers, so nothing of it shows up elsewhere. */
export async function leaveProject(client: Client, projectId: string): Promise<void> {
  const queryKey = queryKeys.project(projectId);
  await client.cancelQueries({ queryKey });
  client.removeQueries({ queryKey });
}

/**
 * The first key part of reads whose content never changes once saved: a fixed document revision and its original
 * (an HTML report with its assets can be 16 MiB). They are read once: a write does not make them stale and they never
 * reread on their own. Leaving the project still drops them.
 */
export const fixedContent = "fixed-revision";

/** After a write in a project, every read of that project is stale and the visible ones reread; fixed content stays. */
export function projectChanged(client: Client, projectId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.project(projectId), predicate: query => query.queryKey[2] !== fixedContent });
}

export interface ProjectQueryOptions { enabled?: boolean; refetchInterval?: number | false; keepPrevious?: boolean }

/**
 * `keepPrevious`: a changed key (another filter, a longer range) shows the last answer while the new one is read. The
 * last answer must belong to the same project: a component that stays mounted across a project switch never shows the
 * old project's answer as a placeholder.
 */
export function previousOfProject(projectId: string) {
  return <T>(previous: T | undefined, query: { queryKey: QueryKey } | undefined): T | undefined =>
    query?.queryKey[0] === "project" && query.queryKey[1] === projectId ? previous : undefined;
}

/** What useProjectQuery asks of TanStack Query; tests observe a read through the same options. */
export function projectQueryOptions<T>(projectId: string, key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>,
  options: ProjectQueryOptions = {}) {
  return {
    queryKey: queryKeys.project(projectId, ...key) as QueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => read(signal),
    enabled: !!projectId && (options.enabled ?? true),
    ...(key[0] === fixedContent ? { staleTime: Infinity } : {}),
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
    ...(options.keepPrevious ? { placeholderData: previousOfProject(projectId) } : {}),
  };
}

/** The last answer a read got, kept by the component that shows it. */
export interface KeptAnswer<T> { projectId: string; data: T; updatedAt: number }
interface ReadResult<T> { data: T | undefined; isError: boolean; isPlaceholderData: boolean; dataUpdatedAt: number }
export interface KeptRead<T> {
  data: T | undefined;
  /** What is shown was read under another key (the previous filter or range). */
  isPlaceholderData: boolean;
  dataUpdatedAt: number;
  /** The latest read failed and what is shown is an earlier answer: 上次读回，当前待核对. */
  stale: boolean;
}

/**
 * What a read shows, given the last answer it got (`memory`, updated here). TanStack Query keeps a placeholder only
 * while the next key is pending: once that read fails its data is undefined, and a list on screen would empty. With
 * `keepPrevious`, the last answer of the same project stays instead, marked `stale`. The failed key stays the one asked
 * for, so a retry reads that key (the longer range), not the old one. A failed reread of the same key keeps its data
 * in TanStack itself and is marked `stale` the same way.
 */
export function keepLastAnswer<T>(projectId: string, result: ReadResult<T>, keepPrevious: boolean,
  memory: { current: KeptAnswer<T> | null }): KeptRead<T> {
  if (result.data !== undefined && !result.isPlaceholderData) memory.current = { projectId, data: result.data, updatedAt: result.dataUpdatedAt };
  const last = memory.current;
  if (keepPrevious && result.data === undefined && result.isError && last?.projectId === projectId)
    return { data: last.data, isPlaceholderData: true, dataUpdatedAt: last.updatedAt, stale: true };
  return { data: result.data, isPlaceholderData: result.isPlaceholderData, dataUpdatedAt: result.dataUpdatedAt,
    stale: result.isError && result.data !== undefined };
}

/**
 * A project read. `checking` is true while a reread runs and the previous answer is still on screen; `stale` is true
 * when the latest read failed and an earlier answer is on screen (上次读回，当前待核对). With `keepPrevious`, a changed
 * key (another filter, a longer range) keeps the last answer on screen until the new one arrives, and keeps it, marked
 * `stale`, if the new one fails. A key that starts with `fixedContent` is read once.
 */
export function useProjectQuery<T>(projectId: string, key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>,
  options: ProjectQueryOptions = {}) {
  const query = useQuery(projectQueryOptions(projectId, key, read, options));
  const memory = useRef<KeptAnswer<T> | null>(null);
  const kept = keepLastAnswer(projectId, query, !!options.keepPrevious, memory);
  // TanStack's result type stays (callers narrow on isPending / isError); a kept answer only adds data at run time.
  return { ...query, ...kept, checking: query.isFetching && kept.data !== undefined } as typeof query & { checking: boolean; stale: boolean };
}

/** Items of the loaded pages in order, each once (a later page's copy replaces an earlier one in place). */
export function pagedItems<T>(pages: readonly { items: readonly T[] }[], identity: (item: T) => string): T[] {
  const items = new Map<string, T>();
  for (const page of pages) for (const item of page.items) items.set(identity(item), item);
  return [...items.values()];
}

/** A cursor seen before would loop: the list stops there (and reports `repeatedCursor`). */
export function nextCursor(last: { nextCursor: string | null }, lastCursor: string | null, cursors: readonly (string | null)[]): string | null {
  return last.nextCursor && last.nextCursor !== lastCursor && !cursors.includes(last.nextCursor) ? last.nextCursor : null;
}

/** What useProjectPages asks of TanStack Query; tests observe a paged read through the same options. */
export function projectPagesOptions<T extends { nextCursor: string | null }>(projectId: string, key: readonly unknown[],
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<T>, options: { enabled?: boolean; keepPrevious?: boolean } = {}) {
  return {
    queryKey: queryKeys.project(projectId, ...key) as QueryKey,
    queryFn: ({ pageParam, signal }: { pageParam: string | null; signal: AbortSignal }) => read(pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: T, _pages: T[], lastCursor: string | null, cursors: (string | null)[]) => nextCursor(last, lastCursor, cursors),
    enabled: !!projectId && (options.enabled ?? true),
    retry: false,
    ...(options.keepPrevious ? { placeholderData: previousOfProject(projectId) } : {}),
  };
}

/**
 * A paged project read (a list API with cursors). Pages load on request and stay together under one key, so every
 * component showing the list shares them; a reread refetches the loaded pages in order. Not retried: a failed page
 * is reported and loaded again on request, never silently repeated.
 */
export function useProjectPages<T extends { nextCursor: string | null }>(projectId: string, key: readonly unknown[],
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<T>, options: { enabled?: boolean; keepPrevious?: boolean } = {}) {
  const query = useInfiniteQuery<T, Error, InfiniteData<T, string | null>, QueryKey, string | null>(projectPagesOptions(projectId, key, read, options));
  const last = query.data?.pages.at(-1);
  return { ...query, checking: query.isFetching && !query.isFetchingNextPage && query.data !== undefined,
    repeatedCursor: !query.isPlaceholderData && !!last?.nextCursor && !query.hasNextPage,
    /** Reading the loaded pages again failed; they stay on screen as 上次读回，当前待核对. */
    stale: query.isRefetchError,
    /** The next page failed (这一页没读到); the loaded pages are what was read. Loading more retries that page. */
    pageFailed: query.isFetchNextPageError };
}

export interface ProjectList<T> {
  /** The loaded pages' items, each once; undefined until the first page is read. */
  items: T[] | undefined;
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
  /** A reread failed, or with `keepPrevious` the first read of another key did; the items are 上次读回，当前待核对. */
  stale: boolean;
  /** With `keepPrevious`: the items shown were read under another key while this one is read. */
  previous: boolean;
  /** The next page failed (这一页没读到); the items are what was read. `loadMore` retries that page only. */
  pageFailed: boolean;
  /** A cursor came back that was seen before; the list stops there. */
  repeatedCursor: boolean;
  observedAt: number;
  /** Read the next page, and only that page. Two components asking at once share one request. */
  loadMore(): void;
}

/**
 * A cursor list read page by page: 载入更多 reads one more page instead of the whole range again (the old way sent 210
 * requests to reach page 20). With `target`, it keeps reading pages until that many items are loaded, the pages run
 * out, `maxPages` are loaded, or a page fails (then it waits for loadMore). Only a component on screen (`active`)
 * reads further by itself. With `keepPrevious`, another key (another filter) shows the last list while its first page
 * is read, and keeps it as 上次读回 if that read fails.
 */
export function useProjectList<T, P extends { items: T[]; nextCursor: string | null }>(projectId: string, key: readonly unknown[],
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<P>, identity: (item: T) => string,
  options: { enabled?: boolean; target?: number; maxPages?: number; active?: boolean; keepPrevious?: boolean } = {}): ProjectList<T> {
  const pages = useProjectPages<P>(projectId, key, read, { enabled: options.enabled, keepPrevious: options.keepPrevious });
  const memory = useRef<KeptAnswer<InfiniteData<P, string | null>> | null>(null);
  const kept = keepLastAnswer(projectId, pages, !!options.keepPrevious, memory);
  const loaded = kept.data?.pages;
  const items = useMemo(() => loaded ? pagedItems(loaded, identity) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded]);
  const more = !!pages.hasNextPage;
  const { fetchNextPage } = pages;
  const loadMore = useCallback(() => { void fetchNextPage({ cancelRefetch: false }); }, [fetchNextPage]);
  const wantMore = !!items && !kept.isPlaceholderData && more && options.active !== false && options.target !== undefined
    && items.length < options.target && (loaded?.length ?? 0) < (options.maxPages ?? Number.POSITIVE_INFINITY)
    && !pages.isFetching && !pages.isError;
  useEffect(() => { if (wantMore) loadMore(); }, [wantMore, loaded?.length, loadMore]);
  return {
    items, pages: kept.isPlaceholderData ? 0 : loaded?.length ?? 0, more, reading: pages.isPending && pages.isFetching && !kept.data,
    checking: pages.isFetching && !pages.isFetchingNextPage && kept.data !== undefined, loadingMore: pages.isFetchingNextPage,
    error: pages.error, failed: pages.isError && kept.data === undefined, stale: kept.stale && !pages.pageFailed,
    previous: kept.isPlaceholderData, pageFailed: pages.pageFailed,
    repeatedCursor: pages.repeatedCursor, observedAt: kept.dataUpdatedAt, loadMore,
  };
}
