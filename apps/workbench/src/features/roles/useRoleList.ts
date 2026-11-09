// The project's Roles, read page by page under one key so the directory in the inner rail, the overview and the
// selected Role share one answer. Loading more reads only the next page and keeps the pages already shown; a failed
// next page is reported on its own. A write elsewhere invalidates the project and the loaded pages are read again
// without clearing what is shown.
import { useInfiniteQuery } from "@tanstack/react-query";
import type { Page } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { errorText } from "../../shared/api";
import { queryKeys } from "../../shared/query";
import { roleClient } from "../../shared/roleClient";

export const maxAutoPages = 20;

/** One page, checked: it belongs to this project and its cursor moves on. */
export async function readRolePage(projectId: string, cursor: string): Promise<Page<RoleRecord>> {
  const page = await roleClient("", projectId).list(cursor || undefined);
  if (!Array.isArray(page.items) || page.items.some(item => item.projectId !== projectId)) throw new Error("职责列表返回了其他项目的记录");
  if (page.nextCursor && page.nextCursor === cursor) throw new Error("职责列表游标没有前进，请回读当前状态。");
  return page;
}

/** Pages in reading order, later pages winning for a Role read twice. */
export function mergeRolePages(pages: ReadonlyArray<Page<RoleRecord>>): RoleRecord[] {
  const byId = new Map<string, RoleRecord>();
  for (const page of pages) for (const item of page.items) byId.set(item.id, item);
  return [...byId.values()];
}

export function useRoleList(projectId: string) {
  const list = useInfiniteQuery({
    queryKey: queryKeys.project(projectId, "roles", "list"),
    queryFn: ({ pageParam }) => readRolePage(projectId, pageParam),
    initialPageParam: "",
    // A cursor seen before would loop; stop there and say so through `more` staying false.
    getNextPageParam: (last, _pages, _param, params) => last.nextCursor && !params.includes(last.nextCursor) ? last.nextCursor : undefined,
    enabled: !!projectId,
  });
  const pages = list.data?.pages ?? [];
  const nextFailed = list.isFetchNextPageError;
  return {
    items: mergeRolePages(pages),
    more: !!list.hasNextPage,
    pages: pages.length,
    /** First read: nothing to show yet. */
    loading: list.isPending,
    /** The loaded pages are being read again; what is shown is the previous answer. */
    checking: list.isFetching && !list.isFetchingNextPage && !list.isPending,
    loadingMore: list.isFetchingNextPage,
    /** The first page (or a reread of the loaded pages) failed. */
    error: list.isError && !nextFailed ? errorText(list.error) : "",
    /** Only the next page failed; the pages already shown stay. */
    moreError: nextFailed ? errorText(list.error) : "",
    observedAt: list.dataUpdatedAt ? new Date(list.dataUpdatedAt) : null,
    loadMore: () => { if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage(); },
  };
}
