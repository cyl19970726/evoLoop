import assert from "node:assert/strict";
import { test } from "node:test";
import { collaborationTarget } from "../src/features/discussions/collaborationTarget.ts";

const base = "/p/p1/tasks/t1";
test("a 待我决定 link selects its question; anything else selects nothing", () => {
  assert.deepEqual(collaborationTarget(`${base}?section=collaboration&discussion=d1&question=e1&return=%2Fp%2Fp1%2Finbox`, "p1", "t1"), { discussionId: "d1", eventId: "e1" });
  assert.deepEqual(collaborationTarget(`${base}?section=collaboration&question=e1`, "p1", "t1"), { discussionId: "", eventId: "e1" }, "the question alone is enough to find it");
  assert.equal(collaborationTarget(`${base}?section=collaboration&discussion=d1`, "p1", "t1"), null, "no question, nothing to select");
  assert.equal(collaborationTarget(`${base}?section=timing&question=e1`, "p1", "t1"), null, "another section");
  assert.equal(collaborationTarget(`${base}?section=collaboration&question=e1&question=e2`, "p1", "t1"), null, "a repeated question names no single one");
  assert.equal(collaborationTarget(`${base}?section=collaboration&question=%20`, "p1", "t1"), null, "a blank id");
  assert.equal(collaborationTarget(`/p/p1/tasks/other?section=collaboration&question=e1`, "p1", "t1"), null, "another task");
  assert.equal(collaborationTarget(`/p/p1/work?section=collaboration&question=e1`, "p1", "t1"), null, "another page");
});
