// The agent page returns early until its snapshot is read. A hook called after that return runs only once the snapshot
// arrives, so React sees more hooks than on the first render and the whole page fails (React error #310: “这一页显示出错”).
// Browser regressions are not part of CI, so this reads the source: every hook of SessionWorkspace sits above the return.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("SessionWorkspace calls every hook before it returns early for a missing snapshot", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/features/sessions/SessionWorkspace.tsx"), "utf8");
  const start = source.indexOf("export function SessionWorkspace(");
  const early = source.indexOf("if (!snapshot) return", start);
  const end = source.indexOf("\n}\n", early);
  assert.ok(start >= 0 && early > start && end > early, "the component, its early return and its end are found");
  const after = source.slice(early, end).split("\n").map((line, index) => [index, line] as const)
    .filter(([, line]) => /\buse[A-Z]\w*\(/.test(line));
  assert.deepEqual(after, [], "no hook after the early return");
});
