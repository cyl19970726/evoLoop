// Query scopes: a project's answers never outlive leaving it, writes make only that project stale, 4xx is final.
import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryObserver } from "@tanstack/react-query";
import { ApiError } from "../src/shared/api.ts";
import {
  createQueryClient, fixedContent, leaveProject, projectChanged, projectQueryOptions, queryKeys, shouldRetry,
} from "../src/shared/query.ts";

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
