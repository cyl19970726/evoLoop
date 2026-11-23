import assert from "node:assert/strict";
import test from "node:test";
import { jumpPrefixRange, parseJumpInput } from "../src/object-jump.ts";

test("what a pasted text means", () => {
  assert.deepEqual(parseJumpInput("#527"), { kind: "pr", number: 527 });
  assert.deepEqual(parseJumpInput(" 527 "), { kind: "pr", number: 527 });
  assert.deepEqual(parseJumpInput("a1b2c3d4"), { kind: "id", prefix: "a1b2c3d4" });
  assert.deepEqual(parseJumpInput("A1B2C3D4-0000"), { kind: "id", prefix: "a1b2c3d40000" });
  assert.deepEqual(parseJumpInput("12345678"), { kind: "id", prefix: "12345678" }, "eight digits are an id prefix");
  assert.deepEqual(parseJumpInput("a1b2c3d"), { kind: "short", length: 7 });
  assert.deepEqual(parseJumpInput("#0"), { kind: "invalid" });
  for (const text of ["", "  ", "#", "x1b2c3d4", "a1b2c3d4'", "50%", "a_b", "#12a", `${"a".repeat(33)}`]) assert.equal(parseJumpInput(text).kind === "id", false, text);
});

test("an id prefix is the range of full ids that start with it", () => {
  assert.deepEqual(jumpPrefixRange("a1b2c3d4"), { low: "a1b2c3d4-0000-0000-0000-000000000000", high: "a1b2c3d4-ffff-ffff-ffff-ffffffffffff" });
  assert.deepEqual(jumpPrefixRange("a1b2c3d4000"), { low: "a1b2c3d4-0000-0000-0000-000000000000", high: "a1b2c3d4-000f-ffff-ffff-ffffffffffff" });
});
