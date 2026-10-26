import assert from "node:assert/strict";
import { test } from "node:test";
import { allocationNameLookupKeys, allocationVisibleNames } from "../src/discussions/useAllocationNames.ts";

test("relationship reread looks up already seeded names within the existing bound", () => {
  const keys = ["task:one", "role:two", "session:owned:three"];
  const seeded = { "task:one": "旧任务名", "role:two": "旧职责名" };
  assert.deepEqual(allocationNameLookupKeys(keys, seeded, {}, new Set(), false), ["session:owned:three"]);
  assert.deepEqual(allocationNameLookupKeys(keys, seeded, {}, new Set(), true), keys);
  assert.equal(allocationNameLookupKeys(Array.from({ length: 81 }, (_, i) => `task:${i}`), {}, {}, new Set(), true).length, 80);
});

test("new exact reads override old choices and a reread hides stale labels", () => {
  const seeded = { "task:one": "旧任务名", "role:two": "旧职责名" };
  assert.deepEqual(allocationVisibleNames(seeded, { "task:one": "新任务名" }, false),
    { "task:one": "新任务名", "role:two": "旧职责名" });
  assert.deepEqual(allocationVisibleNames(seeded, {}, true), {});
});
