#!/usr/bin/env node
// Discovers the script tests (`scripts/**/*.test.mjs`) that `npm run test:unit` runs, so adding a test file never
// means editing package.json: the old one-line list of files made every PR that added a test conflict with every other.
// Used as `$(node scripts/lib/script-tests.mjs)` in the test:unit command, and by scripts/ci-test-coverage.test.mjs, so the
// coverage check judges the same list CI runs. Prints repo-relative paths, one per line, sorted.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Script tests that `test:unit` must not run, each with the reason. This is the ONLY exclusion mechanism; an entry whose
// file is gone, or which test:unit runs anyway, is flagged by scripts/ci-test-coverage.test.mjs so the list cannot go stale.
export const MANUAL_ONLY = {
  "scripts/backup.test.mjs": "needs a dedicated evoloop_backup_test database and PostgreSQL 18 client tools (pg_dump, pg_restore), which the CI job does not have; run by hand as described in docs/development/local-run.md",
};

// Directories under scripts/ whose tests belong to another group: `.js` suites of test:docs (docs, architecture-map) and research code.
// ONLY test:unit's discovery skips these. The coverage check's universe (allScriptTests) does not: a `.test.mjs` dropped in one
// of them is run by nobody, so the check must see it and fail unless a group matches it or MANUAL_ONLY registers it.
export const OTHER_GROUPS = new Set(["node_modules", "research", "docs", "architecture-map"]);

function walk(dir, out, skip, pattern) {
  for (const name of readdirSync(dir).sort()) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out, skip, pattern);
    else if (pattern.test(name)) out.push(path);
  }
  return out;
}

const rel = (root, paths) => paths.map(path => relative(root, path).split(sep).join("/")).sort();
const exists = dir => { try { return statSync(dir).isDirectory(); } catch { return false; } };

/** Script test files that test:unit runs under `root`, as repo-relative posix paths. `skip` is only for tests that simulate a wrong skip list. */
export function listScriptTests(root = repoRoot, { skip = OTHER_GROUPS } = {}) {
  const scripts = join(root, "scripts");
  if (!exists(scripts)) return [];
  return rel(root, walk(scripts, [], skip, /\.test\.mjs$/)).filter(path => !(path in MANUAL_ONLY));
}

/** Every `.test.mjs` / `.test.js` under scripts/ except in node_modules, whatever group should run it: what the coverage check must account for. */
export function allScriptTests(root = repoRoot) {
  const scripts = join(root, "scripts");
  if (!exists(scripts)) return [];
  return rel(root, walk(scripts, [], new Set(["node_modules"]), /\.test\.(mjs|js)$/));
}

/**
 * The discovery output is handed to `node --test` through the shell, where an empty or garbled list would silently run
 * fewer tests. So the list must be non-empty, every line a repo-relative `.test.mjs` path under scripts/, no duplicates.
 */
export function assertValidList(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("script test discovery found no tests; test:unit would silently skip every script test");
  const bad = list.filter(path => typeof path !== "string" || !/^scripts\/[\w./-]+\.test\.mjs$/.test(path));
  if (bad.length) throw new Error(`script test discovery produced unparsable entries: ${bad.slice(0, 3).join(", ")}`);
  if (new Set(list).size !== list.length) throw new Error("script test discovery produced duplicate entries");
  return list;
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const rootArg = process.argv.indexOf("--root");
  const root = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : repoRoot;
  // Any failure exits non-zero BEFORE anything is printed: `files=$(…) && …` in test:unit then stops instead of running without them.
  try { process.stdout.write(assertValidList(listScriptTests(root)).map(path => `${path}\n`).join("")); }
  catch (error) { process.stderr.write(`script-tests: ${error.message}\n`); process.exit(1); }
}
