// The project's documents as the list conditions ask for them. The inner rail and the table read the same key, so
// they share one answer. A longer range or another kind keeps the last answer on screen until the new one arrives.
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, errorText } from "../../shared/api";
import { visibleLeaderDocuments } from "../../shared/leaderWorkLoad";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { readDocumentRange } from "./documentListModel";
import { isFiltered, loadMoreTarget, pagesFor, type DocumentListState } from "./documentListState";

export const readProblem = (cause: unknown, subject = "该项目的文档"): string =>
  cause instanceof ApiError && (cause.status === 401 || cause.status === 403) ? `当前身份无权读取${subject}` : errorText(cause);

export function useDocumentList(projectId: string, state: DocumentListState, update: (patch: Partial<DocumentListState>) => void) {
  const { kind } = state;
  const pages = pagesFor(state);
  const client = useQueryClient();
  const list = useProjectQuery(projectId, ["documents", "list", kind, state.target], signal =>
    readDocumentRange(cursor => api().documents(projectId, cursor, kind === "all" ? undefined : kind, signal), projectId, state.target, pages),
  { keepPrevious: true });
  const page = list.data?.page;
  const items = page?.items.filter(item => item.projectId === projectId) ?? [];
  const visible = visibleLeaderDocuments(items, state.status, state.kind, state.query.trim());
  const more = !!page?.nextCursor;
  const searching = !!state.query.trim();
  return {
    items, visible, more,
    /** First read, nothing to show yet. */
    loading: list.isPending,
    /** A reread or a longer range is on its way; what is shown is the previous answer. */
    checking: list.isFetching && !list.isPending,
    error: list.error ? readProblem(list.error) : "",
    observedAt: list.dataUpdatedAt ? new Date(list.dataUpdatedAt) : null,
    filtered: isFiltered(state),
    /** A search stopped at the automatic limit while pages remain. */
    searchLimited: searching && more && !list.isPlaceholderData && !list.isFetching && (list.data?.pages ?? 0) >= pages,
    loadMore: () => update({ target: loadMoreTarget(state, items.length) }),
    /** Read the list and its uses and referencing tasks again; what is on screen stays until the answers arrive. */
    reread: () => client.invalidateQueries({ queryKey: queryKeys.project(projectId, "documents") }),
  };
}
