import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LEGACY, assertValidList, listBrowserTests, repoRoot } from "./browser-tests.mjs";

// The set CI ran before discovery existed (the old one-line list in package.json); it must not change.
const BEFORE = [
  "apps/workbench/test/button-colors-browser.test.ts",
  "apps/workbench/test/chunk-retention-ci-browser.test.ts",
  "apps/workbench/test/delivery-link-ci-browser.test.ts",
  "apps/workbench/test/flow-view-browser.test.ts",
  "apps/workbench/test/runtime-fault-display-browser.test.ts",
  "apps/workbench/test/focus-ring-ci-browser.test.ts",
  "apps/workbench/test/key-pages-ci-browser.test.ts",
  "apps/workbench/test/session-live-shape-browser.test.ts",
  "apps/workbench/test/task-used-waits-browser.test.ts",
  "apps/workbench/test/theme-switch-browser.test.ts",
];

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "browser-tests-"));
  for (const path of files) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), ""); }
  return root;
}

test("discovery finds every browser test CI ran before, and nothing else", () => {
  const found = listBrowserTests(repoRoot);
  for (const path of BEFORE) assert.ok(found.includes(path), `${path} must still run`);
  // Anything new must follow the naming rule; a file that is neither legacy nor `-ci-browser` would be a leak.
  for (const path of found.filter(path => !BEFORE.includes(path))) assert.match(path, /-ci-browser\.test\.ts$/);
});

test("a new `-ci-browser` test is discovered without touching any shared list; a local-only browser test is not", () => {
  const root = fixture([...LEGACY, "apps/workbench/test/new-thing-ci-browser.test.ts", "apps/workbench/test/sub/deep-ci-browser.test.ts", "apps/workbench/test/local-only-browser.test.ts", "apps/workbench/test/unit.test.ts"]);
  try {
    const found = listBrowserTests(root);
    assert.ok(found.includes("apps/workbench/test/new-thing-ci-browser.test.ts"));
    assert.ok(found.includes("apps/workbench/test/sub/deep-ci-browser.test.ts"));
    assert.ok(!found.includes("apps/workbench/test/local-only-browser.test.ts"));
    assert.ok(!found.includes("apps/workbench/test/unit.test.ts"));
    assert.equal(found.length, LEGACY.length + 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a legacy entry whose file is gone fails instead of silently running fewer tests", () => {
  const root = fixture(LEGACY.slice(1));
  try {
    assert.throws(() => listBrowserTests(root), /legacy browser tests are missing/);
    const run = spawnSync(process.execPath, [join(repoRoot, "scripts/lib/browser-tests.mjs"), "--root", root], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.equal(run.stdout, "", "nothing may be printed when discovery fails");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an empty, duplicated or garbled list is rejected", () => {
  assert.throws(() => assertValidList([]), /no tests/);
  assert.throws(() => assertValidList(["a-ci-browser.test.ts"]), /unparsable/);
  assert.throws(() => assertValidList([BEFORE[0], BEFORE[0]]), /duplicate/);
  assert.deepEqual(assertValidList(BEFORE), BEFORE);
});

test("package.json test:browser asks discovery instead of listing files", () => {
  const script = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts["test:browser"];
  assert.match(script, /scripts\/lib\/browser-tests\.mjs/);
  assert.doesNotMatch(script, /\.test\.ts\s+\S*\.test\.ts/, "the files must not be listed back on one line");
});
