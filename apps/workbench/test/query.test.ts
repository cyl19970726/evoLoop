// Query scopes: a project's answers never outlive leaving it, writes make only that project stale, 4xx is final.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/shared/api.ts";
import { createQueryClient, leaveProject, projectChanged, queryKeys, shouldRetry } from "../src/shared/query.ts";

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

test("4xx answers are final; connection and server failures retry twice", () => {
  for (const status of [400, 401, 403, 404, 409]) assert.equal(shouldRetry(0, new ApiError(status, "x")), false, String(status));
  assert.equal(shouldRetry(0, new ApiError(0, "连接中断")), true);
  assert.equal(shouldRetry(1, new ApiError(503, "busy")), true);
  assert.equal(shouldRetry(2, new ApiError(503, "busy")), false);
});
