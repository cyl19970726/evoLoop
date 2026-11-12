// Every test file under scripts/ must be run by something CI executes. A test wired only into an npm script that no
// workflow calls passes by never running, and a green `app` check then proves nothing about it.
// `test:unit` finds the script tests itself (scripts/lib/script-tests.mjs), so adding a test file does not touch package.json;
// this check judges the same discovered list, plus anything a reachable script names explicitly.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MANUAL_ONLY, OTHER_GROUPS, allScriptTests, assertValidList, listScriptTests } from "./lib/script-tests.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const realRoot = resolve(here, "..");
const DISCOVERY = "scripts/lib/script-tests.mjs";

function workflowRuns(root) {
  const dir = join(root, ".github/workflows");
  return readdirSync(dir).filter(name => /\.ya?ml$/.test(name)).flatMap(name => [...readFileSync(join(dir, name), "utf8").matchAll(/^\s*-?\s*run:\s*(.+)$/gm)].map(match => match[1]));
}

/** Text of every npm script CI reaches: `npm run X` in a workflow, followed through `npm run Y` inside scripts. */
export function reachableScriptText(root = realRoot) {
  const packageScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const reached = new Set(), queue = [];
  const visit = text => { for (const match of text.matchAll(/npm run (?:--silent )?([\w:.-]+)/g)) if (!reached.has(match[1])) { reached.add(match[1]); queue.push(match[1]); } };
  const runs = workflowRuns(root);
  runs.forEach(visit);
  runs.forEach(line => { for (const name of Object.keys(packageScripts)) if (line.trim() === `npm ${name}` || line.trim() === `npm test`) { if (!reached.has(name)) { reached.add(name); queue.push(name); } } });
  const texts = [];
  while (queue.length) { const name = queue.shift(); const body = packageScripts[name]; if (!body) continue; texts.push(body); visit(body); }
  return { texts: texts.join("\n"), reached: [...reached] };
}

const globToRegExp = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);

/**
 * Which script tests no CI-reachable script runs, and which MANUAL_ONLY entries no longer apply.
 * The universe is every `.test.mjs`/`.test.js` under scripts/ except in node_modules, NOT the directories test:unit's discovery
 * skips: a test in scripts/docs, scripts/research or scripts/architecture-map that no group matches must be reported, not hidden.
 * `discoverySkip` and `manualOnly` exist so tests can simulate a wrong skip list or a registered exception.
 */
export function coverage(root = realRoot, { discoverySkip = OTHER_GROUPS, manualOnly = MANUAL_ONLY } = {}) {
  const { texts } = reachableScriptText(root);
  const tokens = texts.split(/\s+/).filter(token => /\.test\.(mjs|js|ts)$|\*/.test(token));
  const discovered = new Set(texts.includes(DISCOVERY) ? listScriptTests(root, { skip: discoverySkip }) : []);
  const files = allScriptTests(root);
  const reached = path => discovered.has(path) || tokens.some(token => token === path || (token.includes("*") && globToRegExp(token).test(path)));
  return {
    unreached: files.filter(path => !reached(path) && !(path in manualOnly)),
    stale: Object.keys(manualOnly).filter(path => !files.includes(path) || reached(path)),
    discovered: [...discovered],
  };
}

test("every scripts/**/*.test.* file is run by a script a CI workflow runs, or is listed in MANUAL_ONLY with a reason", () => {
  const { unreached, stale } = coverage();
  assert.deepEqual(unreached, [], `tests no CI workflow runs (.test.mjs files are found by ${DISCOVERY} automatically, except under scripts/docs, scripts/research and scripts/architecture-map: move such a test out, make it a .test.js for test:docs, or list it in MANUAL_ONLY with a reason): ${unreached.join(", ")}`);
  assert.deepEqual(stale, [], `MANUAL_ONLY entries that no longer apply: ${stale.join(", ")}`);
  for (const [path, reason] of Object.entries(MANUAL_ONLY)) assert.ok(reason.length > 20, `${path} needs a real reason`);
});

test("the CI-executed groups include the ones this suite relies on, and test:unit finds script tests by discovery, not by a hand-kept list", () => {
  const { reached, texts } = reachableScriptText();
  for (const name of ["test:unit", "test:integration", "test:docs"]) assert.ok(reached.includes(name), `${name} is not reachable from a workflow`);
  assert.ok(texts.includes(`$(node ${DISCOVERY})`), "test:unit must run $(node scripts/lib/script-tests.mjs)");
  const listed = texts.split(/\s+/).filter(token => /^scripts\/[\w./-]+\.test\.mjs$/.test(token));
  assert.deepEqual(listed, [], `script tests listed one by one again (every new test would conflict on that line): ${listed.join(", ")}`);
});

/** A scratch copy of the repo's CI wiring (package.json + workflows) with only the script tests we put there. */
function scratch(files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cov-")));
  cpSync(join(realRoot, ".github"), join(root, ".github"), { recursive: true });
  cpSync(join(realRoot, "package.json"), join(root, "package.json"));
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
  return root;
}
const passing = name => `import test from "node:test"; test("${name}", () => {});\n`;

test("a script test file added without touching package.json is covered and actually runs, at any depth", () => {
  const root = scratch({ "scripts/zz-added.test.mjs": passing("added at the top"), "scripts/deep/er/zz-nested.test.mjs": passing("added deep") });
  const result = coverage(root);
  assert.deepEqual(result.unreached, []);
  assert.deepEqual(result.discovered.sort(), ["scripts/deep/er/zz-nested.test.mjs", "scripts/zz-added.test.mjs"]);
  // the exact mechanism CI uses: the discovery script's output handed to node --test
  const listed = spawnSync(process.execPath, [join(realRoot, DISCOVERY), "--root", root], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split("\n").filter(Boolean);
  assert.deepEqual(files, ["scripts/deep/er/zz-nested.test.mjs", "scripts/zz-added.test.mjs"]);
  // a node --test child inherits the parent runner's NODE_TEST_CONTEXT and would not print its own summary
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const ran = spawnSync(process.execPath, ["--test", ...files], { cwd: root, encoding: "utf8", env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /ℹ tests 2\b/);
  assert.match(ran.stdout, /ℹ pass 2\b/);
});

test("two branches that each add a script test do not touch the same line: package.json is identical before and after either addition", () => {
  const before = readFileSync(join(realRoot, "package.json"), "utf8");
  const a = scratch({ "scripts/branch-a.test.mjs": passing("a") }), b = scratch({ "scripts/branch-b.test.mjs": passing("b") });
  for (const root of [a, b]) assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
  assert.deepEqual(coverage(a).unreached.concat(coverage(b).unreached), []);
});

test("the check still fails for a test CI would not run: wiring that lists files by hand and misses one", () => {
  const root = scratch({ "scripts/listed.test.mjs": passing("listed"), "scripts/forgotten.test.mjs": passing("forgotten") });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.scripts["test:unit"] = "node --test scripts/listed.test.mjs";
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  assert.deepEqual(coverage(root).unreached, ["scripts/forgotten.test.mjs"]);
});

test("MANUAL_ONLY tests are never discovered but are accounted for; a docs-group .test.js is matched by test:docs", () => {
  const root = scratch({ "scripts/backup.test.mjs": passing("manual"), "scripts/docs/site2.test.js": "// matched by test:docs\n", "scripts/ok.test.mjs": passing("ok") });
  assert.deepEqual(listScriptTests(root), ["scripts/ok.test.mjs"]);
  assert.ok(allScriptTests(root).includes("scripts/backup.test.mjs"));
  assert.ok(allScriptTests(root).includes("scripts/docs/site2.test.js"));
  assert.deepEqual(coverage(root).unreached, []);
  assert.deepEqual(coverage(root).stale, []);
});

test("a stray .test.mjs in scripts/docs, scripts/research or scripts/architecture-map is reported, because test:unit skips those directories and no other group matches it", () => {
  for (const dir of ["docs", "research", "architecture-map"]) {
    const root = scratch({ [`scripts/${dir}/zz-stray.test.mjs`]: passing("stray"), "scripts/ok.test.mjs": passing("ok") });
    assert.deepEqual(listScriptTests(root), ["scripts/ok.test.mjs"], `${dir}: test:unit does not discover it`);
    assert.deepEqual(coverage(root).unreached, [`scripts/${dir}/zz-stray.test.mjs`], `${dir}: the coverage check must fail`);
  }
  // the same file registered with a reason is accounted for, and a docs-group .test.js that test:docs matches is fine
  const root = scratch({ "scripts/docs/zz-stray.test.mjs": passing("stray"), "scripts/docs/site2.test.js": "// matched by test:docs\n" });
  assert.deepEqual(coverage(root, { manualOnly: { "scripts/docs/zz-stray.test.mjs": "a documented reason that is long enough" } }).unreached, []);
  assert.deepEqual(coverage(root).unreached, ["scripts/docs/zz-stray.test.mjs"]);
});

test("the coverage universe does not share the discovery's skip list: a wrongly skipped directory is caught", () => {
  const root = scratch({ "scripts/lib/zz-lib.test.mjs": passing("lib"), "scripts/ok.test.mjs": passing("ok") });
  assert.deepEqual(coverage(root).unreached, []);
  const wrong = coverage(root, { discoverySkip: new Set([...OTHER_GROUPS, "lib"]) });
  assert.deepEqual(wrong.unreached, ["scripts/lib/zz-lib.test.mjs"]);
});

test("a failing, empty or garbled discovery stops test:unit instead of letting it run without the script tests", () => {
  // the discovery script itself: nothing to find, or a broken tree, is a non-zero exit with nothing printed
  const empty = scratch({});
  const none = spawnSync(process.execPath, [join(realRoot, DISCOVERY), "--root", empty], { encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.equal(none.stdout, "");
  assert.match(none.stderr, /found no tests/);
  assert.throws(() => assertValidList([]), /found no tests/);
  assert.throws(() => assertValidList(["scripts/a.test.mjs", "not a path\n; rm -rf"]), /unparsable/);
  assert.throws(() => assertValidList(["../outside.test.mjs"]), /unparsable/);
  assert.throws(() => assertValidList(["scripts/a.test.mjs", "scripts/a.test.mjs"]), /duplicate/);
  assert.deepEqual(assertValidList(["scripts/a.test.mjs"]), ["scripts/a.test.mjs"]);
  // the wiring in package.json: the discovery is captured first with `&&`, so a failure short-circuits the whole script
  const unit = JSON.parse(readFileSync(join(realRoot, "package.json"), "utf8")).scripts["test:unit"];
  assert.ok(unit.includes(`files=$(node ${DISCOVERY}) && node --import tsx --test`), "test:unit must capture the discovery with files=$(…) && before node --test");
  assert.ok(/\$files\b/.test(unit));
  // and that shape really stops: a failing discovery means the test command never runs (the same sh construct as test:unit)
  const shape = discovery => `files=$(${discovery}) && echo RAN $files`;
  const failed = spawnSync("sh", ["-c", shape("node -e 'process.exit(3)'")], { encoding: "utf8" });
  assert.notEqual(failed.status, 0);
  assert.ok(!failed.stdout.includes("RAN"));
  const crashed = spawnSync("sh", ["-c", shape(`node ${join(realRoot, DISCOVERY)} --root ${empty}`)], { encoding: "utf8" });
  assert.notEqual(crashed.status, 0);
  assert.ok(!crashed.stdout.includes("RAN"));
  // contrast: the bare `$(…)` form that was used before ran anyway with an empty list
  const bare = spawnSync("sh", ["-c", "echo RAN $(node -e 'process.exit(3)')"], { encoding: "utf8" });
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /RAN/);
  const ok = spawnSync("sh", ["-c", shape(`node ${join(realRoot, DISCOVERY)}`)], { encoding: "utf8", cwd: realRoot });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /RAN scripts\//);
});
