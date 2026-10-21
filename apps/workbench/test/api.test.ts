import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ApiError, isStaleConflict, isUnconfirmed, safeArtifactHref } from "../src/api.ts";

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

test("artifact links allow this project's fixed routes and web URLs only", () => {
  const project = "11111111-1111-4111-8111-111111111111";
  const task = "22222222-2222-4222-8222-222222222222";
  assert.equal(safeArtifactHref(`#/p/${project}/tasks/${task}?revision=${task}`, project),
    `#/p/${project}/tasks/${task}?revision=${task}`);
  assert.equal(safeArtifactHref("https://example.test/report#fixed", project), "https://example.test/report#fixed");
  const fixed = `#/p/${project}/documents/${task}?revision=${task}`;
  assert.equal(safeArtifactHref(`http://127.0.0.1:55337/${fixed}`, project), fixed);
  assert.equal(safeArtifactHref(`http://localhost:55337/app/${fixed}`, project), fixed);
  assert.equal(safeArtifactHref(`https://example.test/${fixed}`, project), `https://example.test/${fixed}`);
  assert.equal(safeArtifactHref(`http://127.0.0.1:55337/unrelated/${fixed}`, project), `http://127.0.0.1:55337/unrelated/${fixed}`);
  const knowledge = `#/p/${project}/knowledge?knowledgeId=${task}&knowledgeRevision=${project}`;
  const evaluation = `#/p/${project}/evaluations/${task}?revision=${project}`;
  assert.equal(safeArtifactHref(`http://127.0.0.1:55421/${knowledge}`, project), knowledge);
  assert.equal(safeArtifactHref(evaluation, project), evaluation);
  assert.equal(safeArtifactHref(`http://localhost:55421/app/${evaluation}`, project), evaluation);
  for (const invalid of [
    `#/p/${project}/knowledge?knowledgeId=${task}&knowledgeRevision=${project}&knowledgeId=${task}`,
    `#/p/${project}/knowledge?knowledgeId=${task}&knowledgeRevision=${project}&review=1`,
    `#/p/${project}/knowledge?knowledgeId=${task}&knowledgeRevision=bad`,
    `#/p/${project}/knowledge?knowledgeRevision=${project}`,
    `#/p/${project}/knowledge?revision=${project}`,
    `#/p/${project}/evaluations/${task}?revision=${project}&action=run`,
    `#/p/${project}/evaluations/${task}?revision=${project}&revision=${project}`,
    `#/p/${task}/knowledge?knowledgeId=${task}&knowledgeRevision=${project}`,
    `#/p/${task}/evaluations/${task}?revision=${project}`,
  ]) assert.equal(safeArtifactHref(invalid, project), null, invalid);
  for (const unsafe of ["javascript:alert(1)", "file:///private/report", "data:text/html,hello",
    "//example.test/report", `#/p/${task}/tasks/${task}`, `#/p/${project}/tasks/../knowledge`,
    `#/p/${project}/tasks/${task}?next=javascript:alert(1)`, "https://user:pass@example.test/report"]) {
    assert.equal(safeArtifactHref(unsafe, project), null, unsafe);
  }
});

test("task revision history uses the task-scoped read endpoint", async () => {
  const revision = { revision: { id: "fixed", version: 2, state: "deferred", reason: "需补证" }, basis: null };
  await withFetch(async (input, init) => {
    assert.equal(input, "/api/projects/project-1/tasks/task-1/revisions");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token");
    return Response.json([revision]);
  }, async () => {
    assert.deepEqual(await api("token").taskRevisions("project-1", "task-1"), [revision]);
  });
});

test("discussion reads stay within the authorized project and expose immutable events", async () => {
  const requested: string[] = [];
  await withFetch(async input => {
    requested.push(String(input));
    return Response.json(String(input).endsWith("/events") ? [{ id: "event-1", kind: "prepared", version: 1 }]
      : String(input).includes("?limit=") ? { items: [{ id: "discussion-1", status: "prepared" }], nextCursor: null }
      : { id: "discussion-1", status: "prepared" });
  }, async () => {
    const client = api("token");
    assert.equal((await client.discussions("project-1")).items[0]?.id, "discussion-1");
    assert.equal((await client.discussion("project-1", "discussion-1")).status, "prepared");
    assert.equal((await client.discussionEvents("project-1", "discussion-1"))[0]?.kind, "prepared");
  });
  assert.deepEqual(requested, [
    "/api/projects/project-1/discussions?limit=50",
    "/api/projects/project-1/discussions/discussion-1",
    "/api/projects/project-1/discussions/discussion-1/events",
  ]);
});

test("a confirmed business mismatch remains editable while changed versions require readback", () => {
  assert.equal(isStaleConflict(new ApiError(409, "wrong stage", { code: "BASELINE_MISMATCH" })), false);
  assert.equal(isStaleConflict(new ApiError(409, "invalid choice", { code: "INVALID_STATE" })), false);
  assert.equal(isStaleConflict(new ApiError(409, "changed", { code: "VERSION_CONFLICT" })), true);
  assert.equal(isStaleConflict(new ApiError(409, "changed", { code: "DOCUMENT_CHANGED" })), true);
  assert.equal(isStaleConflict(new ApiError(409, "changed", { code: "DECISION_TARGET_CHANGED" })), true);
  assert.equal(isStaleConflict("REVIEW_TARGET_CHANGED"), true);
  assert.equal(isStaleConflict(new ApiError(409, "unknown", {})), false);
});
