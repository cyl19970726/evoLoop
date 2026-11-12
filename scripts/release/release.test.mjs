import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { STEPS, checkDatabaseTarget, loadConfig, repoRoot, rollback, run, selectSteps } from "./release.mjs";
import { duplicateMigrationNumbers } from "./preflight.mjs";

const hooks = { "wait-idle": ["wait"], stop: ["stop"], start: ["start"], "post-check": ["check"] };
const base = (root, extraHooks = {}) => ({ releaseRoot: join(root, "rel"), currentLink: join(root, "current"), stateDir: join(root, "state"),
  backup: { out: join(root, "bk"), blobRoot: join(root, "blobs") }, database: { name: "evoloop_live_db" }, skipTests: true, hooks: { ...hooks, ...extraHooks } });
const ENV = { EVOLOOP_DATABASE_URL: "postgres://u:p@db.example:5432/evoloop_live_db" };
const SHA = "c".repeat(40);
const quiet = () => {};
const fresh = async (withPrevious = true, { relative: relativeLink = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "rel-"));
  await mkdir(join(root, "rel", "old"), { recursive: true });
  if (withPrevious) await symlink(relativeLink ? join("rel", "old") : join(root, "rel", "old"), join(root, "current"));
  return root;
};
const stateOf = async (root, id) => JSON.parse(await readFile(join(root, "state", `release-${id}.json`), "utf8"));

/**
 * A fake machine. `fail` maps a command name to how many times it fails (default once); `log` records every command
 * in order, so the tests can say what ran before what. Git, the migration status and the counts hook answer like the real ones.
 */
const sim = ({ fail = {}, counts = ["10", "10"], originHead = SHA, onMain = true, migrations = [["a", "b"], ["a", "b", "c"]], countsFail = 0 } = {}) => {
  const log = [], failures = { ...fail }, pending = [...counts], statuses = migrations.map(list => [...list]);
  let countsRuns = 0;
  const runner = async (argv, options) => {
    const name = argv[0] === "node" ? argv[1] : argv[0];
    log.push(name === "git" ? `git ${argv.slice(argv.indexOf("-C") + 2, argv.indexOf("-C") + 3)}`.trim() : name);
    if (failures[name] > 0) { failures[name] -= 1; throw new Error(`${name} failed`); }
    if (name === "git") {
      const rest = argv.slice(argv.indexOf("-C") + 2);
      if (rest[0] === "worktree") { await mkdir(rest.at(-2), { recursive: true }); return ""; }
      if (rest[0] === "rev-parse") return rest[1].startsWith("origin/") ? originHead : SHA;
      if (rest[0] === "merge-base" && !onMain) throw new Error("not an ancestor");
      return "";
    }
    if (name === "scripts/release/migration-status.mjs") return (statuses.shift() ?? []).join("\n");
    if (name === "counts") { countsRuns += 1; if (countsRuns <= countsFail) throw new Error("counts failed"); return pending.shift() ?? ""; }
    return "";
  };
  return { log, runner };
};
const go = (root, extra = {}) => run({ config: base(root, extra.hooks), id: "r1", execute: true, env: ENV, log: quiet, ...extra, config: base(root, extra.hooks) });
const order = (log, a, b) => assert.ok(log.indexOf(a) >= 0 && log.indexOf(b) >= 0 && log.indexOf(a) < log.indexOf(b), `${a} should run before ${b}: ${log.join(",")}`);

test("config must live and point outside the repository, name every host hook and the expected database", () => {
  const ok = JSON.stringify(base("/srv/x"));
  assert.ok(loadConfig(ok, "/etc/evo/release.json"));
  assert.ok(loadConfig(JSON.stringify(base("/srv/x", { "post-migrate": ["pm"], "data-counts": ["counts"] })), "/etc/evo/release.json"));
  assert.throws(() => loadConfig(ok, join(repoRoot, "release.json")), /outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base("/srv/x"), releaseRoot: join(repoRoot, "r") }), "/etc/r.json"), /outside/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base("/srv/x"), hooks: { stop: ["stop"] } }), "/etc/r.json"), /hooks.wait-idle is required/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base("/srv/x"), hooks: { ...hooks, drain: ["x"] } }), "/etc/r.json"), /Unknown hook/);
  assert.throws(() => loadConfig(JSON.stringify({ ...base("/srv/x"), database: {} }), "/etc/r.json"), /database.name is required/);
});

test("a database that differs from the configured one is refused before any step runs", async () => {
  const root = await fresh();
  const config = base(root);
  assert.doesNotThrow(() => checkDatabaseTarget(config, ENV));
  assert.throws(() => checkDatabaseTarget(config, { EVOLOOP_DATABASE_URL: "postgres://u:p@h/evoloop_other" }), /does not match the expected "evoloop_live_db"/);
  assert.throws(() => checkDatabaseTarget({ ...config, database: { name: "evoloop_live_db", host: "db.example", port: 5433 } }, ENV), /port/);
  assert.throws(() => checkDatabaseTarget(config, {}), /not set/);
  const { log, runner } = sim();
  await assert.rejects(run({ config, id: "x", execute: true, env: { EVOLOOP_DATABASE_URL: "postgres://u:p@h/evoloop_other" }, log: quiet, runner }), /Refusing to release/);
  assert.equal(log.length, 0);
});

test("dry run executes nothing and lists every step in order", async () => {
  const root = await fresh();
  const lines = [];
  await run({ config: base(root), id: "r1", log: line => lines.push(line), runner: () => assert.fail("must not execute") });
  assert.deepEqual(lines.map(line => line.split(":")[0].replace("PLAN ", "")), STEPS);
});

test("a full release runs in order and records the release facts the acceptance needs", async () => {
  const root = await fresh();
  const { log, runner } = sim();
  const manifest = JSON.stringify({ files: [{ path: "db.dump" }, { path: "blobs/x" }] });
  const result = await go(root, { runner, hooks: { "data-counts": ["counts"], "post-migrate": ["pm"] }, readManifest: async () => manifest });
  assert.equal(await readlink(join(root, "current")), join(root, "rel", "r1"));
  order(log, "stop", "counts"); // counts are taken while the service is stopped
  order(log, "counts", "scripts/backup.mjs");
  order(log, "npm", "pm");
  assert.equal(log.lastIndexOf("counts") > log.indexOf("npm"), true); // the after-count is also taken after the migration, before the switch
  assert.ok(log.lastIndexOf("counts") < log.indexOf("start"));
  const saved = await stateOf(root, "r1");
  assert.equal(saved.previous, join(root, "rel", "old"));
  assert.equal(saved.releaseDir, join(root, "rel", "r1"));
  assert.equal(saved.acceptance.postCheck, "passed");
  assert.equal(saved.acceptance.countsEqual, true);
  assert.equal(saved.acceptance.postMigrateCheck, "passed");
  assert.deepEqual(saved.acceptance.migrationsApplied, ["c"]);
  assert.ok(typeof saved.acceptance.downtimeSeconds === "number" && saved.acceptance.stopCompletedAt);
  assert.deepEqual(saved.commit && { sha: saved.commit.sha, onRemote: saved.commit.onRemote, equalsRemoteHead: saved.commit.equalsRemoteHead }, { sha: SHA, onRemote: true, equalsRemoteHead: true });
  assert.equal(saved.backup.dir, join(root, "bk", "r1-1"));
  assert.equal(saved.backup.files, 2);
  assert.match(saved.backup.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.steps.at(-1).step, "post-check");
});

test("the release commit is checked against the remote main: unmerged is refused unless allowed, and the facts are recorded", async () => {
  const root = await fresh();
  const refused = sim({ onMain: false, originHead: "d".repeat(40) });
  await assert.rejects(go(root, { runner: refused.runner }), /not on origin\/main/);
  assert.ok(!refused.log.includes("stop"));
  assert.equal((await stateOf(root, "r1")).failedAt, "preflight");
  const rehearsal = sim({ onMain: false, originHead: "d".repeat(40) });
  await go(root, { runner: rehearsal.runner, allowOffMain: true, from: "preflight" });
  const saved = await stateOf(root, "r1");
  assert.deepEqual([saved.commit.onRemote, saved.commit.equalsRemoteHead], [false, false]);
});

test("a failure before the stop changes nothing and does not touch the running service", async () => {
  const root = await fresh();
  const { log, runner } = sim({ fail: { sh: 1 } });
  await assert.rejects(go(root, { runner }), /sh failed/);
  assert.ok(!log.includes("start") && !log.includes("stop"));
  assert.equal(await readlink(join(root, "current")), join(root, "rel", "old"));
  const saved = await stateOf(root, "r1");
  assert.equal(saved.failedAt, "build");
  assert.equal(saved.recovery, undefined);
});

test("F1: after a failure past the stop and a successful restore, the stop-and-after steps are undone and a resume must restart at wait-idle", async () => {
  for (const [failing, migrated] of [["scripts/backup.mjs", false], ["npm", true]]) {
    const root = await fresh();
    const first = sim({ fail: { [failing]: 1 } });
    await assert.rejects(go(root, { runner: first.runner }));
    const failed = await stateOf(root, "r1");
    assert.equal(failed.recovery.result, "restored");
    assert.equal(failed.acceptance.dataMayBeChanged, migrated);
    const resultOf = step => failed.steps.find(entry => entry.step === step)?.result;
    assert.equal(resultOf("wait-idle"), "undone");
    assert.equal(resultOf("stop"), "undone");
    if (migrated) assert.equal(resultOf("backup"), "undone");
    assert.equal(resultOf("preflight"), "ok");
    // Resuming at migrate (the dangerous shortcut) is refused and the message says where to resume.
    const shortcut = sim();
    await assert.rejects(go(root, { runner: shortcut.runner, from: "migrate" }), /earlier steps not completed.*wait-idle.*resume with --from wait-idle/s);
    assert.equal(shortcut.log.length, 0);
    // Resuming at wait-idle works, takes a NEW backup target, and clears the failure.
    const second = sim();
    await go(root, { runner: second.runner, from: "wait-idle" });
    const finished = await stateOf(root, "r1");
    assert.equal(finished.failedAt, undefined);
    assert.equal(finished.recovery, undefined);
    assert.equal(finished.acceptance.dataMayBeChanged, undefined);
    assert.equal(finished.failures.length, 1);
    assert.equal(finished.backup.dir, join(root, "bk", migrated ? "r1-2" : "r1-2"));
    order(second.log, "wait", "stop");
    assert.equal(await readlink(join(root, "current")), join(root, "rel", "r1"));
  }
});

test("F1: the backup target of a retry is a different directory, so an existing earlier one cannot make it fail", async () => {
  const root = await fresh();
  const targets = [];
  const runner = (inner => async (argv, options) => { if (argv[1] === "scripts/backup.mjs") targets.push(argv[argv.indexOf("--out") + 1]); return inner(argv, options); })(sim({ fail: { npm: 1 } }).runner);
  await assert.rejects(go(root, { runner }));
  await go(root, { runner: (inner => async (argv, options) => { if (argv[1] === "scripts/backup.mjs") targets.push(argv[argv.indexOf("--out") + 1]); return inner(argv, options); })(sim().runner), from: "wait-idle" });
  assert.deepEqual(targets.map(target => relative(root, target)), [join("bk", "r1-1"), join("bk", "r1-2")]);
});

test("F2: the automatic restore stops whatever is running first, then starts the old version", async () => {
  for (const failing of ["check", "start"]) {
    const root = await fresh();
    const { log, runner } = sim({ fail: { [failing]: 1 } });
    await assert.rejects(go(root, { runner }));
    const after = log.slice(log.indexOf(failing) + 1);
    assert.deepEqual(after.filter(name => ["stop", "start", "check"].includes(name)), ["stop", "start", "check"], `failing ${failing}`);
    assert.equal((await stateOf(root, "r1")).recovery.result, "restored");
    assert.equal(await readlink(join(root, "current")), join(root, "rel", "old"));
  }
});

test("F2: if the new version cannot be stopped, the old one is not started on top of it and the restore is recorded as failed", async () => {
  const root = await fresh();
  const { log, runner } = sim({ fail: { check: 1 } });
  const stops = { n: 0 };
  const wrapped = async (argv, options) => { if (argv[0] === "stop") { stops.n += 1; if (stops.n === 2) throw new Error("stop hung"); } return runner(argv, options); };
  await assert.rejects(go(root, { runner: wrapped }));
  const saved = await stateOf(root, "r1");
  assert.equal(saved.recovery.result, "failed");
  assert.match(saved.recovery.error, /stop hung/);
  assert.equal(log.filter(name => name === "start").length, 1); // only the failed new start, never the old one
  // The next run refuses until a human says the service was restored by hand.
  await assert.rejects(go(root, { runner: sim().runner, from: "wait-idle" }), /Restore it by hand.*--acknowledge-manual-recovery/s);
  await go(root, { runner: sim().runner, from: "wait-idle", acknowledgeManualRecovery: true });
  assert.equal((await stateOf(root, "r1")).recovery, undefined);
});

test("a start failure after the switch points the link back and starts the old version", async () => {
  const root = await fresh();
  const { log, runner } = sim({ fail: { start: 1 } });
  await assert.rejects(go(root, { runner }), /start failed/);
  assert.equal(await readlink(join(root, "current")), join(root, "rel", "old"));
  assert.equal(log.filter(name => name === "start").length, 2);
  assert.equal((await stateOf(root, "r1")).recovery.result, "restored");
});

test("F3: a counts hook that fails is recorded and never triggers a restore or a rollback", async () => {
  // fails before the stop phase is over (the first call), after the migration (the second), or both
  for (const countsFail of [1, 2]) {
    const root = await fresh();
    const { log, runner } = sim({ countsFail });
    await go(root, { runner, hooks: { "data-counts": ["counts"] } });
    const saved = await stateOf(root, "r1");
    assert.equal(saved.recovery, undefined);
    assert.equal(saved.failedAt, undefined);
    assert.equal(await readlink(join(root, "current")), join(root, "rel", "r1")); // the healthy new version stays
    assert.equal(log.filter(name => name === "start").length, 1);
    assert.match(saved.acceptance.countsBeforeError ?? saved.acceptance.countsAfterError, /counts failed/);
    assert.notEqual(saved.acceptance.countsEqual, true);
  }
});

test("F3: counts unequal while stopped is reported as such, and a migration-status failure is only recorded", async () => {
  const root = await fresh();
  const { runner } = sim({ counts: ["10", "11"], fail: { "scripts/release/migration-status.mjs": 2 } });
  await go(root, { runner, hooks: { "data-counts": ["counts"] } });
  const saved = await stateOf(root, "r1");
  assert.equal(saved.acceptance.countsEqual, false);
  assert.match(saved.acceptance.migrationsBeforeError, /failed/);
  assert.equal(saved.recovery, undefined);
});

test("the backup manifest that cannot be read is recorded, not fatal", async () => {
  const root = await fresh();
  await go(root, { runner: sim().runner, readManifest: async () => { throw new Error("no manifest"); } });
  assert.match((await stateOf(root, "r1")).backup.manifestError, /no manifest/);
});

test("a rerun without --from reuses the working tree of the same commit and refuses one at another commit", async () => {
  const root = await fresh();
  const first = sim({ fail: { sh: 1 } });
  await assert.rejects(go(root, { runner: first.runner }));
  const second = sim();
  await go(root, { runner: second.runner }); // no --from: prepare meets the existing directory
  assert.ok(!second.log.includes("git worktree"), second.log.join(","));
  const root2 = await fresh();
  const failing = sim({ fail: { sh: 1 } });
  await assert.rejects(go(root2, { runner: failing.runner }));
  const other = sim();
  const wrong = async (argv, options) => (argv[0] === "git" && argv.includes("rev-parse") && argv.includes("HEAD") && argv.includes(join(root2, "rel", "r1")) ? "e".repeat(40) : other.runner(argv, options));
  await assert.rejects(go(root2, { runner: wrong }), /already exists at eeeeeeee, not cccccccc/);
});

test("the previous release is stored as an absolute path even when the link is relative", async () => {
  const root = await fresh(true, { relative: true });
  await go(root, { runner: sim().runner });
  const saved = await stateOf(root, "r1");
  assert.ok(isAbsolute(saved.previous));
  assert.equal(saved.previous, join(root, "rel", "old"));
});

test("resuming keeps the original previous release, so rollback still works", async () => {
  const root = await fresh();
  const config = base(root);
  const old = join(root, "rel", "old"), next = join(root, "rel", "r6");
  await mkdir(next, { recursive: true });
  await mkdir(config.stateDir, { recursive: true });
  const ok = step => ({ step, result: "ok" });
  await writeFile(join(config.stateDir, "release-r6.json"), JSON.stringify({ id: "r6", previous: old, releaseDir: next, steps: STEPS.slice(0, STEPS.indexOf("repoint-cli")).map(ok), failedAt: "start" }));
  await rm(join(root, "current"));
  await symlink(next, join(root, "current")); // the link already points at the new release
  await run({ config, id: "r6", execute: true, from: "repoint-cli", env: ENV, log: quiet, runner: sim().runner });
  assert.equal((await stateOf(root, "r6")).previous, old);
  await rollback({ config, id: "r6", execute: true, log: quiet, runner: sim().runner });
  assert.equal(await readlink(join(root, "current")), old);
  assert.equal((await stateOf(root, "r6")).rollbacks.length, 1);
});

test("rollback checks before stopping anything: the link must be this release and the previous directory must exist", async () => {
  const root = await fresh();
  await go(root, { runner: sim().runner });
  const config = base(root);
  // the previous release directory was removed: nothing would be left to start
  await rm(join(root, "rel", "old"), { recursive: true });
  const missing = sim();
  await assert.rejects(rollback({ config, id: "r1", execute: true, log: quiet, runner: missing.runner }), /previous release directory .* no longer exists/);
  assert.equal(missing.log.length, 0);
  await mkdir(join(root, "rel", "old"), { recursive: true });
  // a good rollback, then a second one finds the link no longer pointing at this release
  await rollback({ config, id: "r1", execute: true, log: quiet, runner: sim().runner });
  assert.equal(await readlink(join(root, "current")), join(root, "rel", "old"));
  const again = sim();
  await assert.rejects(rollback({ config, id: "r1", execute: true, log: quiet, runner: again.runner }), /current link points at .*rel\/old, not at this release/);
  assert.equal(again.log.length, 0);
  // and a link that was replaced by another release
  await symlink(join(root, "rel", "r9"), join(root, "current.tmp"));
  await rm(join(root, "current")); await symlink(join(root, "rel", "r9"), join(root, "current"));
  await assert.rejects(rollback({ config, id: "r1", execute: true, log: quiet, runner: sim().runner }), /not at this release/);
});

test("rollback of a first release (no previous) is refused with a clear reason", async () => {
  const root = await fresh(false);
  const config = base(root);
  await run({ config, id: "r8", execute: true, allowNoPrevious: true, env: ENV, log: quiet, runner: sim().runner });
  await assert.rejects(rollback({ config, id: "r8", execute: true, log: quiet, runner: sim().runner }), /first release/);
});

test("--from needs every earlier step done for that release; unknown step names are rejected", async () => {
  const root = await fresh();
  await assert.rejects(go(root, { runner: sim().runner, from: "migrate" }), /earlier steps not completed/);
  assert.throws(() => selectSteps({ only: ["stpo"] }), /Unknown step: stpo/);
  assert.throws(() => selectSteps({ from: "nope" }), /Unknown step/);
  assert.deepEqual(selectSteps({ only: ["stop", "start"] }), ["stop", "start"]);
});

test("without a current link a release is refused unless it is explicitly the first one", async () => {
  const root = await fresh(false);
  await assert.rejects(go(root, { runner: sim().runner }), /--allow-no-previous/);
  await go(root, { runner: sim().runner, allowNoPrevious: true });
});

test("a previous release directory that is gone refuses the release before anything is stopped", async () => {
  const root = await fresh();
  await rm(join(root, "rel", "old"), { recursive: true });
  const { log, runner } = sim();
  await assert.rejects(go(root, { runner }), /previous release directory .* no longer exists/);
  assert.equal(log.length, 0);
});

test("the test step needs a dedicated test database that is not the live one", async () => {
  const root = await fresh();
  const config = { ...base(root), skipTests: false };
  const runner = sim().runner;
  await assert.rejects(run({ config, id: "r9", execute: true, env: ENV, log: quiet, runner }), /EVOLOOP_RELEASE_TEST_DATABASE_URL/);
  await assert.rejects(run({ config, id: "r9", execute: true, env: { ...ENV, EVOLOOP_RELEASE_TEST_DATABASE_URL: ENV.EVOLOOP_DATABASE_URL }, log: quiet, runner }), /must not be the live database/);
  let seen;
  await run({ config, id: "r9", execute: true, only: ["test"], env: { ...ENV, EVOLOOP_RELEASE_TEST_DATABASE_URL: "postgres://t@h/evoloop_x_test" }, log: quiet, runner: async (argv, { env }) => { if (argv[0] === "npm") seen = env.TEST_DATABASE_URL; return ""; } });
  assert.equal(seen, "postgres://t@h/evoloop_x_test");
});

test("duplicate migration numbers are reported with their files", () => {
  assert.deepEqual(duplicateMigrationNumbers(["078_a.mjs", "078_b.mjs", "079_c.mjs"]), [{ number: "078", files: ["078_a.mjs", "078_b.mjs"] }]);
});

test("sourceSubdir puts the checkout in <release>/source: every build step runs there, hooks still see the release directory and the source path", async () => {
  const root = await fresh();
  await mkdir(join(root, "rel", "old", "source"), { recursive: true });
  const seen = [];
  const inner = sim().runner;
  const runner = async (argv, options) => { seen.push({ name: argv[0] === "node" ? argv[1] : argv[0], cwd: options.cwd, source: options.env?.EVOLOOP_RELEASE_SOURCE, dir: options.env?.EVOLOOP_RELEASE_DIR, argv }); return inner(argv, options); };
  const config = { ...base(root), sourceSubdir: "source" };
  await run({ config, id: "r1", execute: true, env: ENV, log: quiet, runner });
  const release = join(root, "rel", "r1");
  const at = name => seen.find(item => item.name === name);
  assert.ok(at("git").argv.includes(join(release, "source")), "the working tree is created at <release>/source");
  assert.ok(!at("git").argv.includes(release), "not at the release directory itself");
  for (const name of ["sh", "scripts/release/preflight.mjs", "scripts/backup.mjs", "npm"]) assert.equal(at(name).cwd, join(release, "source"), name);
  for (const name of ["wait", "stop", "start", "check"]) { assert.equal(at(name).dir, release, name); assert.equal(at(name).source, join(release, "source"), name); }
  assert.equal(await readlink(join(root, "current")), release); // the link still points at the release directory, not at source
  assert.equal((await stateOf(root, "r1")).releaseDir, release);
});

test("sourceSubdir is a relative path without ..; the default keeps the release directory as the checkout", () => {
  for (const bad of ["/abs", "../up", "a/../b"]) assert.throws(() => loadConfig(JSON.stringify({ ...base("/srv/x"), sourceSubdir: bad }), "/etc/r.json"), /sourceSubdir/);
  assert.ok(loadConfig(JSON.stringify({ ...base("/srv/x"), sourceSubdir: "source" }), "/etc/r.json"));
  assert.ok(loadConfig(JSON.stringify(base("/srv/x")), "/etc/r.json"));
});

test("with sourceSubdir the restore after a failure hands the previous release's own source path to the hooks", async () => {
  const root = await fresh();
  const seen = [];
  const inner = sim({ fail: { check: 1 } }).runner;
  const runner = async (argv, options) => { seen.push({ name: argv[0], source: options.env?.EVOLOOP_RELEASE_SOURCE, dir: options.env?.EVOLOOP_RELEASE_DIR }); return inner(argv, options); };
  await assert.rejects(run({ config: { ...base(root), sourceSubdir: "source" }, id: "r1", execute: true, env: ENV, log: quiet, runner }));
  const restoreStart = seen.filter(item => item.name === "start").at(-1);
  assert.equal(restoreStart.dir, join(root, "rel", "old"));
  assert.equal(restoreStart.source, join(root, "rel", "old", "source"));
});
