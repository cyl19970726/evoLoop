#!/usr/bin/env node
// Discovers the browser tests that `npm run test:browser` runs, so adding one never means editing package.json: the old
// one-line list of files made every PR that added a browser test conflict with every other (#469 and #470 did, on 2026-11-16).
// Used as `$(node scripts/lib/browser-tests.mjs)` in the test:browser command and by scripts/lib/browser-tests.test.mjs.
// Prints repo-relative paths, one per line, sorted.
//
// The rule: a browser test that CI runs is a file named `apps/workbench/test/**/<name>-ci-browser.test.ts`. The other
// `*-browser.test.ts` files in that directory are local-only and stay out of CI, exactly as before.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const TEST_DIR = "apps/workbench/test";
export const CI_PATTERN = /-ci-browser\.test\.ts$/;

// The tests CI already ran by name before discovery existed and whose names do not end in `-ci-browser`. This list is
// frozen: do NOT add to it, name a new test `<name>-ci-browser.test.ts` instead. An entry whose file is gone is an error.
export const LEGACY = [
  "apps/workbench/test/button-colors-browser.test.ts",
  "apps/workbench/test/flow-view-browser.test.ts",
  "apps/workbench/test/session-live-shape-browser.test.ts",
  "apps/workbench/test/task-used-waits-browser.test.ts",
  "apps/workbench/test/theme-switch-browser.test.ts",
];

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CI_PATTERN.test(name)) out.push(path);
  }
  return out;
}

const exists = path => { try { return statSync(path).isFile(); } catch { return false; } };

/** Browser test files `test:browser` runs under `root`, as repo-relative posix paths. */
export function listBrowserTests(root = repoRoot) {
  const dir = join(root, TEST_DIR);
  const found = walk(dir, []).map(path => relative(root, path).split(sep).join("/"));
  const missing = LEGACY.filter(path => !exists(join(root, path)));
  if (missing.length) throw new Error(`legacy browser tests are missing: ${missing.join(", ")}`);
  return [...new Set([...LEGACY, ...found])].sort();
}

/** The output goes to `node --test` through the shell, so an empty or garbled list must fail instead of running fewer tests. */
export function assertValidList(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("browser test discovery found no tests; test:browser would silently skip them all");
  const bad = list.filter(path => typeof path !== "string" || !/^apps\/workbench\/test\/[\w./-]+-browser\.test\.ts$/.test(path));
  if (bad.length) throw new Error(`browser test discovery produced unparsable entries: ${bad.slice(0, 3).join(", ")}`);
  if (new Set(list).size !== list.length) throw new Error("browser test discovery produced duplicate entries");
  return list;
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const rootArg = process.argv.indexOf("--root");
  const root = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : repoRoot;
  // Any failure exits non-zero BEFORE anything is printed, so `files=$(…) && …` in test:browser stops instead of running without them.
  try { process.stdout.write(assertValidList(listBrowserTests(root)).map(path => `${path}\n`).join("")); }
  catch (error) { process.stderr.write(`browser-tests: ${error.message}\n`); process.exit(1); }
}
