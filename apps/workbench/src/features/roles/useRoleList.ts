// The project's Roles, read as a range of pages under one key so the directory in the inner rail, the overview and
// the selected Role share one answer. A longer range keeps the last answer on screen until the new one arrives; a
// write elsewhere invalidates the project and the range is read again without clearing what is shown.
import { useState } from "react";
import type { RoleRecord } from "@evoloop/contracts/roles";
import { errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { roleClient } from "../../shared/roleClient";

export const maxAutoPages = 20;

export async function readRoleRange(projectId: string, pages: number): Promise<{ items: RoleRecord[]; nextCursor: string | null; pages: number }> {
  const byId = new Map<string, RoleRecord>();
  const seen = new Set<string>();
  let cursor: string | undefined, read = 0, next: string | null = null;
  do {
    const page = await roleClient("", projectId).list(cursor);
    if (page.items.some(item => item.projectId !== projectId)) throw new Error("职责列表返回了其他项目的记录");
    for (const item of page.items) byId.set(item.id, item);
    read += 1; next = page.nextCursor;
    if (next && (next === cursor || seen.has(next))) throw new Error("职责列表游标没有前进，请回读当前状态。");
    if (next) seen.add(next);
    cursor = next ?? undefined;
  } while (cursor && read < pages);
  return { items: [...byId.values()], nextCursor: next, pages: read };
}

export function useRoleList(projectId: string) {
  const [pages, setPages] = useState(1);
  const list = useProjectQuery(projectId, ["roles", "list", pages], () => readRoleRange(projectId, pages), { keepPrevious: true });
  const data = list.data;
  return {
    items: data?.items ?? [],
    more: !!data?.nextCursor,
    pages,
    /** First read: nothing to show yet. */
    loading: list.isPending,
    /** A reread or a longer range is under way; what is shown is the previous answer. */
    checking: list.isFetching && !list.isPending,
    error: list.error ? errorText(list.error) : "",
    observedAt: list.dataUpdatedAt ? new Date(list.dataUpdatedAt) : null,
    loadMore: () => setPages(value => value + 1),
    /** Ask for more pages only while the current range has been read and more remain. */
    extend: () => { if (!list.isFetching && data?.nextCursor && data.pages >= pages) setPages(value => value + 1); },
    reread: () => list.refetch(),
  };
}
