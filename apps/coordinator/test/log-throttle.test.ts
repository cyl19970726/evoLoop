import assert from "node:assert/strict";
import { test } from "node:test";
import { throttledLog } from "../src/log-throttle.js";

test("the same line is written once per window and the next one says how many were held back", () => {
  let time = 0;
  const lines: string[] = [];
  const log = throttledLog(line => lines.push(line), 60_000, () => time);
  for (let tick = 0; tick < 100; tick++) { log("Session message needs reconciliation"); time += 2000; }
  // 100 ticks over 200 s: the first at 0 s, then one per elapsed minute.
  assert.ok(lines.length <= 4, `wrote ${lines.length} lines for 100 identical errors`);
  assert.equal(lines[0], "Session message needs reconciliation");
  assert.match(lines[1]!, /held back \d+ more times? in the last 60s/);
});

test("a different message is never suppressed by another", () => {
  const lines: string[] = [];
  const log = throttledLog(line => lines.push(line), 60_000, () => 0);
  log("a"); log("a"); log("b");
  assert.deepEqual(lines, ["a", "b"]);
});
