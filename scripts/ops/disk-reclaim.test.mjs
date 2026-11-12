import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { countClientBackends, formatReport, instanceDir, instanceSkipReasons, loadConfig, makeAdapters, reclaim, repoRoot, worktreeSkipReasons } from "./disk-reclaim.mjs";
import { MARKER } from "./test-pg.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const GB = 1024 ** 3;

/** A real origin + main clone + workspace root in a temp directory; worktrees are real git worktrees. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "disk-")));
  const origin = join(root, "origin.git"), ws = join(root, "ws"), main = join(ws, "main");
  mkdirSync(ws);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, main], { stdio: "ignore" });
  git(main, "checkout", "-q", "-b", "main");
  writeFileSync(join(main, "a.txt"), "a\n"); git(main, "add", "-A"); git(main, "commit", "-qm", "init"); git(main, "push", "-q", "origin", "main");
  const config = { repos: [main], workspaceRoots: [ws], protectedPaths: [join(ws, "prod-db"), join(ws, "releases")], testPgRoots: [join(root, "pg")], legacyPgNames: [/^(idle|busy|unknown|young|port-protected|racy|legacy-ok)$/], protectedPorts: [55432], minFreeGB: 20, pgMinAgeMinutes: 30, pgIdleMinutes: 120, baseBranch: "main", remote: "origin", repo: null };
  mkdirSync(join(root, "pg"));
  /** A worktree for `branch`, with one commit pushed; `merged` merges it into main like a merged PR would. */
  const worktree = (name, { merged = true, push = true } = {}) => {
    const path = join(ws, name);
    git(main, "worktree", "add", "-q", "-b", name, path, "origin/main");
    writeFileSync(join(path, `${name}.txt`), `${name}\n`); git(path, "add", "-A"); git(path, "commit", "-qm", name);
    if (push) git(path, "push", "-q", "origin", name);
    if (merged) { git(main, "merge", "-q", "--no-ff", "-m", `merge ${name}`, name); git(main, "push", "-q", "origin", "main"); }
    return path;
  };
  return { root, ws, main, config, worktree, git };
}

const prs = map => branch => map[branch] ?? null;
const base = (w, over = {}) => ({ ...makeAdapters(w.config), prFor: prs({}), cwds: () => [], pgProcesses: () => [], pgLastWriteMs: () => 0, freeBytes: () => 100 * GB, ...over });
const run = (w, over = {}, options = {}) => reclaim({ adapter: base(w, over), config: w.config, ...options });
const merged = number => ({ number, state: "MERGED", open: null });
const reasonsFor = (report, path) => report.skipped.find(item => item.path === path)?.reasons.join(" | ") ?? "";

test("a merged, clean, pushed, unused worktree is reclaimed; branch and commits stay", async () => {
  const w = world();
  const path = w.worktree("feat-a");
  const sha = w.git(path, "rev-parse", "HEAD").trim();
  const dry = await run(w, { prFor: prs({ "feat-a": merged(10) }) });
  assert.deepEqual(dry.reclaimed.map(item => [item.path, item.dryRun]), [[path, true]]);
  assert.ok(existsSync(path), "a dry run deletes nothing");
  const done = await run(w, { prFor: prs({ "feat-a": merged(10) }) }, { execute: true });
  assert.deepEqual(done.reclaimed.map(item => item.path), [path]);
  assert.ok(!existsSync(path));
  assert.match(w.git(w.main, "branch", "--list", "feat-a"), /feat-a/);
  assert.equal(w.git(w.main, "cat-file", "-t", sha).trim(), "commit");
  assert.ok(!w.git(w.main, "worktree", "list").includes("feat-a"));
});

test("uncommitted work blocks reclaim: modified, staged and untracked files all count", async () => {
  const w = world();
  const modified = w.worktree("mod"), untracked = w.worktree("untr"), staged = w.worktree("stg");
  writeFileSync(join(modified, "a.txt"), "changed\n");
  writeFileSync(join(untracked, "new-file.txt"), "x\n");
  writeFileSync(join(staged, "s.txt"), "x\n"); w.git(staged, "add", "s.txt");
  const report = await run(w, { prFor: prs({ mod: merged(1), untr: merged(2), stg: merged(3) }) }, { execute: true });
  assert.deepEqual(report.reclaimed, []);
  for (const path of [modified, untracked, staged]) { assert.match(reasonsFor(report, path), /有未提交内容/); assert.ok(existsSync(path)); }
});

test("PR state decides: open, closed-unmerged, none, unknown, and a merged PR with a newer open one are all skipped", async () => {
  const w = world();
  const names = ["opened", "closed", "nopr", "unknown", "reopened"].map(name => [name, w.worktree(name)]);
  const report = await run(w, { prFor: branch => { if (branch === "unknown") throw new Error("gh down"); return { opened: { number: 5, state: "OPEN", open: 5 }, closed: { number: 6, state: "CLOSED", open: null }, nopr: null, reopened: { number: 8, state: "MERGED", open: 9 } }[branch]; } }, { execute: true });
  assert.deepEqual(report.reclaimed, []);
  const by = Object.fromEntries(names);
  assert.match(reasonsFor(report, by.opened), /PR #5 还开着/);
  assert.match(reasonsFor(report, by.closed), /PR #6 已关闭但没有合并/);
  assert.match(reasonsFor(report, by.nopr), /没有对应的 PR/);
  assert.match(reasonsFor(report, by.unknown), /无法查询/);
  assert.match(reasonsFor(report, by.reopened), /PR #9 还开着/);
});

test("commits that are neither in the remote main nor in the PR head are unpushed work", async () => {
  const w = world();
  const path = w.worktree("late");
  writeFileSync(join(path, "after-merge.txt"), "x\n"); w.git(path, "add", "-A"); w.git(path, "commit", "-qm", "after the merge, never pushed");
  const report = await run(w, { prFor: prs({ late: merged(4) }) }, { execute: true });
  assert.match(reasonsFor(report, path), /尚未进入远端主分支或 PR 头的提交/);
  assert.ok(existsSync(path));
  const unpushedMerged = world();
  const own = unpushedMerged.worktree("own", { merged: false, push: false }); // never pushed nor merged, PR claims merged
  const r2 = await run(unpushedMerged, { prFor: prs({ own: merged(5) }) }, { execute: true });
  assert.match(reasonsFor(r2, own), /尚未进入远端/);
});

test("a process whose working directory is in (or under) the worktree blocks it; unknown process data blocks everything", async () => {
  const w = world();
  const busy = w.worktree("busy"), idle = w.worktree("idle");
  mkdirSync(join(busy, "sub"));
  const cwds = () => [{ pid: 42, command: "claude", cwd: join(busy, "sub") }, { pid: 43, command: "zsh", cwd: w.root }];
  const report = await run(w, { prFor: prs({ busy: merged(1), idle: merged(2) }), cwds }, { execute: true });
  assert.deepEqual(report.reclaimed.map(item => item.path), [idle]);
  assert.match(reasonsFor(report, busy), /有进程以它为工作目录\(claude\[42\]\)/);
  const blind = world(); const p = blind.worktree("blind");
  const r2 = await run(blind, { prFor: prs({ blind: merged(1) }), cwds: () => { throw new Error("no lsof"); } }, { execute: true });
  assert.deepEqual(r2.reclaimed, []);
  assert.match(reasonsFor(r2, p), /无法检查有没有进程/);
  assert.match(formatReport(r2), /无法列出进程工作目录/);
});

test("never touched: the main worktree, a detached HEAD, a locked worktree, protected paths, paths outside the workspace", async () => {
  const w = world();
  const detached = w.worktree("det"); w.git(detached, "checkout", "-q", "--detach");
  const locked = w.worktree("lck"); w.git(w.main, "worktree", "lock", locked);
  const protectedDir = join(w.ws, "releases"); mkdirSync(protectedDir);
  const guarded = join(protectedDir, "guarded"); w.git(w.main, "worktree", "add", "-q", "-b", "guarded", guarded, "origin/main");
  const outside = join(w.root, "elsewhere"); w.git(w.main, "worktree", "add", "-q", "-b", "outside", outside, "origin/main");
  const report = await run(w, { prFor: () => merged(1) }, { execute: true });
  assert.deepEqual(report.reclaimed, []);
  assert.match(reasonsFor(report, w.main), /主工作树/);
  assert.match(reasonsFor(report, detached), /游离/);
  assert.match(reasonsFor(report, locked), /锁定/);
  assert.match(reasonsFor(report, guarded), /受保护/);
  assert.match(reasonsFor(report, outside), /不在配置的工作区根目录内/);
  for (const path of [w.main, detached, locked, guarded, outside]) assert.ok(existsSync(path));
});

test("--branch limits a run to one worktree (the post-merge trigger)", async () => {
  const w = world();
  const one = w.worktree("one"), two = w.worktree("two");
  const report = await run(w, { prFor: () => merged(1) }, { execute: true, onlyBranch: "one" });
  assert.deepEqual(report.reclaimed.map(item => item.path), [one]);
  assert.ok(existsSync(two));
});

const pgFixture = (w, name, { marker = null, withData = true } = {}) => {
  const dir = join(w.root, "pg", name); mkdirSync(join(dir, "data"), { recursive: true });
  if (marker) writeFileSync(join(dir, MARKER), JSON.stringify(marker));
  return { dir, dataDir: join(dir, "data") };
};
const procFor = (instance, port) => ({ pid: 900 + port, binary: "/pg/bin/postgres", dataDir: instance.dataDir, port });
const pgAdapter = (w, { connections = 0, ageMinutes = 120, stopped = [] } = {}) => ({
  pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: Date.now() - ageMinutes * 60_000 }),
  pgConnections: typeof connections === "function" ? connections : () => connections,
  stopPg: ({ dataDir }) => { stopped.push(dataDir); }, removeDir: dir => { stopped.push(`rm ${dir}`); },
});

test("a test instance nobody is connected to is stopped and removed; connections, unknown state and a recent start block it", async () => {
  const w = world();
  const idle = pgFixture(w, "idle"), busy = pgFixture(w, "busy"), unknown = pgFixture(w, "unknown"), young = pgFixture(w, "young");
  const stopped = [];
  const conns = ({ port }) => ({ 1: 0, 2: 3, 3: null, 4: 0 })[port];
  const procs = [procFor(idle, 1), procFor(busy, 2), procFor(unknown, 3), procFor(young, 4)];
  const adapter = { pgProcesses: () => procs, pgInfo: dataDir => ({ port: procs.find(p => p.dataDir === dataDir).port, socketDir: "/tmp", startedAt: Date.now() - (dataDir === young.dataDir ? 5 : 600) * 60_000 }), pgConnections: conns, stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: dir => stopped.push(`rm ${dir}`) };
  const report = await run(w, adapter, { execute: true });
  assert.deepEqual(stopped, [idle.dataDir, `rm ${idle.dir}`]);
  assert.match(reasonsFor(report, busy.dataDir), /有 3 个客户端连接/);
  assert.match(reasonsFor(report, unknown.dataDir), /无法确认有没有客户端连接/);
  assert.match(reasonsFor(report, young.dataDir), /刚启动 5 分钟/);
});

test("production and release instances, and instances outside the test roots, are never stopped even with zero connections", async () => {
  const w = world();
  const prod = join(w.ws, "prod-db", "postgres", "data"); mkdirSync(prod, { recursive: true });
  const byPort = pgFixture(w, "port-protected"), foreign = join(w.root, "somebody-elses-pg"); mkdirSync(foreign);
  const stopped = [];
  const procs = [{ pid: 1, binary: "/pg/bin/postgres", dataDir: prod, port: 55500 }, procFor(byPort, 55432), { pid: 3, binary: "/pg/bin/postgres", dataDir: foreign, port: 55600 }];
  const adapter = { pgProcesses: () => procs, pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => 0, stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: dir => stopped.push(dir) };
  const report = await run(w, adapter, { execute: true });
  assert.deepEqual(stopped, []);
  assert.deepEqual(report.skipped.filter(item => item.kind === "instance").map(item => item.reasons[0].slice(0, 6)), ["受保护的正式", "受保护的正式", "不在配置的测"]);
});

test("an instance with an owner marker goes only with its worktree: kept while the worktree is live, removed when it is gone or reclaimed in the same run", async () => {
  const w = world();
  const live = w.worktree("live-wt", { merged: false });
  const gone = join(w.ws, "gone-wt");
  const doomed = w.worktree("doomed-wt");
  const inst = {
    live: pgFixture(w, "live", { marker: { name: "live", worktree: live } }),
    gone: pgFixture(w, "gone", { marker: { name: "gone", worktree: gone } }),
    doomed: pgFixture(w, "doomed", { marker: { name: "doomed", worktree: doomed } }),
  };
  const stopped = [];
  const procs = Object.values(inst).map((item, index) => procFor(item, index + 1));
  const adapter = { prFor: prs({ "live-wt": { number: 1, state: "OPEN", open: 1 }, "doomed-wt": merged(2) }), pgProcesses: () => procs, pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => 0, stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: () => {} };
  const dry = await run(w, adapter);
  assert.deepEqual(dry.reclaimed.filter(item => item.kind === "instance").map(item => item.path).sort(), [inst.doomed.dir, inst.gone.dir].sort());
  const report = await run(w, adapter, { execute: true });
  assert.deepEqual(stopped.sort(), [inst.doomed.dataDir, inst.gone.dataDir].sort());
  assert.match(reasonsFor(report, inst.live.dataDir), /所属工作树 .* 仍在使用/);
  assert.ok(!existsSync(doomed));
});

test("a client that connects between the survey and the stop saves the instance", async () => {
  const w = world();
  const inst = pgFixture(w, "racy"); const stopped = [];
  let calls = 0;
  const adapter = { pgProcesses: () => [procFor(inst, 1)], pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => (++calls === 1 ? 0 : 2), stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: () => stopped.push("rm") };
  const report = await run(w, adapter, { execute: true });
  assert.deepEqual(stopped, []);
  assert.match(reasonsFor(report, inst.dataDir), /停止前复查时有 2 个客户端连接/);
});

test("a postgres under a test root that has no marker and no matching name is somebody else's and is never touched", async () => {
  const w = world();
  const foreign = pgFixture(w, "commerce-lab"), mine = pgFixture(w, "legacy-ok"), stopped = [];
  const procs = [procFor(foreign, 1), procFor(mine, 2)];
  const adapter = { pgProcesses: () => procs, pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => 0, stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: () => {} };
  const report = await run(w, adapter, { execute: true });
  assert.deepEqual(stopped, [mine.dataDir]);
  assert.match(reasonsFor(report, foreign.dataDir), /没有归属标记,目录名也不匹配 legacyPgNames/);
  const none = world(); const only = pgFixture(none, "legacy-ok"); none.config.legacyPgNames = [];
  const r2 = await run(none, { pgProcesses: () => [procFor(only, 1)], pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => 0, stopPg: () => assert.fail("must not stop"), removeDir: () => {} }, { execute: true });
  assert.deepEqual(r2.reclaimed, []);
});

test("instanceDir is the child of a test root; a path outside the roots has none", () => {
  const config = { testPgRoots: ["/data/pg"] };
  assert.equal(instanceDir("/data/pg/wt-a/data", config), "/data/pg/wt-a");
  assert.equal(instanceDir("/data/pg/wt-a", config), "/data/pg/wt-a");
  assert.equal(instanceDir("/data/pg", config), null);
  assert.equal(instanceDir("/elsewhere/x", config), null);
});

test("the report always carries free space, counts, reclaimed and skipped; low space is stated first and flagged", async () => {
  const w = world();
  const keep = w.worktree("keep", { merged: false }); w.worktree("go");
  const report = await run(w, { prFor: prs({ keep: { number: 3, state: "OPEN", open: 3 }, go: merged(4) }), freeBytes: () => 4.4 * GB });
  assert.equal(report.lowSpace, true);
  assert.equal(report.worktrees.count, 2);
  assert.ok(report.worktrees.totalBytes > 0);
  assert.equal(report.instances.running, 0);
  const text = formatReport(report);
  assert.match(text.split("\n")[0], /^⚠ 剩余空间 4\.4 GB,低于 20\.0 GB:需要 Leader 处理/);
  assert.match(text, /工作树:2 个/);
  assert.match(text, /将回收\(1\)/);
  assert.match(text, new RegExp(`跳过\\(\\d+\\):[\\s\\S]*${keep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*PR #3 还开着`));
  const fine = formatReport(await run(w, { prFor: prs({ go: merged(4) }), freeBytes: () => 100 * GB }));
  assert.ok(!fine.startsWith("⚠"));
});

test("config must be outside the repository with absolute lists, including the protected paths", () => {
  const ok = JSON.stringify({ repos: ["/srv/r"], workspaceRoots: ["/srv/ws"], protectedPaths: ["/srv/db"] });
  assert.equal(loadConfig(ok, "/etc/disk.json").minFreeGB, 20);
  assert.throws(() => loadConfig(ok, join(repoRoot, "disk.json")), /outside the repository/);
  assert.throws(() => loadConfig(JSON.stringify({ repos: ["/srv/r"], workspaceRoots: ["/srv/ws"] }), "/etc/d.json"), /protectedPaths must list at least one/);
  assert.throws(() => loadConfig(JSON.stringify({ repos: ["rel"], workspaceRoots: ["/srv/ws"], protectedPaths: ["/x"] }), "/etc/d.json"), /absolute/);
  assert.throws(() => loadConfig(JSON.stringify({ repos: [join(repoRoot, "x")], workspaceRoots: ["/srv/ws"], protectedPaths: ["/x"] }), "/etc/d.json"), /outside the repository/);
});

test("end to end: the real script with a fake gh, lsof and ps exits 3 on low space and 0 otherwise, and deletes nothing in a report", () => {
  const w = world();
  const path = w.worktree("e2e");
  const bin = join(w.root, "bin"); mkdirSync(bin);
  const script = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  script("gh", `echo '[{"number":7,"state":"MERGED","headRefOid":"0000"}]'`);
  script("lsof", "exit 0");
  script("ps", "exit 0");
  const configPath = join(w.root, "config.json");
  writeFileSync(configPath, JSON.stringify({ ...w.config, minFreeGB: 1e9 }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVOLOOP_DISK_CONFIG: configPath };
  const script_ = join(repoRoot, "scripts/ops/disk-reclaim.mjs");
  const low = spawnSync(process.execPath, [script_, "report"], { encoding: "utf8", env });
  assert.equal(low.status, 3, low.stderr);
  assert.match(low.stdout, /^⚠ 剩余空间/);
  assert.match(low.stdout, new RegExp(`将回收\\(1\\):[\\s\\S]*${path}`));
  assert.ok(existsSync(path));
  writeFileSync(configPath, JSON.stringify({ ...w.config, minFreeGB: 0 }));
  const ok = spawnSync(process.execPath, [script_, "run", "--execute"], { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(!existsSync(path));
  const missingConfig = spawnSync(process.execPath, [script_, "report"], { encoding: "utf8", env: { ...env, EVOLOOP_DISK_CONFIG: "" } });
  assert.equal(missingConfig.status, 2);
});

test("client connections are read from the process table: only children of that postmaster with a host field count", () => {
  const lines = [
    "  100     1 /pg/bin/postgres -D /data/a -p 5001",
    "  101   100 postgres: checkpointer",
    "  102   100 postgres: io worker 0",
    "  103   100 postgres: autovacuum launcher",
    "  104   100 postgres: logical replication launcher",
    "  110   100 postgres: dev evoloop_x_test 127.0.0.1(51234) idle",
    "  111   100 postgres: dev postgres [local] SELECT",
    "  112   100 postgres: dev evoloop_x_test ::1(51240) idle in transaction",
    "  120   200 postgres: dev evoloop_y_test 127.0.0.1(51300) idle", // another instance's client
    "  130   100 postgres: autovacuum worker evoloop_x_test",
  ];
  assert.equal(countClientBackends(lines, 100), 3);
  assert.equal(countClientBackends(lines, 200), 1);
  assert.equal(countClientBackends(lines.filter(line => !line.includes("evoloop_x_test") && !line.includes("[local]")), 100), 0);
  assert.equal(countClientBackends([], 100), 0);
});

test("zero connections is not enough: a recent write, or an unreadable data directory, keeps the instance", async () => {
  const w = world();
  const quiet = pgFixture(w, "idle"), recent = pgFixture(w, "busy"), blind = pgFixture(w, "unknown"), stopped = [];
  const procs = [procFor(quiet, 1), procFor(recent, 2), procFor(blind, 3)];
  const adapter = { pgProcesses: () => procs, pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => 0,
    pgLastWriteMs: dataDir => (dataDir.includes("/busy/") ? Date.now() - 10 * 60_000 : dataDir.includes("/unknown/") ? null : Date.now() - 5 * 3600_000),
    stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: () => {} };
  const report = await run(w, adapter, { execute: true });
  assert.equal(stopped.length, 1, JSON.stringify(stopped));
  assert.ok(stopped[0].endsWith("/idle/data"));
  assert.match(reasonsFor(report, recent.dataDir), /10 分钟前还有写入,不足 120 分钟空闲/);
  assert.match(reasonsFor(report, blind.dataDir), /无法确认数据目录最近有没有写入/);
});

test("--branch scopes instances too: only the one owned by that worktree goes, never legacy or other instances", async () => {
  const w = world();
  const wtPath = w.worktree("scoped");
  const owned = pgFixture(w, "owned", { marker: { name: "owned", worktree: wtPath } });
  const other = pgFixture(w, "idle");           // legacy, would be eligible in a full run
  const stopped = [];
  const adapter = { prFor: prs({ scoped: merged(1) }), pgProcesses: () => [procFor(owned, 1), procFor(other, 2)], pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => 0,
    pgLastWriteMs: () => 0, stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: () => {} };
  await run(w, adapter, { execute: true, onlyBranch: "scoped" });
  assert.equal(stopped.length, 1);
  assert.ok(stopped[0].endsWith("/owned/data"));
  assert.ok(!existsSync(wtPath));
});

// ---- --branch after the worktree is gone: the orphan-instance order (Task f7e3153a) ----

const scopedAdapter = (w, instances, { connections, stopped, idleMs = 5 * 3600_000 }) => ({
  prFor: prs({ scoped: merged(1) }), pgProcesses: () => instances.filter(inst => !stopped.includes(`rm ${inst.dir}`)).map((inst, index) => procFor(inst, index + 1)), // a removed instance is no longer running
  pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: ({ port }) => (typeof connections === "function" ? connections(port) : connections),
  pgLastWriteMs: () => Date.now() - idleMs, stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: dir => stopped.push(`rm ${dir}`),
});

test("ORDER: --branch skips the instance while a client is connected and reclaims the worktree; after the client leaves, the second --branch run reclaims the orphaned instance", async () => {
  const w = world();
  const wt = w.worktree("scoped");
  const inst = pgFixture(w, "scoped-pg", { marker: { name: "scoped-pg", worktree: wt, branch: "scoped" } });
  const stopped = []; let connected = 2;
  const adapter = scopedAdapter(w, [inst], { connections: () => connected, stopped });
  const first = await run(w, adapter, { execute: true, onlyBranch: "scoped" });
  assert.deepEqual(first.reclaimed.map(item => item.kind), ["worktree"]);
  assert.ok(!existsSync(wt), "the worktree was reclaimed");
  assert.deepEqual(stopped, [], "the connected instance was not stopped");
  assert.match(reasonsFor(first, inst.dataDir), /有 2 个客户端连接/);
  connected = 0; // the client disconnects
  const second = await run(w, adapter, { execute: true, onlyBranch: "scoped" });
  assert.equal(stopped.length, 2, JSON.stringify(stopped)); // stopPg + removeDir
  assert.ok(stopped[0].endsWith("/scoped-pg/data"));
  assert.deepEqual(second.reclaimed.map(item => item.kind), ["instance"]);
  assert.ok(!second.skipped.some(item => item.kind === "instance"));
  // a third run finds nothing left to do
  assert.deepEqual((await run(w, adapter, { execute: true, onlyBranch: "scoped" })).reclaimed, []);
});

test("ORDER (dry run): the report of a scoped run lists the orphaned instance as reclaimable without touching it", async () => {
  const w = world();
  const inst = pgFixture(w, "scoped-pg", { marker: { name: "scoped-pg", worktree: join(w.ws, "already-gone"), branch: "scoped" } });
  const stopped = [];
  const report = await run(w, scopedAdapter(w, [inst], { connections: 0, stopped }), { onlyBranch: "scoped" });
  assert.deepEqual(report.reclaimed.map(item => [item.kind, item.dryRun]), [["instance", true]]);
  assert.deepEqual(stopped, []);
});

test("ORDER counterexamples: the orphan match never widens what a scoped run may touch", async () => {
  const w = world();
  const gone = join(w.ws, "already-gone");
  const prod = join(w.ws, "prod-db", "postgres", "data"); mkdirSync(prod, { recursive: true });
  const foreign = join(w.root, "somebody-elses-pg"); mkdirSync(foreign);
  const live = w.worktree("other-live", { merged: false });
  const fixtures = {
    ok: pgFixture(w, "ok", { marker: { name: "ok", worktree: gone, branch: "scoped" } }),
    otherBranch: pgFixture(w, "idle", { marker: { name: "idle", worktree: gone, branch: "another-branch" } }),
    noBranch: pgFixture(w, "busy", { marker: { name: "busy", worktree: gone } }),                              // a marker written before branches were recorded
    pathStillThere: pgFixture(w, "unknown", { marker: { name: "unknown", worktree: live, branch: "scoped" } }),  // same branch name, but that worktree still exists
    legacy: pgFixture(w, "young"),                                                                               // no marker at all
    protectedPort: pgFixture(w, "port-protected", { marker: { name: "port-protected", worktree: gone, branch: "scoped" } }),
    recentWrite: pgFixture(w, "racy", { marker: { name: "racy", worktree: gone, branch: "scoped" } }),
  };
  w.config.legacyPgNames = [/.*/];
  const stopped = [];
  const instances = [...Object.values(fixtures)];
  const procs = [...instances.map((inst, index) => procFor(inst, index === 5 ? 55432 : index + 1)),
    { pid: 8001, binary: "/pg/bin/postgres", dataDir: prod, port: 55500 }, { pid: 8002, binary: "/pg/bin/postgres", dataDir: foreign, port: 55600 }];
  const adapter = { prFor: prs({}), pgProcesses: () => procs, pgInfo: () => ({ port: 1, socketDir: "/tmp", startedAt: 0 }), pgConnections: () => 0,
    pgLastWriteMs: dataDir => (dataDir.includes("/racy/") ? Date.now() - 60_000 : Date.now() - 5 * 3600_000), stopPg: ({ dataDir }) => stopped.push(dataDir), removeDir: () => {} };
  // markers for the protected production data dir and the foreign directory also claim the branch with the worktree gone
  writeFileSync(join(prod, "..", MARKER), JSON.stringify({ name: "p", worktree: gone, branch: "scoped" }));
  writeFileSync(join(foreign, MARKER), JSON.stringify({ name: "f", worktree: gone, branch: "scoped" }));
  const report = await run(w, adapter, { execute: true, onlyBranch: "scoped" });
  assert.equal(stopped.length, 1, JSON.stringify(stopped)); // exactly the one clean orphan
  assert.ok(stopped[0].endsWith("/ok/data"));
  const skipped = path => reasonsFor(report, path);
  assert.match(skipped(fixtures.protectedPort.dataDir), /受保护/);
  assert.match(skipped(fixtures.recentWrite.dataDir), /还有写入/);
  // out of scope for this branch: not reported, not touched. That includes the production data directory and the directory outside
  // the test roots even though their markers name this branch: only instances under a test root are ever matched.
  for (const path of [prod, foreign, fixtures.otherBranch.dataDir, fixtures.noBranch.dataDir, fixtures.pathStillThere.dataDir, fixtures.legacy.dataDir]) assert.equal(skipped(path), "", path);
  assert.ok(!stopped.some(path => path.includes("prod-db") || path.includes("somebody-elses")));
});
