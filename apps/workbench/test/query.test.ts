// Query scopes: a project's answers never outlive leaving it, writes make only that project stale, 4xx is final.
// 上次读回 is only a key's own earlier answer, another key that fails was never read, and a list reads one page at a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { InfiniteQueryObserver, QueryObserver, type InfiniteData, type QueryObserverResult } from "@tanstack/react-query";
import { ApiError } from "../src/shared/api.ts";
import {
  createQueryClient, fixedContent, leaveProject, previousOfProject, projectChanged, projectPagesOptions,
  projectQueryOptions, queryKeys, readStanding, shouldRetry,
} from "../src/shared/query.ts";
import { pagedItems, projectListState } from "../src/shared/projectList.ts";
import { coverageText } from "../src/shared/listCoverage.ts";

/** Wait until the observer's result satisfies `done` (TanStack notifies asynchronously). */
async function until<R>(read: () => R, done: (result: R) => boolean): Promise<R> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = read();
    if (done(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("the read did not settle");
}

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";

test("leaving a project cancels and forgets only that project's reads", async () => {
  const client = createQueryClient();
  client.setQueryData(queryKeys.project(a, "project"), { title: "A" });
  client.setQueryData(queryKeys.project(a, "tasks", { filter: "open" }), ["t1"]);
  client.setQueryData(queryKeys.project(b, "project"), { title: "B" });
  client.setQueryData(queryKeys.identity("reader", "projects"), [a, b]);
  let cancelled = false;
  const slow = client.fetchQuery({ queryKey: queryKeys.project(a, "slow"), queryFn: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(new Error("aborted")); });
  }) }).catch(() => undefined);
  await leaveProject(client, a);
  await slow;
  assert.equal(cancelled, true, "an in-flight read of the old project is aborted");
  assert.equal(client.getQueryData(queryKeys.project(a, "project")), undefined);
  assert.equal(client.getQueryData(queryKeys.project(a, "tasks", { filter: "open" })), undefined);
  assert.deepEqual(client.getQueryData(queryKeys.project(b, "project")), { title: "B" });
  assert.deepEqual(client.getQueryData(queryKeys.identity("reader", "projects")), [a, b]);
  client.clear();
});

test("a write makes only its project stale and keeps the answers on screen until the reread", async () => {
  const client = createQueryClient();
  client.setQueryData(queryKeys.project(a, "project"), { title: "A" });
  client.setQueryData(queryKeys.project(b, "project"), { title: "B" });
  await projectChanged(client, a);
  assert.equal(client.getQueryState(queryKeys.project(a, "project"))?.isInvalidated, true);
  assert.equal(client.getQueryState(queryKeys.project(b, "project"))?.isInvalidated, false);
  assert.deepEqual(client.getQueryData(queryKeys.project(a, "project")), { title: "A" }, "stale data stays until replaced");
  client.clear();
});

test("after a write the current version rereads once, while a fixed revision and its original are never read again", async () => {
  const client = createQueryClient();
  const reads = { current: 0, revision: 0, original: 0 };
  // Observed the way a mounted page (visible or hidden) observes them, through the options useProjectQuery uses.
  const observe = (key: readonly unknown[], name: keyof typeof reads) =>
    new QueryObserver(client, projectQueryOptions(a, key, async () => { reads[name]++; return `${name}:${reads[name]}`; }))
      .subscribe(() => undefined);
  const stops = [
    observe(["document", "doc", "detail"], "current"),
    observe([fixedContent, "doc", "r1", "revision"], "revision"),
    observe([fixedContent, "doc", "r1", "original"], "original"),
  ];
  for (let attempt = 0; attempt < 50 && (client.isFetching() > 0 || Object.values(reads).some(count => count === 0)); attempt++)
    await new Promise(done => setTimeout(done, 5));
  assert.deepEqual(reads, { current: 1, revision: 1, original: 1 });
  await projectChanged(client, a);
  assert.deepEqual(reads, { current: 2, revision: 1, original: 1 }, "only the current version is read again");
  assert.equal(client.getQueryState(queryKeys.project(a, "document", "doc", "detail"))?.isInvalidated, false, "the reread replaced it");
  for (const part of ["revision", "original"])
    assert.equal(client.getQueryState(queryKeys.project(a, fixedContent, "doc", "r1", part))?.isInvalidated, false, part);
  assert.equal(projectQueryOptions(a, [fixedContent, "doc", "r1", "original"], async () => null).staleTime, Infinity,
    "fixed content never goes stale on its own");
  assert.equal("staleTime" in projectQueryOptions(a, ["document", "doc", "detail"], async () => null), false,
    "other reads keep the client's default");
  for (const stop of stops) stop();
  await leaveProject(client, a);
  assert.equal(client.getQueryData(queryKeys.project(a, fixedContent, "doc", "r1", "original")), undefined, "leaving the project still drops fixed content");
  client.clear();
});

test("4xx answers are final; connection and server failures retry twice", () => {
  for (const status of [400, 401, 403, 404, 409]) assert.equal(shouldRetry(0, new ApiError(status, "x")), false, String(status));
  assert.equal(shouldRetry(0, new ApiError(0, "连接中断")), true);
  assert.equal(shouldRetry(1, new ApiError(503, "busy")), true);
  assert.equal(shouldRetry(2, new ApiError(503, "busy")), false);
});

test("上次读回 is only a key's own earlier answer: another key that fails before it was ever read has failed", async () => {
  const client = createQueryClient();
  let planFails = false, allFails = false;
  // Two objects under one component: the 计划 list and the 全部 list (another kind is another key). 409 is not retried.
  const read = (kind: string) => async () => {
    if ((kind === "plan" && planFails) || (kind === "all" && allFails)) throw new ApiError(409, "list unavailable");
    return [`${kind}-1`, `${kind}-2`];
  };
  const observer = new QueryObserver(client, projectQueryOptions(a, ["list", "plan"], read("plan"), { keepPrevious: true }));
  const stop = observer.subscribe(() => undefined);
  const plan = await until(() => observer.getCurrentResult(), result => result.data !== undefined);
  assert.deepEqual(readStanding(plan), { failed: false, stale: false, previous: false });

  // Switch to 全部 while its first read is on the way: the 计划 rows only stand in, marked `previous`.
  allFails = true;
  observer.setOptions(projectQueryOptions(a, ["list", "all"], read("all"), { keepPrevious: true }));
  const pending = observer.getCurrentResult();
  assert.deepEqual(pending.data, ["plan-1", "plan-2"]);
  assert.deepEqual(readStanding(pending), { failed: false, stale: false, previous: true }, "a stand-in, never a result");
  // 全部 fails before it was ever read: a failed read, not the 计划 rows as 上次读回.
  const failed = await until(() => observer.getCurrentResult(), result => result.isError);
  assert.equal(failed.data, undefined);
  assert.deepEqual(readStanding(failed), { failed: true, stale: false, previous: false });

  // Once 全部 was read, a failed reread of it keeps its own answer: that is 上次读回.
  allFails = false;
  await observer.refetch();
  const all = await until(() => observer.getCurrentResult(), result => !result.isPlaceholderData && result.data?.[0] === "all-1");
  assert.deepEqual(readStanding(all), { failed: false, stale: false, previous: false });
  allFails = true;
  await observer.refetch();
  const stale = await until(() => observer.getCurrentResult(), result => result.isError);
  assert.deepEqual(stale.data, ["all-1", "all-2"]);
  assert.deepEqual(readStanding(stale), { failed: false, stale: true, previous: false });
  stop();
  client.clear();
});

test("another project never shows the last project's answer, even as a stand-in", async () => {
  const client = createQueryClient();
  const observer = new QueryObserver(client, projectQueryOptions(a, ["summary"], async () => "A 的摘要", { keepPrevious: true }));
  const stop = observer.subscribe(() => undefined);
  await until(() => observer.getCurrentResult(), result => result.data !== undefined);
  // The same component now reads project B; its first read is still on the way.
  let answerB = (_value: string) => undefined as void;
  observer.setOptions(projectQueryOptions(b, ["summary"], () => new Promise<string>(resolve => { answerB = resolve; }), { keepPrevious: true }));
  const pending = observer.getCurrentResult();
  assert.equal(pending.data, undefined, "A's answer does not stand in for B");
  assert.deepEqual(readStanding(pending), { failed: false, stale: false, previous: false });
  assert.equal(previousOfProject(b)("A 的摘要", { queryKey: queryKeys.project(a, "summary") }), undefined);
  assert.equal(previousOfProject(a)("A 的摘要", { queryKey: queryKeys.project(a, "summary") }), "A 的摘要");
  answerB("B 的摘要");
  assert.equal((await until(() => observer.getCurrentResult(), result => result.data !== undefined)).data, "B 的摘要");
  stop();
  client.clear();
});

type Page = { items: string[]; nextCursor: string | null };
type PagedObserverResult = QueryObserverResult<InfiniteData<Page, string | null>> & {
  hasNextPage: boolean; isFetchNextPageError: boolean; isRefetchError: boolean; isFetchingNextPage: boolean };

test("a list reads one more page on load more; a failed next page keeps the loaded pages and is retried alone", async () => {
  const client = createQueryClient();
  const asked: Array<string | undefined> = [];
  let failing: string | null = "c3";
  const book: Record<string, Page> = {
    first: { items: ["a", "b"], nextCursor: "c2" }, c2: { items: ["b", "c"], nextCursor: "c3" }, c3: { items: ["d"], nextCursor: null },
  };
  const read = async (cursor: string | undefined) => {
    asked.push(cursor);
    if (cursor && cursor === failing) throw new ApiError(503, "page unavailable");
    return book[cursor ?? "first"]!;
  };
  const observer = new InfiniteQueryObserver<Page, Error, InfiniteData<Page, string | null>, readonly unknown[], string | null>(client,
    projectPagesOptions(a, ["list"], read) as never);
  const stop = observer.subscribe(() => undefined);
  const result = () => observer.getCurrentResult() as PagedObserverResult;
  const state = () => projectListState(result());
  assert.equal(state().reading, true);
  assert.equal(state().coverage, "reading");
  await until(result, value => value.data?.pages.length === 1);
  assert.deepEqual([state().coverage, state().more, state().pages], ["current", true, 1]);
  await observer.fetchNextPage();
  assert.deepEqual(asked, [undefined, "c2"], "page 2 is one request, not the range from page 1 again");
  assert.deepEqual(pagedItems(result().data!.pages, item => item), ["a", "b", "c"], "each item once");

  await observer.fetchNextPage();
  const pageFailed = state();
  assert.equal(pageFailed.pageFailed, true, "这一页没读到");
  assert.deepEqual([pageFailed.stale, pageFailed.failed, pageFailed.pages, pageFailed.more], [false, false, 2, true], "the loaded pages stay current");
  assert.equal(pageFailed.coverage, "current", "the loaded pages were read; the coverage line says 后续页面未读");
  failing = null;
  asked.length = 0;
  await observer.fetchNextPage();
  assert.deepEqual(asked, ["c3"], "the retry reads only the failed page");
  assert.deepEqual(pagedItems(result().data!.pages, item => item), ["a", "b", "c", "d"]);
  assert.deepEqual([state().more, state().pageFailed, state().coverage], [false, false, "current"]);

  // A reread that fails keeps all loaded pages, as 上次读回, and no longer claims 已读完.
  failing = "c2";
  await observer.refetch();
  const stale = state();
  assert.deepEqual([stale.stale, stale.pageFailed, stale.failed, stale.pages, stale.coverage], [true, false, false, 3, "stale"]);
  stop();
  client.clear();
});

test("a list whose first page fails was never read: failed, with no 上次读回 and no 已读完", async () => {
  const client = createQueryClient();
  const observer = new InfiniteQueryObserver(client, projectPagesOptions(a, ["broken"], async () => {
    throw new ApiError(503, "list unavailable");
  }) as never);
  const stop = observer.subscribe(() => undefined);
  const failed = projectListState(await until(() => observer.getCurrentResult() as PagedObserverResult, value => value.isError));
  assert.deepEqual([failed.failed, failed.stale, failed.pageFailed, failed.pages, failed.coverage], [true, false, false, 0, "failed"]);
  assert.equal(coverageText({ loaded: 0, matched: 0, filtered: false, more: false, coverage: failed.coverage }), "列表没有读回，无法判断有多少");
  stop();
  client.clear();
});

test("every combination of list flags maps to one coverage, and only a list just read says 已读完", () => {
  const base = { data: undefined, error: null, isPending: true, isFetching: false, isFetchingNextPage: false, isError: false,
    isFetchNextPageError: false, isRefetchError: false, hasNextPage: false, dataUpdatedAt: 0 };
  const read = { pages: [{ nextCursor: "n2" }] }, done = { pages: [{ nextCursor: null }] };
  const cases: Array<[string, Parameters<typeof projectListState>[0], Partial<ReturnType<typeof projectListState>>]> = [
    ["first page on its way", { ...base, isFetching: true }, { reading: true, coverage: "reading" }],
    ["first page failed", { ...base, isPending: false, isError: true, error: new Error("x") }, { failed: true, stale: false, coverage: "failed" }],
    ["read, more to come", { ...base, isPending: false, data: read, hasNextPage: true }, { coverage: "current", more: true, pages: 1 }],
    ["read to the end", { ...base, isPending: false, data: done }, { coverage: "current", more: false }],
    ["reread under way", { ...base, isPending: false, data: done, isFetching: true }, { checking: true, coverage: "checking" }],
    ["next page under way", { ...base, isPending: false, data: read, hasNextPage: true, isFetching: true, isFetchingNextPage: true },
      { loadingMore: true, checking: false, coverage: "current" }],
    ["next page failed", { ...base, isPending: false, data: read, hasNextPage: true, isError: true, isFetchNextPageError: true, error: new Error("x") },
      { pageFailed: true, stale: false, failed: false, coverage: "current" }],
    ["reread failed", { ...base, isPending: false, data: done, isError: true, isRefetchError: true, error: new Error("x") },
      { stale: true, failed: false, coverage: "stale" }],
    ["cursor came back", { ...base, isPending: false, data: read, hasNextPage: false }, { repeatedCursor: true, more: false }],
  ];
  for (const [name, result, expected] of cases) {
    const state = projectListState(result);
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(state[field as keyof typeof state], value, `${name}: ${field}`);
    const text = coverageText({ loaded: 2, matched: 2, filtered: false, more: state.more, coverage: state.coverage });
    if (state.coverage !== "current") assert.doesNotMatch(text, /已读完/, name);
  }
  assert.equal(coverageText({ loaded: 3, matched: 3, filtered: false, more: false, coverage: "stale" }), "上次读回 3 项 · 当前待核对");
  assert.equal(coverageText({ loaded: 3, matched: 1, filtered: true, more: true, coverage: "checking" }), "已载入 3 项 · 匹配 1 项 · 后续页面未读 · 正在核对");
  assert.equal(coverageText({ loaded: 3, matched: 3, filtered: false, more: false }), "已载入 3 项 · 已读完");
  assert.equal(coverageText({ loaded: 0, matched: 0, filtered: false, more: false, coverage: "reading" }), "正在读取");
});

test("a cursor that comes back again ends the list instead of looping", async () => {
  const client = createQueryClient();
  const observer = new InfiniteQueryObserver(client, projectPagesOptions(a, ["loop"], async (cursor: string | undefined) =>
    ({ items: [cursor ?? "first"], nextCursor: cursor ?? "again" })) as never);
  const stop = observer.subscribe(() => undefined);
  await until(() => observer.getCurrentResult(), value => value.data !== undefined);
  await observer.fetchNextPage();
  assert.equal((observer.getCurrentResult() as { hasNextPage: boolean }).hasNextPage, false, "the cursor came back: no further page");
  assert.equal(projectListState(observer.getCurrentResult() as PagedObserverResult).repeatedCursor, true);
  stop();
  client.clear();
});
