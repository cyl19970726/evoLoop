// Server reads go through TanStack Query. Every key starts with the scope it belongs to (an identity or a
// project), so switching project or identity can cancel and drop exactly that scope. A reread keeps what is
// on screen and reports `checking` until the answer arrives; the cache only speeds up reads and never decides
// which version is current.
import { QueryClient, keepPreviousData, useQuery, type QueryClient as Client, type QueryKey } from "@tanstack/react-query";
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

/** What useProjectQuery asks of TanStack Query; tests observe a read through the same options. */
export function projectQueryOptions<T>(projectId: string, key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>,
  options: ProjectQueryOptions = {}) {
  return {
    queryKey: queryKeys.project(projectId, ...key) as QueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => read(signal),
    enabled: !!projectId && (options.enabled ?? true),
    ...(key[0] === fixedContent ? { staleTime: Infinity } : {}),
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
    ...(options.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  };
}

/**
 * A project read. `checking` is true while a reread runs and the previous answer is still on screen. With
 * `keepPrevious`, a changed key (another filter, a longer range) keeps the last answer on screen until the new one
 * arrives, instead of starting over empty. A key that starts with `fixedContent` is read once.
 */
export function useProjectQuery<T>(projectId: string, key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>,
  options: ProjectQueryOptions = {}) {
  const query = useQuery(projectQueryOptions(projectId, key, read, options));
  return { ...query, checking: query.isFetching && query.data !== undefined };
}
