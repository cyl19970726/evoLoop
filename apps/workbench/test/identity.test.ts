// One identity for every request: a token typed in this page or the Hub's cookie; a 401 anywhere signs out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, api } from "../src/shared/api.ts";
import { authMode, onUnauthorized, requestAuth, signIn, signOut, signedInToken } from "../src/shared/identity.ts";

const doc = (content: string | null) => ({ querySelector: () => content === null ? null : { getAttribute: () => content } }) as unknown as Pick<Document, "querySelector">;

test("the Hub marks its pages; everything else is a local coordinator", () => {
  assert.equal(authMode(doc("hub")), "hub");
  assert.equal(authMode(doc("token")), "token");
  assert.equal(authMode(doc(null)), "token");
  assert.equal(authMode(null), "token");
});

test("requests carry the signed-in token, an explicit login token wins, and none after sign-out", () => {
  signOut();
  assert.deepEqual(requestAuth(), { headers: {}, credentials: "same-origin" }, "the Hub cookie alone");
  signIn("t-signed-in");
  assert.equal(signedInToken(), "t-signed-in");
  assert.deepEqual(requestAuth().headers, { Authorization: "Bearer t-signed-in" });
  assert.deepEqual(requestAuth("t-checking").headers, { Authorization: "Bearer t-checking" });
  signOut();
  assert.deepEqual(requestAuth().headers, {});
});

test("api() without a token uses the identity; a 401 is reported once per answer, a 403 is not", async () => {
  const seen: Array<{ url: string; auth: string | null; credentials?: RequestCredentials }> = [];
  let status = 200;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get("authorization"), credentials: init?.credentials });
    return new Response(JSON.stringify(status === 200 ? { principal: { actorId: "reader", projectIds: [], permissions: [] }, capabilities: {} } : { message: "no" }), { status });
  }) as typeof fetch;
  let reported = 0;
  const stop = onUnauthorized(() => { reported++; });
  try {
    signIn("t-1");
    await api().session();
    assert.deepEqual(seen.at(-1), { url: "/api/session", auth: "Bearer t-1", credentials: "same-origin" });
    status = 403;
    await assert.rejects(api().session(), (cause: unknown) => cause instanceof ApiError && cause.status === 403);
    assert.equal(reported, 0, "403 is about one resource; pages explain it");
    status = 401;
    await assert.rejects(api().session(), (cause: unknown) => cause instanceof ApiError && cause.status === 401);
    assert.equal(reported, 1);
  } finally { stop(); signOut(); globalThis.fetch = original; }
});
