// The task list shared by the inner rail and the table view. Pages, work statuses and the current-work projections
// are TanStack queries, so every page instance (the table and each opened task) shows the same loaded list. Only the
// page on screen continues reading further pages.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import type { Task } from "@evoloop/contracts";
import type { LeaderWorkPage, LeaderWorkTask } from "@evoloop/contracts/work-index";
import { api, errorDiagnostic, errorText } from "../../shared/api";
import { appendLeaderWorkPage } from "../../shared/leaderWorkLoad";
import { queryKeys, useProjectPages, useProjectQuery } from "../../shared/query";
import { visibleWorkGroups, type WorkTaskStatus } from "../../shared/workStatusPresentation";
import { isMyCurrentWork, type TaskListView } from "./taskExperience";
import { isMine, matchesFilters, sortTasks, sortUsesProjection } from "./taskListModel";

const pageLimit = 50;
const autoPageLimit = 10;
const autoItemLimit = 500;
const indexItemLimit = 500;
const partialStatusDiagnostic = "接口未返回全部已载入任务的工作进度。";

export interface StatusProblem { kind: "unavailable" | "partial"; diagnostic: string }
export interface ProjectionIndex {
  first: LeaderWorkPage<LeaderWorkTask> | null; items: Record<string, LeaderWorkTask>; complete: boolean; error: string; loading: boolean;
  /** More open work exists than was read; readMore() reads the next 500 rows. */
  truncated: boolean; reading: boolean; readMore(): void;
}

/** The current-work index for open tasks, read up to 500 rows. A partial read never becomes "nobody is assigned". */
async function readProjectionIndex(projectId: string, limit: number): Promise<{ first: LeaderWorkPage<LeaderWorkTask>; page: LeaderWorkPage<LeaderWorkTask>; problem: string }> {
  const client = api();
  const first = await client.leaderWork(projectId, "tasks") as LeaderWorkPage<LeaderWorkTask>;
  let page = first, problem = "";
  const seen = new Set<string>();
  try {
    while (page.nextCursor && page.items.length < limit) {
      if (seen.has(page.nextCursor)) throw new Error("当前工作分页游标重复");
      seen.add(page.nextCursor);
      page = appendLeaderWorkPage(page, await client.leaderWork(projectId, "tasks", page.nextCursor) as LeaderWorkPage<LeaderWorkTask>);
    }
  } catch (cause) { problem = errorText(cause); }
  return { first, page, problem };
}

export function useTaskList(projectId: string, view: TaskListView, actorId: string, active: boolean, options: { projectionsFor?: "filtered" | "none"; extraIds?: string[] } = {}) {
  const client = useQueryClient();
  const pages = useProjectPages(projectId, ["tasks", "list"], async (cursor, signal) => {
    const page = await api().tasks(projectId, cursor, signal);
    if (page.items.length > pageLimit) throw new Error("任务分页响应超过每页上限");
    return page;
  });
  const tasks = useMemo(() => {
    const seen = new Set<string>(), merged: Task[] = [];
    for (const page of pages.data?.pages ?? []) for (const task of page.items) if (!seen.has(task.id)) { seen.add(task.id); merged.push(task); }
    return merged;
  }, [pages.data]);

  // Work statuses, one read per loaded page.
  const loaded = pages.data?.pages ?? [];
  const statusReads = useQueries({ queries: loaded.map((page, index) => {
    const ids = page.items.map(task => task.id);
    return {
      queryKey: queryKeys.project(projectId, "tasks", "work-status", pages.data?.pageParams[index] ?? "first", ids.join(",")),
      queryFn: ({ signal }: { signal: AbortSignal }) => api().workStatuses(projectId, ids, signal),
      enabled: ids.length > 0, retry: false,
    };
  }) });
  const statuses = useMemo(() => {
    const next: Record<string, WorkTaskStatus> = {};
    for (const read of statusReads) for (const item of read.data?.items ?? []) next[item.taskId] = item;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusReads.map(read => read.dataUpdatedAt).join(",")]);
  // A failed page stays reported while it is read again (the query forgets the error when a retry starts) and
  // until its statuses actually arrive.
  const statusErrors = useRef(new Map<string, string>());
  statusReads.forEach((read, index) => {
    const page = String(pages.data?.pageParams[index] ?? "first");
    if (read.error) statusErrors.current.set(page, errorDiagnostic(read.error));
    else if (read.data) statusErrors.current.delete(page);
  });
  const failedStatus = [...statusErrors.current.values()][0];
  const statusProblem: StatusProblem | null = failedStatus ? { kind: "unavailable", diagnostic: failedStatus }
    : statusReads.some(read => read.data) && tasks.some(task => !Object.hasOwn(statuses, task.id)) && statusReads.every(read => !read.isFetching || read.data)
      ? { kind: "partial", diagnostic: partialStatusDiagnostic } : null;
  const [statusRetrying, setStatusRetrying] = useState(false);
  async function retryStatuses() {
    if (statusRetrying) return;
    setStatusRetrying(true);
    try { await client.refetchQueries({ queryKey: queryKeys.project(projectId, "tasks", "work-status") }); }
    finally { setStatusRetrying(false); }
  }

  // Current-work projections: the open-task index, plus single reads for listed tasks the index leaves out (closed ones).
  // Open work is read 500 rows at a time; beyond that the reader asks for more (继续读取) instead of waiting forever.
  const [indexLimit, setIndexLimit] = useState(indexItemLimit);
  const indexRead = useProjectQuery(projectId, ["tasks", "leader-index", indexLimit], () => readProjectionIndex(projectId, indexLimit), { keepPrevious: true });
  const indexItems = useMemo(() => Object.fromEntries((indexRead.data?.page.items ?? []).map(item => [item.taskId, item])), [indexRead.data]);
  const index: ProjectionIndex = {
    first: indexRead.data?.first ?? null, items: indexItems, loading: indexRead.isPending,
    complete: !!indexRead.data && !indexRead.data.page.nextCursor && !indexRead.data.page.partial && !indexRead.data.problem,
    error: indexRead.error ? errorText(indexRead.error) : indexRead.data?.problem ?? "",
    truncated: !!indexRead.data?.page.nextCursor && !indexRead.data.problem && indexRead.data.page.items.length >= indexLimit,
    reading: indexRead.isFetching, readMore: () => setIndexLimit(limit => limit + indexItemLimit),
  };
  const filtered = useMemo(() => tasks.filter(task => matchesFilters(task, view, statuses[task.id])), [tasks, view.query, view.filter, view.kind, statuses]);
  const wanted = options.projectionsFor === "none" && !sortUsesProjection(view.sort) ? [] : filtered;
  const missing = indexRead.data ? [...wanted, ...tasks.filter(task => options.extraIds?.includes(task.id))]
    .filter((task, position, all) => !indexItems[task.id] && all.findIndex(other => other.id === task.id) === position) : [];
  const singleReads = useQueries({ queries: missing.map(task => ({
    queryKey: queryKeys.project(projectId, "tasks", "leader", task.id, task.version),
    queryFn: () => api().leaderTask(projectId, task.id),
    retry: false,
  })) });
  const singles = singleReads.map(read => read.data).filter((item): item is LeaderWorkTask => !!item);
  const projections = useMemo(() => ({ ...indexItems, ...Object.fromEntries(singles.map(item => [item.taskId, item])) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [indexItems, singles.map(item => `${item.taskId}:${item.workChangeSequence}`).join(",")]);

  // The visible list.
  const scoped = view.scope === "mine" ? filtered.filter(task => isMine(task, projections[task.id], actorId)) : filtered;
  const visible = useMemo(() => sortTasks(scoped, view.sort, projections), [scoped, view.sort, projections]);
  const classificationUnavailable = !!statusProblem && !Object.keys(statuses).length;
  const groups = visibleWorkGroups(visible, statuses, classificationUnavailable);
  const mineCount = Object.values(projections).filter(item => isMyCurrentWork(item, actorId)).length;
  const awaitingAssignments = view.scope === "mine" && !index.complete && !index.error;
  const loading = pages.isPending;
  const firstError = pages.isError && !pages.data ? errorText(pages.error) : "";
  const pageError = pages.isFetchNextPageError ? errorText(pages.error) : pages.repeatedCursor ? "任务分页游标重复，无法确认后续结果" : "";
  const hasMore = !!pages.hasNextPage;
  const needsFilteredPage = !visible.length && !awaitingAssignments;

  // Continue reading when the filters leave the loaded pages empty, or while a search runs: bounded, on screen only.
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const counts = useRef({ pages: 0, items: 0 });
  counts.current = { pages: loaded.length, items: tasks.length };
  const query = view.query.trim();
  useEffect(() => {
    if (!active || loading || firstError || (!query && !needsFilteredPage) || !hasMore) { setSearching(false); setSearchError(""); return; }
    let live = true;
    setSearching(true); setSearchError("");
    const timer = window.setTimeout(async () => {
      try {
        if (counts.current.pages >= autoPageLimit || counts.current.items + pageLimit > autoItemLimit)
          throw new Error(`自动搜索已达 ${autoPageLimit} 页或 ${autoItemLimit} 项上限；结果未完整。可继续手动加载，或缩小范围。`);
        const result = await pages.fetchNextPage({ cancelRefetch: false });
        if (result.isFetchNextPageError) throw result.error;
        // The next render rechecks the filters before another page is read.
        if (live) setSearching(false);
      } catch (cause) { if (live) { setSearching(false); setSearchError(errorText(cause)); } }
    }, 180);
    return () => { live = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loading, firstError, query, view.filter, view.kind, view.scope, needsFilteredPage, hasMore, loaded.length]);

  async function loadMore() {
    if (pages.isFetchingNextPage) return;
    await pages.fetchNextPage({ cancelRefetch: false });
  }
  /** 重新读取列表: every read behind the list, kept on screen until the answers arrive. */
  function reread() {
    void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "tasks") });
    void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "roles") });
    void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "session-names") });
  }
  // Coming back to the window rereads the list on screen, as the old list did.
  useEffect(() => {
    if (!active) return;
    const onFocus = () => { if (document.visibilityState === "visible") void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "tasks") }); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, client, projectId]);
  // Returning from another page checks the same monotonic work stream that sealed this list. If it moved, reread
  // every Task read behind the rail, table and counts; if the check itself fails, reread rather than keep a stale list.
  const wasActive = useRef(active);
  useEffect(() => {
    const returning = active && !wasActive.current;
    wasActive.current = active;
    const observedSequence = index.first?.changeSequence;
    if (!returning || observedSequence === undefined) return;
    let live = true;
    const reread = () => client.invalidateQueries({ queryKey: queryKeys.project(projectId, "tasks") });
    void api().leaderWorkChanges(projectId, undefined, 1).then(changes => {
      if (live && changes.changeSequence > observedSequence) void reread();
    }).catch(() => { if (live) void reread(); });
    return () => { live = false; };
  }, [active, client, index.first?.changeSequence, projectId]);

  return {
    tasks, visible, groups, statuses, projections, index, mineCount,
    loading, checking: pages.checking, firstError, pageError, hasMore, loadingMore: pages.isFetchingNextPage, loadMore, reread,
    observedAt: pages.dataUpdatedAt ? new Date(pages.dataUpdatedAt) : null,
    statusProblem, statusRetrying, retryStatuses,
    awaitingAssignments, searching: searching || (needsFilteredPage && hasMore && !query && !searchError && !firstError && !pageError),
    searchError: searchError || pageError,
  };
}
export type TaskListRead = ReturnType<typeof useTaskList>;
