import assert from "node:assert/strict";
import { test } from "node:test";
import { roleCardKey, roleListScope } from "../src/roles/roleListRefresh";

test("a Role card keeps its identity across new versions so an open entry stays open", () => {
  assert.equal(roleCardKey({ id: "r1" }), roleCardKey({ id: "r1", version: 2 } as { id: string }));
  assert.notEqual(roleCardKey({ id: "r1" }), roleCardKey({ id: "r2" }));
});

test("the list is cleared only for another reader or project, not for a same-scope refresh", () => {
  assert.equal(roleListScope("t", "p"), roleListScope("t", "p"));
  assert.notEqual(roleListScope("t", "p"), roleListScope("t2", "p"));
  assert.notEqual(roleListScope("t", "p"), roleListScope("t", "p2"));
});
