import assert from "node:assert/strict";
import { test } from "node:test";
import { allocationRelations } from "../src/discussions/allocationClient.ts";
import { allocationChangeRequiresReload } from "../src/discussions/useAllocationChanges.ts";
import { api } from "../src/api.ts";
import { sessionClient } from "../src/sessions/client.ts";
import type { SessionChanges } from "@evoloop/contracts/session-observation";

const projectId = "11111111-1111-4111-8111-111111111111";
const roleId = "22222222-2222-4222-8222-222222222222";
const discussionId = "33333333-3333-4333-8333-333333333333";

test("allocation relation reads use exactly one server filter and preserve opaque cursor", async () => {
  const previous = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async input => {
    paths.push(String(input));
    return Response.json({ items: [], nextCursor: null, resetRequired: false,
      canonicalSessionKey: null, metadata: { generatedAt: "2026-10-26T00:00:00Z", sourceObservedAt: null, partial: false, limitations: [] } });
  };
  try {
    await allocationRelations("token", projectId, { roleId });
    await allocationRelations("token", projectId, { discussionId }, "next:cursor/1");
    assert.equal(paths.length, 2);
    const first = new URL(paths[0]!, "http://local.test");
    assert.equal(first.searchParams.get("roleId"), roleId);
    assert.equal(first.searchParams.get("discussionId"), null);
    assert.equal(first.searchParams.get("sessionKey"), null);
    assert.equal(first.searchParams.get("limit"), "20");
    const second = new URL(paths[1]!, "http://local.test");
    assert.equal(second.searchParams.get("discussionId"), discussionId);
    assert.equal(second.searchParams.get("cursor"), "next:cursor/1");
  } finally { globalThis.fetch = previous; }
});

test("discussion exploration requests server filtered allocation pages", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://local.test");
    assert.equal(url.pathname, `/api/projects/${projectId}/discussions`);
    assert.equal(url.searchParams.get("kind"), "allocation");
    return Response.json({ items: [], nextCursor: null });
  };
  try { assert.deepEqual((await api("token").discussions(projectId, undefined, "allocation")).items, []); }
  finally { globalThis.fetch = previous; }
});

test("allocation invalidation watches project changes, including unrelated Session keys", async () => {
  const previous = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async input => {
    paths.push(String(input));
    return Response.json(paths.length === 1 ? { observationCursor: "project-cursor" } : {
      items: [], nextCursor: "next-cursor", hasMore: false, resetRequired: false,
      metadata: { generatedAt: "2026-10-26T00:00:00Z", sourceObservedAt: null, partial: false, limitations: [] },
    });
  };
  try {
    const client = sessionClient("token", projectId);
    assert.equal((await client.directory({ limit: 1 })).observationCursor, "project-cursor");
    await client.changes("project-cursor");
    const directory = new URL(paths[0]!, "http://local.test");
    const changes = new URL(paths[1]!, "http://local.test");
    assert.equal(directory.searchParams.get("limit"), "1");
    assert.equal(changes.searchParams.get("cursor"), "project-cursor");
    assert.equal(changes.searchParams.has("key"), false);
  } finally { globalThis.fetch = previous; }
  const unchanged = { items: [], nextCursor: "next", hasMore: false, resetRequired: false,
    metadata: { generatedAt: "2026-10-26T00:00:00Z", sourceObservedAt: null, partial: false, limitations: [] } } as SessionChanges;
  assert.equal(allocationChangeRequiresReload(unchanged), false);
  assert.equal(allocationChangeRequiresReload({ ...unchanged, metadata: { ...unchanged.metadata, partial: true } }), false);
  assert.equal(allocationChangeRequiresReload({ ...unchanged, items: [{ sessionKeys: ["owned:other"] }] } as SessionChanges), true);
  assert.equal(allocationChangeRequiresReload({ ...unchanged, resetRequired: true }), true);
  assert.equal(allocationChangeRequiresReload({ ...unchanged, hasMore: true }), true);
});
