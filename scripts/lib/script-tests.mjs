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
const OTHER_GROUPS = new Set(["node_modules", "research", "docs", "architecture-map"]);

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (OTHER_GROUPS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".test.mjs")) out.push(path);
  }
  return out;
}

/** Script test files that test:unit runs under `root`, as repo-relative posix paths. */
export function listScriptTests(root = repoRoot) {
  const scripts = join(root, "scripts");
  try { statSync(scripts); } catch { return []; }
  return walk(scripts, []).map(path => relative(root, path).split(sep).join("/")).filter(path => !(path in MANUAL_ONLY)).sort();
}

/** Every `scripts/**` `.test.mjs` file regardless of exclusion: what the coverage check must account for. */
export function allScriptTests(root = repoRoot) {
  const scripts = join(root, "scripts");
  try { statSync(scripts); } catch { return []; }
  return walk(scripts, []).map(path => relative(root, path).split(sep).join("/")).sort();
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const rootArg = process.argv.indexOf("--root");
  const root = rootArg > 0 ? resolve(process.argv[rootArg + 1]) : repoRoot;
  process.stdout.write(listScriptTests(root).map(path => `${path}\n`).join(""));
}
