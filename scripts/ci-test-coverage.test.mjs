// Every test file under scripts/ must be run by something CI executes. A test wired only into an npm script that no
// workflow calls passes by never running, and a green `app` check then proves nothing about it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;

function workflowRuns() {
  const dir = join(root, ".github/workflows");
  return readdirSync(dir).filter(name => /\.ya?ml$/.test(name)).flatMap(name => [...readFileSync(join(dir, name), "utf8").matchAll(/^\s*-?\s*run:\s*(.+)$/gm)].map(match => match[1]));
}

/** Text of every npm script CI reaches: `npm run X` in a workflow, followed through `npm run Y` inside scripts. */
export function reachableScriptText() {
  const reached = new Set(), queue = [];
  const visit = text => { for (const match of text.matchAll(/npm run (?:--silent )?([\w:.-]+)/g)) if (!reached.has(match[1])) { reached.add(match[1]); queue.push(match[1]); } };
  workflowRuns().forEach(visit);
  workflowRuns().forEach(line => { for (const name of Object.keys(packageScripts)) if (line.trim() === `npm ${name}` || line.trim() === `npm test`) { if (!reached.has(name)) { reached.add(name); queue.push(name); } } });
  const texts = [];
  while (queue.length) { const name = queue.shift(); const body = packageScripts[name]; if (!body) continue; texts.push(body); visit(body); }
  return { texts: texts.join("\n"), reached: [...reached] };
}

const globToRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);

function testFiles(dir) {
  return readdirSync(dir).flatMap(name => {
    if (name === "node_modules" || name === "research") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? testFiles(path) : /\.test\.(mjs|js)$/.test(name) ? [path] : [];
  });
}

// Known tests that CI cannot run, each with the reason. An entry that CI starts running (or whose file disappears)
// must be removed from this list, so the list cannot quietly go stale.
export const MANUAL_ONLY = {
  "scripts/backup.test.mjs": "needs a dedicated evoloop_backup_test database and PostgreSQL 18 client tools (pg_dump, pg_restore); run by hand as described in docs/development/local-run.md",
};

test("every scripts/**/*.test.* file is named (or globbed) by a script that a CI workflow runs", () => {
  const { texts } = reachableScriptText();
  const tokens = texts.split(/\s+/).filter(token => /\.test\.(mjs|js|ts)$|\*/.test(token));
  const files = testFiles(join(root, "scripts")).map(path => relative(root, path));
  const reached = path => tokens.some(token => token === path || (token.includes("*") && globToRegExp(token).test(path)));
  const unreached = files.filter(path => !reached(path) && !(path in MANUAL_ONLY));
  assert.deepEqual(unreached, [], `tests no CI workflow runs (wire them into test:unit, or list them in MANUAL_ONLY with a reason): ${unreached.join(", ")}`);
  const stale = Object.keys(MANUAL_ONLY).filter(path => !files.includes(path) || reached(path));
  assert.deepEqual(stale, [], `MANUAL_ONLY entries that no longer apply: ${stale.join(", ")}`);
});

test("the CI-executed groups include the ones this suite relies on", () => {
  const { reached } = reachableScriptText();
  for (const name of ["test:unit", "test:integration", "test:docs"]) assert.ok(reached.includes(name), `${name} is not reachable from a workflow`);
});
