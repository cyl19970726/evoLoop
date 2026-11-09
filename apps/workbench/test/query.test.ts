// Query scopes: a project's answers never outlive leaving it, writes make only that project stale, 4xx is final.
// A failed read keeps the last answer (marked stale) instead of emptying the screen, and a list reads one page at a time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { InfiniteQueryObserver, QueryObserver, type InfiniteData, type QueryObserverResult } from "@tanstack/react-query";
import { ApiError } from "../src/shared/api.ts";
import {
  createQueryClient, fixedContent, keepLastAnswer, leaveProject, pagedItems, previousOfProject, projectChanged, projectPagesOptions,
  projectQueryOptions, queryKeys, shouldRetry, type KeptAnswer,
} from "../src/shared/query.ts";

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

test("a deeper range that fails keeps the last answer on screen, marked stale, and a retry reads the deeper range", async () => {
  const client = createQueryClient();
  const reads: number[] = [];
  let deeperFails = true;
  // A range read: depth 1 answers, depth 2 fails until it is allowed (409 is not retried, so the test does not wait).
  const read = (depth: number) => async () => {
    reads.push(depth);
    if (depth === 2 && deeperFails) throw new ApiError(409, "range unavailable");
    return Array.from({ length: depth * 2 }, (_, index) => `item-${index}`);
  };
  const memory: { current: KeptAnswer<string[]> | null } = { current: null };
  const observer = new QueryObserver(client, projectQueryOptions(a, ["list", 1], read(1), { keepPrevious: true }));
  const stop = observer.subscribe(() => undefined);
  const first = await until(() => observer.getCurrentResult(), result => result.data !== undefined);
  assert.deepEqual(keepLastAnswer(a, first, true, memory), { data: ["item-0", "item-1"], isPlaceholderData: false, dataUpdatedAt: first.dataUpdatedAt, stale: false });

  observer.setOptions(projectQueryOptions(a, ["list", 2], read(2), { keepPrevious: true }));
  const pending = observer.getCurrentResult();
  assert.equal(pending.isPlaceholderData, true, "while the deeper range is read, the last answer stands in");
  const failed = await until(() => observer.getCurrentResult(), result => result.isError);
  assert.equal(failed.data, undefined, "TanStack itself drops the placeholder once the new key fails");
  const kept = keepLastAnswer(a, failed, true, memory);
  assert.deepEqual(kept, { data: ["item-0", "item-1"], isPlaceholderData: true, dataUpdatedAt: first.dataUpdatedAt, stale: true },
    "the list on screen stays, as 上次读回");
  assert.equal(keepLastAnswer(a, failed, false, { current: memory.current }).data, undefined, "without keepPrevious nothing is kept");

  // A retry reads the deeper range again, not the old one.
  deeperFails = false;
  reads.length = 0;
  await observer.refetch();
  const deeper = await until(() => observer.getCurrentResult(), result => !result.isPlaceholderData && result.data?.length === 4);
  assert.deepEqual(reads, [2]);
  assert.deepEqual(keepLastAnswer(a, deeper, true, memory), { data: deeper.data, isPlaceholderData: false, dataUpdatedAt: deeper.dataUpdatedAt, stale: false });
  stop();
  client.clear();
});

test("another project never shows the last project's answer, as a placeholder or as 上次读回", async () => {
  const client = createQueryClient();
  const memory: { current: KeptAnswer<string> | null } = { current: null };
  const observer = new QueryObserver(client, projectQueryOptions(a, ["summary"], async () => "A 的摘要", { keepPrevious: true }));
  const stop = observer.subscribe(() => undefined);
  keepLastAnswer(a, await until(() => observer.getCurrentResult(), result => result.data !== undefined), true, memory);
  // The same component now reads project B; its first read is still on the way.
  let answerB = (_value: string) => undefined as void;
  observer.setOptions(projectQueryOptions(b, ["summary"], () => new Promise<string>(resolve => { answerB = resolve; }), { keepPrevious: true }));
  const pending = observer.getCurrentResult();
  assert.equal(pending.data, undefined, "A's answer is not a placeholder for B");
  assert.equal(pending.isPlaceholderData, false);
  // And when B's read fails, A's last answer is not kept for B either.
  const failedForB = { data: undefined, isError: true, isPlaceholderData: false, dataUpdatedAt: 0 };
  assert.deepEqual(keepLastAnswer(b, failedForB, true, memory), { data: undefined, isPlaceholderData: false, dataUpdatedAt: 0, stale: false });
  assert.equal(previousOfProject(b)("A 的摘要", { queryKey: queryKeys.project(a, "summary") }), undefined);
  assert.equal(previousOfProject(a)("A 的摘要", { queryKey: queryKeys.project(a, "summary") }), "A 的摘要");
  // A failed reread of the same key keeps its data in TanStack and is marked stale the same way.
  assert.equal(keepLastAnswer(a, { data: "A 的摘要", isError: true, isPlaceholderData: false, dataUpdatedAt: 1 }, true, { current: null }).stale, true);
  answerB("B 的摘要");
  assert.equal((await until(() => observer.getCurrentResult(), result => result.data !== undefined)).data, "B 的摘要");
  stop();
  client.clear();
});

test("a list reads one more page on load more; a failed next page keeps the loaded pages and is retried alone", async () => {
  const client = createQueryClient();
  const asked: Array<string | undefined> = [];
  let failing: string | null = "c3";
  type Page = { items: string[]; nextCursor: string | null };
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
  const result = () => observer.getCurrentResult() as QueryObserverResult<InfiniteData<Page, string | null>> & {
    hasNextPage: boolean; isFetchNextPageError: boolean; isRefetchError: boolean };
  await until(result, value => value.data?.pages.length === 1);
  await observer.fetchNextPage();
  assert.deepEqual(asked, [undefined, "c2"], "page 2 is one request, not the range from page 1 again");
  assert.deepEqual(pagedItems(result().data!.pages, item => item), ["a", "b", "c"], "each item once");

  await observer.fetchNextPage();
  const pageFailed = result();
  assert.equal(pageFailed.isFetchNextPageError, true, "这一页没读到");
  assert.equal(pageFailed.isRefetchError, false);
  assert.equal(pageFailed.data?.pages.length, 2, "the loaded pages stay");
  failing = null;
  asked.length = 0;
  await observer.fetchNextPage();
  assert.deepEqual(asked, ["c3"], "the retry reads only the failed page");
  assert.deepEqual(pagedItems(result().data!.pages, item => item), ["a", "b", "c", "d"]);
  assert.equal(result().hasNextPage, false);

  // A reread that fails keeps all loaded pages, as 上次读回.
  failing = "c2";
  await observer.refetch();
  const stale = result();
  assert.equal(stale.isRefetchError, true);
  assert.equal(stale.data?.pages.length, 3);
  stop();
  client.clear();
});

test("a cursor that comes back again ends the list instead of looping", async () => {
  const client = createQueryClient();
  const observer = new InfiniteQueryObserver(client, projectPagesOptions(a, ["loop"], async (cursor: string | undefined) =>
    ({ items: [cursor ?? "first"], nextCursor: cursor ?? "again" })) as never);
  const stop = observer.subscribe(() => undefined);
  await until(() => observer.getCurrentResult(), value => value.data !== undefined);
  await observer.fetchNextPage();
  assert.equal((observer.getCurrentResult() as { hasNextPage: boolean }).hasNextPage, false, "the cursor came back: no further page");
  stop();
  client.clear();
});
