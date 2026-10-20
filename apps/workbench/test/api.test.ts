import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ApiError, isUnconfirmed } from "../src/api.ts";

const command = {
  type: "task.reviewBasis" as const,
  projectId: "project-1", taskId: "task-1", impactId: "impact-1",
  expectedVersion: 1, decision: "retain" as const, reason: "仍按原依据执行",
  operationId: "operation-1",
};

async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); }
  finally { globalThis.fetch = previous; }
}

test("a truncated successful command response remains unconfirmed", async () => {
  await withFetch(async () => new Response("{", { status: 200 }), async () => {
    await assert.rejects(api("token").command(command), cause => cause instanceof ApiError && cause.status === 0 && isUnconfirmed(cause));
  });
});

test("a successful response for another operation remains unconfirmed", async () => {
  await withFetch(async () => Response.json({ status: "applied", operationId: "other", entityId: command.taskId }), async () => {
    await assert.rejects(api("token").command(command), cause => cause instanceof ApiError && cause.status === 0);
  });
});

test("request deadline aborts an unresolved command and keeps its result unknown", async () => {
  await withFetch(((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch, async () => {
    await assert.rejects(api("token", 5).command(command), cause => cause instanceof ApiError && cause.status === 0 && isUnconfirmed(cause));
  });
});

test("known 409 remains a conflict even when its JSON body is truncated", async () => {
  await withFetch(async () => new Response("{", { status: 409 }), async () => {
    await assert.rejects(api("token").command(command), cause => cause instanceof ApiError && cause.status === 409 && !isUnconfirmed(cause));
  });
});
