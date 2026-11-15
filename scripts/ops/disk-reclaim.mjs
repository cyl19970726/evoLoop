#!/usr/bin/env node
// Reclaims disk on the resident host: linked git worktrees whose PR is merged, and test PostgreSQL instances nobody
// is connected to; reports free space, counts and what was reclaimed or skipped (with the reason for each).
// Dry run unless `run --execute`. Every safety condition is a check in this file, never a habit:
//   worktree: its branch's PR is MERGED, nothing uncommitted (untracked counts), nothing unpushed (HEAD is already in
//             the remote main or the PR head), no process has it as its working directory, it is under a configured
//             workspace root, it is not the main worktree and not under a protected path.
//   instance: under a configured test-instance root, not protected, recognised as a test instance (an owner marker written
//             by test-pg.mjs, or a directory name matching config.legacyPgNames: nothing else is ever touched), nobody
//             connected (unknown counts as connected), not just started, and (with a marker) its worktree is gone or
//             reclaimed in this run.
// Dependency directories (node_modules, reinstallable; sources, untracked files, branches and commits are never touched) are reclaimed in
// three more places, each with its own checks:
//   tmp copy:  a copy under a configured tmp root whose name matches config.tmpCopyNames (acceptance Sessions' temporary clones and instances)
//   merged worktree: a linked worktree whose PR is MERGED but which does not meet the strict whole-tree conditions above (dirty, unpushed)
//   old release: a release directory under config.releaseRoot that is neither the current release nor the previous complete one
//   all three: not protected, no process has it as its working directory, nothing changed in it for config.depsIdleMinutes.
// Private values (clone paths, workspace roots, protected production/release paths) come from a config file OUTSIDE the
// repository: EVOLOOP_DISK_CONFIG. Nothing here deletes by age.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync, statfsSync, rmSync, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MARKER } from "./test-pg.mjs";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GB = 1024 ** 3;
// <name>-main-<7-hex commit>-<yyyymmdd>: how a release directory is named, whatever the host user is called.
const DEFAULT_RELEASE_NAMES = String.raw`^[\w.-]+-main-[0-9a-f]{7}-\d{8}$`;

const real = path => { try { return realpathSync(path); } catch { return resolve(path); } };
export const within = (path, root) => { const a = real(path), b = real(root); return a === b || a.startsWith(b + sep); };
const inside = (path, root) => { const a = real(path), b = real(root); return a !== b && a.startsWith(b + sep); }; // strictly below

export function loadConfig(text, path) {
  if (!isAbsolute(path) || within(path, repoRoot)) throw new Error("Disk config must be an absolute path outside the repository");
  const config = JSON.parse(text);
  const absList = (key, required) => {
    const list = config[key] ?? [];
    if (required && !list.length) throw new Error(`config.${key} must list at least one absolute path`);
    for (const item of list) if (typeof item !== "string" || !isAbsolute(item)) throw new Error(`config.${key} entries must be absolute paths`);
    for (const item of list) if (within(item, repoRoot)) throw new Error(`config.${key} must be outside the repository`);
    return list;
  };
  const result = { repos: absList("repos", true), workspaceRoots: absList("workspaceRoots", true), protectedPaths: absList("protectedPaths", true),
    testPgRoots: absList("testPgRoots", false), legacyPgNames: (config.legacyPgNames ?? []).map(pattern => new RegExp(pattern)), protectedPorts: (config.protectedPorts ?? []).map(Number),
    tmpCopyRoots: absList("tmpCopyRoots", false), tmpCopyNames: (config.tmpCopyNames ?? []).map(pattern => new RegExp(pattern)),
    releaseRoot: config.releaseRoot ?? null, releaseNames: new RegExp(config.releaseNames ?? DEFAULT_RELEASE_NAMES), depsIdleMinutes: config.depsIdleMinutes ?? 120,
    minFreeGB: config.minFreeGB ?? 20, pgMinAgeMinutes: config.pgMinAgeMinutes ?? 30, pgIdleMinutes: config.pgIdleMinutes ?? 120, baseBranch: config.baseBranch ?? "main", remote: config.remote ?? "origin", repo: config.repo ?? null };
  if (!Number.isFinite(result.minFreeGB) || result.minFreeGB < 0) throw new Error("config.minFreeGB must be a number");
  if (result.releaseRoot !== null && (typeof result.releaseRoot !== "string" || !isAbsolute(result.releaseRoot) || within(result.releaseRoot, repoRoot))) throw new Error("config.releaseRoot must be an absolute path outside the repository");
  if (!Number.isFinite(result.depsIdleMinutes) || result.depsIdleMinutes < 0) throw new Error("config.depsIdleMinutes must be a number");
  return result;
}

// ---- pure decisions ----

/** Why a worktree may not be reclaimed. Empty list = reclaim. Every reason is reported. */
export function worktreeSkipReasons(facts, config) {
  const reasons = [];
  if (facts.isMain) reasons.push("是主工作树(克隆本体),永不回收");
  if (facts.locked) reasons.push(`工作树被锁定${facts.locked === true ? "" : `(${facts.locked})`}`);
  if (!facts.underWorkspace) reasons.push("不在配置的工作区根目录内");
  if (config.protectedPaths.some(p => within(facts.path, p) || within(p, facts.path))) reasons.push("路径受保护(正式数据库目录或发布目录相关),永不回收");
  if (facts.detached || !facts.branch) reasons.push("HEAD 是游离状态,没有分支可对应 PR");
  const pr = facts.pr;
  if (facts.branch && !facts.detached) {
    if (facts.prUnknown) reasons.push("无法查询这个分支的 PR 状态");
    else if (!pr) reasons.push(`分支 ${facts.branch} 没有对应的 PR`);
    else if (pr.open) reasons.push(`PR #${pr.open} 还开着`);
    else if (pr.state !== "MERGED") reasons.push(`PR #${pr.number} 已关闭但没有合并`);
  }
  if (facts.dirty === null) reasons.push("无法确认有没有未提交内容");
  else if (facts.dirty.length) reasons.push(`有未提交内容(${facts.dirty.length} 项,如 ${facts.dirty.slice(0, 2).join("; ")})`);
  if (facts.unpushed === null) reasons.push("无法确认提交是否都已在远端");
  else if (facts.unpushed) reasons.push("有尚未进入远端主分支或 PR 头的提交");
  if (facts.processes === null) reasons.push("无法检查有没有进程以它为工作目录");
  else if (facts.processes.length) reasons.push(`有进程以它为工作目录(${facts.processes.slice(0, 3).map(p => `${p.command}[${p.pid}]`).join(", ")})`);
  return reasons;
}

/** Why a test instance may not be stopped and removed. */
export function instanceSkipReasons(facts, config, { reclaimedWorktrees = new Set() } = {}) {
  const reasons = [];
  if (config.protectedPorts.includes(facts.port) || config.protectedPaths.some(p => within(facts.dataDir, p) || within(p, facts.dataDir))) return ["受保护的正式或发布实例,永不触碰"];
  if (!config.testPgRoots.some(root => inside(facts.dataDir, root))) return ["不在配置的测试实例根目录内(不是本流程管理的实例)"];
  // A directory under a broad root can be someone else's database: only a marker or an explicit name pattern says "test instance".
  if (!facts.marker && !config.legacyPgNames.some(pattern => pattern.test(facts.dirName ?? ""))) return ["没有归属标记,目录名也不匹配 legacyPgNames:不能确定是测试实例,不触碰"];
  if (facts.connections === null) reasons.push("无法确认有没有客户端连接");
  else if (facts.connections > 0) reasons.push(`有 ${facts.connections} 个客户端连接`);
  // Zero connections right now can be the gap between two test runs: also require that nothing was written for a while.
  if (facts.idleMinutes === null || facts.idleMinutes === undefined) reasons.push("无法确认数据目录最近有没有写入");
  else if (facts.idleMinutes < config.pgIdleMinutes) reasons.push(`数据目录 ${Math.round(facts.idleMinutes)} 分钟前还有写入,不足 ${config.pgIdleMinutes} 分钟空闲`);
  if (facts.ageMinutes !== null && facts.ageMinutes < config.pgMinAgeMinutes) reasons.push(`刚启动 ${Math.round(facts.ageMinutes)} 分钟,不足 ${config.pgMinAgeMinutes} 分钟`);
  if (facts.marker?.worktree && existsSync(facts.marker.worktree) && !reclaimedWorktrees.has(real(facts.marker.worktree))) reasons.push(`所属工作树 ${facts.marker.worktree} 仍在使用`);
  return reasons;
}

/**
 * Why the dependency directories of a place may not be removed. `facts`: { path, kind: "tmp-copy" | "worktree" | "release", processes (list or null),
 * recentChange (a path changed inside the idle window, null = unknown, false = none), plus per kind: tmp-copy: nothing more; worktree: pr, branch;
 * release: isCurrent, isPrevious }. Empty list = remove its node_modules.
 */
export function depsSkipReasons(facts, config) {
  const reasons = [];
  if (config.protectedPaths.some(p => within(facts.path, p) || within(p, facts.path))) reasons.push("路径受保护(正式数据库目录、隧道配置目录或发布目录相关),永不回收");
  if (facts.kind === "tmp-copy") {
    if (!(config.tmpCopyRoots ?? []).some(root => inside(facts.path, root))) reasons.push("不在配置的临时目录根下");
    else if (!(config.tmpCopyNames ?? []).some(pattern => pattern.test(basename(facts.path)))) reasons.push("目录名不匹配 tmpCopyNames:不能确定是验收临时副本,不触碰");
  } else if (facts.kind === "worktree") {
    if (!facts.branch || facts.detached) reasons.push("HEAD 是游离状态,没有分支可对应 PR");
    else if (facts.prUnknown) reasons.push("无法查询这个分支的 PR 状态");
    else if (!facts.pr) reasons.push(`分支 ${facts.branch} 没有对应的 PR`);
    else if (facts.pr.open) reasons.push(`PR #${facts.pr.open} 还开着`);
    else if (facts.pr.state !== "MERGED") reasons.push(`PR #${facts.pr.number} 已关闭但没有合并`);
  } else if (facts.kind === "release") {
    if (!config.releaseRoot || !inside(facts.path, config.releaseRoot)) reasons.push("不在配置的发布目录根下");
    else if (!(config.releaseNames ?? new RegExp(DEFAULT_RELEASE_NAMES)).test(basename(facts.path))) reasons.push("目录名不匹配 releaseNames:不是发布目录,不触碰");
    if (facts.isCurrent) reasons.push("是当前发布(current 指向它)");
    if (facts.isPrevious) reasons.push("是上一个完整发布(保留作回退)");
    if (facts.isNewerThanCurrent) reasons.push("比当前发布还新:可能是正在准备的下一个发布,不动");
  } else reasons.push(`未知类型 ${facts.kind}`);
  if (facts.processes === null) reasons.push("无法检查有没有进程以它为工作目录");
  else if (facts.processes.length) reasons.push(`有进程以它为工作目录(${facts.processes.slice(0, 3).map(p => `${p.command}[${p.pid}]`).join(", ")})`);
  if (facts.recentChange === null) reasons.push("无法确认最近有没有改动");
  else if (facts.recentChange) reasons.push(`${config.depsIdleMinutes ?? 120} 分钟内有改动(${facts.recentChange === true ? "" : facts.recentChange})`.replace("()", ""));
  return reasons;
}

/** The directory to delete for an instance: the child of a test-instance root that contains its data directory. */
export function instanceDir(dataDir, config) {
  const root = config.testPgRoots.find(r => inside(dataDir, r));
  if (!root) return null;
  const rel = real(dataDir).slice(real(root).length + 1).split(sep)[0];
  return join(real(root), rel);
}

/**
 * Client connections of one PostgreSQL instance, read from the process table instead of by logging in (the test
 * instances use different superuser names, and logging in would itself be a connection). A client backend's title is
 * "postgres: USER DATABASE HOST(PORT) STATE" or "... [local] STATE"; background processes ("checkpointer", "io worker 1",
 * "autovacuum launcher", ...) have no host field and are not counted. `lines` are "PID PPID COMMAND" rows.
 */
export function countClientBackends(lines, postmasterPid) {
  let count = 0;
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s+postgres: (\S+) (\S+) (\[local\]|\[unknown\]|[0-9a-fA-F:.]+\(\d+\))(?:\s|$)/.exec(line);
    if (m && Number(m[2]) === postmasterPid) count += 1;
  }
  return count;
}

// ---- adapters (tests inject fakes) ----

export function makeAdapters(config, exec = execFileSync) {
  const run = (file, args, options = {}) => exec(file, args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], ...options });
  const git = (cwd, ...args) => run("git", ["-C", cwd, ...args]);
  return {
    git,
    fetch: repo => { try { git(repo, "fetch", "--quiet", config.remote); return true; } catch { return false; } },
    worktrees: repo => {
      const entries = [];
      for (const block of git(repo, "worktree", "list", "--porcelain").trim().split("\n\n")) {
        const entry = { repo, locked: false };
        for (const line of block.split("\n")) {
          const [key, ...rest] = line.split(" "); const value = rest.join(" ");
          if (key === "worktree") entry.path = value; else if (key === "HEAD") entry.head = value;
          else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, ""); else if (key === "detached") entry.detached = true;
          else if (key === "locked") entry.locked = value || true; else if (key === "prunable") entry.prunable = true;
        }
        if (entry.path) entries.push(entry);
      }
      return entries.map((entry, index) => ({ ...entry, isMain: index === 0 }));
    },
    prFor: branch => {
      const args = ["pr", "list", "--head", branch, "--state", "all", "--limit", "20", "--json", "number,state,headRefOid", ...(config.repo ? ["--repo", config.repo] : [])];
      const list = JSON.parse(run("gh", args));
      if (!list.length) return null;
      const open = list.find(pr => pr.state === "OPEN");
      const latest = [...list].sort((a, b) => b.number - a.number)[0];
      return { ...latest, open: open?.number ?? null };
    },
    status: path => { try { return git(path, "status", "--porcelain=v1", "--untracked-files=all").split("\n").filter(Boolean); } catch { return null; } },
    isAncestor: (path, commit, ref) => { try { git(path, "merge-base", "--is-ancestor", commit, ref); return true; } catch (error) { return error.status === 1 ? false : null; } },
    hasObject: (path, oid) => { try { git(path, "cat-file", "-e", `${oid}^{commit}`); return true; } catch { return false; } },
    // Every process's working directory (lsof): a Session or a Run that works in a directory shows up here.
    cwds: () => {
      const out = run("lsof", ["-a", "-d", "cwd", "-Fpcn"]).split("\n");
      const result = []; let current = null;
      for (const line of out) { if (line[0] === "p") current = { pid: Number(line.slice(1)) }; else if (line[0] === "c" && current) current.command = line.slice(1); else if (line[0] === "n" && current) { result.push({ ...current, cwd: line.slice(1) }); } }
      return result;
    },
    sizeBytes: path => { try { return Number(run("du", ["-sk", path]).split("\t")[0]) * 1024; } catch { return null; } },
    removeWorktree: (repo, path) => { git(repo, "worktree", "remove", path); },
    // node_modules directories up to `depth` levels below `dir` (never looking inside one, nor inside .git).
    findDeps: (dir, depth = 3) => {
      const found = [];
      const walk = (current, level) => {
        let entries; try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const child = join(current, entry.name);
          if (entry.name === "node_modules") found.push(child);
          else if (entry.name !== ".git" && level < depth) walk(child, level + 1);
        }
      };
      walk(dir, 1);
      return found;
    },
    // A path (relative) of one file changed within `minutes`, ignoring node_modules and .git; false = none; null = could not look.
    recentChange: (dir, minutes) => {
      try {
        const out = run("find", [dir, "(", "-name", "node_modules", "-o", "-name", ".git", ")", "-prune", "-o", "-type", "f", "-mmin", `-${Math.max(1, Math.ceil(minutes))}`, "-print", "-quit"]).trim();
        return out ? out.slice(dir.length + 1) || true : false;
      } catch { return null; }
    },
    listDirs: root => { try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => join(root, entry.name)); } catch { return null; } },
    realpath: path => real(path),
    // A release that was deployed has both source/ and runtime/; a build that was only made (or aborted) has less and is not a rollback target.
    deployed: dir => existsSync(join(dir, "source")) && existsSync(join(dir, "runtime")),
    mtimeMs: path => { try { return statSync(path).mtimeMs; } catch { return null; } },
    removeDeps: path => { if (basename(path) !== "node_modules") throw new Error("refusing to remove a directory that is not node_modules"); rmSync(path, { recursive: true, force: true }); },
    freeBytes: path => { const s = statfsSync(path); return s.bavail * s.bsize; },
    // Running test PostgreSQL postmasters: `postgres ... -D DIR ...` (children are "postgres: ..." and are skipped).
    pgProcesses: () => run("ps", ["-axo", "pid=,etime=,command="]).split("\n").map(line => {
      const m = /^\s*(\d+)\s+(\S+)\s+(\S*\/postgres)\s(.*)$/.exec(line);
      if (!m) return null;
      const dir = /(?:^|\s)-D\s+(\S+)/.exec(m[4]); if (!dir) return null;
      const port = /(?:^|\s)-p\s+(\d+)/.exec(m[4]);
      return { pid: Number(m[1]), binary: m[3], dataDir: dir[1], port: port ? Number(port[1]) : null };
    }).filter(Boolean),
    pgInfo: dataDir => {
      try {
        const lines = readFileSync(join(dataDir, "postmaster.pid"), "utf8").split("\n");
        return { port: Number(lines[3]), socketDir: lines[4], startedAt: statSync(join(dataDir, "postmaster.pid")).mtimeMs };
      } catch { return null; }
    },
    // Newest modification time (ms) of the control file and the WAL segments: they change whenever the instance is written to.
    pgLastWriteMs: dataDir => {
      try {
        let newest = statSync(join(dataDir, "global", "pg_control")).mtimeMs;
        for (const name of readdirSync(join(dataDir, "pg_wal"))) { try { newest = Math.max(newest, statSync(join(dataDir, "pg_wal", name)).mtimeMs); } catch { /* segment rotated away */ } }
        return newest;
      } catch { return null; }
    },
    pgConnections: ({ pid }) => {
      try { return countClientBackends(run("ps", ["-axo", "pid=,ppid=,command="]).split("\n"), pid); } catch { return null; }
    },
    stopPg: ({ binary, dataDir }) => { run(join(dirname(binary), "pg_ctl"), ["-D", dataDir, "stop", "-m", "fast", "-w", "-t", "30"]); },
    readMarker: dir => { try { return JSON.parse(readFileSync(join(dir, MARKER), "utf8")); } catch { return null; } },
    removeDir: dir => rmSync(dir, { recursive: true, force: true }),
    dirExists: dir => existsSync(dir),
  };
}

// ---- the run ----

export async function survey({ adapter, config, onlyBranch = null, now = Date.now() }) {
  const processes = (() => { try { return adapter.cwds(); } catch { return null; } })();
  const worktrees = [];
  for (const repo of config.repos) {
    adapter.fetch(repo);
    let list = [];
    try { list = adapter.worktrees(repo); } catch (error) { worktrees.push({ path: repo, skipped: [`无法列出工作树: ${error.message.split("\n")[0]}`], bytes: null, kind: "worktree" }); continue; }
    for (const entry of list) {
      if (onlyBranch && entry.branch !== onlyBranch) continue;
      const facts = { path: entry.path, repo, branch: entry.branch, detached: entry.detached, isMain: entry.isMain, locked: entry.locked,
        underWorkspace: config.workspaceRoots.some(root => inside(entry.path, root)), pr: null, dirty: null, unpushed: null, processes: null };
      if (entry.isMain || !existsSync(entry.path)) { worktrees.push({ ...entry, facts, bytes: existsSync(entry.path) ? adapter.sizeBytes(entry.path) : 0, reasons: worktreeSkipReasons({ ...facts, dirty: [], unpushed: false, processes: [] }, config), kind: "worktree" }); continue; }
      if (entry.branch && !entry.detached) { try { facts.pr = adapter.prFor(entry.branch); } catch { facts.prUnknown = true; } }
      facts.dirty = adapter.status(entry.path);
      if (entry.head) {
        const remoteMain = `${config.remote}/${config.baseBranch}`;
        let pushed = adapter.isAncestor(entry.path, entry.head, remoteMain);
        if (pushed === false && facts.pr?.headRefOid && adapter.hasObject(entry.path, facts.pr.headRefOid)) pushed = adapter.isAncestor(entry.path, entry.head, facts.pr.headRefOid);
        facts.unpushed = pushed === null ? null : !pushed;
      }
      facts.processes = processes === null ? null : processes.filter(p => within(p.cwd, entry.path));
      worktrees.push({ ...entry, facts, bytes: adapter.sizeBytes(entry.path), reasons: worktreeSkipReasons(facts, config), kind: "worktree" });
    }
  }
  const instances = [];
  for (const proc of adapter.pgProcesses()) {
    const dataDir = real(proc.dataDir);
    const info = adapter.pgInfo(dataDir);
    const port = proc.port ?? info?.port ?? null;
    const dir = instanceDir(dataDir, config);
    const facts = { dataDir, port, pid: proc.pid, binary: proc.binary, dirName: dir ? basename(dir) : null, connections: null, ageMinutes: info ? (now - info.startedAt) / 60000 : null, idleMinutes: (() => { const last = adapter.pgLastWriteMs?.(dataDir); return typeof last === "number" ? (now - last) / 60000 : null; })(), marker: dir ? adapter.readMarker(dir) : null };
    const managed = config.testPgRoots.some(root => inside(dataDir, root));
    if (managed) facts.connections = adapter.pgConnections({ pid: proc.pid, binary: proc.binary, port });
    instances.push({ kind: "instance", dataDir, port, pid: proc.pid, dir, facts, bytes: adapter.sizeBytes(dataDir) });
  }
  return { worktrees, instances, processesKnown: processes !== null, processes };
}

export const DEPS_CLASSES = { "tmp-copy": "/tmp 验收临时副本", worktree: "已合并 PR 的工作树依赖", release: "旧发布依赖" };

/**
 * The places whose node_modules may be reclaimed, each with the reasons it may not (empty = reclaim). Worktrees that the run removes
 * whole are not listed again. `wholeRemoved` holds the real paths of worktrees removed (or planned) in this run.
 */
export function surveyDeps({ adapter, config, surveyed, wholeRemoved = new Set(), now = Date.now() }) {
  const items = [];
  const processes = surveyed.processes ?? null;
  const using = dir => (processes === null ? null : processes.filter(p => within(p.cwd, dir)));
  const bytesOf = dirs => dirs.reduce((sum, dir) => sum + (adapter.sizeBytes(dir) ?? 0), 0);
  const add = (cls, path, facts) => {
    const depsDirs = adapter.findDeps(path);
    if (!depsDirs.length) return;
    items.push({ class: cls, path, depsDirs, bytes: bytesOf(depsDirs), reasons: depsSkipReasons({ path, ...facts, processes: using(path), recentChange: adapter.recentChange(path, config.depsIdleMinutes ?? 120) }, config) });
  };
  for (const root of config.tmpCopyRoots ?? []) {
    for (const dir of adapter.listDirs(root) ?? []) if ((config.tmpCopyNames ?? []).some(pattern => pattern.test(basename(dir)))) add("tmp-copy", dir, { kind: "tmp-copy" });
  }
  for (const entry of surveyed.worktrees) {
    if (!entry.facts || entry.isMain || !entry.facts.underWorkspace || !adapter.dirExists(entry.path) || wholeRemoved.has(real(entry.path))) continue;
    add("worktree", entry.path, { kind: "worktree", branch: entry.branch, detached: entry.detached, pr: entry.facts.pr, prUnknown: entry.facts.prUnknown });
  }
  if (config.releaseRoot) {
    const dirs = (adapter.listDirs(config.releaseRoot) ?? []).filter(dir => (config.releaseNames ?? new RegExp(DEFAULT_RELEASE_NAMES)).test(basename(dir)));
    const current = (() => { const link = adapter.realpath(join(config.releaseRoot, "current")); return dirs.map(real).includes(link) ? link : null; })();
    // The previous release is the newest other one that was deployed (source/ and runtime/): a build that was made but never deployed, or an aborted
    // one, is newer but is not what a rollback would go back to.
    const previous = dirs.filter(dir => real(dir) !== current && adapter.deployed(dir)).sort((a, b) => (adapter.mtimeMs(b) ?? 0) - (adapter.mtimeMs(a) ?? 0))[0] ?? null;
    for (const dir of dirs) add("release", dir, { kind: "release", isCurrent: real(dir) === current, isPrevious: previous !== null && real(dir) === real(previous),
      isNewerThanCurrent: current !== null && real(dir) !== current && (adapter.mtimeMs(dir) ?? 0) > (adapter.mtimeMs(current) ?? Infinity) });
  }
  return items;
}

/** Decide, then (only with execute) act. Returns the full report data. */
export async function reclaim({ adapter, config, execute = false, onlyBranch = null, now = Date.now(), log = () => {} }) {
  const freeBefore = adapter.freeBytes(config.workspaceRoots[0]);
  const surveyed = await survey({ adapter, config, onlyBranch, now });
  const reclaimed = [], skipped = [], failed = [];
  const reclaimedWorktrees = new Set();
  const plan = surveyed.worktrees.filter(w => !w.reasons?.length && w.facts);
  for (const item of surveyed.worktrees) {
    if (item.reasons?.length || !item.facts) { if (item.reasons?.length || item.skipped) skipped.push({ kind: "worktree", path: item.path, branch: item.branch ?? null, bytes: item.bytes, reasons: item.reasons ?? item.skipped }); }
  }
  // instances are evaluated against what this run will reclaim, so a merged worktree's own instance can go with it
  const planned = new Set(plan.map(w => real(w.path)));
  for (const item of plan) {
    if (!execute) { reclaimed.push({ kind: "worktree", path: item.path, branch: item.branch, bytes: item.bytes, dryRun: true }); planned.add(real(item.path)); continue; }
    try { adapter.removeWorktree(item.repo, item.path); reclaimed.push({ kind: "worktree", path: item.path, branch: item.branch, bytes: item.bytes }); reclaimedWorktrees.add(real(item.path)); log(`removed worktree ${item.path}`); }
    catch (error) { failed.push({ kind: "worktree", path: item.path, error: error.message.split("\n")[0] }); }
  }
  for (const item of surveyed.instances) {
    // With --branch the run is scoped to that branch's worktree: an instance is in scope when its owner marker points at that
    // worktree, or when the worktree is already gone and the marker names this branch. The second case is the order "first
    // --branch run reclaimed the worktree but skipped the instance because a client was connected; the client left; run again":
    // without it the instance stays an orphan until the next unscoped run. Everything else about the instance is unchanged,
    // so it still has to pass every protection (roots, protected paths and ports, no connections, idle, not just started).
    if (onlyBranch) {
      const marker = item.facts.marker;
      const owner = marker?.worktree ? real(marker.worktree) : null;
      const target = surveyed.worktrees.find(w => w.branch === onlyBranch);
      const ownedByTarget = Boolean(owner && target && owner === real(target.path));
      const orphanOfBranch = Boolean(marker?.branch === onlyBranch && marker?.worktree && !existsSync(marker.worktree));
      if (!ownedByTarget && !orphanOfBranch) continue;
    }
    const reasons = instanceSkipReasons(item.facts, config, { reclaimedWorktrees: execute ? reclaimedWorktrees : planned });
    if (reasons.length || !item.dir) { skipped.push({ kind: "instance", path: item.dataDir, port: item.port, bytes: item.bytes, reasons: reasons.length ? reasons : ["无法确定实例目录"] }); continue; }
    if (!execute) { reclaimed.push({ kind: "instance", path: item.dir, port: item.port, bytes: item.bytes, dryRun: true }); continue; }
    try {
      // Re-check right before stopping: a client may have connected since the survey.
      const again = adapter.pgConnections({ pid: item.pid, binary: item.facts.binary, port: item.port });
      if (again !== 0) { skipped.push({ kind: "instance", path: item.dataDir, port: item.port, bytes: item.bytes, reasons: [again === null ? "停止前复查时无法确认连接" : `停止前复查时有 ${again} 个客户端连接`] }); continue; }
      adapter.stopPg({ binary: item.facts.binary, dataDir: item.dataDir });
      if (config.protectedPaths.some(p => within(item.dir, p) || within(p, item.dir)) || !config.testPgRoots.some(r => inside(item.dir, r))) throw new Error("refusing to delete a path outside the test-instance roots");
      adapter.removeDir(item.dir);
      reclaimed.push({ kind: "instance", path: item.dir, port: item.port, bytes: item.bytes }); log(`stopped and removed instance ${item.dir}`);
    } catch (error) { failed.push({ kind: "instance", path: item.dataDir, error: error.message.split("\n")[0] }); }
  }
  const deps = surveyDeps({ adapter, config, surveyed, wholeRemoved: execute ? reclaimedWorktrees : planned, now });
  for (const item of deps) {
    if (item.reasons.length) { skipped.push({ kind: "deps", class: item.class, path: item.path, bytes: item.bytes, reasons: item.reasons }); continue; }
    if (!execute) { reclaimed.push({ kind: "deps", class: item.class, path: item.path, bytes: item.bytes, dryRun: true }); continue; }
    try {
      for (const dir of item.depsDirs) adapter.removeDeps(dir);
      reclaimed.push({ kind: "deps", class: item.class, path: item.path, bytes: item.bytes }); log(`removed node_modules in ${item.path}`);
    } catch (error) { failed.push({ kind: "deps", class: item.class, path: item.path, error: error.message.split("\n")[0] }); }
  }
  const byClass = Object.fromEntries(Object.keys(DEPS_CLASSES).map(cls => {
    const rec = reclaimed.filter(item => item.kind === "deps" && item.class === cls), skp = skipped.filter(item => item.kind === "deps" && item.class === cls);
    return [cls, { reclaimedCount: rec.length, reclaimedBytes: rec.reduce((sum, item) => sum + (item.bytes ?? 0), 0), skippedCount: skp.length, skippedBytes: skp.reduce((sum, item) => sum + (item.bytes ?? 0), 0) }];
  }));
  const free = adapter.freeBytes(config.workspaceRoots[0]);
  const linked = surveyed.worktrees.filter(w => !w.isMain && w.facts);
  return {
    generatedAt: new Date(now).toISOString(), execute, onlyBranch,
    freeBytesBefore: freeBefore, freeBytes: free, deps: byClass, minFreeBytes: config.minFreeGB * GB, lowSpace: free < config.minFreeGB * GB,
    worktrees: { count: linked.length, totalBytes: linked.reduce((sum, w) => sum + (w.bytes ?? 0), 0) },
    instances: { running: surveyed.instances.length, underTestRoots: surveyed.instances.filter(i => i.dir).length, totalBytes: surveyed.instances.reduce((sum, i) => sum + (i.bytes ?? 0), 0) },
    reclaimed, skipped, failed, processesKnown: surveyed.processesKnown,
  };
}

export function formatReport(report) {
  const gb = bytes => `${(bytes / GB).toFixed(1)} GB`;
  const lines = [];
  if (report.lowSpace) lines.push(`⚠ 剩余空间 ${gb(report.freeBytes)},低于 ${gb(report.minFreeBytes)}:需要 Leader 处理(回收后仍不足时:加盘、清理其他项目缓存或停用不需要的工作区,这些不在本脚本范围内)`, "");
  lines.push(`剩余空间:${gb(report.freeBytes)}(${report.execute ? "已执行" : "预演,未删除任何东西"},${report.generatedAt})`);
  lines.push(`工作树:${report.worktrees.count} 个,共 ${gb(report.worktrees.totalBytes)};测试实例:运行中 ${report.instances.running} 个(数据目录合计约 ${gb(report.instances.totalBytes)},其中在测试实例根目录下 ${report.instances.underTestRoots} 个)`);
  const rec = report.reclaimed;
  lines.push("", `${report.execute ? "本次回收" : "将回收"}(${rec.length}):`);
  const label = item => (item.kind === "worktree" ? "工作树" : item.kind === "deps" ? `${DEPS_CLASSES[item.class] ?? "依赖"}(node_modules)` : "测试实例");
  for (const item of rec) lines.push(`  - ${label(item)} ${item.path}${item.branch ? `(${item.branch})` : ""}${item.port ? ` 端口 ${item.port}` : ""} ${item.bytes == null ? "" : gb(item.bytes)}`);
  if (report.deps) {
    lines.push("", `依赖目录回收(按类别;${report.execute ? "已回收" : "可回收"} / 跳过):`);
    for (const [cls, name] of Object.entries(DEPS_CLASSES)) { const d = report.deps[cls]; lines.push(`  - ${name}:${report.execute ? "回收" : "可回收"} ${d.reclaimedCount} 处 ${gb(d.reclaimedBytes)};跳过 ${d.skippedCount} 处 ${gb(d.skippedBytes)}`); }
    if (report.freeBytesBefore != null) lines.push(`  - 执行前后可用空间(statfs):${gb(report.freeBytesBefore)} → ${gb(report.freeBytes)}(差 ${gb(report.freeBytes - report.freeBytesBefore)};脚本回收合计 ${gb(rec.reduce((sum, item) => sum + (item.bytes ?? 0), 0))},“du 大小”与实际释放可能不同)`);
  }
  lines.push("", `跳过(${report.skipped.length}):`);
  for (const item of report.skipped) lines.push(`  - ${label(item)} ${item.path}${item.branch ? `(${item.branch})` : ""}${item.port ? ` 端口 ${item.port}` : ""}:${item.reasons.join(";")}`);
  if (report.failed.length) { lines.push("", `失败(${report.failed.length}):`); for (const item of report.failed) lines.push(`  - ${item.kind} ${item.path}:${item.error}`); }
  if (!report.processesKnown) lines.push("", "注意:无法列出进程工作目录(lsof 不可用),所有工作树都因此被跳过。");
  return lines.join("\n");
}

const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain()) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { execute: { type: "boolean", default: false }, json: { type: "boolean", default: false }, branch: { type: "string" }, config: { type: "string" } } });
  const command = positionals[0] ?? "report";
  const path = values.config ?? process.env.EVOLOOP_DISK_CONFIG;
  if (!["report", "run"].includes(command) || !path) {
    console.error("usage: disk-reclaim.mjs report [--json]            (dry run: what would be reclaimed, free space, counts)\n       disk-reclaim.mjs run [--execute] [--branch NAME] [--json]   (reclaim; --branch limits it to one worktree, e.g. right after merging its PR)\nconfig: --config PATH or EVOLOOP_DISK_CONFIG (outside the repository)");
    process.exit(2);
  }
  try {
    const config = loadConfig(readFileSync(path, "utf8"), resolve(path));
    const adapter = makeAdapters(config);
    const report = await reclaim({ adapter, config, execute: command === "run" && values.execute, onlyBranch: values.branch ?? null, log: line => console.error(line) });
    console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
    if (report.failed.length) process.exit(1);
    if (report.lowSpace) process.exit(3); // a low-space alert must be seen by a scheduler, not only logged
  } catch (error) { console.error(error.message); process.exit(1); }
}
