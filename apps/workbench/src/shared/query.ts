// Server reads go through TanStack Query. Every key starts with the scope it belongs to (an identity or a
// project), so switching project or identity can cancel and drop exactly that scope. A reread keeps what is
// on screen and reports `checking` until the answer arrives; the cache only speeds up reads and never decides
// which version is current. 上次读回 is only a key's own earlier answer (readStanding); a list reads one more page
// at a time under one key (shared/projectList.ts).
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
 * `keepPrevious`: a changed key shows the last answer as a stand-in while the new one is read (`previous`). The last
 * answer must belong to the same project: a component that stays mounted across a project switch never shows the old
 * project's answer, even as a stand-in.
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

/** How the answer on screen stands. Every read says it the same way. */
export interface ReadStanding {
  /** This key was never read and its read failed: say that it failed, never 上次读回. */
  failed: boolean;
  /** A reread of this same key failed; what is shown is this key's earlier answer: 上次读回，当前待核对. */
  stale: boolean;
  /** What is shown belongs to the previous key (another object) while this key is read: a stand-in, never a result. */
  previous: boolean;
}

/**
 * The rule for every read: 上次读回 is only ever the same key's own earlier answer. A changed key is another object
 * (another filter, kind, page or set): with `keepPrevious` the last key's answer may stand in while the new key is read
 * (`previous`), but when the new key fails before it was ever read, the read has failed, and the old key's answer is
 * not passed off as it. (TanStack drops the stand-in at that point; nothing here brings it back.) A longer range of
 * the same list is not another key: lists read further pages under one key (useProjectList).
 */
export function readStanding(result: { data: unknown; isError: boolean; isPlaceholderData: boolean }): ReadStanding {
  return {
    failed: result.isError && result.data === undefined,
    stale: result.isError && result.data !== undefined && !result.isPlaceholderData,
    previous: result.isPlaceholderData,
  };
}

/**
 * A project read. `checking` is true while a read runs and an answer is still on screen; `stale` and `previous` are
 * readStanding's. A key that starts with `fixedContent` is read once.
 */
export function useProjectQuery<T>(projectId: string, key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>,
  options: ProjectQueryOptions = {}) {
  const query = useQuery(projectQueryOptions(projectId, key, read, options));
  const standing = readStanding(query);
  return { ...query, checking: query.isFetching && query.data !== undefined, stale: standing.stale, previous: standing.previous };
}

/** A cursor seen before would loop: the list stops there (and reports `repeatedCursor`). */
export function nextCursor(last: { nextCursor: string | null }, lastCursor: string | null, cursors: readonly (string | null)[]): string | null {
  return last.nextCursor && last.nextCursor !== lastCursor && !cursors.includes(last.nextCursor) ? last.nextCursor : null;
}

/** What useProjectPages asks of TanStack Query; tests observe a paged read through the same options. */
export function projectPagesOptions<T extends { nextCursor: string | null }>(projectId: string, key: readonly unknown[],
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<T>, options: { enabled?: boolean } = {}) {
  return {
    queryKey: queryKeys.project(projectId, ...key) as QueryKey,
    queryFn: ({ pageParam, signal }: { pageParam: string | null; signal: AbortSignal }) => read(pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: T, _pages: T[], lastCursor: string | null, cursors: (string | null)[]) => nextCursor(last, lastCursor, cursors),
    enabled: !!projectId && (options.enabled ?? true),
    retry: false,
  };
}

/**
 * A paged project read (a list API with cursors). Pages load on request and stay together under one key, so every
 * component showing the list shares them; a reread refetches the loaded pages in order. Not retried: a failed page
 * is reported and loaded again on request, never silently repeated.
 */
export function useProjectPages<T extends { nextCursor: string | null }>(projectId: string, key: readonly unknown[],
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<T>, options: { enabled?: boolean } = {}) {
  const query = useInfiniteQuery<T, Error, InfiniteData<T, string | null>, QueryKey, string | null>(projectPagesOptions(projectId, key, read, options));
  const last = query.data?.pages.at(-1);
  return { ...query, checking: query.isFetching && !query.isFetchingNextPage && query.data !== undefined,
    repeatedCursor: !!last?.nextCursor && !query.hasNextPage,
    /** Reading the loaded pages again failed; they stay on screen as 上次读回，当前待核对. */
    stale: query.isRefetchError,
    /** The next page failed (这一页没读到); the loaded pages are what was read. Loading more retries that page. */
    pageFailed: query.isFetchNextPageError };
}
