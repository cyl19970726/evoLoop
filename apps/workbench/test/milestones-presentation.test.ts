import assert from "node:assert/strict";
import { test } from "node:test";
import { versionView, VERSION_UNREAD } from "../src/features/overview/milestonesPresentation.ts";

test("a missing commit reads 版本未读到, never an old value; links stay public", () => {
  const view = versionView({ commit: null, builtAt: null, startedAt: "2026-11-12T08:00:00.000Z" });
  assert.equal(view.readable, false); assert.equal(view.commit, VERSION_UNREAD); assert.equal(view.builtAt, VERSION_UNREAD);
  assert.ok(view.links.every(link => link.href.startsWith("https://github.com/")));
  assert.equal(versionView(null).startedAt, VERSION_UNREAD);
});
test("a read commit shows 7 chars and a commit link", () => {
  const view = versionView({ commit: "9a4020a5886be01b2d74fe850687ca7355b2d226", builtAt: "2026-11-12T03:10:00.000Z", startedAt: "2026-11-12T08:00:00.000Z" });
  assert.equal(view.commit, "9a4020a"); assert.equal(view.builtAt, "2026-11-12 03:10 UTC");
  assert.ok(view.links[0]!.href.endsWith("/commit/9a4020a5886be01b2d74fe850687ca7355b2d226"));
});
