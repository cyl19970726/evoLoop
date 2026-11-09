// The project's documents as the list conditions ask for them. The inner rail and the table read the same key, so
// they share one answer. The list reads page by page: a longer range (载入更多, or a search reading ahead) reads only
// the pages it lacks, and a failed page leaves the loaded rows in place (这一页没读到) while a failed reread keeps them as
// 上次读回. Another kind is another list (another key), read from its first page: it never shows the last kind's rows,
// and a failed first read of it is a failed read, not 上次读回.
import type { Document, Page } from "@evoloop/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, errorDetail, errorText } from "../../shared/api";
import { visibleLeaderDocuments } from "../../shared/leaderWorkLoad";
import { useProjectList } from "../../shared/projectList";
import { queryKeys } from "../../shared/query";
import { validDocumentPage } from "./documentListModel";
import { isFiltered, loadMoreTarget, pagesFor, type DocumentListState } from "./documentListState";

export const readProblem = (cause: unknown, subject = "该项目的文档"): string =>
  cause instanceof ApiError && (cause.status === 401 || cause.status === 403) ? `当前身份无权读取${subject}` : errorText(cause);

export function useDocumentList(projectId: string, state: DocumentListState, update: (patch: Partial<DocumentListState>) => void) {
  const { kind } = state;
  const maxPages = pagesFor(state);
  const client = useQueryClient();
  const list = useProjectList(projectId, ["documents", "list", kind], async (cursor, signal) => {
    const page: Page<Document> = await api().documents(projectId, cursor, kind === "all" ? undefined : kind, signal);
    validDocumentPage(page, projectId, cursor);
    return page;
  }, (document: Document) => document.id, { target: state.target, maxPages });
  const items = list.items?.filter(item => item.projectId === projectId) ?? [];
  const visible = visibleLeaderDocuments(items, state.status, state.kind, state.query.trim());
  const searching = !!state.query.trim();
  const problem = list.error ? readProblem(list.error) : list.repeatedCursor ? "文档分页游标重复，无法确认后续结果" : "";
  return {
    items, visible, more: list.more,
    /** First read, nothing to show yet. */
    loading: list.reading,
    /** A reread or the next page is on its way; what is shown is what was read before. */
    checking: list.checking || list.loadingMore,
    /** The first read or a reread failed (`stale`: the rows shown are 上次读回). */
    error: list.pageFailed || (!list.error && list.repeatedCursor) ? "" : problem,
    stale: list.stale,
    /** What the coverage line may claim (only a list just read says 已读完). */
    coverage: list.coverage,
    /** The next page failed or could not continue; the rows shown are what was read and are still current. */
    pageError: list.pageFailed || (!list.error && list.repeatedCursor) ? problem : "",
    /** The original answer behind `error` or `pageError`, for 诊断信息. */
    errorDetail: list.error ? errorDetail(list.error) : null,
    observedAt: list.observedAt ? new Date(list.observedAt) : null,
    filtered: isFiltered(state),
    /** A search stopped at the automatic limit while pages remain. */
    searchLimited: searching && list.more && !list.checking && !list.loadingMore && list.pages >= maxPages,
    /** One more page: past the range read so far; after a failed page, that page again. */
    loadMore: () => list.pageFailed ? list.loadMore() : update({ target: loadMoreTarget(state, items.length) }),
    /** Read the list and its uses and referencing tasks again; what is on screen stays until the answers arrive. */
    reread: () => client.invalidateQueries({ queryKey: queryKeys.project(projectId, "documents") }),
  };
}
