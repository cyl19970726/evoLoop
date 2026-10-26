import assert from "node:assert/strict";
import { test } from "node:test";
import { allocationRelations } from "../src/discussions/allocationClient.ts";
import { api } from "../src/api.ts";

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
