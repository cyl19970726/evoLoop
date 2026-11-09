// Server reads go through TanStack Query. Every key starts with the scope it belongs to (an identity or a
// project), so switching project or identity can cancel and drop exactly that scope. A reread keeps what is
// on screen and reports `checking` until the answer arrives; the cache only speeds up reads and never decides
// which version is current.
import { QueryClient, useQuery, type QueryClient as Client, type QueryKey } from "@tanstack/react-query";
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

/** After a write in a project, every read of that project is stale and the visible ones reread. */
export function projectChanged(client: Client, projectId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: queryKeys.project(projectId) });
}

/** A project read. `checking` is true while a reread runs and the previous answer is still on screen. */
export function useProjectQuery<T>(projectId: string, key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>,
  options: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  const query = useQuery({
    queryKey: queryKeys.project(projectId, ...key) as QueryKey,
    queryFn: ({ signal }) => read(signal),
    enabled: !!projectId && (options.enabled ?? true),
    ...(options.refetchInterval !== undefined ? { refetchInterval: options.refetchInterval } : {}),
  });
  return { ...query, checking: query.isFetching && query.data !== undefined };
}
